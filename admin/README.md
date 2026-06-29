# Tab Admin — Sandbox de desarrollo

Sandbox aislado del Tab Administración. **No toca la PWA real ni el Sheet master** hasta que cutover.

## Estructura

```
tab-admin/
├── README.md                  ← este archivo
├── prototype.html             ← UI standalone con dev server propio
├── apps-script-test.gs        ← Apps Script para Sheet TEST clonado
├── mock-data.js               ← datos de prueba mientras no haya backend
├── bind-test.js               ← Node script para validar endpoint Bind sandbox
└── cutover-checklist.md       ← lista de cosas a hacer al pasar a producción
```

## Cómo correrlo localmente

### 1 · Levantar el prototipo

```bash
cd /Users/geminismkt/claude/cityrootsfarm-pwa/tab-admin
python3 -m http.server 8086
```

Abrir http://localhost:8086/prototype.html en el navegador.

### 2 · Sheet TEST clonado

1. Abrir `FlujoEfectivo_2026_MASTER` en Drive
2. Archivo → Hacer una copia → renombrar como `FlujoEfectivo_2026_TEST`
3. Mover a carpeta `HADE/Sandbox/` en Drive
4. Extensiones → Apps Script
5. Pegar `apps-script-test.gs` → Guardar → Implementar como Web App
6. Copiar la URL pública y pegarla en `mock-data.js` (constante `TEST_SHEET_URL`)

### 3 · Datos de prueba

`mock-data.js` tiene 20 movimientos de muestra para validar:
- 6 capturados sin factura
- 4 con factura sin Bind
- 8 ya en Bind
- 2 sin categoría

Carga inicial: ejecutar `seed()` desde la consola del prototype.

## Reglas del sandbox

1. **NUNCA escribir al Sheet master real** desde el sandbox. Toda escritura va al Sheet TEST.
2. **Bind API en modo sandbox** — el backend de hade-erpweb debe correr con `BIND_MODE=sandbox` durante pruebas.
3. **Datos sintéticos** — no usar datos reales de clientes en mock-data (privacidad).
4. **Cualquier cambio de schema** se documenta primero aquí, luego en `SPEC-TAB-ADMIN-v1-LOCKED.md`.

## Cutover a producción

Cuando todo esté validado (~M7 del plan):
1. Aplicar Apps Script al master real (agregar columnas M–S, no tocar A–L)
2. Correr script one-shot de migración del color rojo
3. Integrar el HTML del prototype al `cityrootsfarm-app/index.html`
4. Bump APP_VERSION + CACHE_NAME en sw.js
5. Eliminar este sandbox o moverlo a `archivo/`

Ver `cutover-checklist.md` para los pasos detallados.

## Estado

| Componente | Status |
|---|---|
| Spec cerrada | ✅ `../SPEC-TAB-ADMIN-v1-LOCKED.md` |
| Wireframes validados con JC | ✅ 29-jun-2026 |
| Wireframes validados con Martha | ⏳ pendiente |
| Apps Script TEST deployado | ⏳ M1 |
| prototype.html standalone | ⏳ M3-M6 |
| Backend Bind hade-erpweb | ⏳ M2 |
| Memoria pagos recurrentes | ✅ `project_hade_pagos_recurrentes.md` |
