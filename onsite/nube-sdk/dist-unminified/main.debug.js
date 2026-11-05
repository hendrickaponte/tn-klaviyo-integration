// src/lib.ts
function isValidCompanyId(v) {
  return typeof v === "string" && /^[A-Za-z0-9]{6}$/.test(v);
}
function cartAddItems(eventPayload) {
  if (Array.isArray(eventPayload)) return eventPayload;
  if (eventPayload && typeof eventPayload === "object") return [eventPayload];
  return [];
}
function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function httpsOnly(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https:\/\//i.test(s) ? s : void 0;
}
function clean(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === void 0 || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}
function addedToCartEventBody(item, currency, profile) {
  const price = money(item.price);
  const quantity = money(item.quantity) || 1;
  const properties = clean({
    ProductID: item.product_id,
    VariantID: item.variant_id,
    ProductName: item.name,
    VariantName: item.variant_values,
    SKU: item.sku ?? void 0,
    Quantity: quantity,
    ItemPrice: price,
    RowTotal: price * quantity,
    ProductURL: httpsOnly(item.url),
    ImageURL: httpsOnly(item.thumbnail),
    "Source Name": "Tiendanube"
  });
  return {
    data: {
      type: "event",
      attributes: {
        properties,
        metric: { data: { type: "metric", attributes: { name: "Added to Cart" } } },
        profile: { data: { type: "profile", attributes: profile } },
        value: price * quantity,
        value_currency: currency,
        time: (/* @__PURE__ */ new Date()).toISOString()
      }
    }
  };
}

// src/main.ts
var CONFIG_URL = "https://darqvjlojlsfjhfipubd.supabase.co/functions/v1/onsite-config";
var KLAVIYO_REVISION = "2025-10-15";
var ANONYMOUS_ID_KEY = "klaviyo_anonymous_id";
async function fetchCompanyId(storeId) {
  try {
    const r = await fetch(`${CONFIG_URL}?store=${storeId}`, { credentials: "omit" });
    if (!r.ok) return null;
    const c = await r.json();
    const v = c?.company_id;
    return isValidCompanyId(v) ? v : null;
  } catch {
    return null;
  }
}
async function anonymousId(nube) {
  const storage = nube.getBrowserAPIs().asyncLocalStorage;
  const existing = await storage.getItem(ANONYMOUS_ID_KEY);
  if (typeof existing === "string" && existing) return existing;
  const id = crypto.randomUUID();
  await storage.setItem(ANONYMOUS_ID_KEY, id);
  return id;
}
async function profileIdentifier(nube, state) {
  const email = state.customer?.contact?.email;
  if (email) return { email };
  return { anonymous_id: await anonymousId(nube) };
}
async function sendAddedToCart(nube, companyId, state) {
  const items = cartAddItems(state.eventPayload);
  if (!items.length) return;
  const currency = state.store?.currency_details?.code;
  const profile = await profileIdentifier(nube, state);
  for (const item of items) {
    try {
      await fetch(`https://a.klaviyo.com/client/events/?company_id=${encodeURIComponent(companyId)}`, {
        method: "POST",
        headers: { "content-type": "application/vnd.api+json", revision: KLAVIYO_REVISION },
        body: JSON.stringify(addedToCartEventBody(item, currency, profile))
      });
    } catch {
    }
  }
}
function App(nube) {
  let companyIdPromise = null;
  const getCompanyId = () => {
    if (!companyIdPromise) companyIdPromise = fetchCompanyId(nube.getState().store.id);
    return companyIdPromise;
  };
  nube.on("cart:add:success", async (state) => {
    const companyId = await getCompanyId();
    if (!companyId) return;
    await sendAddedToCart(nube, companyId, state);
  });
}
export {
  App
};
