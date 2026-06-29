# Cutover Checklist — Tab Admin del Sandbox a Producción

> Pasos para pasar de sandbox (`prototype.html` + Sheet TEST) a integración real en `cityrootsfarm-app/index.html` + Sheet master.

---

## Pre-requisitos antes del cutover

- [ ] **Sandbox validado con JC** — todas las vistas funcionan, flow Vincular Bind probado
- [ ] **Sandbox validado con Martha** — vista Pendientes le ahorra tiempo real (medir 1 semana)
- [ ] **Backup del master en Drive** — `FlujoEfectivo_2026_MASTER_backup_AAAAMMDD.xlsx`
- [ ] **Snapshot del Apps Script actual** del Sheet master en caso de rollback

---

## Paso 1 · Sheet master · agregar columnas M-S

En `FlujoEfectivo_2026_MASTER` (Google Sheet nativo):

- [ ] Abrir Apps Script del Sheet master (Extensiones → Apps Script)
- [ ] Pegar `apps-script-test.gs` adaptando `SHEET_NAME = 'FLUJO_2026'`
- [ ] Correr `inicializarHeaders()` — agrega headers M (row_id), N (estado), O (created_by), P (created_at), Q (factura_at), R (bind_at), S (updated_by) en la fila de headers
- [ ] Verificar que las columnas A-L siguen intactas
- [ ] Las fórmulas L existentes deben seguir funcionando

## Paso 2 · Migración del "color rojo" a estado

- [ ] Correr `migrarColorRojo()` desde el editor Apps Script
- [ ] Verificar log: `{'en-bind': X, 'con-factura': Y, 'capturado': Z, 'sin-categoria': W}` debe sumar al total de filas no vacías
- [ ] Spot check: 5 filas aleatorias — el estado debe coincidir con el color/factura/categoría real
- [ ] Si algo está mal, corregir el regex de detección de rojo en `migrarColorRojo()` y re-correr (es idempotente)

## Paso 3 · Deploy del Apps Script

- [ ] Implementar → Nueva implementación → Web App
- [ ] Ejecutar como: yo (tu cuenta)
- [ ] Quién tiene acceso: Cualquier persona (mismo patrón que las otras Apps Scripts)
- [ ] Copiar la URL `https://script.google.com/macros/s/.../exec`
- [ ] Probar desde curl:
  ```bash
  curl -L "URL/exec?action=ping"
  curl -L "URL/exec?action=getSaldoSummary"
  ```
- [ ] Si el ping responde `{ok:true}`, listo

## Paso 4 · Backend Bind en hade-erpweb

- [ ] Crear endpoint `GET /api/finanzas/clients/:id/pending-invoices` reusando `src/services/bind-invoices.js`
- [ ] Crear endpoint `POST /api/finanzas/payment` que llame a Bind para crear el pago
- [ ] Habilitar CORS para `https://cityroots-app.github.io`
- [ ] Variable de entorno `BIND_MODE=production` (sandbox para pruebas iniciales)
- [ ] Deploy a producción de hade-erpweb
- [ ] Probar endpoints desde Postman/curl con datos reales

## Paso 5 · Integrar HTML del prototype al cityrootsfarm-app/index.html

- [ ] Copiar CSS del `.tab-admin` (selectores) — prefijar todo con `.role-admin` para no romper otros roles
- [ ] Copiar JS de las 5 vistas como funciones `renderAdmCaptura/Pendientes/Programados/Saldo/Admin`
- [ ] Agregar 4° rol "Administración" al selector de roles (welcome screen)
- [ ] Routing del rol admin a sus 5 tabs (`adm_captura`, `adm_pendientes`, `adm_programados`, `adm_saldo`, `adm_admin`)
- [ ] Bottom nav con 5 botones SVG Lucide
- [ ] Conectar al Apps Script master usando `localStorage.crf_url_admin` (nueva URL)
- [ ] Conectar a hade-erpweb para Bind usando `localStorage.crf_url_hade_finanzas`

## Paso 6 · Bump de versión + Service Worker

- [ ] `cityrootsfarm-app/index.html` → `APP_VERSION='2.21.0'`
- [ ] `cityrootsfarm-app/sw.js` → `CACHE_NAME='crf-v61'`
- [ ] Commit + push

## Paso 7 · Testing en producción

- [ ] JC selecciona rol Admin en su iPhone
- [ ] Capturar 1 movimiento real desde móvil → verificar que aparece en el Sheet master
- [ ] Vista Pendientes en Mac de Martha — debe mostrar lo capturado
- [ ] Vincular Bind con factura real — verificar que el pago se crea en Bind
- [ ] Subir a Bind — verificar que el estado cambia a `en-bind` + timestamp
- [ ] Vista Saldo — verificar que el saldo bancario coincide con Banregio
- [ ] Vista Próximos — los 10 pagos programados de mock-data NO aparecen aquí (eran solo sandbox)

## Paso 8 · Carga inicial de pagos programados del mes

- [ ] Claude carga los pagos recurrentes del mes desde [[hade-pagos-recurrentes]] con `estado=programado`
- [ ] Verificar que la suma de programados coincide con lo esperado (~$380k/mes)
- [ ] Validar saldo proyectado

## Paso 9 · Comunicación al equipo

- [ ] Capacitar a Martha (30 min) — uso de Pendientes + Vincular Bind
- [ ] Informar al contador externo que el Sheet sigue siendo leíble para sus reportes mensuales
- [ ] Documentar en `cityrootsfarm-pwa/CLAUDE.md` el nuevo rol y URLs

## Paso 10 · Cleanup post-cutover

- [ ] Cuando todo esté estable (1-2 semanas), archivar `tab-admin/` → `tab-admin/archivo/`
- [ ] Borrar `FlujoEfectivo_2026_TEST` del Drive
- [ ] Actualizar memoria [[hade-flujo-drive-workflow]] con el nuevo workflow
- [ ] Cerrar issue del bug XLSX↔Sheets (el `onEdit` queda como protección defensiva)

---

## Rollback (si algo sale mal)

Si el Apps Script nuevo rompe el Sheet o las fórmulas:

1. **Restaurar el archivo backup**: subir `FlujoEfectivo_2026_MASTER_backup_AAAAMMDD.xlsx` a Drive
2. **Re-conectar el Apps Script viejo**: revertir el código en el editor del Sheet
3. **Hacer rollback de la PWA**: `git revert` del commit del rol Admin
4. **Bump de versión**: `crf-v62`, push, esperar service worker refresh

El sandbox sigue funcionando como fallback mientras se diagnostica.

---

## Notas

- El `onEdit` de limpieza de strings vacíos (`hade-finanzas/scripts/flujo_appscript_limpieza.js`) debe quedar instalado en el Apps Script del master como protección defensiva, incluso después del cutover. Eso evita que el bug XLSX↔Sheets regrese si alguien edita a mano.
- Si Martha encuentra que la vista Pendientes le quita flexibilidad, mantener el botón "Editar inline" para que pueda corregir campos sin pasar por un form completo.
- Bind API tiene rate limits — agregar throttle si hay > 5 calls/segundo desde la PWA.
