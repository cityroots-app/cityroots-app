// Mock data para sandbox del Tab Administración
// 30 movimientos sintéticos con todos los estados representados.
// Reemplazar con respuestas del Apps Script TEST cuando esté deployado.

const TEST_SHEET_URL = ''; // Pegar aquí la URL del Apps Script TEST cuando se deploye

// Saldo bancario al cierre del 22-jun-2026 — último registro real del flujo HADE
const SALDO_INICIAL = 268531.69;

// Categorías del Estado de Resultados (extraídas del flujo real 2026)
// El usuario solo desglosa subcategoría cuando categoría = GASTO FIJO
const CATEGORIAS = {
  INGRESO: ['INGRESO'],
  EGRESO: [
    'PRODUCTO',          // Compras de inventario para vender
    'CONSUMIBLES',       // Contenedores, semillas, etiquetas
    'NOMINA',            // Operativos (ayudante, chofer, Martha)
    'NOMINA DIRECTOR',   // Bolsa $60k/mes JC
    'GASTO FIJO',        // Renta, servicios, suscripciones (subcategoría manual)
    'EXTRAS',
    'ENVIOS',            // Pakmail, fletes, paquetería
    'TRASLADOS',         // Uber, gasolina ruta
    'ADMINISTRACION',
    'OFICINA',
    'CAJA CHICA',
    'GASOLINA',
    'VEHICULO',
    'REPARACIONES',
    'SERVICIOS',
    'PRESTACIONES',
    'CREDITO',
    'INVERSION',
    'PRESTAMO',
    'MARKETING'
  ]
};

// Sub-categorías típicas cuando categoría = GASTO FIJO (basadas en histórico)
const SUBCATEGORIAS_GASTO_FIJO = [
  'RENTA', 'INTERNET', 'CELULARES', 'LUZ', 'GAS', 'AGUA',
  'CONTADOR', 'SOFTWARE', 'LICENCIAS', 'SEGUROS', 'OTROS'
];

const FORMAS_PAGO = ['TRANSFERENCIA', 'TARJETA', 'EFECTIVO'];

const TIPOS_EGRESO = ['GASTO', 'GASTO ND', 'COMPRA'];

const DOCUMENTOS = ['FACTURA', 'NO APLICA', 'PENDIENTE'];

const REGISTRADO_POR = ['Director', 'Admin'];

// Top proveedores / clientes para autocomplete
const CONTRAPARTES = [
  // Clientes (ingresos)
  'ENSO HOSPITALITY RYOSHI', 'ENSO HOSPITALITY AMATERASU', 'ENSO HOSPITALITY ICHIKANI',
  'ENSO HOSPITALITY HOTARU', 'INMOBILIARIA HOTELERA (HOTEL PRESIDENTE)',
  'RESTAURANTE CANTARITOS', 'MAXIMA DISTINCION MAR DEL ZUR', 'CHAPULIN',
  'RESTAURANT Y ESPECIALIDADES ATRIPK CARA DE VACA', 'GRUPO PRESIDENTE',
  // Proveedores producto
  'ORGANICO MX', 'GEORGANICA', 'COSTCO', 'BODEGA 72', 'ABASTECEDORA GRILL',
  'FUNGO', 'HEB', 'MICROFARMS', 'DISTRIBUIDORA SAN JOSE', 'ABARROTES SAN JOSE',
  // Consumibles
  'PLASTIPRODUCTOS', 'TRUELEAF MARKET', 'UNBOXING', 'AGRODAK', 'RICKOS',
  // Logística
  'PAKMAIL', 'OXXOGAS', 'UBER',
  // Servicios
  'CFE', 'IZZI', 'TELCEL', 'CLAUDE IA', 'GOOGLE CLOUD',
  // Nómina
  'AYUDANTE PRODUCCION', 'CHOFER', 'ASISTENTE ADMIN', 'NOMINA DIRECTOR', 'VENTAS',
  // Otros
  'JUVENTINO GARZA', 'EDENRED', 'BANREGIO', 'AMAZON', 'HOME DEPOT', 'CAJA CHICA',
  'JCGP'
];

