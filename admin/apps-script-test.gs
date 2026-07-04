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
    } else if (action === 'getcxp') {
      result = getCxP();
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
    else if (action === 'reordenarbloqueados') result = reordenarBloqueados();
    else if (action === 'importarcxp') result = importarCxPBatch(body.data);
    else if (action === 'borrarcxp') result = borrarCxP(body.data);
    else if (action === 'borrartodoscxp') result = borrarTodosCxP();
    else if (action === 'updatecxp') result = updateCxP(body.data);
    else if (action === 'pagarcxp') result = pagarCxP(body.data);
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
  const id = data.id || uuid();
  const now = new Date();

  // Estado inicial: si trae estado='programado', no afecta saldo. Si no, capturado.
  const estado = data.estado || (data.categoria ? 'capturado' : 'sin-categoria');
  const esBloqueado = (estado === 'bloqueado');

  const fechaStr = data.fecha ? new Date(data.fecha) : now;
  const ingreso = Number(data.ingreso) || 0;
  const egreso = Number(data.egreso) || 0;

  // Posición de inserción: los BLOQ SIEMPRE viven al final de la hoja.
  //  - Bloqueado nuevo      → append al final (zona BLOQ).
  //  - Movimiento con fecha → se inserta ANTES del primer BLOQ, para que la
  //    zona de bloqueados quede siempre hasta abajo del registro.
  const firstBloq = esBloqueado ? 0 : findFirstBloqueadoRow(sh);
  let newRow;
  if (firstBloq > 0) {
    sh.insertRowBefore(firstBloq);
    newRow = firstBloq;
  } else {
    newRow = lastRow + 1;
  }

  // Estados que NO afectan saldo (programado, sin-categoria, por-pagar, bloqueado).
  // Los bloqueados NO tienen fecha real → col A = "BLOQ".
  const estadosNoAfectan = ['programado', 'sin-categoria', 'por-pagar', 'bloqueado'];
  const prevTotal = getLastValidTotal(sh, newRow);
  const total = estadosNoAfectan.indexOf(estado) >= 0 ? prevTotal : prevTotal + ingreso - egreso;
  const fechaCol = esBloqueado ? 'BLOQ' : fechaStr;

  const row = [
    fechaCol,
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

  // Si insertamos un movimiento con fecha ARRIBA de la zona BLOQ, el saldo
  // cambió → los BLOQ de abajo muestran total = saldo, hay que refrescarlos.
  if (firstBloq > 0 && estadosNoAfectan.indexOf(estado) < 0) {
    actualizarTotalBloqueados(sh, total);
  }
  return { ok: true, id, row: newRow, total };
}

// Primera fila de datos (>= HEADER_ROW+1) cuyo ESTADO es 'bloqueado'. 0 si no hay.
function findFirstBloqueadoRow(sh) {
  const last = sh.getLastRow();
  if (last <= HEADER_ROW) return 0;
  const estados = sh.getRange(HEADER_ROW + 1, COL.ESTADO, last - HEADER_ROW, 1).getValues();
  for (let i = 0; i < estados.length; i++) {
    if (String(estados[i][0]).trim() === 'bloqueado') return HEADER_ROW + 1 + i;
  }
  return 0;
}

// Los BLOQ no afectan el saldo → su col TOTAL debe mostrar el saldo vigente.
function actualizarTotalBloqueados(sh, nuevoSaldo) {
  const last = sh.getLastRow();
  if (last <= HEADER_ROW) return;
  const estados = sh.getRange(HEADER_ROW + 1, COL.ESTADO, last - HEADER_ROW, 1).getValues();
  for (let i = 0; i < estados.length; i++) {
    if (String(estados[i][0]).trim() === 'bloqueado') {
      sh.getRange(HEADER_ROW + 1 + i, COL.TOTAL).setValue(nuevoSaldo);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reordenar: mueve TODOS los BLOQ existentes al final de la hoja (one-shot).
// Primero las filas con fecha (en su orden actual), al final los BLOQ.
// Preserva los totales de las filas con fecha (NO recalcula → el saldo no cambia);
// a los BLOQ les asigna el saldo final. Respalda la hoja antes de tocar nada.
// ─────────────────────────────────────────────────────────────────────────────
function reordenarBloqueados() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME);
  const last = sh.getLastRow();
  if (last <= HEADER_ROW) return { ok: true, conFecha: 0, bloqueados: 0, nota: 'hoja vacía' };

  const nCols = sh.getLastColumn();
  const data = sh.getRange(HEADER_ROW + 1, 1, last - HEADER_ROW, nCols).getValues();
  const cEstado = COL.ESTADO - 1, cTotal = COL.TOTAL - 1;

  const conFecha = [], bloqueados = [];
  data.forEach(function (r) {
    (String(r[cEstado]).trim() === 'bloqueado' ? bloqueados : conFecha).push(r);
  });

  if (bloqueados.length === 0) return { ok: true, conFecha: conFecha.length, bloqueados: 0, nota: 'sin BLOQ que mover' };

  // Backup ANTES de reescribir.
  const tz = ss.getSpreadsheetTimeZone() || 'America/Monterrey';
  const stamp = Utilities.formatDate(now_(), tz, 'yyyyMMdd_HHmmss');
  sh.copyTo(ss).setName('FLUJO_backup_' + stamp);

  // Saldo final = último TOTAL numérico de las filas con fecha que afectan saldo.
  let saldoFinal = 0;
  for (let i = conFecha.length - 1; i >= 0; i--) {
    const est = String(conFecha[i][cEstado]).trim();
    const t = Number(conFecha[i][cTotal]);
    if (!isNaN(t) && est !== 'programado' && est !== 'sin-categoria' && est !== 'por-pagar') { saldoFinal = t; break; }
  }
  bloqueados.forEach(function (r) { r[cTotal] = saldoFinal; });

  const nuevo = conFecha.concat(bloqueados);
  sh.getRange(HEADER_ROW + 1, 1, nuevo.length, nCols).setValues(nuevo);

  return { ok: true, conFecha: conFecha.length, bloqueados: bloqueados.length, saldoFinal, backup: 'FLUJO_backup_' + stamp };
}

function now_() { return new Date(); }

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
  // Fecha y montos: importantes para bloqueado→asentado (fecha real ≠ 'BLOQ')
  // y para ajustes de monto al pagar programados.
  if (data.fecha !== undefined) set(COL.FECHA, new Date(data.fecha));
  if (data.egreso !== undefined && data.egreso !== null) set(COL.EGRESO, Number(data.egreso));
  if (data.ingreso !== undefined && data.ingreso !== null) set(COL.INGRESO, Number(data.ingreso));

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
  const estadosNoAfectan = ['programado', 'sin-categoria', 'por-pagar', 'bloqueado'];
  let total = getLastValidTotal(sh, fromRow);
  for (let r = fromRow; r <= lastRow; r++) {
    const estado = sh.getRange(r, COL.ESTADO).getValue();
    if (estadosNoAfectan.indexOf(estado) >= 0) {
      sh.getRange(r, COL.TOTAL).setValue(total);
      continue;
    }
    const ing = Number(sh.getRange(r, COL.INGRESO).getValue()) || 0;
    const egr = Number(sh.getRange(r, COL.EGRESO).getValue()) || 0;
    total = total + ing - egr;
    sh.getRange(r, COL.TOTAL).setValue(total);
  }
}

// Recalcula toda la columna L (saldo running) desde la primera fila.
// Correr desde el editor DESPUÉS de reordenar filas manualmente en el Sheet.
function recalcTodo() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  recalcSaldoDesde(sh, HEADER_ROW + 1);
  Logger.log('✓ Saldo running recalculado desde fila ' + (HEADER_ROW + 1) + ' hasta ' + sh.getLastRow());
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

// Mueve las fechas de los programados de Georgina Martinez Antonio y Josue
// Arturo Ramirez Moreno (más nóminas si se agregan más adelante) al viernes
// de la misma semana ISO. Los pagos a estos proveedores se hacen los viernes.
function moverAViernes() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const lastRow = sh.getLastRow();
  const targets = ['GEORGINA MARTINEZ ANTONIO', 'JOSUE ARTURO RAMIREZ MORENO',
                   'AYUDANTE PRODUCCION', 'CHOFER', 'ASISTENTE ADMIN', 'VENTAS JC'];
  let ajustados = 0;
  for (let r = HEADER_ROW + 1; r <= lastRow; r++) {
    const prov = String(sh.getRange(r, COL.PROVEEDOR).getValue() || '').trim().toUpperCase();
    const estado = sh.getRange(r, COL.ESTADO).getValue();
    if (estado !== 'programado') continue;
    if (!targets.some(t => prov.indexOf(t) >= 0)) continue;
    const fecha = sh.getRange(r, COL.FECHA).getValue();
    if (!(fecha instanceof Date)) continue;
    const viernes = viernesDeLaSemanaISO(fecha);
    if (viernes.getTime() === fecha.getTime()) continue; // ya es viernes
    sh.getRange(r, COL.FECHA).setValue(viernes);
    sh.getRange(r, COL.UPDATED_BY).setValue('Ajuste viernes');
    ajustados++;
  }
  Logger.log('Fechas movidas al viernes: ' + ajustados + ' movimientos');
}

