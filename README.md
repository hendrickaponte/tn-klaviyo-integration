# Tiendanube ⇄ Klaviyo (MVP)

App embebida para el admin de Tiendanube que sincroniza clientes, pedidos y catálogo hacia Klaviyo, y carga el script
onsite de Klaviyo (pop-ups, formularios y Viewed Product) en la tienda.

Stack: Supabase (Postgres + Edge Functions/Deno) + React/Vite + Nimbus DS + SDK Nexo. Frontend en Vercel.

> Es un MVP probado de punta a punta en una tienda de prueba, no un producto homologado. Lee "Límites conocidos" antes de usarlo con tiendas reales.

## Qué hace hoy

| Capacidad | Estado | Nota |
|---|---|---|
| Clientes → perfiles de Klaviyo | Sí | Webhook + sincronización inicial. El email es el identificador. |
| Pedidos | Sí | Placed Order, Ordered Product, Fulfilled Order, Cancelled Order, con dirección, cupón, descuento, método de pago y variante. |
| Costo de envío (`ShippingRate`) | Derivado | La API 2025-03 no trae el campo. Se calcula como total − subtotal + descuento (supone que no hay impuestos fuera del subtotal). |
| Catálogo | Sí | Producto y variantes con precio, precio de comparación, SKU, stock e imagen. Stock sin control se envía como 999.999. |
| Sincronización inicial | Sí | Clientes, productos y pedidos pagados de los últimos 12 meses. |
| Consentimiento de marketing | Opt-in | `accepts_marketing` → suscripción. Apagado por defecto. |
| Pop-ups y formularios | Sí | Script DOM del footer que carga `klaviyo.js` con la Public API key de cada tienda. |
| Active on Site | Enviado por el SDK (sin probar en tienda) | `klaviyo.js` solo lo genera para navegadores identificados (ver la ayuda de Klaviyo, "Onsite Tracking"), así que el SDK manda además un evento "Active on Site" por API, una vez por sesión, también para visitantes anónimos. Riesgo: puede crear una métrica distinta a la nativa si Klaviyo las separa por integración; verificar en Analytics → Metrics. |
| Viewed Product | Sí (SDK, sin probar en tienda) | Vía NubeSDK (`page:loaded` / `location:updated`, `location.page.type === "product"`). Nombre, ID, URL, imagen, precio de la primera variante y moneda. |
| Added to Cart | Sí (probado en tienda real) | Vía NubeSDK (`cart:add:success`), no vía el script onload. Ver "Eventos de NubeSDK" abajo. |
| Started Checkout | Sí (SDK, sin probar en tienda) | Vía NubeSDK (`checkout:ready` con `step === "start"`), una vez por carrito y sesión. Ver "Eventos de NubeSDK". |
| Refunded Order | No | Pendiente. |
| `ShippingOption` / tracking | No | No están en el nivel superior del pedido en la API 2025-03; probablemente en `fulfillments[]`, sin verificar. |
| OAuth de Klaviyo | No | Usa una Private API key por tienda. |

## Arquitectura

```
Admin TN (iframe: web/) ──POST + session token──► klaviyo-api      (conectar, ajustes, sincronización por páginas)
TN ──webhooks firmados con HMAC──► tn-webhook ──► API TN (detalle) ──► API Klaviyo
TN ──?code=──► tn-oauth-callback   (guarda el token cifrado, registra webhooks, redirige al admin)
Tienda ──script DOM (footer del tema, lo sirve onsite-script)──► onsite-config (devuelve solo la Public API key) ──► klaviyo.js
```

- Tokens de TN y API keys de Klaviyo: AES-256-GCM, IV aleatorio por cifrado. Nunca se devuelven al frontend ni se loguean.
- Tablas con RLS activo y sin policies: solo `service_role`.
- Idempotencia: cada evento lleva `unique_id`, así los reintentos de Tiendanube no deberían duplicar eventos. Un pedido ya enviado no se actualiza al reenviarlo.
- No se guardan datos de clientes en la base propia (solo IDs en los logs); los privacy webhooks hacen ack.
- `onsite-config` responde con CORS `*` a propósito: el script corre en dominios de tienda arbitrarios y solo devuelve la Public API key, que ya es visible en el HTML de cualquier tienda con Klaviyo.

### Eventos de NubeSDK (Added to Cart, Viewed Product, Started Checkout)

> **Requisito importante:** Added to Cart necesita el Storefront SDK (NubeSDK). Para la tienda de prueba hay que pedir a Tiendanube que active el tag `enable-nube-sdk-all-apps`. Una vez que la app esté homologada y publicada, ya no hace falta pedirlo para las demás tiendas.

