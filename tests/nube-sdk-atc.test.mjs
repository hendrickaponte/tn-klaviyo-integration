import assert from "node:assert/strict";
import { App } from "../onsite/nube-sdk/src/main.ts";
import {
  addedToCartEventBody,
  localized,
  startedCheckoutEventBody,
  viewedProductEventBody,
  cartAddItems,
  httpsOnly,
  isValidCompanyId,
  money,
} from "../onsite/nube-sdk/src/lib.ts";

let n = 0; const t = async (name, fn) => { try { await fn(); n++; console.log("PASS", name); } catch (e) { console.log("FAIL", name, "\n  ", e.message); process.exitCode = 1; } };

await t("isValidCompanyId exige 6 alfanuméricos", () => {
  assert.ok(isValidCompanyId("AbC123"));
  assert.ok(!isValidCompanyId("x\"><script>"));
  assert.ok(!isValidCompanyId(""));
  assert.ok(!isValidCompanyId(undefined));
});

await t("cartAddItems normaliza Storefront (objeto) y Checkout (array)", () => {
  assert.deepEqual(cartAddItems({ id: 1 }), [{ id: 1 }]);
  assert.deepEqual(cartAddItems([{ id: 1 }, { id: 2 }]), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(cartAddItems(null), []);
  assert.deepEqual(cartAddItems(undefined), []);
});

await t("money tolera strings y basura", () => {
  assert.equal(money("12.50"), 12.5);
  assert.equal(money(undefined), 0);
  assert.equal(money("no-numero"), 0);
});

await t("httpsOnly descarta URLs no https", () => {
  assert.equal(httpsOnly("https://cdn.x/img.jpg"), "https://cdn.x/img.jpg");
  assert.equal(httpsOnly("http://inseguro/img.jpg"), undefined);
  assert.equal(httpsOnly(undefined), undefined);
});

await t("addedToCartEventBody arma el evento Added to Cart (perfil con email)", () => {
  const body = addedToCartEventBody(
    { product_id: 321, variant_id: 123, name: "Audifonos", price: "10.5", quantity: 2, sku: "AUD-1", url: "https://shop.example/p/1", thumbnail: "https://cdn.x/img.jpg" },
    "MXN",
    { email: "a@b.com" },
  );
  const attrs = body.data.attributes;
  assert.equal(attrs.metric.data.attributes.name, "Added to Cart");
  assert.deepEqual(attrs.profile.data.attributes, { email: "a@b.com" });
  assert.equal(attrs.value, 21);
  assert.equal(attrs.value_currency, "MXN");
  assert.equal(attrs.properties.ProductID, 321);
  assert.equal(attrs.properties.VariantID, 123);
  assert.equal(attrs.properties.Quantity, 2);
  assert.equal(attrs.properties.ItemPrice, 10.5);
  assert.equal(attrs.properties.RowTotal, 21);
  assert.equal(attrs.properties.ProductURL, "https://shop.example/p/1");
  assert.equal(attrs.properties["Source Name"], "Tiendanube");
});

await t("addedToCartEventBody con perfil anónimo y sin thumbnail/sku no ensucia properties", () => {
  const body = addedToCartEventBody({ product_id: 1, quantity: 1, price: 5 }, undefined, { anonymous_id: "v-1" });
  const attrs = body.data.attributes;
  assert.deepEqual(attrs.profile.data.attributes, { anonymous_id: "v-1" });
  assert.equal(attrs.value_currency, undefined);
  assert.ok(!("SKU" in attrs.properties));
  assert.ok(!("ImageURL" in attrs.properties));
  assert.equal(attrs.properties.RowTotal, 5);
});

function mockNube({ store = { id: 1234567 }, customer = null, eventPayload = null, storage = new Map() } = {}) {
  const listeners = {};
  const session = new Map();
  const nube = {
    on: (event, fn) => { listeners[event] = fn; },
    send: () => {},
    getState: () => ({ store, customer, eventPayload }),
    getBrowserAPIs: () => ({
      asyncLocalStorage: {
        getItem: async (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: async (k, v) => { storage.set(k, v); },
        removeItem: async (k) => { storage.delete(k); },
      },
      asyncSessionStorage: {
        getItem: async (k) => (session.has(k) ? session.get(k) : null),
        setItem: async (k, v) => { session.set(k, v); },
        removeItem: async (k) => { session.delete(k); },
      },
    }),
  };
  return { nube, listeners, storage };
}

await t("sin company_id (tienda sin Klaviyo/onsite apagado) no llama a Klaviyo", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({ company_id: null }) }; };
  try {
    const { nube, listeners } = mockNube({ eventPayload: { product_id: 1, quantity: 1, price: 1 } });
    App(nube);
    await listeners["cart:add:success"]({ store: { id: 1234567 }, customer: null, eventPayload: { product_id: 1, quantity: 1, price: 1 } });
    assert.equal(calls.length, 1); // solo el fetch al onsite-config, nunca a Klaviyo
    assert.ok(calls[0].includes("onsite-config"));
  } finally { globalThis.fetch = realFetch; }
});

