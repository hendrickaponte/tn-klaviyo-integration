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
| Pop-ups, formularios y Active on Site | Sí | Script onsite que carga `klaviyo.js` con la Public API key de cada tienda. |
| Viewed Product | Sí | Datos mínimos: nombre, ID, URL, imagen y moneda. |
| Added to Cart, Started Checkout, Refunded Order | No | Pendiente. No se conoce todavía cómo detectar el carrito en el tema. |
| `ShippingOption` / tracking | No | No están en el nivel superior del pedido en la API 2025-03; probablemente en `fulfillments[]`, sin verificar. |
| OAuth de Klaviyo | No | Usa una Private API key por tienda. |

## Arquitectura

```
Admin TN (iframe: web/) ──POST + session token──► klaviyo-api      (conectar, ajustes, sincronización por páginas)
TN ──webhooks firmados con HMAC──► tn-webhook ──► API TN (detalle) ──► API Klaviyo
TN ──?code=──► tn-oauth-callback   (guarda el token cifrado, registra webhooks, redirige al admin)
Tienda ──script onsite (portal de TN)──► onsite-config (devuelve solo la Public API key) ──► klaviyo.js
```

- Tokens de TN y API keys de Klaviyo: AES-256-GCM, IV aleatorio por cifrado. Nunca se devuelven al frontend ni se loguean.
- Tablas con RLS activo y sin policies: solo `service_role`.
- Idempotencia: cada evento lleva `unique_id`, así los reintentos de Tiendanube no deberían duplicar eventos. Un pedido ya enviado no se actualiza al reenviarlo.
- No se guardan datos de clientes en la base propia (solo IDs en los logs); los privacy webhooks hacen ack.
- `onsite-config` responde con CORS `*` a propósito: el script corre en dominios de tienda arbitrarios y solo devuelve la Public API key, que ya es visible en el HTML de cualquier tienda con Klaviyo.

## Estructura

```
supabase/functions/   Edge Functions (klaviyo-api, tn-webhook, tn-oauth-callback, onsite-config) y _shared/
supabase/migrations/  Esquema (init + onsite)
web/                  Frontend embebido (React + Vite + Nimbus)
onsite/               Script que se sube al Partner Portal de Tiendanube
tests/                Pruebas sin dependencias (Node >= 22.18)
```

## Despliegue

1. **Supabase**: crea un proyecto, `supabase link --project-ref <ref>` y `supabase db push` (aplica las dos migraciones).
2. **Secretos**: `cp supabase/functions/.env.example supabase/functions/.env`, complétalo y `supabase secrets set --env-file supabase/functions/.env`. Genera `ENCRYPTION_KEY` con `openssl rand -base64 32` y guárdala: si se pierde hay que reconectar todas las tiendas.
3. **Funciones** (todas sin verificación JWT de Supabase; cada una tiene su propia auth: HMAC o session token):
   `supabase functions deploy tn-oauth-callback tn-webhook klaviyo-api onsite-config --no-verify-jwt`
4. **Frontend** (`web/`): `npm install`, `cp .env.example .env`, completa y `npm run build`. Despliega `dist/` (hay `vercel.json` con CSP y `frame-ancestors`). Las dependencias `@nimbus-ds/*` y `@tiendanube/nexo` están en `latest` y no hay lockfile: ejecuta `npm install`, **commitea el lockfile** y fija las versiones.
5. **Partner Portal de Tiendanube**:
   - URL de redirección OAuth: `https://<ref>.supabase.co/functions/v1/tn-oauth-callback`
   - Scopes: `read_customers`, `read_orders`, `read_products`.
   - URL de la app embebida: la del frontend.
   - Webhooks de privacidad (`store/redact`, `customers/redact`, `customers/data_request`): `https://<ref>.supabase.co/functions/v1/tn-webhook`
   - **Script onsite**: edita `CONFIG_URL` en `onsite/klaviyo-onsite.js` (reemplaza `<YOUR_PROJECT_REF>`) y súbelo como script nuevo: lugar Store, evento `onload`, sin NubeSDK, instalación automática. **Publica la versión**: en borrador no se sirve. Si la app ya estaba instalada en una tienda antes de crear el script, reinstálala en esa tienda.
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
- Para homologar faltan: política de privacidad publicada, pantalla de errores de webhooks, manejo de `app/suspended` y `app/resumed`.

## Pruebas

```
node --experimental-strip-types tests/shared.test.mjs
node tests/onsite.test.mjs
```

Cubren cifrado, HMAC, validación del JWT, mapeos, eventos de pedido, catálogo con variantes, reintentos y errores de Klaviyo (con `fetch` simulado) y el script onsite. **No cubren** las Edge Functions de punta a punta ni el frontend.
