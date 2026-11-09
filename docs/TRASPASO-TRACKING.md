# Traspaso: tracking onsite (SDK vs. script DOM)

Documento para el equipo que se hace cargo de la integración. Resume cómo se reportan los eventos de la tienda a Klaviyo, qué hace cada script, cómo se despliega cada uno y qué se aprendió probando en una tienda real. Complementa al [README](../README.md).

Tienda de prueba usada: `https://focuss.com.mx/` (alias `focustechnology2.mitiendanube.com`, store id `1568276`, company de Klaviyo `Tnkzgw`). App en el Partner Portal: id `49733`.

## 1. Reparto de responsabilidades

Hay **dos scripts en el navegador** con trabajos distintos y que no se mezclan:

| | Script NubeSDK (SDK) | Script DOM |
|---|---|---|
| Código | `onsite/nube-sdk/src/main.ts` y `src/lib.ts` | `supabase/functions/onsite-script/index.ts` (string `SCRIPT`) |
| Dónde corre | Web Worker aislado de NubeSDK (sin `window`, `document` ni `_learnq`) | Página de la tienda (DOM normal) |
| Cómo se instala | App de Tiendanube, vía Partner Portal (scripts con "Uses Nube SDK") | Pegado en el **footer del Brand editor** de cada tienda |
| Qué hace | **Todo el tracking de eventos** (ver abajo) | **Solo carga `klaviyo.js`**, que pinta **formularios y pop-ups** |
| Envía eventos | Sí, directo a la API pública de Klaviyo | **No envía ningún evento** |

### 1.1 Qué hace el SDK

Manda a `POST https://a.klaviyo.com/client/events/?company_id=<key>` (JSON:API, revisión `2025-10-15`):

| Evento | Disparador | Reglas |
|---|---|---|
| Added to Cart | `cart:add:success` | Un evento por ítem. |
| Viewed Product | `page:loaded` y `location:updated` con `location.page.type === "product"` | Dedup por URL en memoria del worker. Precio de la primera variante. |
| Started Checkout | `checkout:ready` con `step === "start"` | Una vez por carrito y sesión (`asyncSessionStorage`, clave `klaviyo_started_checkout`). `$value` = `cart.prices.total` (o `subtotal`). |
| Active on Site | `page:loaded` (si hay `location`) | Una vez por sesión (`klaviyo_active_on_site`). Ver 4.1: es un **workaround**. |

Identificación del perfil: email si `state.customer.contact.email` existe; si no, un `anonymous_id` (`crypto.randomUUID()`) guardado en `asyncLocalStorage` (clave `klaviyo_anonymous_id`). La `company_id` se pide a `onsite-config` por store id. Sin reintentos: si el `fetch` falla, el evento se pierde (criterio: nunca romper la tienda).

Al arrancar, el script evalúa `nube.getState()` además de escuchar eventos. Es necesario porque los scripts cargan en `onfirstinteraction` y el evento `page:loaded` inicial ya pasó cuando el worker arranca.

### 1.2 Qué hace el script DOM

1. Si ya corrió (`window.__tnKlaviyoOnsite`), no hace nada.
2. Lee `LS.store.id` (objeto global de Tiendanube); si no es numérico, sale.
3. Espera la primera interacción (scroll, clic, tecla, mouse, toque).
4. Pide `onsite-config?store=<id>`. Si no hay `company_id` válido (6 alfanuméricos), no hace nada.
5. Inyecta `https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=<id>`.

Todo lo que se vea en pantalla de Klaviyo (formularios, pop-ups, flyouts) lo dibuja `klaviyo.js`; lo que se configure ahí vive en Klaviyo, no en este repo. Este script **no** manda Viewed Product, Added to Cart, Started Checkout ni Active on Site.

### 1.3 Backend de apoyo

`onsite-config` (Edge Function) devuelve `{company_id}` solo si la tienda está activa, `onsite_enabled` es true y la key es válida; respuesta idéntica para tienda inexistente o sin Klaviyo. CORS `*` a propósito (la key pública ya viaja en el HTML de cualquier tienda con Klaviyo). `onsite-script` sirve el JS del DOM con `Cache-Control: public, max-age=300`.

## 2. Despliegue

### SDK (3 scripts en el Partner Portal, misma app)

- Build: `cd onsite/nube-sdk && npm install && npm run build` → `dist/main.min.js` (git-ignored; ~4.3 KB).
- En el portal hay dos scripts SDK con el **mismo build**, porque cada script tiene una `location` fija:
  - `atc1` → `location: store` (Viewed Product, Added to Cart, Active on Site).
  - `Checkout Script` → `location: checkout` (Started Checkout).
- Cada script se versiona. Se sube `dist/main.min.js` como nueva versión y se activa. URL de versión: `apps-scripts.tiendanube.com/klaviyo-sync/<handle>/<n>.js`. Se cachea como inmutable; una versión inexistente devuelve un HTML de fallback (no es un error del script).
- Tras crear un script nuevo, hay que esperar la propagación y/o reinstalar la app en la tienda.
- La tienda necesita el tag `enable-nube-sdk-all-apps` hasta que la app esté homologada y publicada.
- Si cambia el proyecto de Supabase, editar `CONFIG_URL` en `src/main.ts` y volver a construir.

### DOM

- No va al Partner Portal. Se despliega pegando el contenido de `supabase/functions/onsite-script/index.ts` en el editor de Edge Functions del dashboard de Supabase (proyecto `tn-klaviyo`). La función debe tener **"Verify JWT" apagado** (se carga desde tiendas anónimas; con JWT responde 401).
- Cada tienda lo instala en el footer del Brand editor: `<script async src="https://darqvjlojlsfjhfipubd.supabase.co/functions/v1/onsite-script"></script>`.
- Si cambia el proyecto de Supabase, editar `CONFIG_URL` dentro de `index.ts`.