// Retorna el viernes de la misma semana ISO (lunes = día 1, viernes = día 5).
// Ejemplo: jueves 2-jul-2026 → viernes 3-jul-2026.
// Ejemplo: domingo 19-jul-2026 → viernes 17-jul-2026 (viernes anterior en la misma semana ISO).
function viernesDeLaSemanaISO(fecha) {
  const d = new Date(fecha);
  const dayOfWeek = d.getDay(); // 0=dom, 1=lun, ..., 5=vie, 6=sáb
  // ISO: la semana empieza lunes. Ajustar para que domingo sea 7.
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
  const offset = 5 - isoDay; // 5 = viernes en ISO
  const viernes = new Date(d);
  viernes.setDate(d.getDate() + offset);
  return viernes;
}

// Recalcula la columna L (saldo running) desde una row específica hacia el final,
// respetando los 4 estados que no afectan saldo. Útil si se editaron manualmente
// filas o si cambiaron estados de un grupo de movimientos.
function recalcularSaldoDesde() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const desdeRow = 1450; // ajustar si necesitas empezar en otra fila
  recalcSaldoDesde(sh, desdeRow);
  Logger.log('Saldo recalculado desde row ' + desdeRow + ' hasta ' + sh.getLastRow());
}

// Cierre masivo: marca como 'en-bind' todos los movimientos con estado
// 'con-factura' o 'capturado' cuya fecha sea ANTERIOR al cutoff.
// Uso: arrancar limpio con julio (los históricos ya se registraron
// en Bind hace tiempo, la migración del color rojo solo los perdió).
function cerrarHistoricoEnBind() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const cutoff = new Date(2026, 6, 1); // 1-jul-2026 (mes 6 = julio en JS)
  const lastRow = sh.getLastRow();
  const data = sh.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, COL.UPDATED_BY).getValues();
  const now = new Date();
  let cerrados = 0;
  for (let i = 0; i < data.length; i++) {
    const rowNum = i + HEADER_ROW + 1;
    const fecha = data[i][COL.FECHA - 1];
    const estado = data[i][COL.ESTADO - 1];
    if (!(fecha instanceof Date)) continue; // BLOQ o texto → skip
    if (fecha >= cutoff) continue;
    if (estado !== 'con-factura' && estado !== 'capturado') continue;
    sh.getRange(rowNum, COL.ESTADO).setValue('en-bind');
    sh.getRange(rowNum, COL.BIND_AT).setValue(now);
    sh.getRange(rowNum, COL.UPDATED_BY).setValue('Cierre masivo');
    cerrados++;
  }
  Logger.log('Cierre masivo · ' + cerrados + ' movimientos anteriores al 1-jul-2026 marcados como en-bind');
}

