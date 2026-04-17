const { BindAPI } = require('./bind-api');
const {
  fetchHistorialByCode,
  resolveSupplier,
  getAlternativeSuppliers,
} = require('./supplier-resolver');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ override: true });

const bind = new BindAPI();

// ── Configuración de terminalidad de producción ───────────────────────────────
// Carga lazy + cache de product-sourcing.json para saber qué categorías/códigos
// NO deben expandir su fórmula Bind (evita que 7003 MICROGREENS CHICHARO se
// expanda a "chicharo a granel" y de ahí a "peat moss" en compras).
let _terminalCache = null;
function loadTerminalConfig() {
  if (_terminalCache) return _terminalCache;
  try {
    const cfgPath = path.join(__dirname, '..', 'config', 'product-sourcing.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const terminalCategorias = new Set();
    const nonTerminalCategorias = new Set();
    for (const cat of cfg.produccion?.categorias || []) {
      if (cat.terminal === true)  terminalCategorias.add(cat.id);
      if (cat.terminal === false) nonTerminalCategorias.add(cat.id);
    }
    _terminalCache = {
      terminalCategorias,
      nonTerminalCategorias,
      codigosTerminales:    new Set(cfg.produccion?.codigosTerminales    || []),
      codigosNoTerminales:  new Set(cfg.produccion?.codigosNoTerminales  || []),
    };
  } catch (err) {
    console.warn('   ⚠️  No se pudo cargar terminal config:', err.message);
    _terminalCache = {
      terminalCategorias: new Set(),
      nonTerminalCategorias: new Set(),
      codigosTerminales: new Set(),
      codigosNoTerminales: new Set(),
    };
  }
  return _terminalCache;
}

/**
 * Decide si un item de producción es terminal (no expandir fórmula Bind).
 * Prioridad: override por código > categoría > default no-terminal.
 */
function isTerminalProduccion(item, product) {
  const t = loadTerminalConfig();
  if (t.codigosTerminales.has(item.code))   return true;
  if (t.codigosNoTerminales.has(item.code)) return false;
  const catID = product?.Category1ID;
  if (catID && t.terminalCategorias.has(catID))    return true;
  if (catID && t.nonTerminalCategorias.has(catID)) return false;
  return false; // default: expandir (comportamiento legacy)
}

/**
 * Clasifica productos según el campo Description en Bind:
 *   PRODUCCION → lista para encargado de producción
 *   COMPRAS → lista para el chofer
 *   COMPRAS FORANEAS → pedido semanal (DHL/avión), no se envía
 *
 * Usa las Fórmulas de Bind para resolver cadenas de transformación:
 *   Ej: ESPINACA BABY KG → 5 × ESPINACA BABY 200GR (producción) → ESPINACA BABY LIBRA (compra Costco)
 */

const CLASIFICACIONES = {
  PRODUCCION: 'produccion',
  PRODUCCIÓN: 'produccion',
  COMPRAS: 'compras',
  COMPRA: 'compras',
  'COMPRAS FORANEAS': 'compras_foraneas',
  'COMPRAS FORÁNEAS': 'compras_foraneas',
  'COMPRAS DELIVERY': 'compras_delivery',
};

function classifyByDescription(description) {
  if (!description) return 'sin_clasificar';
  const desc = description.trim().toUpperCase();
  if (CLASIFICACIONES[desc]) return CLASIFICACIONES[desc];
  for (const [key, value] of Object.entries(CLASIFICACIONES)) {
    if (desc.startsWith(key)) return value;
  }
  return 'sin_clasificar';
}

/**
 * Carga las fórmulas de Bind y construye el árbol de transformación
 */
async function loadFormulas() {
  const formulas = await bind.request('/api/Formulas');
  const formulaList = formulas.value || [];

  // Mapeo: ProductCode del producto terminado → fórmula con ingredientes
  const formulaMap = new Map();

  for (const f of formulaList) {
    // Cargar detalle de cada fórmula para obtener ingredientes
    const detail = await bind.request(`/api/Formulas/${f.ID}`);
    formulaMap.set(detail.ProductCode, {
      productCode: detail.ProductCode,
      productTitle: detail.ProductTitle,
      productUnit: detail.ProductUnit,
      qtyProduced: detail.Qty,
      ingredients: (detail.ProductionFormulaItems || []).map(i => ({
        code: i.Code,
        title: i.Title,
        qty: i.Qty,
        productID: i.ProductID,
      })),
    });
  }

  return formulaMap;
}

/**
 * Resuelve un faltante recorriendo la cadena de fórmulas hasta llegar
 * a un producto con clasificación COMPRAS o PRODUCCION.
 *
 * Ej: 3 KG ESPINACA BABY KG
 *   → fórmula: 1 KG = 5 × ESPINACA BABY 200GR
 *   → 3 KG = 15 × ESPINACA BABY 200GR
 *   → ESPINACA BABY 200GR es PRODUCCION
 *   → pero su ingrediente ESPINACA BABY LIBRA es COMPRAS
 *   → 15 × 200GR, y 1 LIBRA = 0.45KG... lo resuelve la fórmula de 200GR
 */
/**
 * Resuelve un faltante recorriendo TODA la cadena de fórmulas.
 * Si un producto es PRODUCCION, se agrega a producción Y sigue
 * expandiendo para encontrar las materias primas de COMPRAS.
 *
 * Ej: 3 KG ESPINACA BABY KG
 *   → fórmula: 5 × ESPINACA BABY 200GR (PRODUCCION) → va a lista producción
 *   → fórmula 200GR: 0.4444 × ESPINACA BABY LIBRA (COMPRAS) → va a lista chofer
 */
function resolveShortage(item, formulaMap, productMap, visited = new Set()) {
  if (visited.has(item.code)) return [item];
  visited.add(item.code);

  const product = Array.from(productMap.values()).find(p => p.Code === item.code);
  const tipo = classifyByDescription(product?.Description);
  const formula = formulaMap.get(item.code);

  // Si tiene clasificación Y no tiene fórmula → caso final
  if (tipo !== 'sin_clasificar' && !formula) {
    return [{ ...item, tipo }];
  }

  // Terminal de producción: no expandir la fórmula Bind. La "fórmula" en estos
  // casos es costeo (peat moss, semilla, charola) y no una cadena de producción
  // real que deba alertar a compras/producción. El producto se agrega tal cual
  // a la lista de producción y se para la expansión.
  if (tipo === 'produccion' && isTerminalProduccion(item, product)) {
    if (formula) {
      console.log(`     ↯ ${item.code} ${item.name} es terminal (${product?.Category1 || 'categoría'}) — fórmula no expandida`);
    }
    return [{ ...item, tipo }];
  }

  // Si tiene clasificación Y tiene fórmula → expandir hijos.
  // Para producción no-terminal con fórmula, decidimos si agregar o no el padre:
  //   - Si el primer ingrediente de la fórmula TAMBIÉN es producción → el padre
  //     es un "agregador" redundante (ej: ESPINACA KG = 5x 200GR, ambos producción).
  //     Se salta para no duplicar la solicitud.
  //   - Si el primer ingrediente es compras/otro → el padre ES el producto que
  //     producción prepara (ej: ESPINACA 200GR → LIBRA compras). Se conserva.
  const results = [];
  let skipParent = false;
  if (formula && tipo === 'produccion' && !isTerminalProduccion(item, product)) {
    const firstIngredient = (formula.ingredients || []).find(i => !i.code.startsWith('MP3') && !i.code.startsWith('KIT'));
    if (firstIngredient) {
      const ingredientProduct = Array.from(productMap.values()).find(p => p.Code === firstIngredient.code);
      const ingredientTipo = classifyByDescription(ingredientProduct?.Description);
      if (ingredientTipo === 'produccion') skipParent = true;
    }
  }

  if (tipo !== 'sin_clasificar' && !skipParent) {
    results.push({ ...item, tipo });
  }

  if (formula) {
    const batchesNeeded = item.deficit / formula.qtyProduced;

    for (const ingredient of formula.ingredients) {
      // Ignorar contenedores y empaques
      if (ingredient.code.startsWith('MP3') || ingredient.code.startsWith('KIT')) continue;

      const ingredientDeficit = Math.ceil(batchesNeeded * ingredient.qty);
      const subItem = {
        code: ingredient.code,
        name: ingredient.title,
        unit: productMap.get(ingredient.productID)?.Unit || 'PZ',
        deficit: ingredientDeficit,
        totalNeeded: ingredientDeficit,
        currentStock: 0,
        derivedFrom: `${item.deficit} ${item.unit} ${item.name}`,
      };

      const subResolved = resolveShortage(subItem, formulaMap, productMap, visited);
      results.push(...subResolved);
    }
  }

  return results.length > 0 ? results : [{ ...item, tipo: tipo || 'sin_clasificar' }];
}

/**
 * Procesa el reporte de faltantes y genera listas separadas
 */
async function routeShortages(shortageReport) {
  console.log('   Cargando fórmulas de producción de Bind...');
  const formulaMap = await loadFormulas();
  console.log(`   ✅ ${formulaMap.size} fórmulas cargadas`);

  // Cargar productos para Description y unidades
  const products = await bind.getAllProducts();
  const productMap = new Map();
  for (const p of products) {
    productMap.set(p.ID, p);
  }

  const compras = [];
  const produccion = [];
  const comprasForaneas = [];
  const comprasDelivery = [];
  const sinClasificar = [];

  for (const [productID, shortage] of shortageReport.productShortages) {
    const item = {
      code: shortage.code,
      name: shortage.name,
      unit: shortage.unit,
      totalNeeded: shortage.totalNeeded,
      currentStock: shortage.currentStock,
      deficit: shortage.totalNeeded - shortage.currentStock,
      orders: shortage.orders,
    };

    // Resolver a través de fórmulas
    const resolved = resolveShortage(item, formulaMap, productMap);

    for (const r of resolved) {
      switch (r.tipo) {
        case 'produccion':
          produccion.push(r);
          break;
        case 'compras':
          compras.push(r);
          break;
        case 'compras_foraneas':
          comprasForaneas.push(r);
          break;
        case 'compras_delivery':
          comprasDelivery.push(r);
          break;
        default:
          sinClasificar.push(r);
      }
    }
  }

  // Consolidar: si el mismo producto aparece varias veces, sumar cantidades
  const consolidate = (list) => {
    const map = new Map();
    for (const item of list) {
      if (map.has(item.code)) {
        const existing = map.get(item.code);
        existing.deficit += item.deficit;
        if (item.derivedFrom) {
          existing.derivedFrom = existing.derivedFrom
            ? existing.derivedFrom + ' + ' + item.derivedFrom
            : item.derivedFrom;
        }
      } else {
        map.set(item.code, { ...item });
      }
    }
    return Array.from(map.values());
  };

  // Enriquecer las compras con proveedor inteligente (historial últimas 2 iguales
  // → fallback a product-sourcing.json). La PWA agrupa por supplier y muestra
  // alternativeSuppliers como sugerencias cuando el chofer da "Cambiar".
  console.log('   Cargando historial de compras para resolver proveedores...');
  const historialByCode = await fetchHistorialByCode();
  const productsArr = Array.from(productMap.values());
  const productByCode = new Map();
  for (const p of productsArr) productByCode.set(p.Code, p);

  const comprasConsolidated = consolidate(compras);
  const comprasEnriched = comprasConsolidated.map(item => {
    const product = productByCode.get(item.code);
    const { supplier, supplierSource } = resolveSupplier(item.code, product, historialByCode);
    const alternativeSuppliers = getAlternativeSuppliers(item.code, historialByCode);
    return {
      ...item,
      supplier,
      supplierSource,
      alternativeSuppliers,
      category: product?.Category1 || item.category || 'COMPRAS',
    };
  });

  return {
    compras: comprasEnriched,
    produccion: consolidate(produccion),
    comprasForaneas: consolidate(comprasForaneas),
    comprasDelivery: consolidate(comprasDelivery),
    sinClasificar: consolidate(sinClasificar),
  };
}

/**
 * Genera mensajes formateados para enviar por WhatsApp/otro medio
 */
function formatMessages(routed) {
  const fecha = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  // Mensaje para CHOFER (compras)
  let comprasMsg = `🚚 *LISTA DE COMPRAS*\n📅 ${fecha}\n\n`;
  if (routed.compras.length === 0) {
    comprasMsg += '_No hay productos por comprar._\n';
  } else {
    for (const item of routed.compras) {
      comprasMsg += `• ${item.deficit} ${item.unit} ${item.name}\n`;
    }
  }

  // Mensaje para PRODUCCIÓN
  let produccionMsg = `🌱 *LISTA DE PRODUCCIÓN*\n📅 ${fecha}\n\n`;
  if (routed.produccion.length === 0) {
    produccionMsg += '_No hay productos por producir._\n';
  } else {
    for (const item of routed.produccion) {
      produccionMsg += `• ${item.deficit} ${item.unit} ${item.name}\n`;
    }
  }

  // Compras foráneas
  let foraneaMsg = null;
  if (routed.comprasForaneas.length > 0) {
    foraneaMsg = `✈️ *COMPRAS FORÁNEAS* (pedido semanal)\n📅 ${fecha}\n\n`;
    for (const item of routed.comprasForaneas) {
      foraneaMsg += `• ${item.deficit} ${item.unit} ${item.name}\n`;
    }
  }

  return { comprasMsg, produccionMsg, foraneaMsg };
}

/**
 * Imprime las listas en consola
 */
function printRoutedShortages(routed) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          LISTAS DE ABASTECIMIENTO                    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // COMPRAS
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🚚 COMPRAS — Enviar al chofer');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  if (routed.compras.length === 0) {
    console.log('  ✅ No hay productos por comprar.\n');
  } else {
    for (const item of routed.compras) {
      const derived = item.derivedFrom ? ` ← ${item.derivedFrom}` : '';
      console.log(`     • ${item.deficit} ${item.unit} — ${item.name}${derived}`);
    }
    console.log('');
  }

  // PRODUCCIÓN
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🌱 PRODUCCIÓN — Enviar a encargado de producción');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  if (routed.produccion.length === 0) {
    console.log('  ✅ No hay productos por producir.\n');
  } else {
    for (const item of routed.produccion) {
      const derived = item.derivedFrom ? ` ← ${item.derivedFrom}` : '';
      console.log(`     • ${item.deficit} ${item.unit} — ${item.name}${derived}`);
    }
    console.log('');
  }

  // FORÁNEAS
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✈️  COMPRAS FORÁNEAS — Pedido semanal (no se envía)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  if (routed.comprasForaneas.length === 0) {
    console.log('  ✅ No hay compras foráneas pendientes.\n');
  } else {
    for (const item of routed.comprasForaneas) {
      console.log(`     • ${item.deficit} ${item.unit} — ${item.name}`);
    }
    console.log('');
  }

  // DELIVERY
  if (routed.comprasDelivery && routed.comprasDelivery.length > 0) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  🚛 COMPRAS DELIVERY — El proveedor lo trae (no se envía)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    for (const item of routed.comprasDelivery) {
      console.log(`     • ${item.deficit} ${item.unit} — ${item.name}`);
    }
    console.log('');
  }

  // SIN CLASIFICAR
  if (routed.sinClasificar.length > 0) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ⚠️  SIN CLASIFICAR — Agregar Description en Bind');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    for (const item of routed.sinClasificar) {
      console.log(`     • ${item.deficit} ${item.unit} — ${item.name} [${item.code}]`);
    }
    console.log('');
    console.log('  💡 Agrega "PRODUCCION", "COMPRAS" o "COMPRAS FORANEAS"');
    console.log('     en la Description del producto en Bind.\n');
  }
}

