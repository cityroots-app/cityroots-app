# TODO — Cron semanal para actualizar CxP de Bind

**Propuesto por JC:** 2-jul-2026 (aún no implementar, dejar como pendiente).

## Idea

Todos los **lunes a las 12:00 PM** un cron lee un archivo de cuentas por pagar descargado de Bind y actualiza los CxP visibles en la PWA Tab Admin.

## Flujo esperado

```
Lunes 12:00                                Cron ejecuta
       │
       ▼
JC ha guardado ────────────────────► Cron lee archivo (json/csv/xlsx)
cxp-YYYY-MM-DD.xlsx                          │
en carpeta acordada                          ▼
                                    Parsea y normaliza (Proveedor,
                                    Concepto, Fecha, Monto)
                                             │
                                             ▼
                                    Escribe archivo estático
                                    cityrootsfarm-app/admin/cxp-bind.json
                                             │
                                             ▼
                                    Commit + push a GitHub Pages
                                             │
                                             ▼
                                    PWA lee cxp-bind.json al cargar
                                    (además de localStorage)
                                    Muestra en tab Próximos
```

## Decisiones pendientes cuando se implemente

1. **Ubicación del archivo fuente**: carpeta local monitoreada (ej. `~/HADE/bind-cxp/`) o descarga automática desde Bind con headless browser (más complejo pero elimina paso manual).

2. **Formato de salida**: JSON estático en `cityrootsfarm-app/admin/cxp-bind.json` con estructura:
   ```json
   {
     "generated_at": "2026-07-13T12:00:00Z",
     "cxp": [
       {"prov": "JOSUE ARTURO RAMIREZ MORENO", "concepto": "CxP Bind #2115", "fecha": "2026-07-17", "monto": 3250},
       ...
     ]
   }
   ```

3. **Merge con localStorage**: cuando el JSON estático se actualiza, ¿reemplaza los CxP locales o los mezcla? Recomendación: reemplaza los que tengan el mismo `bind_id` (folio Bind), preserva los que JC editó manualmente.

4. **Auto-mover a viernes**: aplicar la misma lógica de `moverAViernes()` para Josué/Georgina/nóminas después de parsear.

5. **Mecanismo del cron**:
   - Opción A: `launchd` en Mac de JC (persistente, sobrevive reboots).
   - Opción B: GitHub Actions con schedule `cron: "0 18 * * 1"` (12:00 CST = 18:00 UTC lunes). Requiere que el archivo fuente esté accesible (S3, Drive, etc).
   - Opción C: script Node en `hade-erpweb` con `node-cron`.

6. **Notificación**: al terminar el cron, ¿mandar email/Slack a JC con resumen ("15 CxP importados, 3 removidos, saldo proyectado semana X = $Y")?

## Cuándo implementar

- Cuando JC confirme que el flujo semanal manual funciona bien 2-3 semanas.
- Antes: solo importa manual desde el modal "Importar CxP Bind" en la PWA.

## Referencias

- Memoria del piloto: [[pwa-tab-admin-piloto]]
- Sync semanal similar en `hade-ventas/scripts/download-ventas-2026.js`
- Format del textarea de importación: `admin/index.html` función `parsearCxP()`