function inicializarHeaders() {
  // Agregar headers M-S si no existen. Correr 1 vez antes de migrarColorRojo.
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  const headers = ['row_id', 'estado', 'created_by', 'created_at', 'factura_at', 'bind_at', 'updated_by'];
  sh.getRange(HEADER_ROW, COL.ROW_ID, 1, headers.length).setValues([headers]);
  Logger.log('Headers M-S agregados');
}

// ─────────────────────────────────────────────────────────────────────────────
// CxP BIND · Hoja "_cxp_bind" para cuentas por pagar (persistente, sin duplicados)
// ─────────────────────────────────────────────────────────────────────────────

const CXP_SHEET = '_cxp_bind';
const CXP_HEADERS = ['bind_folio', 'prov', 'concepto', 'fecha', 'monto', 'forma_pago',
                     'categoria', 'subcategoria', 'tipo', 'row_id', 'created_at',
                     'last_imported', 'updated_by'];
const CXP = {
  BIND_FOLIO: 1, PROV: 2, CONCEPTO: 3, FECHA: 4, MONTO: 5, FORMA_PAGO: 6,
  CATEGORIA: 7, SUBCATEGORIA: 8, TIPO: 9, ROW_ID: 10, CREATED_AT: 11,
  LAST_IMPORTED: 12, UPDATED_BY: 13
};

