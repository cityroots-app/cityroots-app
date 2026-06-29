/**
 * Apps Script TEST · Tab Administración HADE
 *
 * Backend del Sheet FlujoEfectivo_2026_TEST (sandbox clonado del master).
 * Deploy: pegar este código → Implementar → Web App → Ejecutar como yo + acceso "Cualquier persona".
 *
 * Endpoints expuestos via doGet/doPost:
 *   GET  ?action=ping
 *   GET  ?action=getFlujo&periodo=mes|all&filtro=todos|pendientes|programados
 *   GET  ?action=getSaldoSummary
 *   GET  ?action=getContrapartes
 *   POST {action:'addMovimiento', data:{...}}
 *   POST {action:'updateMovimiento', data:{row_id, ...campos}}
 *   POST {action:'markEnBind', data:{row_id, factura, userId}}
 *   POST {action:'marcarPagado', data:{row_id, monto?, fecha?}}
 *
 * Schema esperado en hoja FLUJO_2026 (columnas A-S):
 *   A FECHA · B PROVEEDOR · C CONCEPTO · D FORMA_PAGO · E APLICADO · F FACTURA
 *   G TIPO · H CATEGORIA · I SUB-CATEGORIA · J INGRESO · K EGRESO · L TOTAL
 *   M row_id · N estado · O created_by · P created_at · Q factura_at · R bind_at · S updated_by
 *
 * Reglas:
 *   - addMovimiento: append a final, genera row_id UUID, calcula L = L(n-1)+J(n)-K(n)
 *   - Estado 'programado' NO debe sumar/restar a L (saldo running). El saldo lo lleva
 *     una fórmula condicional o este script al recalcular.
 *   - updateMovimiento: busca por row_id (col M), actualiza solo campos enviados.
 */

const SHEET_NAME = 'FLUJO_2026';
const COL = {
  FECHA: 1, PROVEEDOR: 2, CONCEPTO: 3, FORMA_PAGO: 4, APLICADO: 5, FACTURA: 6,
  TIPO: 7, CATEGORIA: 8, SUBCATEGORIA: 9, INGRESO: 10, EGRESO: 11, TOTAL: 12,
  ROW_ID: 13, ESTADO: 14, CREATED_BY: 15, CREATED_AT: 16,
  FACTURA_AT: 17, BIND_AT: 18, UPDATED_BY: 19
};
const HEADER_ROW = 2; // Fila 1 es título, fila 2 son headers (ajustar si master usa otra estructura)