/**
 * Genera la lista completa para ALMACÉN con todos los productos
 * de los pedidos activos, organizada por categoría de Bind.
 * Solo muestra totales consolidados con nota de faltantes.
 *
 * @param {Object} inventoryReport - Reporte del inventory-checker (pedidos activos + stock)
 * @param {Object} routed - Resultado de routeShortages (listas clasificadas)
 */
function generateWarehouseList(inventoryReport, routed) {
  const { activeOrders, productMap } = inventoryReport;

  // Consolidar todos los productos de todos los pedidos
  const allProducts = new Map(); // productID → { name, unit, totalQty, category, stock, status, nota }

  for (const order of activeOrders) {
    for (const item of order.Products) {
      const key = item.ProductID;
      if (!allProducts.has(key)) {
        const product = productMap ? productMap.get(item.ProductID) : null;
        const currentStock = product ? product.CurrentInventory : 0;
        allProducts.set(key, {
          code: item.Code,
          name: item.Name,
          unit: item.Unit,
          totalQty: 0,
          currentStock,
          category: product?.Category1 || 'SIN CATEGORÍA',
        });
      }
      allProducts.get(key).totalQty += item.Qty;
    }
  }

  // Determinar status de cada producto
  const shortageCodesCompras = new Set(routed.compras.map(i => i.code));
  const shortageCodesProduccion = new Set(routed.produccion.map(i => i.code));
  const shortageCodesForaneas = new Set(routed.comprasForaneas.map(i => i.code));
  const shortageCodesDelivery = new Set((routed.comprasDelivery || []).map(i => i.code));

  const warehouseList = [];

  for (const [productID, entry] of allProducts) {
    let status = 'listo';
    let nota = '';

    if (entry.currentStock < entry.totalQty) {
      const origenes = [];
      if (shortageCodesCompras.has(entry.code)) origenes.push('chofer notificado');
      if (shortageCodesProduccion.has(entry.code)) origenes.push('producción notificada');
      if (shortageCodesForaneas.has(entry.code)) origenes.push('pedido foráneo pendiente');
      if (shortageCodesDelivery.has(entry.code)) origenes.push('proveedor delivery lo trae');

      if (origenes.length > 0) {
        status = 'pendiente';
        nota = origenes.join(' / ');
      } else {
        status = 'faltante';
        nota = 'sin clasificar';
      }
    }

    warehouseList.push({
      ...entry,
      status,
      nota,
    });
  }

  // Ordenar por categoría y luego por nombre
  warehouseList.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  return warehouseList;
}