// Crea la hoja _cxp_bind con headers si no existe. Correr 1 vez (idempotente).
function crearHojaCxP() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CXP_SHEET);
  if (!sh) {
    sh = ss.insertSheet(CXP_SHEET);
    sh.getRange(1, 1, 1, CXP_HEADERS.length).setValues([CXP_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    Logger.log('Hoja _cxp_bind creada con headers');
  } else {
    Logger.log('Hoja _cxp_bind ya existe');
  }
  return sh;
}

function getCxP() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CXP_SHEET);
  if (!sh) return { ok: true, movs: [] }; // hoja no existe aún
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, movs: [] };
  const data = sh.getRange(2, 1, lastRow - 1, CXP_HEADERS.length).getValues();
  const movs = data.filter(r => r[CXP.ROW_ID - 1]).map(r => ({
    bind_folio: String(r[CXP.BIND_FOLIO - 1] || ''),
    prov: String(r[CXP.PROV - 1] || ''),
    concepto: String(r[CXP.CONCEPTO - 1] || ''),
    fecha: r[CXP.FECHA - 1] instanceof Date ? r[CXP.FECHA - 1].toISOString() : String(r[CXP.FECHA - 1] || ''),
    monto: Number(r[CXP.MONTO - 1]) || 0,
    forma_pago: String(r[CXP.FORMA_PAGO - 1] || 'TRANSFERENCIA'),
    categoria: String(r[CXP.CATEGORIA - 1] || 'PRODUCTO'),
    subcategoria: String(r[CXP.SUBCATEGORIA - 1] || 'PRODUCTO'),
    tipo: String(r[CXP.TIPO - 1] || 'COMPRA'),
    id: String(r[CXP.ROW_ID - 1] || ''),
    created_at: r[CXP.CREATED_AT - 1] instanceof Date ? r[CXP.CREATED_AT - 1].toISOString() : '',
    last_imported: r[CXP.LAST_IMPORTED - 1] instanceof Date ? r[CXP.LAST_IMPORTED - 1].toISOString() : '',
    updated_by: String(r[CXP.UPDATED_BY - 1] || '')
  }));
  return { ok: true, movs: movs, count: movs.length };
}

// Importa/actualiza CxP masivo. Dedup por bind_folio: existe = UPDATE, no existe = INSERT.
// data = { items: [{bind_folio, prov, concepto, fecha, monto, ...}, ...] }
function importarCxPBatch(data) {
  const items = data.items || [];
  const sh = crearHojaCxP(); // asegura que existe
  const now = new Date();
  const lastRow = sh.getLastRow();

  // Índice existente: bind_folio → rowNum
  const existentes = {};
  if (lastRow >= 2) {
    const folios = sh.getRange(2, CXP.BIND_FOLIO, lastRow - 1, 1).getValues();
    for (let i = 0; i < folios.length; i++) {
      const f = String(folios[i][0] || '').trim();
      if (f) existentes[f] = i + 2; // rowNum absoluto
    }
  }

  let inserts = 0, updates = 0, skipped = 0;
  items.forEach(it => {
    const folio = String(it.bind_folio || '').trim();
    if (!folio) { skipped++; return; }
    const fecha = it.fecha ? new Date(it.fecha) : now;
    const row = [
      folio,
      String(it.prov || '').toUpperCase(),
      it.concepto || '',
      fecha,
      Number(it.monto) || 0,
      it.forma_pago || 'TRANSFERENCIA',
      it.categoria || 'PRODUCTO',
      it.subcategoria || 'PRODUCTO',
      it.tipo || 'COMPRA',
      it.id || 'cxp_' + Utilities.getUuid().replace(/-/g,'').slice(0,16),
      now, // created_at (se sobreescribe si es update)
      now, // last_imported
      it.updated_by || 'Import'
    ];
    if (existentes[folio]) {
      // UPDATE: mantener created_at original
      const rowNum = existentes[folio];
      const created_orig = sh.getRange(rowNum, CXP.CREATED_AT).getValue();
      const row_id_orig = sh.getRange(rowNum, CXP.ROW_ID).getValue();
      row[CXP.CREATED_AT - 1] = created_orig || now;
      row[CXP.ROW_ID - 1] = row_id_orig || row[CXP.ROW_ID - 1];
      sh.getRange(rowNum, 1, 1, CXP_HEADERS.length).setValues([row]);
      updates++;
    } else {
      // INSERT
      sh.appendRow(row);
      inserts++;
    }
  });

  return { ok: true, inserts, updates, skipped, total: inserts + updates };
}

