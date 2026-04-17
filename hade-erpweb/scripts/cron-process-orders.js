#!/usr/bin/env node
/**
 * HADE-WEBERP — Procesamiento automático de pedidos por email
 *
 * Este script (cada 5 min):
 *  1. Lee correos NO LEÍDOS de ventas1@hade.mx
 *  2. Claude interpreta los PDFs/texto
 *  3. Hace matching con catálogo de Bind
 *  4. Si entrega = HOY → crea pedido en Bind inmediatamente
 *  5. Si entrega = FUTURO → guarda PDF + JSON en ordenes-compra/ (diferido)
 *  6. Revisa carpeta ordenes-compra/ por pedidos diferidos cuya fecha ya sea HOY
 *     → los crea en Bind y borra el .json (el PDF se queda en ordenes-compra/)
 *  7. Si hubo pedidos creados para hoy, revisa inventario y genera listas
 *
 * Se ejecuta cada 5 minutos via cron.
 */
require('dotenv').config({ override: true, path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { processUnreadOrders } = require('../src/services/email-order-processor');
const { prepareBindOrder, createBindOrder, loadCatalogs } = require('../src/services/order-creator');
const { checkInventoryForOrders } = require('../src/services/inventory-checker');
const { routeShortages, formatMessages, generateWarehouseList, formatWarehouseMessage } = require('../src/services/shortage-router');
const { pushListasToSheets } = require('../src/services/sheets-pusher');
const { registerOrder, findByOrderNumber } = require('../src/services/orders-registry');

// Directorios
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'order-processing.log');
const PENDING_FILE = path.join(LOG_DIR, 'pending-review.json');
const PDF_DIR = path.join(__dirname, '..', 'docs', 'ordenes-compra');

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function savePendingReview(pending) {
  let existing = [];
  if (fs.existsSync(PENDING_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch (e) {}
  }
  existing.push(...pending);
  fs.writeFileSync(PENDING_FILE, JSON.stringify(existing, null, 2));
}

/**
 * Formatea fecha YYYY-MM-DD a DDMMAAAA para nombre de archivo
 */
function formatDateForFilename(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-'); // YYYY-MM-DD
  return parts[2] + parts[1] + parts[0]; // DDMMAAAA
}

/**
 * Obtiene la fecha de hoy en formato YYYY-MM-DD
 */
function getToday() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Guarda PDF adjuntos en docs/ordenes-compra/
 * @returns {string[]} nombres de archivos guardados
 */
function savePDFs(parsed, prepared) {
  const savedFiles = [];
  if (!parsed._source?.attachmentBuffers?.length) return savedFiles;

  // Sin OC no guardamos respaldo — el adjunto es el pedido en sí (p.ej. screenshot
  // de WhatsApp reenviado). No tiene sentido archivarlo como "orden de compra".
  if (!parsed.orderNumber) {
    log(`   ℹ️  Pedido sin OC — no se guarda adjunto en ordenes-compra/`);
    return savedFiles;
  }

  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

  const clientName = prepared.client.bindMatch.name.replace(/[^A-Z0-9]/gi, '_').toUpperCase();
  const oc = parsed.orderNumber;
  const fechaStr = formatDateForFilename(parsed.deliveryDate) || formatDateForFilename(getToday());
  const prefix = process.env.TEST_MODE === 'prueba' ? 'PRUEBA_' : '';

  for (const att of parsed._source.attachmentBuffers) {
    const pdfName = `${prefix}${fechaStr}_${clientName}_${oc}.PDF`;
    const pdfPath = path.join(PDF_DIR, pdfName);
    fs.writeFileSync(pdfPath, att.content);
    savedFiles.push(pdfName);
    log(`   📄 PDF guardado: ${pdfName}`);
  }
  return savedFiles;
}

/**
 * Guarda JSON con datos del pedido preparado (para creación diferida)
 */
function saveDeferredOrder(parsed, prepared) {
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

  const clientName = prepared.client.bindMatch.name.replace(/[^A-Z0-9]/gi, '_').toUpperCase();
  const oc = parsed.orderNumber || 'SIN_OC';
  const fechaStr = formatDateForFilename(parsed.deliveryDate);
  const jsonName = `${fechaStr}_${clientName}_${oc}.json`;
  const jsonPath = path.join(PDF_DIR, jsonName);

  const deferredData = {
    savedAt: new Date().toISOString(),
    deliveryDate: parsed.deliveryDate,
    clientName: prepared.client.bindMatch.name,
    orderNumber: parsed.orderNumber,
    bindOrderBody: prepared.bindOrderBody,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(deferredData, null, 2));
  log(`   💾 Pedido diferido guardado: ${jsonName} (entrega: ${parsed.deliveryDate})`);
  return jsonName;
}

/**
 * Borra el JSON diferido tras crearse en Bind.
 * Los PDFs permanecen en ordenes-compra/ como respaldo histórico.
 */
function deleteDeferredJson(filename) {
  const src = path.join(PDF_DIR, filename);
  if (fs.existsSync(src)) {
    fs.unlinkSync(src);
  }
}

/**
 * PASO A: Procesar emails nuevos
 */
async function processNewEmails() {
  let parsedOrders, emailReader;
  try {
    const result = await processUnreadOrders();
    parsedOrders = result.results;
    emailReader = result.reader;
    log(`📧 ${parsedOrders.length} email(s) no leído(s) procesado(s)`);
  } catch (err) {
    log(`❌ ERROR leyendo emails: ${err.message}`);
    return { created: 0, deferred: 0, failed: 0 };
  }

  if (parsedOrders.length === 0) {
    return { created: 0, deferred: 0, failed: 0 };
  }

  const today = getToday();
  let created = 0;
  let deferred = 0;
  let failed = 0;
  let pendingReview = [];
  const processedUids = [];

  for (const [i, parsed] of parsedOrders.entries()) {
    if (!parsed.success) {
      const isRetryable = parsed.error && (
        parsed.error.includes('529') ||
        parsed.error.includes('overloaded') ||
        parsed.error.includes('500') ||
        parsed.error.includes('timeout') ||
        parsed.error.includes('ECONNRESET')
      );

      if (isRetryable) {
        log(`🔄 Email ${i + 1}: error temporal (se reintentará) — ${parsed.error}`);
      } else {
        log(`⚠️  Email ${i + 1}: no interpretable — ${parsed.error || 'sin datos'}`);
        if (parsed._uid) processedUids.push(parsed._uid);
        pendingReview.push({
          timestamp: new Date().toISOString(),
          reason: 'no_interpretable',
          emailFrom: parsed._source?.emailFrom || 'N/A',
          emailSubject: parsed._source?.emailSubject || 'N/A',
          error: parsed.error,
        });
      }
      failed++;
      continue;
    }

    // Parsing exitoso → marcar como leído
    if (parsed._uid) processedUids.push(parsed._uid);

    log(`📋 Email ${i + 1}: ${parsed.clientName} — ${parsed.items?.length || 0} productos — Entrega: ${parsed.deliveryDate || 'N/A'}`);

    // ─── DEDUPLICACIÓN: si la OC ya existe en el registro, no recrear ───
    if (parsed.orderNumber) {
      const existing = findByOrderNumber(parsed.orderNumber);
      if (existing) {
        log(`   ⏭️  OC ${parsed.orderNumber} ya procesada el ${existing.createdAt} (BindID ${existing.bindOrderID}) — SKIP`);
        continue;
      }
    }

    // Preparar pedido (matching)
    const prepared = await prepareBindOrder(parsed);

    if (!prepared.ready) {
      const reasons = [];
      if (!prepared.client.bindMatch) reasons.push(`Cliente sin match: "${prepared.client.parsed}"`);
      if (prepared.unmatchedProducts.length > 0) reasons.push(`Productos sin match: ${prepared.unmatchedProducts.join(', ')}`);

      log(`⚠️  Pedido NO listo: ${reasons.join(' | ')}`);
      pendingReview.push({
        timestamp: new Date().toISOString(),
        reason: 'incomplete_match',
        clientParsed: prepared.client.parsed,
        clientMatch: prepared.client.bindMatch?.name || null,
        unmatchedProducts: prepared.unmatchedProducts,
        emailFrom: parsed._source?.emailFrom || 'N/A',
        orderNumber: parsed.orderNumber,
      });
      failed++;
      continue;
    }

    // Guardar PDFs siempre
    savePDFs(parsed, prepared);

    // ─── Clasificar por fecha de entrega ───
    // - HOY o sin fecha → crear en Bind ahora
    // - FUTURO → diferir (guardar JSON)
    // - PASADO → enviar a revisión manual (NO crear, evita duplicar pedidos viejos)
    const testBypassPastGuard = process.env.TEST_MODE === 'prueba';
    const isPastDate = !testBypassPastGuard && parsed.deliveryDate && parsed.deliveryDate < today;
    const isForToday = !isPastDate && (!parsed.deliveryDate || parsed.deliveryDate === today || testBypassPastGuard);

    if (isPastDate) {
      log(`   ⚠️  OC ${parsed.orderNumber || ''} con entrega ${parsed.deliveryDate} (PASADA) — enviada a revisión manual, NO se crea en Bind`);
      pendingReview.push({
        timestamp: new Date().toISOString(),
        reason: 'past_delivery_date',
        clientName: prepared.client.bindMatch.name,
        orderNumber: parsed.orderNumber,
        deliveryDate: parsed.deliveryDate,
        emailFrom: parsed._source?.emailFrom || 'N/A',
        notes: 'OC con fecha de entrega pasada. Verificar manualmente si debe crearse o ignorarse.',
      });
      failed++;
      continue;
    }

    if (isForToday) {
      // ─── CREAR EN BIND INMEDIATAMENTE ───
      const result = await createBindOrder(prepared.bindOrderBody);
      if (result.success) {
        const bindOrderID = typeof result.order === 'string' ? result.order.replace(/"/g, '') : result.order;
        log(`✅ PEDIDO CREADO en Bind — Cliente: ${prepared.client.bindMatch.name} | Ref: ${parsed.orderNumber || 'N/A'} | Entrega: HOY | BindID: ${JSON.stringify(result.order)}`);
        created++;

        registerOrder(bindOrderID, {
          clientName: prepared.client.bindMatch.name,
          orderNumber: parsed.orderNumber,
          deliveryDate: parsed.deliveryDate || today,
        });
      } else {
        log(`❌ ERROR creando en Bind: ${result.error}`);
        pendingReview.push({
          timestamp: new Date().toISOString(),
          reason: 'bind_error',
          clientName: prepared.client.bindMatch.name,
          orderNumber: parsed.orderNumber,
          error: result.error,
          body: prepared.bindOrderBody,
        });
        failed++;
      }
    } else {
      // ─── DIFERIR: guardar JSON para crear el día de entrega ───
      saveDeferredOrder(parsed, prepared);
      deferred++;
    }
  }

  // Marcar como leídos los emails procesados
  if (processedUids.length > 0) {
    try {
      await emailReader.markAsRead(processedUids);
      log(`📬 ${processedUids.length} email(s) marcados como leídos`);
    } catch (err) {
      log(`⚠️  Error marcando emails como leídos: ${err.message}`);
    }
  }

  if (pendingReview.length > 0) {
    savePendingReview(pendingReview);
    log(`📝 ${pendingReview.length} pedido(s) requieren revisión manual → ${PENDING_FILE}`);
  }

  return { created, deferred, failed, total: parsedOrders.length };
}

/**
 * PASO B: Revisar carpeta ordenes-compra/ por pedidos diferidos cuya fecha ya es HOY
 */
async function processDeferredOrders() {
  if (!fs.existsSync(PDF_DIR)) return { created: 0 };

  const today = getToday();
  const todayDDMM = formatDateForFilename(today); // DDMMAAAA

  // Buscar archivos .json en la carpeta
  const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.json'));

  if (files.length === 0) return { created: 0 };

  let created = 0;
  let pendingReview = [];

  for (const jsonFile of files) {
    const jsonPath = path.join(PDF_DIR, jsonFile);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      log(`⚠️  Error leyendo ${jsonFile}: ${e.message}`);
      continue;
    }

    // Verificar si la fecha de entrega es HOY o ya pasó
    if (!data.deliveryDate) continue;
    const isForToday = data.deliveryDate === today || data.deliveryDate < today;
    if (!isForToday) continue;

    log(`📂 Pedido diferido encontrado para HOY: ${jsonFile}`);

    // Deduplicación: si la OC ya está en el registro, no la recreamos
    if (data.orderNumber) {
      const existing = findByOrderNumber(data.orderNumber);
      if (existing) {
        log(`   ⏭️  OC ${data.orderNumber} ya procesada (BindID ${existing.bindOrderID}) — borrando .json diferido sin recrear`);
        deleteDeferredJson(jsonFile);
        continue;
      }
    }

    // Actualizar OrderDate al día de hoy (se crea hoy, no cuando llegó el email)
    if (data.bindOrderBody) {
      data.bindOrderBody.OrderDate = today;
    }

    // Crear en Bind
    const result = await createBindOrder(data.bindOrderBody);
    if (result.success) {
      const bindOrderID = typeof result.order === 'string' ? result.order.replace(/"/g, '') : result.order;
      log(`✅ PEDIDO DIFERIDO CREADO en Bind — Cliente: ${data.clientName} | Ref: ${data.orderNumber || 'N/A'} | BindID: ${JSON.stringify(result.order)}`);
      created++;

      registerOrder(bindOrderID, {
        clientName: data.clientName,
        orderNumber: data.orderNumber,
        deliveryDate: data.deliveryDate,
      });

      // Borrar el JSON (ya no se necesita) — el PDF se queda en ordenes-compra/
      deleteDeferredJson(jsonFile);
    } else {
      log(`❌ ERROR creando pedido diferido en Bind: ${result.error}`);
      pendingReview.push({
        timestamp: new Date().toISOString(),
        reason: 'bind_error_deferred',
        clientName: data.clientName,
        orderNumber: data.orderNumber,
        error: result.error,
        file: jsonFile,
      });
    }
  }

  if (pendingReview.length > 0) {
    savePendingReview(pendingReview);
  }

  return { created };
}

/**
 * PASO C: Revisar inventario para pedidos de HOY (si se crearon pedidos)
 */
async function checkInventoryForToday() {
  // En TEST_MODE=prueba usar hoy en zona Monterrey (GMT-6) para evitar el gap de medianoche UTC
  const today = process.env.TEST_MODE === 'prueba'
    ? new Date(Date.now() - 6*3600*1000).toISOString().split('T')[0]
    : getToday();
  log(`━━━ Revisando inventario para pedidos con entrega HOY (${today}) ━━━`);

  try {
    const inventoryReport = await checkInventoryForOrders(today);

    if (inventoryReport.ordersWithShortage.length > 0) {
      const routed = await routeShortages(inventoryReport);
      const messages = formatMessages(routed);
      const warehouseList = generateWarehouseList(inventoryReport, routed);
      const almacenMsg = formatWarehouseMessage(warehouseList);

      // Guardar listas de abastecimiento
      const supplyFile = path.join(LOG_DIR, 'supply-lists.json');
      const supplyData = {
        timestamp: new Date().toISOString(),
        deliveryDate: today,
        compras: routed.compras,
        produccion: routed.produccion,
        comprasForaneas: routed.comprasForaneas,
        comprasDelivery: routed.comprasDelivery,
        sinClasificar: routed.sinClasificar,
        almacen: warehouseList,
        mensajes: { ...messages, almacenMsg },
      };
      fs.writeFileSync(supplyFile, JSON.stringify(supplyData, null, 2));

      log(`⚠️  Faltantes detectados:`);
      if (routed.compras.length > 0) log(`   🚚 COMPRAS (chofer): ${routed.compras.length} productos`);
      if (routed.produccion.length > 0) log(`   🌱 PRODUCCIÓN: ${routed.produccion.length} productos`);
      if (routed.comprasForaneas.length > 0) log(`   ✈️  FORÁNEAS: ${routed.comprasForaneas.length} productos`);
      if (routed.sinClasificar.length > 0) log(`   ⚠️  SIN CLASIFICAR: ${routed.sinClasificar.length} productos`);
      log(`   📦 ALMACÉN: ${warehouseList.length} productos totales`);

      // Inyectar compras manuales (logs/manual-compras.json) — items temporales
      // que sobreviven ciclos del cron hasta su expiresAt. Útil cuando un proveedor
      // foráneo no entrega y se debe comprar localmente por excepción.
      const manualFile = path.join(LOG_DIR, 'manual-compras.json');
      if (fs.existsSync(manualFile)) {
        try {
          const manualData = JSON.parse(fs.readFileSync(manualFile, 'utf8'));
          const now = new Date().toISOString();
          const active = (manualData.items || []).filter(i => !i.expiresAt || i.expiresAt > now);
          if (active.length > 0) {
            routed.compras.push(...active);
            log(`   🔧 ${active.length} compra(s) manual(es) inyectada(s)`);
          }
          // Limpiar expirados del archivo
          const expired = (manualData.items || []).length - active.length;
          if (expired > 0) {
            manualData.items = active;
            fs.writeFileSync(manualFile, JSON.stringify(manualData, null, 2));
            log(`   🧹 ${expired} compra(s) manual(es) expirada(s) removida(s)`);
          }
        } catch (e) {
          log(`   ⚠️  Error leyendo manual-compras.json: ${e.message}`);
        }
      }

      // Enviar a Google Sheets (incluye activeOrders para módulo Logística)
      try {
        await pushListasToSheets(routed, warehouseList, null, inventoryReport.activeOrders);
        log('   ✅ Listas enviadas a Google Sheets');
      } catch (sheetsErr) {
        log(`   ⚠️  Error enviando a Sheets: ${sheetsErr.message}`);
      }

      // TODO: WhatsApp
      if (routed.compras.length > 0) {
        log(`   📱 Mensaje chofer: ${messages.comprasMsg.split('\n').filter(l=>l.startsWith('•')).length} items`);
      }
      if (routed.produccion.length > 0) {
        log(`   📱 Mensaje producción: ${messages.produccionMsg.split('\n').filter(l=>l.startsWith('•')).length} items`);
      }
    } else {
      log('✅ Inventario suficiente para todos los pedidos de hoy.');
    }
  } catch (err) {
    log(`⚠️  Error revisando inventario: ${err.message}`);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  log('═══ INICIO procesamiento automático de pedidos ═══');

  // Cargar catálogos de Bind
  try {
    await loadCatalogs();
  } catch (err) {
    log(`❌ ERROR cargando catálogos: ${err.message}`);
    process.exit(1);
  }

  // PASO A: Procesar emails nuevos
  const emailResult = await processNewEmails();
  log(`📊 Emails — Creados: ${emailResult.created} | Diferidos: ${emailResult.deferred || 0} | Pendientes: ${emailResult.failed || 0} | Total: ${emailResult.total || 0}`);

  // PASO B: Revisar pedidos diferidos en carpeta ordenes-compra/
  const deferredResult = await processDeferredOrders();
  if (deferredResult.created > 0) {
    log(`📂 Pedidos diferidos creados en Bind: ${deferredResult.created}`);
  }

  // PASO C: Si se creó algún pedido para hoy, revisar inventario
  const totalCreatedToday = emailResult.created + deferredResult.created;
  if (totalCreatedToday > 0) {
    await checkInventoryForToday();
  }

  log(`═══ FIN procesamiento ═══`);
}

main().catch(err => {
  log(`💥 ERROR FATAL: ${err.message}`);
  process.exit(1);
});