function doGet(e) {
  const action = (e.parameter.action || 'ping').toLowerCase();
  try {
    let result;
    if (action === 'ping') {
      result = { ok: true, app: 'TabAdminTEST', ts: new Date().toISOString() };
    } else if (action === 'getflujo') {
      result = getFlujo(e.parameter.periodo, e.parameter.filtro);
    } else if (action === 'getsaldosummary') {
      result = getSaldoSummary();
    } else if (action === 'getcontrapartes') {
      result = getContrapartes();
    } else {
      result = { ok: false, error: 'Acción no reconocida: ' + action };
    }
    return jsonp(e, result);
  } catch (err) {
    return jsonp(e, { ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = (body.action || '').toLowerCase();
    let result;
    if (action === 'addmovimiento') result = addMovimiento(body.data);
    else if (action === 'updatemovimiento') result = updateMovimiento(body.data);
    else if (action === 'markenbind') result = markEnBind(body.data);
    else if (action === 'marcarpagado') result = marcarPagado(body.data);
    else result = { ok: false, error: 'Acción no reconocida: ' + action };
    return json(result);
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// READERS
// ─────────────────────────────────────────────────────────────────────────────

function getFlujo(periodo, filtro) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const data = sh.getDataRange().getValues();
  const rows = [];
  const now = new Date();
  const startMes = new Date(now.getFullYear(), now.getMonth(), 1);

  for (let i = HEADER_ROW; i < data.length; i++) {
    const r = data[i];
    if (!r[COL.PROVEEDOR-1] && !r[COL.CONCEPTO-1]) continue; // skip blank
    const mov = {
      fecha: r[COL.FECHA-1] instanceof Date ? r[COL.FECHA-1].toISOString() : String(r[COL.FECHA-1] || ''),
      prov: r[COL.PROVEEDOR-1] || '',
      concepto: r[COL.CONCEPTO-1] || '',
      forma_pago: r[COL.FORMA_PAGO-1] || '',
      aplicado: r[COL.APLICADO-1] || '',
      factura: r[COL.FACTURA-1] || '',
      tipo: r[COL.TIPO-1] || '',
      categoria: r[COL.CATEGORIA-1] || '',
      subcategoria: r[COL.SUBCATEGORIA-1] || '',
      ingreso: Number(r[COL.INGRESO-1]) || 0,
      egreso: Number(r[COL.EGRESO-1]) || 0,
      total: Number(r[COL.TOTAL-1]) || 0,
      id: r[COL.ROW_ID-1] || '',
      estado: r[COL.ESTADO-1] || '',
      created_by: r[COL.CREATED_BY-1] || '',
      created_at: r[COL.CREATED_AT-1] instanceof Date ? r[COL.CREATED_AT-1].toISOString() : (r[COL.CREATED_AT-1] || ''),
      factura_at: r[COL.FACTURA_AT-1] instanceof Date ? r[COL.FACTURA_AT-1].toISOString() : (r[COL.FACTURA_AT-1] || ''),
      bind_at: r[COL.BIND_AT-1] instanceof Date ? r[COL.BIND_AT-1].toISOString() : (r[COL.BIND_AT-1] || ''),
      updated_by: r[COL.UPDATED_BY-1] || '',
      _row: i + 1 // referencia 1-indexed para updates
    };

    if (periodo === 'mes') {
      const f = new Date(mov.fecha);
      if (f < startMes) continue;
    }
    if (filtro === 'pendientes' && !['capturado', 'con-factura', 'sin-categoria'].includes(mov.estado)) continue;
    if (filtro === 'programados' && mov.estado !== 'programado') continue;

    rows.push(mov);
  }
  return { ok: true, movs: rows, count: rows.length };
}

function getSaldoSummary() {
  const flujo = getFlujo('all', 'todos');
  const movs = flujo.movs;
  const now = new Date();
  const startMes = new Date(now.getFullYear(), now.getMonth(), 1);
  const startMesAnt = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const endMesAnt = new Date(now.getFullYear(), now.getMonth(), 0);

  // Saldo bancario = el TOTAL más reciente con estado distinto a programado/sin-categoria
  let saldo = 0;
  for (let i = movs.length - 1; i >= 0; i--) {
    if (movs[i].estado !== 'programado' && movs[i].estado !== 'sin-categoria') {
      saldo = movs[i].total;
      break;
    }
  }

  const activos = movs.filter(m => m.estado !== 'programado' && m.estado !== 'sin-categoria');
  const mesActual = activos.filter(m => new Date(m.fecha) >= startMes);
  const mesAnt = activos.filter(m => new Date(m.fecha) >= startMesAnt && new Date(m.fecha) <= endMesAnt);

  const ingresoMes = sum(mesActual, 'ingreso');
  const egresoMes = sum(mesActual, 'egreso');
  const ingresoMesAnt = sum(mesAnt, 'ingreso');

  const catMap = {};
  mesActual.filter(m => m.egreso > 0).forEach(m => {
    const k = m.categoria || 'SIN CATEG';
    catMap[k] = (catMap[k] || 0) + m.egreso;
  });
  const topCats = Object.entries(catMap).sort((a,b) => b[1]-a[1]).slice(0, 5)
    .map(([cat, monto]) => ({ cat, monto }));

  const ultimos = activos.slice(-20).reverse().slice(0, 20).map(m => ({
    fecha: m.fecha, prov: m.prov, ingreso: m.ingreso, egreso: m.egreso, categoria: m.categoria
  }));

  return {
    ok: true,
    saldo_actual: saldo,
    ingresos_mes: ingresoMes,
    egresos_mes: egresoMes,
    utilidad: ingresoMes - egresoMes,
    cambio_ing_pct: ingresoMesAnt > 0 ? ((ingresoMes - ingresoMesAnt) / ingresoMesAnt * 100) : 0,
    top_categorias: topCats,
    ultimos: ultimos
  };
}

function getContrapartes() {
  const flujo = getFlujo('all', 'todos');
  const counts = {};
  flujo.movs.forEach(m => {
    if (!m.prov) return;
    const k = String(m.prov).trim().toUpperCase();
    counts[k] = (counts[k] || 0) + 1;
  });
  const list = Object.entries(counts).sort((a,b) => b[1]-a[1]).map(([prov, c]) => prov);
  return { ok: true, contrapartes: list };
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITERS
// ─────────────────────────────────────────────────────────────────────────────

function addMovimiento(data) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const lastRow = sh.getLastRow();
  const newRow = lastRow + 1;
  const id = data.id || uuid();
  const now = new Date();

  // Estado inicial: si trae estado='programado', no afecta saldo. Si no, capturado.
  const estado = data.estado || (data.categoria ? 'capturado' : 'sin-categoria');

  const fechaStr = data.fecha ? new Date(data.fecha) : now;
  const ingreso = Number(data.ingreso) || 0;
  const egreso = Number(data.egreso) || 0;

  // Calcular TOTAL: si es programado o sin-categoria, NO afecta saldo (mismo TOTAL anterior).
  // Si es capturado/con-factura/en-bind, suma/resta.
  const prevTotal = getLastValidTotal(sh, newRow);
  let total;
  if (estado === 'programado' || estado === 'sin-categoria') {
    total = prevTotal;
  } else {
    total = prevTotal + ingreso - egreso;
  }

  const row = [
    fechaStr,
    data.prov || '',
    data.concepto || '',
    data.forma_pago || '',
    data.aplicado || '',
    data.factura || (estado === 'programado' ? 'PEND' : 'PENDIENTE'),
    data.tipo || '',
    data.categoria || '',
    data.subcategoria || '',
    ingreso,
    egreso,
    total,
    id,
    estado,
    data.created_by || 'Web',
    now,
    null,
    null,
    data.created_by || 'Web'
  ];
  sh.getRange(newRow, 1, 1, row.length).setValues([row]);
  return { ok: true, id, row: newRow, total };
}

function updateMovimiento(data) {
  if (!data.row_id) return { ok: false, error: 'row_id requerido' };
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const found = findByRowId(sh, data.row_id);
  if (!found) return { ok: false, error: 'row_id no encontrado: ' + data.row_id };
  const { rowNum } = found;
  const now = new Date();

  const updates = [];
  function set(col, val) { updates.push({ col, val }); }

  if (data.factura !== undefined) { set(COL.FACTURA, data.factura); set(COL.FACTURA_AT, now); }
  if (data.aplicado !== undefined) set(COL.APLICADO, data.aplicado);
  if (data.categoria !== undefined) set(COL.CATEGORIA, data.categoria);
  if (data.subcategoria !== undefined) set(COL.SUBCATEGORIA, data.subcategoria);
  if (data.estado !== undefined) {
    set(COL.ESTADO, data.estado);
    if (data.estado === 'en-bind') set(COL.BIND_AT, now);
  }
  if (data.concepto !== undefined) set(COL.CONCEPTO, data.concepto);
  if (data.updated_by) set(COL.UPDATED_BY, data.updated_by);

  updates.forEach(u => sh.getRange(rowNum, u.col).setValue(u.val));
  // Si cambió el estado de programado a capturado, recalcular saldo desde esta fila.
  if (data.estado && data.estado !== 'programado' && data.estado !== 'sin-categoria') {
    recalcSaldoDesde(sh, rowNum);
  }
  return { ok: true, row: rowNum };
}

function markEnBind(data) {
  return updateMovimiento({ row_id: data.row_id, estado: 'en-bind', factura: data.factura, updated_by: data.userId || 'Martha' });
}

function marcarPagado(data) {
  // Convierte un programado en capturado. Opcionalmente ajusta monto y fecha.
  if (!data.row_id) return { ok: false, error: 'row_id requerido' };
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const found = findByRowId(sh, data.row_id);
  if (!found) return { ok: false, error: 'row_id no encontrado' };
  const { rowNum } = found;
  sh.getRange(rowNum, COL.ESTADO).setValue('capturado');
  sh.getRange(rowNum, COL.FECHA).setValue(data.fecha ? new Date(data.fecha) : new Date());
  if (data.monto !== undefined) {
    // Determinar si era ingreso o egreso
    const ing = Number(sh.getRange(rowNum, COL.INGRESO).getValue()) || 0;
    const egr = Number(sh.getRange(rowNum, COL.EGRESO).getValue()) || 0;
    if (ing > 0) sh.getRange(rowNum, COL.INGRESO).setValue(Number(data.monto));
    else if (egr > 0) sh.getRange(rowNum, COL.EGRESO).setValue(Number(data.monto));
  }
  sh.getRange(rowNum, COL.APLICADO).setValue('');
  sh.getRange(rowNum, COL.UPDATED_BY).setValue(data.userId || 'JC');
  recalcSaldoDesde(sh, rowNum);
  return { ok: true, row: rowNum };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function findByRowId(sh, rowId) {
  const data = sh.getRange(HEADER_ROW + 1, COL.ROW_ID, sh.getLastRow() - HEADER_ROW, 1).getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][0] === rowId) return { rowNum: i + HEADER_ROW + 1 };
  }
  return null;
}

function getLastValidTotal(sh, beforeRow) {
  // Busca el TOTAL más reciente de una fila con estado != programado/sin-categoria
  for (let r = beforeRow - 1; r > HEADER_ROW; r--) {
    const estado = sh.getRange(r, COL.ESTADO).getValue();
    if (estado === 'programado' || estado === 'sin-categoria') continue;
    const total = Number(sh.getRange(r, COL.TOTAL).getValue());
    if (!isNaN(total)) return total;
  }
  return 0;
}

function recalcSaldoDesde(sh, fromRow) {
  const lastRow = sh.getLastRow();
  let total = getLastValidTotal(sh, fromRow);
  for (let r = fromRow; r <= lastRow; r++) {
    const estado = sh.getRange(r, COL.ESTADO).getValue();
    if (estado === 'programado' || estado === 'sin-categoria') {
      sh.getRange(r, COL.TOTAL).setValue(total);
      continue;
    }
    const ing = Number(sh.getRange(r, COL.INGRESO).getValue()) || 0;
    const egr = Number(sh.getRange(r, COL.EGRESO).getValue()) || 0;
    total = total + ing - egr;
    sh.getRange(r, COL.TOTAL).setValue(total);
  }
}

function sum(arr, key) { return arr.reduce((s, x) => s + (Number(x[key]) || 0), 0); }

function uuid() {
  return 'm_' + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
}

function jsonp(e, obj) {
  const callback = e.parameter.callback;
  const body = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + body + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────────────────────
// MIGRACIÓN one-shot · correr 1 vez al inicializar columnas M-S desde el rojo
// ─────────────────────────────────────────────────────────────────────────────

function migrarColorRojo() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const lastRow = sh.getLastRow();
  const facturaRange = sh.getRange(HEADER_ROW + 1, COL.FACTURA, lastRow - HEADER_ROW, 1);
  const backgrounds = facturaRange.getBackgrounds();
  const values = facturaRange.getValues();
  const categorias = sh.getRange(HEADER_ROW + 1, COL.CATEGORIA, lastRow - HEADER_ROW, 1).getValues();

  let migradas = { 'en-bind': 0, 'con-factura': 0, 'capturado': 0, 'sin-categoria': 0 };
  for (let i = 0; i < values.length; i++) {
    const rowNum = i + HEADER_ROW + 1;
    const factura = String(values[i][0] || '').trim();
    const bg = backgrounds[i][0];
    const cat = String(categorias[i][0] || '').trim();
    const isRojo = bg && (bg.toLowerCase().includes('ff') && bg.toLowerCase() !== '#ffffff' && /ff[0-9a-f]{0,2}[0-9a-f]{2}[0-9a-f]{2}/i.test(bg));
    let estado;
    if (!cat) estado = 'sin-categoria';
    else if (isRojo) estado = 'en-bind';
    else if (factura && factura.toUpperCase() !== 'PENDIENTE' && factura.toUpperCase() !== 'PEND') estado = 'con-factura';
    else estado = 'capturado';
    sh.getRange(rowNum, COL.ESTADO).setValue(estado);
    sh.getRange(rowNum, COL.ROW_ID).setValue(uuid());
    migradas[estado]++;
  }
  Logger.log('Migración completa: ' + JSON.stringify(migradas));
  return migradas;
}

function inicializarHeaders() {
  // Agregar headers M-S si no existen. Correr 1 vez antes de migrarColorRojo.
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const headers = ['row_id', 'estado', 'created_by', 'created_at', 'factura_at', 'bind_at', 'updated_by'];
  sh.getRange(HEADER_ROW, COL.ROW_ID, 1, headers.length).setValues([headers]);
  Logger.log('Headers M-S agregados');
}