function borrarCxP(data) {
  if (!data.row_id) return { ok: false, error: 'row_id requerido' };
  const sh = SpreadsheetApp.getActive().getSheetByName(CXP_SHEET);
  if (!sh) return { ok: false, error: 'Hoja _cxp_bind no existe' };
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'Sin CxP' };
  const ids = sh.getRange(2, CXP.ROW_ID, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(data.row_id)) {
      sh.deleteRow(i + 2);
      return { ok: true, row: i + 2 };
    }
  }
  return { ok: false, error: 'row_id no encontrado' };
}

function borrarTodosCxP() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CXP_SHEET);
  if (!sh) return { ok: true, count: 0 };
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, count: 0 };
  const rangoBorrar = lastRow - 1;
  sh.getRange(2, 1, rangoBorrar, CXP_HEADERS.length).clearContent();
  return { ok: true, count: rangoBorrar };
}

function updateCxP(data) {
  if (!data.row_id) return { ok: false, error: 'row_id requerido' };
  const sh = SpreadsheetApp.getActive().getSheetByName(CXP_SHEET);
  if (!sh) return { ok: false, error: 'Hoja _cxp_bind no existe' };
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'Sin CxP' };
  const ids = sh.getRange(2, CXP.ROW_ID, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(data.row_id)) {
      const rowNum = i + 2;
      if (data.fecha !== undefined) sh.getRange(rowNum, CXP.FECHA).setValue(new Date(data.fecha));
      if (data.monto !== undefined) sh.getRange(rowNum, CXP.MONTO).setValue(Number(data.monto));
      if (data.concepto !== undefined) sh.getRange(rowNum, CXP.CONCEPTO).setValue(data.concepto);
      if (data.prov !== undefined) sh.getRange(rowNum, CXP.PROV).setValue(String(data.prov).toUpperCase());
      if (data.categoria !== undefined) sh.getRange(rowNum, CXP.CATEGORIA).setValue(data.categoria);
      if (data.subcategoria !== undefined) sh.getRange(rowNum, CXP.SUBCATEGORIA).setValue(data.subcategoria);
      sh.getRange(rowNum, CXP.UPDATED_BY).setValue(data.updated_by || 'Web');
      return { ok: true, row: rowNum };
    }
  }
  return { ok: false, error: 'row_id no encontrado' };
}

// Pagar CxP: borra de _cxp_bind y agrega movimiento REAL a FLUJO_2026.
// data = { row_id, fecha, monto, forma_pago, factura, categoria, subcategoria, estado }
function pagarCxP(data) {
  if (!data.row_id) return { ok: false, error: 'row_id requerido' };
  const sh = SpreadsheetApp.getActive().getSheetByName(CXP_SHEET);
  if (!sh) return { ok: false, error: 'Hoja _cxp_bind no existe' };
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'Sin CxP' };
  const ids = sh.getRange(2, CXP.ROW_ID, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(data.row_id)) {
      const rowNum = i + 2;
      const cxpData = sh.getRange(rowNum, 1, 1, CXP_HEADERS.length).getValues()[0];
      // Insertar en FLUJO_2026 como movimiento real
      const addRes = addMovimiento({
        fecha: data.fecha || new Date(),
        prov: data.prov || cxpData[CXP.PROV - 1],
        concepto: data.concepto || cxpData[CXP.CONCEPTO - 1],
        forma_pago: data.forma_pago || cxpData[CXP.FORMA_PAGO - 1],
        aplicado: '',
        factura: data.factura || 'PENDIENTE',
        tipo: cxpData[CXP.TIPO - 1] || 'COMPRA',
        categoria: data.categoria || cxpData[CXP.CATEGORIA - 1],
        subcategoria: data.subcategoria || cxpData[CXP.SUBCATEGORIA - 1],
        ingreso: 0,
        egreso: Number(data.monto) || Number(cxpData[CXP.MONTO - 1]) || 0,
        estado: data.estado || 'capturado',
        created_by: data.created_by || 'CxP Bind',
        id: cxpData[CXP.ROW_ID - 1] // reusa el mismo UUID para trazabilidad
      });
      // Borrar de _cxp_bind
      sh.deleteRow(rowNum);
      return { ok: true, addedToFlujo: addRes, deletedRow: rowNum };
    }
  }
  return { ok: false, error: 'row_id no encontrado' };
}