// Generador de UUIDs simples
function uuid() { return 'm_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36); }

// Helper fecha
function d(dateStr) { return new Date(dateStr + 'T12:00:00').toISOString(); }

// 30 movimientos de muestra (últimos 2 meses + algunos programados del mes en curso)
// === DATOS REALES del flujo HADE post-cierre 22-jun-2026 ===
// Saldo final histórico: $268,531.69 (fila 1369 del master).
// Todo lo siguiente son movimientos del 23-jun en adelante que están pendientes de procesar.
const MOCK_MOVIMIENTOS = [
  // Orden del Sheet master (fila 1364→1369). Más antiguo arriba, más reciente abajo.
  // Los "últimos 3 capturados" en el demo serán las 3 últimas entradas: BODEGA 72, CARA DE VACA, ASISTENTE ADMIN.
  // Todos marcados historico:true para que NO afecten el saldo (ya están incluidos en SALDO_INICIAL).

  { id: uuid(), fecha: d('2026-06-23'), prov: 'COSTCO', concepto: 'PRODUCTO', forma_pago: 'TARJETA', aplicado: '', factura: 'PENDIENTE', tipo: 'COMPRA', categoria: 'PRODUCTO', subcategoria: 'PRODUCTO', ingreso: 0, egreso: 139, estado: 'capturado', historico: true, created_by: 'JC', created_at: '2026-06-23T10:00:00Z', factura_at: null, bind_at: null, updated_by: 'JC' },
  { id: uuid(), fecha: d('2026-06-23'), prov: 'MICROSOFT', concepto: 'PROGRAMAS', forma_pago: 'TARJETA', aplicado: '', factura: 'PENDIENTE', tipo: 'GASTO', categoria: 'ADMINISTRACION', subcategoria: 'ADMINISTRACION', ingreso: 0, egreso: 224.99, estado: 'capturado', historico: true, created_by: 'JC', created_at: '2026-06-23T10:01:00Z', factura_at: null, bind_at: null, updated_by: 'JC' },
  { id: uuid(), fecha: d('2026-06-23'), prov: 'AMAZON', concepto: 'GASTO JC', forma_pago: 'TARJETA', aplicado: '', factura: 'NA', tipo: 'GASTO', categoria: 'NOMINA DIRECTOR', subcategoria: 'NOMINA DIRECTOR', ingreso: 0, egreso: 290.28, estado: 'con-factura', historico: true, created_by: 'JC', created_at: '2026-06-23T10:02:00Z', factura_at: d('2026-06-23'), bind_at: null, updated_by: 'JC' },
  { id: uuid(), fecha: d('2026-06-23'), prov: 'AMAZON', concepto: 'GASTO JC', forma_pago: 'TARJETA', aplicado: '', factura: 'NA', tipo: 'GASTO', categoria: 'NOMINA DIRECTOR', subcategoria: 'NOMINA DIRECTOR', ingreso: 0, egreso: 331.88, estado: 'con-factura', historico: true, created_by: 'JC', created_at: '2026-06-23T10:03:00Z', factura_at: d('2026-06-23'), bind_at: null, updated_by: 'JC' },
  // Últimos 3 registros del Sheet master (filas 1367, 1368, 1369):
  // 1367 BODEGA 72 (23-jun · ELOTE BABY · -$1,800 · PENDIENTE)
  { id: uuid(), fecha: d('2026-06-23'), prov: 'BODEGA 72', concepto: 'ELOTE BABY', forma_pago: 'TARJETA', aplicado: '', factura: 'PENDIENTE', tipo: 'COMPRA', categoria: 'PRODUCTO', subcategoria: 'PRODUCTO', ingreso: 0, egreso: 1800, estado: 'capturado', historico: true, created_by: 'JC', created_at: '2026-06-23T15:00:00Z', factura_at: null, bind_at: null, updated_by: 'JC' },
  // 1368 CARA DE VACA (23-jun · PAGO FACTURAS · +$488.81 · factura 3236)
  { id: uuid(), fecha: d('2026-06-23'), prov: 'CARA DE VACA', concepto: 'PAGO FACTURAS', forma_pago: 'TRANSFERENCIA', aplicado: '', factura: '3236', tipo: 'INGRESO', categoria: 'INGRESO', subcategoria: 'INGRESO', ingreso: 488.81, egreso: 0, estado: 'con-factura', historico: true, created_by: 'JC', created_at: '2026-06-23T16:00:00Z', factura_at: d('2026-06-23'), bind_at: null, updated_by: 'JC' },
  // 1369 ASISTENTE ADMIN (22-jun · SEMANA 2625 · -$2,500 · NA) — última fila del master
  { id: uuid(), fecha: d('2026-06-22'), prov: 'ASISTENTE ADMIN', concepto: 'SEMANA 2625', forma_pago: 'TRANSFERENCIA', aplicado: '', factura: 'NA', tipo: 'GASTO', categoria: 'NOMINA', subcategoria: 'NOMINA', ingreso: 0, egreso: 2500, estado: 'con-factura', historico: true, created_by: 'JC', created_at: '2026-06-23T17:00:00Z', factura_at: d('2026-06-23'), bind_at: null, updated_by: 'JC' },

  // === PROGRAMADO julio 2026 (reglas confirmadas por JC 29-jun) ===
  // SEMANALES — todos los viernes del mes
  ...generarSemanales(['2026-07-03','2026-07-10','2026-07-17','2026-07-24','2026-07-31']),

  // MENSUALES — fechas específicas por proveedor
  // Renta Juventino: primeros 5 días → viernes 3 jul
  { id: uuid(), fecha: d('2026-07-03'), prov: 'JUVENTINO GARZA', concepto: 'Renta bodega julio', forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'GASTO', categoria: 'GASTO FIJO', subcategoria: 'RENTA', ingreso: 0, egreso: 16000, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // Edenred: primeros 5 días → viernes 3 jul
  { id: uuid(), fecha: d('2026-07-03'), prov: 'EDENRED', concepto: 'Vales gasolina JC julio', forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'GASTO', categoria: 'NOMINA DIRECTOR', subcategoria: 'GASOLINA', ingreso: 0, egreso: 4800, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // Unboxing: 2da semana del mes (semillas pedidas día 28 anterior)
  { id: uuid(), fecha: d('2026-07-10'), prov: 'UNBOXING', concepto: 'Envío semillas TrueLeaf', forma_pago: 'TARJETA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'GASTO', categoria: 'ENVIOS', subcategoria: 'ENVIOS', ingreso: 0, egreso: 830, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // Agua mensual: día 15
  { id: uuid(), fecha: d('2026-07-15'), prov: 'AGUA', concepto: 'Servicio agua bodega julio', forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'GASTO', categoria: 'GASTO FIJO', subcategoria: 'AGUA', ingreso: 0, egreso: 400, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // IZZI: día 20
  { id: uuid(), fecha: d('2026-07-20'), prov: 'IZZI', concepto: 'Internet bodega', forma_pago: 'TARJETA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'GASTO', categoria: 'GASTO FIJO', subcategoria: 'INTERNET', ingreso: 0, egreso: 720, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // Telcel: día 20
  { id: uuid(), fecha: d('2026-07-20'), prov: 'TELCEL', concepto: 'Celulares plan', forma_pago: 'TARJETA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'GASTO', categoria: 'GASTO FIJO', subcategoria: 'CELULARES', ingreso: 0, egreso: 500, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // Pakmail: día 25
  { id: uuid(), fecha: d('2026-07-25'), prov: 'PAKMAIL', concepto: 'Flete consolidado Georgánica', forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'GASTO', categoria: 'ENVIOS', subcategoria: 'ENVIOS', ingreso: 0, egreso: 2500, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // Claude IA: día 27 (basado en histórico)
  { id: uuid(), fecha: d('2026-07-27'), prov: 'CLAUDE IA', concepto: 'Suscripción mensual', forma_pago: 'TARJETA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'GASTO', categoria: 'OFICINA', subcategoria: 'OFICINA', ingreso: 0, egreso: 1000, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // Plastiproductos: día 28
  { id: uuid(), fecha: d('2026-07-28'), prov: 'PLASTIPRODUCTOS', concepto: 'Contenedores mes', forma_pago: 'TARJETA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'COMPRA', categoria: 'CONSUMIBLES', subcategoria: 'CONSUMIBLES', ingreso: 0, egreso: 7200, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // True Leaf Market: día 28
  { id: uuid(), fecha: d('2026-07-28'), prov: 'TRUELEAF MARKET', concepto: 'Semillas microgreens', forma_pago: 'TARJETA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'COMPRA', categoria: 'CONSUMIBLES', subcategoria: 'CONSUMIBLES', ingreso: 0, egreso: 3400, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
  // Agrodak: día 28
  { id: uuid(), fecha: d('2026-07-28'), prov: 'AGRODAK', concepto: 'Peatmoss sustrato', forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'PEND', tipo: 'COMPRA', categoria: 'CONSUMIBLES', subcategoria: 'CONSUMIBLES', ingreso: 0, egreso: 1800, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' },
];

// Helper: genera nóminas semanales + compras viernes + presupuestos para cada viernes del mes
function generarSemanales(viernes){
  const items = [];
  viernes.forEach((dia, idx)=>{
    const semana = idx + 27; // empezando en sem 27
    // Nóminas
    items.push({ id: uuid(), fecha: d(dia), prov: 'AYUDANTE PRODUCCION', concepto: `Nómina semana ${semana}`, forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'NA', tipo: 'GASTO', categoria: 'NOMINA', subcategoria: 'NOMINA', ingreso: 0, egreso: 3000, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' });
    items.push({ id: uuid(), fecha: d(dia), prov: 'CHOFER', concepto: `Nómina semana ${semana}`, forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'NA', tipo: 'GASTO', categoria: 'NOMINA', subcategoria: 'NOMINA', ingreso: 0, egreso: 3000, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' });
    items.push({ id: uuid(), fecha: d(dia), prov: 'ASISTENTE ADMIN', concepto: `Nómina semana ${semana}`, forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'NA', tipo: 'GASTO', categoria: 'NOMINA', subcategoria: 'NOMINA', ingreso: 0, egreso: 2500, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' });
    items.push({ id: uuid(), fecha: d(dia), prov: 'VENTAS JC', concepto: `Comisiones venta semana ${semana}`, forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO', factura: 'NA', tipo: 'GASTO', categoria: 'NOMINA DIRECTOR', subcategoria: 'COMISIONES', ingreso: 0, egreso: 5000, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' });
    // Compras viernes
    items.push({ id: uuid(), fecha: d(dia), prov: 'ORGANICO MX', concepto: `Facturas vencidas semana ${semana} (vincular en Bind)`, forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO·BIND', factura: 'PEND', tipo: 'COMPRA', categoria: 'PRODUCTO', subcategoria: 'PRODUCTO', ingreso: 0, egreso: 13800, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' });
    items.push({ id: uuid(), fecha: d(dia), prov: 'GEORGANICA', concepto: `Facturas vencidas semana ${semana} (vincular en Bind)`, forma_pago: 'TRANSFERENCIA', aplicado: 'PROGRAMADO·BIND', factura: 'PEND', tipo: 'COMPRA', categoria: 'PRODUCTO', subcategoria: 'PRODUCTO', ingreso: 0, egreso: 5400, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' });
    // Presupuestos semanales
    items.push({ id: uuid(), fecha: d(dia), prov: 'COSTCO', concepto: `Presupuesto semanal ${semana} (descontar c/ registro)`, forma_pago: 'TARJETA', aplicado: 'PRESUPUESTO', factura: 'PEND', tipo: 'COMPRA', categoria: 'PRODUCTO', subcategoria: 'PRODUCTO', ingreso: 0, egreso: 6000, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' });
    items.push({ id: uuid(), fecha: d(dia), prov: 'BODEGA 72', concepto: `Presupuesto semanal ${semana} (descontar c/ registro)`, forma_pago: 'TARJETA', aplicado: 'PRESUPUESTO', factura: 'PEND', tipo: 'COMPRA', categoria: 'PRODUCTO', subcategoria: 'PRODUCTO', ingreso: 0, egreso: 3600, estado: 'programado', created_by: 'Claude', created_at: d('2026-06-29'), factura_at: null, bind_at: null, updated_by: 'Claude' });
  });
  return items;
}

// Bind: facturas pendientes simuladas por cliente (mock para Vincular Bind)
const MOCK_BIND_PENDING = {
  'ENSO HOSPITALITY AMATERASU': [
    { id: '3290', date: '2026-06-25', monto: 4200, concepto: 'Microgreens semana 24' },
    { id: '3291', date: '2026-06-25', monto: 4220, concepto: 'Flores Pensamiento' }
  ],
  'RESTAURANTE CANTARITOS': [
    { id: '3304', date: '2026-06-28', monto: 4100, concepto: 'Microgreens' },
    { id: '3305', date: '2026-06-28', monto: 4150, concepto: 'Microgreens + flores' },
    { id: '3306', date: '2026-06-28', monto: 4150, concepto: 'Hongos shimeji' }
  ],
  'MAXIMA DISTINCION MAR DEL ZUR': [
    { id: '3307', date: '2026-06-28', monto: 3450, concepto: 'Microgreens semanal' }
  ],
  'GRUPO PRESIDENTE': [
    { id: '3210', date: '2026-06-20', monto: 4400, concepto: 'Microgreens' },
    { id: '3220', date: '2026-06-23', monto: 4400, concepto: 'Microgreens + sorrel' }
  ]
};

const ESTADOS_NO_AFECTAN_SALDO = ['programado', 'sin-categoria', 'por-pagar'];

// Movimientos marcados con historico:true ya están incluidos en SALDO_INICIAL
// (vienen del cierre real del banco). NO deben volver a aplicarse al saldo.
function getSaldo() {
  return MOCK_MOVIMIENTOS
    .filter(m => !m.historico && !ESTADOS_NO_AFECTAN_SALDO.includes(m.estado))
    .reduce((sum, m) => sum + (m.ingreso || 0) - (m.egreso || 0), SALDO_INICIAL);
}

function getSaldoProyectado() {
  return MOCK_MOVIMIENTOS
    .reduce((sum, m) => {
      if (m.historico || m.estado === 'sin-categoria') return sum;
      return sum + (m.ingreso || 0) - (m.egreso || 0);
    }, SALDO_INICIAL);
}

if (typeof window !== 'undefined') {
  window.MOCK = { MOCK_MOVIMIENTOS, MOCK_BIND_PENDING, CATEGORIAS, SUBCATEGORIAS_GASTO_FIJO, FORMAS_PAGO, TIPOS_EGRESO, DOCUMENTOS, REGISTRADO_POR, CONTRAPARTES, SALDO_INICIAL, getSaldo, getSaldoProyectado, uuid, TEST_SHEET_URL };
}