/**
 * Genera mensaje formateado para almacén, organizado por categoría
 */
function formatWarehouseMessage(warehouseList) {
  const fecha = new Date().toLocaleDateString('es-MX', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  let msg = `📦 *LISTA DE ALMACÉN — PREPARACIÓN*\n📅 ${fecha}\n\n`;

  // Agrupar por categoría
  const byCategory = {};
  for (const item of warehouseList) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  for (const [category, items] of Object.entries(byCategory)) {
    msg += `*── ${category} ──*\n`;
    for (const item of items) {
      let line = `• ${item.totalQty} ${item.unit} ${item.name}`;
      if (item.status === 'pendiente') {
        line += ` ⏳ _${item.nota}_`;
      } else if (item.status === 'faltante') {
        line += ` ⚠️`;
      }
      msg += line + '\n';
    }
    msg += '\n';
  }

  return msg;
}

/**
 * Imprime la lista de almacén en consola, organizada por categoría
 */
function printWarehouseList(warehouseList) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          LISTA DE ALMACÉN — PREPARACIÓN              ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Agrupar por categoría
  const byCategory = {};
  for (const item of warehouseList) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  const listos = warehouseList.filter(i => i.status === 'listo').length;
  const pendientes = warehouseList.filter(i => i.status === 'pendiente').length;
  const faltantes = warehouseList.filter(i => i.status === 'faltante').length;

  for (const [category, items] of Object.entries(byCategory)) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  📂 ${category}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    for (const item of items) {
      let line = `     • ${item.totalQty} ${item.unit} — ${item.name}`;
      if (item.status === 'pendiente') {
        line += ` ⏳ (${item.nota})`;
      } else if (item.status === 'faltante') {
        line += ` ⚠️ (sin clasificar)`;
      }
      console.log(line);
    }
    console.log('');
  }

  console.log(`  📊 Total: ${warehouseList.length} productos | ✅ ${listos} listos | ⏳ ${pendientes} pendientes | ⚠️ ${faltantes} sin asignar\n`);
}

module.exports = {
  classifyByDescription,
  routeShortages,
  formatMessages,
  printRoutedShortages,
  generateWarehouseList,
  formatWarehouseMessage,
  printWarehouseList,
};
