# City Roots Farm — Sistema de Registros (PWA)

PWA mobile-first para la operación diaria de **City Roots Farm** (microgreens en Monterrey, México).

**🌐 Deploy:** https://cityroots-app.github.io/cityroots-app/

---

## Qué hace

App web con 3 roles que se eligen al primer ingreso:

| Rol | Funciones |
|---|---|
| **Producción** | Lotes, siembras, cosechas, bloc de notas, registros HACCP/POES |
| **Almacén** | Preparación de pedidos del día + inventario |
| **Logística** (chofer) | Compras agrupadas por proveedor + entregas + historial |

Todo corre en un solo `index.html` + `sw.js` (service worker offline-first).

---

## Stack

- **Frontend:** HTML + CSS + JS vanilla (single-file, sin build step)
- **Storage:** `localStorage` (offline-first)
- **Backend:** Google Sheets via Apps Script (dos Sheets: Principal + Logística)
- **Hosting:** GitHub Pages

---

## Arquitectura

La PWA NO se comunica directo con un ERP. Se comunica a través de Google Sheets como **message bus** compartido con el backend HADE-WEBERP (repo privado):

```
hade-erpweb (cron Node.js)     Google Sheets      PWA (index.html)
  ├ Lee emails                  ├ Sheet           ├ Rol Producción
  ├ Parsea con Claude           │  Principal       ├ Rol Almacén
  ├ Crea pedidos en Bind        └ Sheet            └ Rol Logística
  └ Rutea faltantes                Logística
```

Esto permite que cada lado funcione independiente: si el cron está caído, la PWA sigue leyendo del Sheet. Si la PWA no se abre, el cron sigue escribiendo.

---

## Versión actual

**v2.10.4** — 17 de abril 2026. Ver `APP_VERSION` en `index.html` + `CACHE_NAME` en `sw.js`.

---

## Archivos del repo

- `index.html` — la app completa
- `sw.js` — service worker (cache offline)
- `app.html` — redirect con cache-buster (útil cuando la PWA queda cacheada en algún dispositivo)
- `ISOTIPO_VERDE_nobg.png` — logo
- `hade-erpweb/` — carpeta selectiva del backend (solo los archivos que se versionan junto con la PWA — ver `.gitignore`)

---

_Sistema desarrollado como parte del ecosistema operativo de City Roots Farm._
