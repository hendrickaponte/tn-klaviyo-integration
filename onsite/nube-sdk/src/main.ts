// App de NubeSDK (Web Worker, sin DOM). Mismo script onsite / misma app del Partner Portal que
// onsite/klaviyo-onsite.js, pero registrada como un script NUEVO con "Uses Nube SDK" habilitado:
// el evento cart:add:success solo existe dentro de NubeSDK (ver tiendanube.dev/apps/nube-sdk/events/cart).
//
// Responsabilidad única: escuchar "cart:add:success" y mandar "Added to Cart" directo a la API pública
// de eventos de Klaviyo (POST /client/events, autenticada con la Public API key, sin tocar nuestro backend).
// No se puede reusar window._learnq (no hay window dentro del worker): se arma el evento a mano.
//
// Este archivo exporta ÚNICAMENTE `App`, igual que el template oficial de NubeSDK (las funciones puras
// están en lib.ts). Si llega a exportar algo más, el Partner Portal puede no activar la versión.
//
// ANTES DE BUILDEAR: reemplazá <YOUR_PROJECT_REF> en CONFIG_URL (mismo valor que onsite/klaviyo-onsite.js).
import type { NubeSDK, NubeSDKState } from "@tiendanube/nube-sdk-types";
import {
  addedToCartEventBody, cartAddItems, isValidCompanyId, startedCheckoutEventBody, viewedProductEventBody,
  type ProfileIdentifier,
} from "./lib.ts";

const CONFIG_URL = "https://darqvjlojlsfjhfipubd.supabase.co/functions/v1/onsite-config";
// Misma suposición que supabase/functions/_shared/klaviyo.ts (KLAVIYO_REVISION): no hay env vars
// disponibles en el worker, así que queda fija acá. Mantenerlas sincronizadas a mano.
const KLAVIYO_REVISION = "2025-10-15";
const ANONYMOUS_ID_KEY = "klaviyo_anonymous_id";

async function fetchCompanyId(storeId: number): Promise<string | null> {
  try {
    const r = await fetch(`${CONFIG_URL}?store=${storeId}`, { credentials: "omit" });
    if (!r.ok) return null;
    const c = await r.json();
    const v = c?.company_id;
    return isValidCompanyId(v) ? v : null;
  } catch {
    return null; // silencioso: nunca romper la tienda
  }
}

/** Persistido en asyncLocalStorage: un visitante anónimo mantiene el mismo id en toda la tienda. */
async function anonymousId(nube: NubeSDK): Promise<string> {
  const storage = nube.getBrowserAPIs().asyncLocalStorage;
  const existing = await storage.getItem(ANONYMOUS_ID_KEY);
  if (typeof existing === "string" && existing) return existing;
  const id = crypto.randomUUID();
  await storage.setItem(ANONYMOUS_ID_KEY, id);
  return id;
}

async function profileIdentifier(nube: NubeSDK, state: Readonly<NubeSDKState>): Promise<ProfileIdentifier> {
  const email = state.customer?.contact?.email;
  if (email) return { email };
  return { anonymous_id: await anonymousId(nube) };
}

async function postEvent(companyId: string, body: unknown): Promise<void> {
  try {
    await fetch(`https://a.klaviyo.com/client/events/?company_id=${encodeURIComponent(companyId)}`, {
      method: "POST",
      headers: { "content-type": "application/vnd.api+json", revision: KLAVIYO_REVISION },
      body: JSON.stringify(body),
    });
  } catch {
    // silencioso: nunca romper la tienda
  }
}

async function sendAddedToCart(nube: NubeSDK, companyId: string, state: Readonly<NubeSDKState>): Promise<void> {
  const items = cartAddItems(state.eventPayload);
  if (!items.length) return;
  const currency = state.store?.currency_details?.code;
  const profile = await profileIdentifier(nube, state);

  for (const item of items) {
    await postEvent(companyId, addedToCartEventBody(item, currency, profile));
  }
}

export function App(nube: NubeSDK): void {
  let companyIdPromise: Promise<string | null> | null = null;
  const getCompanyId = () => {
    if (!companyIdPromise) companyIdPromise = fetchCompanyId(nube.getState().store.id);
    return companyIdPromise;
  };

  nube.on("cart:add:success", async (state) => {
    const companyId = await getCompanyId();
    if (!companyId) return;
    await sendAddedToCart(nube, companyId, state);
  });

  // Viewed Product: page:loaded (carga inicial) y location:updated (navegación SPA) pueden disparar
  // para la misma página; se deduplica por URL dentro del worker.
  let lastViewedUrl = "";
  const onLocation = async (state: Readonly<NubeSDKState>) => {
    const page = state.location?.page;
    if (page?.type !== "product" || !page.data?.product) return;
    const url = state.location.url;
    if (url === lastViewedUrl) return;
    lastViewedUrl = url;
    const companyId = await getCompanyId();
    if (!companyId) return;
    const profile = await profileIdentifier(nube, state);
    await postEvent(companyId, viewedProductEventBody(
      page.data.product, url, state.store?.currency_details?.code, state.store?.language, profile,
    ));
  };
  nube.on("page:loaded", onLocation);
  nube.on("location:updated", onLocation);

  // Started Checkout: checkout:ready se dispara en cada página del checkout; solo el paso "start".
  // Guard por id de carrito en sessionStorage para no duplicar al recargar el checkout.
  nube.on("checkout:ready", async (state) => {
    const page = state.location?.page;
    if (page?.type !== "checkout" || page.data?.step !== "start") return;
    const companyId = await getCompanyId();
    if (!companyId) return;
    const storage = nube.getBrowserAPIs().asyncSessionStorage;
    const key = "klaviyo_started_checkout";
    if (state.cart.id && (await storage.getItem(key)) === state.cart.id) return;
    if (state.cart.id) await storage.setItem(key, state.cart.id);
    const profile = await profileIdentifier(nube, state);
    await postEvent(companyId, startedCheckoutEventBody(
      state.cart, state.location.url, state.store?.currency_details?.code, profile,
    ));
  });
}