### 2.1 Instalación del DOM en el footer: solución temporal

Instalar el script DOM en el footer del Brand editor fue una decisión **por premura**, no la arquitectura deseada. Obliga a que cada comerciante pegue el código a mano en su tema y no se actualiza con la app.

**Acción recomendada (pendiente):** escribir a **ecosystem@tiendanube.com** y pedir que agreguen la app a una **whitelist** usando su App ID (`49733`), para que la app pueda correr **script DOM (legacy) y scripts SDK en la misma app**. Hoy, sin esa autorización, un script DOM dentro de la app impide que el script SDK se registre (ver sección 3).

Cuando la whitelist esté aprobada:
1. Crear el script DOM en el Partner Portal de la app (sin "Uses Nube SDK", `location: store`, `onfirstinteraction`, auto-instalado). La fuente es el mismo `SCRIPT` de `supabase/functions/onsite-script/index.ts`; el portal pide un archivo/URL, así que hay que alojarlo o servirlo desde la Edge Function.
2. Verificar que el script SDK (`atc1`, `Checkout Script`) sigue apareciendo en `installed_apps_scripts` y enviando eventos.
3. Quitar el `<script>` del footer de las tiendas para no cargar `klaviyo.js` dos veces (el script se protege con `window.__tnKlaviyoOnsite`, pero conviene no depender de eso).

## 3. Lecciones aprendidas (importante)

- **Un script DOM dentro de la misma app impidió que el script SDK se registrara.** Por eso el DOM va (temporalmente) en el footer y no en el portal. No volver a mezclarlos en la app hasta que Ecosystem agregue la app a la whitelist (ver 2.1).
- Un script SDK tiene `location` fija (store *o* checkout). Para cubrir checkout hay que crear otro script, con la misma build.
- Los scripts cargan en `onfirstinteraction`: de ahí el `getState()` inicial. Sin él no salían Viewed Product ni Started Checkout.
- Hay que reinstalar la app o esperar tras crear/activar scripts; verificar qué versión sirve la tienda antes de depurar el código.
- Cómo verificar en la tienda sin ver el worker: el Network del navegador no muestra las peticiones del worker de forma fiable. Se comprobó con `performance` entries y con el HTML de la página: `installed_apps_scripts` (listas `store`/`checkout` con las URLs de versión), `nube-sdk-apps` y `__NUBE_SDK_APPS__`. Comparar el tamaño servido con `dist/main.min.js`.
- La API de Klaviyo da un perfil **distinto** al `__kla_id` de `klaviyo.js`: el perfil anónimo del SDK (`anonymous_id`) no es el mismo que el de las cookies de `klaviyo.js`. Se espera que Klaviyo los una cuando el visitante se identifica con email, pero no se verificó.
- En Supabase, "Verify JWT" apagado para toda función pública (`onsite-config`, `onsite-script`).

## 4. Estado y puntos abiertos

| Evento | Estado |
|---|---|
| Added to Cart | Verificado en la tienda real (perfil anónimo). |
| Viewed Product | Verificado en Klaviyo (actividad del perfil). |
| Started Checkout | Verificado en Klaviyo (tras crear el script de checkout). |
| Active on Site | **Sin verificar**: ver 4.1. |
| Refunded Order | No implementado. |

### 4.1 Active on Site (workaround)

`klaviyo.js` solo genera Active on Site para navegadores **identificados** (cookie `__kla_id` con `cid` solamente = anónimo; `isIdentified()` es falso). Por eso la métrica estaba vacía. El requisito del negocio es poder trackearlo también en anónimos, así que el SDK manda un evento por API llamado `Active on Site` (propiedades: `page` limpia sin query, `Source Name: Tiendanube`), una vez por sesión.

Pendiente de verificar: si ese evento cae en la métrica nativa "Active on Site" o crea una métrica aparte (Klaviyo puede separar por integración). Revisar Analytics → Metrics. Si se separa, las automatizaciones y segmentos basados en la métrica nativa no lo verán; habría que decidir entre apuntarlas a la nueva o aceptar solo el comportamiento nativo (solo identificados).

El Checkout Script estaba aún en la versión 1 (sin Active on Site) en la última revisión; no es crítico porque Active on Site se origina en el storefront, pero conviene subirle la misma build para que ambos queden iguales.

### 4.2 Otros pendientes

- Pedir a ecosystem@tiendanube.com la whitelist de la app (App ID `49733`) para DOM legacy + SDK en la misma app, y mover el DOM del footer al portal (ver 2.1).
- Started Checkout anónimo no sirve para flujos de carrito abandonado (necesitan email); evaluar enviarlo solo si hay email.
- Aplicar `cleanPageUrl` (quita query y hash) también a la URL de Viewed Product.
- Para homologar: política de privacidad publicada, pantalla de errores de webhooks, manejo de `app/suspended` y `app/resumed`.
- Hosting del frontend (`web/`): confirmar dónde está desplegado.

## 5. Pruebas

```
node --experimental-strip-types tests/nube-sdk-atc.test.mjs   # SDK (20)
node tests/onsite.test.mjs                                    # DOM (6)
```

`tests/shared.test.mjs` falla bajo Node 26 por `crypto.ts`; es previo a este trabajo. Las pruebas de SDK usan un `nube` simulado y `fetch` global pisado; no sustituyen la verificación en una tienda real.