await t("con company_id válida: manda Added to Cart a Klaviyo y cachea la company_id (no vuelve a pedirla)", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("onsite-config")) return { ok: true, json: async () => ({ company_id: "AbC123" }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const { nube, listeners } = mockNube();
    App(nube);
    const state = { store: { id: 5, currency_details: { code: "ARS" } }, customer: { contact: { email: "cliente@x.com" } }, eventPayload: { product_id: 9, quantity: 1, price: "100" } };
    await listeners["cart:add:success"](state);
    await listeners["cart:add:success"](state);

    const configCalls = calls.filter((c) => c.url.includes("onsite-config"));
    const klaviyoCalls = calls.filter((c) => c.url.startsWith("https://a.klaviyo.com/client/events"));
    assert.equal(configCalls.length, 1, "la company_id se cachea: un solo fetch a onsite-config");
    assert.equal(klaviyoCalls.length, 2, "cada cart:add:success manda su propio evento");
    assert.ok(klaviyoCalls[0].url.includes("company_id=AbC123"));
    assert.equal(klaviyoCalls[0].opts.headers.revision, "2025-10-15");
    const body = JSON.parse(klaviyoCalls[0].opts.body);
    assert.equal(body.data.attributes.profile.data.attributes.email, "cliente@x.com");
    assert.equal(body.data.attributes.properties.ProductID, 9);
  } finally { globalThis.fetch = realFetch; }
});

await t("checkout (eventPayload array): manda un evento por cada ítem, con anonymous_id persistido", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("onsite-config")) return { ok: true, json: async () => ({ company_id: "ZzZ999" }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const { nube, listeners, storage } = mockNube();
    App(nube);
    const state = {
      store: { id: 5, currency_details: { code: "ARS" } },
      customer: null,
      eventPayload: [{ product_id: 1, quantity: 1, price: 1 }, { product_id: 2, quantity: 3, price: 2 }],
    };
    await listeners["cart:add:success"](state);

    const klaviyoCalls = calls.filter((c) => c.url.startsWith("https://a.klaviyo.com/client/events"));
    assert.equal(klaviyoCalls.length, 2);
    const anon = storage.get("klaviyo_anonymous_id");
    assert.ok(typeof anon === "string" && anon.length > 0);
    for (const c of klaviyoCalls) {
      const body = JSON.parse(c.opts.body);
      assert.deepEqual(body.data.attributes.profile.data.attributes, { anonymous_id: anon });
    }
  } finally { globalThis.fetch = realFetch; }
});

await t("un fetch que rechaza (red caída) no rompe el listener", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("onsite-config")) return { ok: true, json: async () => ({ company_id: "AbC123" }) };
    throw new Error("net down");
  };
  try {
    const { nube, listeners } = mockNube();
    App(nube);
    await assert.doesNotReject(() => listeners["cart:add:success"]({
      store: { id: 5 }, customer: { contact: { email: "a@b.com" } }, eventPayload: { product_id: 1, quantity: 1, price: 1 },
    }));
  } finally { globalThis.fetch = realFetch; }
});

await t("localized prefiere el idioma de la tienda y cae al primero disponible", () => {
  assert.equal(localized({ es: "Hola", pt: "Oi" }, "pt"), "Oi");
  assert.equal(localized({ pt: "Oi" }, "es"), "Oi");
  assert.equal(localized("Plano"), "Plano");
  assert.equal(localized(undefined), undefined);
});