El evento `cart:add` / `cart:add:success` ([tiendanube.dev/apps/nube-sdk/events/cart](https://tiendanube.dev/apps/nube-sdk/events/cart)) **solo existe dentro de NubeSDK**: las apps NubeSDK corren en un Web Worker aislado (sin `window`, sin `document`, sin `_learnq`), así que no se puede escuchar desde `web/public/klaviyo-onsite.js` (script DOM, sin NubeSDK). Por eso el soporte de ATC vive en un script aparte, que también manda Viewed Product y Started Checkout (el script onload ya no manda eventos, solo carga `klaviyo.js`):

```
onsite/nube-sdk/   App NubeSDK (src/main.ts) que escucha cart:add:success y manda "Added to Cart"
                   directo a la API pública de eventos de Klaviyo (POST a.klaviyo.com/client/events),
                   sin pasar por nuestro backend. Mismo Partner Portal app que el script onload,
                   pero es un SCRIPT NUEVO con el flag "Uses Nube SDK" habilitado (ver Despliegue).
```

Decisiones de esta parte:

- **Identificación del perfil**: si `state.customer.contact.email` está disponible (cliente logueado) se manda `email`; si no, se usa un `anonymous_id` estable por visitante, generado con `crypto.randomUUID()` y persistido con `nube.getBrowserAPIs().asyncLocalStorage` (scopeado a la app por NubeSDK). Klaviyo mergea ese perfil anónimo cuando el mismo visitante se identifica después (ej. al comprar). La mayoría de los Added to Cart van a ser anónimos: es la norma en cualquier tienda, no un bug.
- **Por qué la API pública de eventos y no `klaviyo-api`**: igual que Viewed Product, el evento sale directo del navegador con la Public API key; no hay sesión de nuestro backend ni se necesita la Private key.
- `state.eventPayload` es un objeto en Storefront y un array en Checkout (ver doc); se normaliza a lista y se manda un evento por ítem.
- Sin reintentos: si el `fetch` falla (red caída, bloqueador de contenido) el evento se pierde silenciosamente — mismo criterio que el resto del script onsite ("nunca romper la tienda").
- `KLAVIYO_REVISION` queda hardcodeada en el archivo (el worker no tiene `Deno.env`): mantenerla sincronizada a mano con `supabase/functions/_shared/klaviyo.ts`.

- **Viewed Product**: `page:loaded` y `location:updated` (navegación SPA) pueden disparar para la misma página; se deduplica por URL dentro del worker. El precio es el de la primera variante.
- **Started Checkout**: `checkout:ready` se dispara en cada página del checkout; solo se envía en `step === "start"` y se guarda el id del carrito en `asyncSessionStorage` para no repetirlo al recargar. `$value` es `cart.prices.total` (si no hay, `subtotal`).
- Los tres eventos comparten identificación de perfil (email si hay cliente, si no `anonymous_id`) y la misma ruta de envío a `a.klaviyo.com/client/events`.

## Estructura

```
supabase/functions/   Edge Functions (klaviyo-api, tn-webhook, tn-oauth-callback, onsite-config, onsite-script) y _shared/
                      onsite-script/index.ts: fuente del script DOM que carga klaviyo.js (se instala en el footer del tema)
supabase/migrations/  Esquema (init + onsite)
web/                  Frontend embebido (React + Vite + Nimbus)
onsite/               Scripts que se suben al Partner Portal de Tiendanube
onsite/nube-sdk/      Script NubeSDK (Added to Cart); necesita build (ver Despliegue)
tests/                Pruebas sin dependencias (Node >= 22.18)
```

## Despliegue

1. **Supabase**: crea un proyecto, `supabase link --project-ref <ref>` y `supabase db push` (aplica las dos migraciones).
2. **Secretos**: `cp supabase/functions/.env.example supabase/functions/.env`, complétalo y `supabase secrets set --env-file supabase/functions/.env`. Genera `ENCRYPTION_KEY` con `openssl rand -base64 32` y guárdala: si se pierde hay que reconectar todas las tiendas.
3. **Funciones** (todas sin verificación JWT de Supabase; cada una tiene su propia auth: HMAC o session token):
   `supabase functions deploy tn-oauth-callback tn-webhook klaviyo-api onsite-config onsite-script --no-verify-jwt`
4. **Frontend** (`web/`): `npm install`, `cp .env.example .env`, completa y `npm run build`. Despliega `dist/` (hay `vercel.json` con CSP y `frame-ancestors`). Las dependencias `@nimbus-ds/*` y `@tiendanube/nexo` están en `latest` y no hay lockfile: ejecuta `npm install`, **commitea el lockfile** y fija las versiones.
5. **Partner Portal de Tiendanube**:
   - URL de redirección OAuth: `https://<ref>.supabase.co/functions/v1/tn-oauth-callback`
   - Scopes: `read_customers`, `read_orders`, `read_products`.
   - URL de la app embebida: la del frontend.
   - Webhooks de privacidad (`store/redact`, `customers/redact`, `customers/data_request`): `https://<ref>.supabase.co/functions/v1/tn-webhook`
   - **Script DOM (`klaviyo.js`)**: no se sube al portal. La fuente es `supabase/functions/onsite-script/index.ts` y la Edge Function `onsite-script` lo sirve como JavaScript. Cada tienda lo instala pegando esto en el **footer del Brand editor**: `<script async src="https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/onsite-script"></script>`. Detecta la company sola: lee `LS.store.id` y pide la Public API key a `onsite-config`; sin key, no hace nada. Arranca en la primera interacción del visitante (scroll, clic, tecla, mouse o toque). El footer solo cubre el storefront, no el checkout. Si queda un script `Klaviyo onsite` en el portal, desactívalo para no cargarlo dos veces (el script se protege con `__tnKlaviyoOnsite`). Si cambia el proyecto de Supabase, edita `CONFIG_URL` en `index.ts` y vuelve a desplegar `onsite-script`.
   - **Script NubeSDK (Added to Cart)** (requiere el tag `enable-nube-sdk-all-apps` en la tienda de prueba; ver "Added to Cart (NubeSDK)"): en `onsite/nube-sdk/`, edita `CONFIG_URL` en `src/main.ts` (mismo `<YOUR_PROJECT_REF>`), `npm install` y `npm run build` (bundlea `dist/main.min.js` con tsup). En la misma app del Partner Portal, **Scripts → Create script** (es un script nuevo, no una app nueva): habilita el flag **Uses Nube SDK**, apunta el archivo/URL a `dist/main.min.js` y publicá la versión. Si vas a desarrollar en vivo, usa `npm run dev` + Local Mode de NubeSDK DevTools en vez de una URL de dev fija. Ver [tiendanube.dev/apps/nube-sdk/getting-started](https://tiendanube.dev/apps/nube-sdk/getting-started).
6. **Klaviyo**: crea una Private API key con acceso de lectura/escritura a cuentas, perfiles, eventos, catálogo y suscripciones (solo se puede acotar al crearla). Para los pop-ups necesitas además la Public API key (6 caracteres).
7. Instala la app en una tienda de prueba, conecta la key, guarda los ajustes y lanza la sincronización inicial.

## Hallazgos verificados con tráfico real

- Header de webhooks: `x-linkedstore-hmac-sha256`. El payload solo trae `store_id`, `event` e `id`: se consulta la API por el detalle.
- Session token de Nexo: JWT HS256 firmado con el client secret. El store id viaja en el claim `storeId` (**no** `sub`, que es el usuario del admin) y `aud` es el ID de la app.
- `order/created` se omite si el disparador de Placed Order es "pagado".
- En pedidos con retiro en tienda, el zip puede venir como `00000` y la calle vacía.
- `billing_*` son campos planos, no un objeto.

## Límites conocidos

- Sin rate limiting propio en `klaviyo-api`.
- La sincronización inicial se orquesta desde el navegador (25 ítems por llamada) y no tiene lock: dos pestañas pueden correrla a la vez (es idempotente, pero gasta cuota).
- El estado `running` puede quedar colgado si se cierra la pestaña.
- El stock de variantes sin control (999.999) y la URL de variante igual a la del producto son decisiones de diseño, no vienen de la documentación de Klaviyo.
- No se envía `inventory_policy` (la documentación de Klaviyo es inconsistente).
- Versión de API de Tiendanube `2025-03` y revisión de Klaviyo `2025-10-15`: ambas configurables por entorno; confirma que sigan vigentes.
- Tiendas de Brasil (`api.nuvemshop.com.br`): fuera de alcance.
- Added to Cart: sin reintentos (se pierde si el `fetch` falla) y sin lock de idempotencia (`cart:add:success` duplicado por la plataforma mandaría el evento dos veces; no se observó en pruebas pero no está garantizado por la doc). El `anonymous_id` vive en `asyncLocalStorage` de NubeSDK: se pierde si el visitante borra datos del sitio o cambia de navegador/dispositivo.
- Para homologar faltan: política de privacidad publicada, pantalla de errores de webhooks, manejo de `app/suspended` y `app/resumed`.

## Pruebas

```
node --experimental-strip-types tests/shared.test.mjs
node tests/onsite.test.mjs
node --experimental-strip-types tests/nube-sdk-atc.test.mjs
```

Cubren cifrado, HMAC, validación del JWT, mapeos, eventos de pedido, catálogo con variantes, reintentos y errores de Klaviyo (con `fetch` simulado), el script onsite y el script NubeSDK de Added to Cart (con un `nube` simulado: `on`/`getState`/`getBrowserAPIs`, y `fetch` global pisado). **No cubren** las Edge Functions de punta a punta ni el frontend. El script NubeSDK de Added to Cart se validó manualmente en una tienda real, fuera de estas pruebas automáticas.