await t("viewedProductEventBody arma Viewed Product con precio de la primera variante", () => {
  const body = viewedProductEventBody(
    { id: 77, name: { es: "Remera" }, images: [{ src: "https://cdn.x/r.jpg" }], variants: [{ price: "250" }], tags: "a,b" },
    "https://shop.example/productos/remera/", "ARS", "es", { anonymous_id: "v-1" },
  );
  const a = body.data.attributes;
  assert.equal(a.metric.data.attributes.name, "Viewed Product");
  assert.equal(a.properties.ProductID, 77);
  assert.equal(a.properties.ProductName, "Remera");
  assert.equal(a.properties.ImageURL, "https://cdn.x/r.jpg");
  assert.equal(a.properties.Price, 250);
  assert.equal(a.value, 250);
  assert.equal(a.value_currency, "ARS");
});

await t("startedCheckoutEventBody arma Started Checkout con Items, $value y CheckoutURL", () => {
  const body = startedCheckoutEventBody(
    { id: "cart-1", items: [{ product_id: 1, variant_id: 2, name: "A", price: "10", quantity: 2, url: "https://s/a", thumbnail: "https://c/a.jpg" }], prices: { total: 25, subtotal: 20 } },
    "https://shop.example/checkout/v3/start/1", "ARS", { email: "a@b.com" },
  );
  const a = body.data.attributes;
  assert.equal(a.metric.data.attributes.name, "Started Checkout");
  assert.equal(a.properties.$event_id, "cart-1");
  assert.equal(a.properties.$value, 25);
  assert.deepEqual(a.properties.ItemNames, ["A"]);
  assert.equal(a.properties.CheckoutURL, "https://shop.example/checkout/v3/start/1");
  assert.equal(a.properties.Items[0].RowTotal, 20);
  assert.equal(a.value, 25);
});

function klaviyoMock(calls) {
  return async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("onsite-config")) return { ok: true, json: async () => ({ company_id: "AbC123" }) };
    return { ok: true, json: async () => ({}) };
  };
}
const eventsOf = (calls) => calls.filter((c) => c.url.startsWith("https://a.klaviyo.com/client/events"))
  .map((c) => JSON.parse(c.opts.body).data.attributes.metric.data.attributes.name);

await t("Viewed Product: page:loaded + location:updated en la misma URL manda un solo evento; en otra URL, otro", async () => {
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = klaviyoMock(calls);
  try {
    const { nube, listeners } = mockNube();
    App(nube);
    const st = (url, id) => ({
      store: { id: 5, language: "es", currency_details: { code: "ARS" } }, customer: null,
      location: { url, page: { type: "product", data: { product: { id, name: { es: "P" }, variants: [{ price: "1" }], images: [] } } } },
    });
    await listeners["page:loaded"](st("https://s/p1", 1));
    await listeners["location:updated"](st("https://s/p1", 1));
    await listeners["location:updated"](st("https://s/p2", 2));
    assert.deepEqual(eventsOf(calls), ["Viewed Product", "Viewed Product"]);
  } finally { globalThis.fetch = realFetch; }
});

await t("Viewed Product: páginas que no son de producto no mandan nada", async () => {
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = klaviyoMock(calls);
  try {
    const { nube, listeners } = mockNube();
    App(nube);
    await listeners["page:loaded"]({ store: { id: 5 }, customer: null, location: { url: "https://s/", page: { type: "home" } } });
    assert.deepEqual(eventsOf(calls), []);
  } finally { globalThis.fetch = realFetch; }
});

await t("Started Checkout: solo en step start, y no se repite para el mismo carrito", async () => {
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = klaviyoMock(calls);
  try {
    const { nube, listeners } = mockNube();
    App(nube);
    const st = (step) => ({
      store: { id: 5, currency_details: { code: "ARS" } }, customer: null,
      cart: { id: "c1", items: [{ product_id: 1, price: "5", quantity: 1 }], prices: { total: 5 } },
      location: { url: "https://s/checkout/start", page: { type: "checkout", data: { step } } },
    });
    await listeners["checkout:ready"](st("payment"));
    assert.deepEqual(eventsOf(calls), []);
    await listeners["checkout:ready"](st("start"));
    await listeners["checkout:ready"](st("start"));
    assert.deepEqual(eventsOf(calls), ["Started Checkout"]);
  } finally { globalThis.fetch = realFetch; }
});

console.log(`\n${n} pruebas nube-sdk OK`);
