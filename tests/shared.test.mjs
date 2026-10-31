import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

globalThis.Deno = { env: { get: (k) => process.env[k] } };
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.TN_APP_SECRET = "app-secret";
process.env.TN_APP_ID = "11111";
process.env.ENVIRONMENT = "production";

const { encryptSecret, decryptSecret, hmacSha256Hex, constantTimeEqual } = await import("../supabase/functions/_shared/crypto.ts");
const { authenticate, HttpError } = await import("../supabase/functions/_shared/auth.ts");
const m = await import("../supabase/functions/_shared/mappers.ts");
const { sanitize } = await import("../supabase/functions/_shared/log.ts");
const sync = await import("../supabase/functions/_shared/sync.ts");
const kl = await import("../supabase/functions/_shared/klaviyo.ts");

let n = 0; const t = async (name, fn) => { try { await fn(); n++; console.log("PASS", name); } catch (e) { console.log("FAIL", name, "\n  ", e.message); process.exitCode = 1; } };

await t("AES-GCM roundtrip + IV distinto + tamper falla", async () => {
  const a = await encryptSecret("pk_secret_123"), b = await encryptSecret("pk_secret_123");
  assert.notEqual(a, b); assert.equal(await decryptSecret(a), "pk_secret_123");
  const parts = a.split("."); parts[2] = parts[2].slice(0, -4) + "AAAA";
  await assert.rejects(() => decryptSecret(parts.join(".")));
  assert.ok(!a.includes("pk_secret"));
});

await t("HMAC-SHA256 vector conocido (RFC/Wikipedia)", async () => {
  assert.equal(await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  assert.ok(constantTimeEqual("ab", "ab")); assert.ok(!constantTimeEqual("ab", "ac")); assert.ok(!constantTimeEqual("ab", "abc"));
});

const b64u = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const jwt = (payload, { secret = "app-secret", alg = "HS256" } = {}) => {
  const h = b64u({ alg, typ: "JWT" }), p = b64u(payload);
  return `${h}.${p}.${createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
};
const req = (tok, extra = {}) => new Request("https://x", { method: "POST", headers: { authorization: `Bearer ${tok}`, ...extra } });
const exp = () => Math.floor(Date.now() / 1000) + 300;

// Claims verificados con un token real de Nexo: storeId = tienda, sub = usuario del admin, aud = id de la app.
const good = (extra = {}) => ({ storeId: "12345", sub: "999", aud: "11111", exp: exp(), ...extra });
await t("JWT válido devuelve storeId (NO sub)", async () => assert.equal(await authenticate(req(jwt(good()))), "12345"));
await t("JWT expirado / firma mala / alg none / sin exp / storeId inválido / aud ajeno => 401", async () => {
  for (const tok of [
    jwt(good({ exp: Math.floor(Date.now()/1000) - 10 })),
    jwt(good(), { secret: "otro" }),
    `${b64u({alg:"none"})}.${b64u(good())}.AAAA`,
    jwt(good({ exp: undefined })),
    jwt(good({ storeId: "1; drop" })),
    jwt(good({ storeId: undefined })),   // solo sub: no debe aceptarse como tienda
    jwt(good({ aud: "99999" })),
  ]) await assert.rejects(() => authenticate(req(tok)), (e) => e instanceof HttpError && e.status === 401);
  await assert.rejects(() => authenticate(new Request("https://x", { method: "POST" })), (e) => e.status === 401);
});
await t("bypass dev ignorado en producción; activo solo fuera de prod", async () => {
  process.env.ALLOW_INSECURE_DEV_AUTH = "true";
  await assert.rejects(() => authenticate(new Request("https://x", { headers: { "x-dev-store-id": "99" } })), (e) => e.status === 401);
  process.env.ENVIRONMENT = "development";
  assert.equal(await authenticate(new Request("https://x", { headers: { "x-dev-store-id": "99" } })), "99");
  process.env.ENVIRONMENT = "production"; delete process.env.ALLOW_INSECURE_DEV_AUTH;
});
await t("iss/aud se exigen si están configurados", async () => {
  process.env.SESSION_ISS = "tn";
  await assert.rejects(() => authenticate(req(jwt(good({ iss: "evil" })))));
  assert.equal(await authenticate(req(jwt(good({ iss: "tn" })))), "12345");
  delete process.env.SESSION_ISS;
});

await t("mappers: email/teléfono/nombre/ubicación", () => {
  assert.equal(m.cleanEmail("  Ana@Example.COM "), "ana@example.com"); assert.equal(m.cleanEmail("nope"), null);
  assert.equal(m.normalizePhone("+52 998 123-4567"), "+529981234567"); assert.equal(m.normalizePhone("998 123 4567"), undefined);
  const p = m.customerToProfile({ id: 7, name: "Ana María López", email: "ana@x.com", phone: "123", total_spent: "150.5", accepts_marketing: true, default_address: { address: "Calle 1", number: "22", city: "Cancún", country: "MX" } });
  assert.deepEqual([p.first_name, p.last_name, p.phone_number, p.location.address1, p.properties.tn_total_spent], ["Ana", "María López", undefined, "Calle 1 22", 150.5]);
  assert.equal(m.customerToProfile({ id: 1, email: "" }), null);
});
const order = { id: 10, number: 1001, total: "300.00", discount: "0", currency: "MXN", contact_email: "ana@x.com", contact_name: "Ana L", created_at: "2026-10-01T10:00:00-05:00", paid_at: "2026-10-01T10:05:00-05:00", products: [{ id: 1, product_id: 5, name: "Taza", sku: "T1", quantity: 2, price: "100.00" }, { id: 2, product_id: 6, name: "Plato", quantity: 1, price: "100.00" }] };
await t("mappers: Placed Order / Ordered Product / unique_id estables", () => {
  const p = m.placedOrderEvent(order, "paid");
  assert.equal(p.uniqueId, "tn-placed-order-10"); assert.equal(p.value, 300); assert.equal(p.time, order.paid_at);
  assert.equal(p.properties.ItemCount, 3); assert.deepEqual(p.properties.ItemNames, ["Taza", "Plato"]);
  const ops = m.orderedProductEvents(order);
  assert.deepEqual(ops.map((e) => [e.uniqueId, e.value]), [["tn-ordered-product-10-1", 200], ["tn-ordered-product-10-2", 100]]);
  assert.equal(m.placedOrderEvent({ ...order, contact_email: "x" }, "paid"), null);
});
await t("mappers: catálogo (url https obligatoria, precio mínimo, HTML fuera)", () => {
  const c = m.productToCatalog({ id: 5, name: { es: "Taza" }, description: { es: "<p>Linda <b>taza</b></p>" }, canonical_url: "https://t.mitiendanube.com/p/taza", variants: [{ id: 1, price: "100" }, { id: 2, price: "120", promotional_price: "80" }], images: [{ src: "https://img/1.jpg" }] });
  assert.deepEqual([c.external_id, c.description, c.price, c.published], ["5", "Linda taza", 80, true]);
  assert.equal(m.productToCatalog({ id: 6, name: { es: "x" }, canonical_url: "http://insecure" }), null);
});
await t("mappers: Placed Order enriquecido (descuento, envío, pago, direcciones, URL/imagen/categorías por línea)", () => {
  const rich = { ...order, subtotal: "280.00", discount: "20.00", shipping_cost_customer: "20.00", shipping_option: "Estándar", coupon: [{ code: "OCT10" }, { code: "ENVIO" }],
    gateway_name: "Mercado Pago", payment_details: { method: "credit_card", installments: 3 }, contact_phone: "+529981234567",
    shipping_address: { address: "Calle 1", number: "22", city: "Cancún", province: "QR", country: "MX", zipcode: "77500" },
    billing_address: "Av. Tulum", billing_number: "5", billing_city: "Cancún", billing_country: "MX",
    products: [{ id: 1, product_id: 5, variant_id: 50, name: "Taza", sku: "T1", quantity: 2, price: "100.00", variant_values: ["Rojo", "M"], image: { src: "https://img/l.jpg" } }, { id: 2, product_id: 6, name: "Plato", quantity: 1, price: "100.00" }] };
  const prods = new Map([[5, { id: 5, canonical_url: "https://t.mitiendanube.com/p/taza", images: [{ src: "https://img/1.jpg" }], categories: [{ id: 1, name: { es: "Cocina" } }], brand: "Acme" }]]);
  const e = m.placedOrderEvent(rich, "paid", prods).properties;
  assert.deepEqual([e.Subtotal, e.DiscountCode, e.DiscountValue, e.ShippingRate, e.ShippingOption, e.PaymentMethod, e.Installments], [280, "OCT10, ENVIO", 20, 20, "Estándar", "credit_card", 3]);
  assert.deepEqual(e.Categories, ["Cocina"]); assert.equal(e["Source Name"], "Tiendanube");
  assert.equal(e.Items[0].ProductURL, "https://t.mitiendanube.com/p/taza"); assert.equal(e.Items[0].ImageURL, "https://img/l.jpg"); // la imagen de la línea gana
  assert.equal(e.Items[0].VariantName, "Rojo / M"); assert.equal(e.Items[0].Brand, "Acme");
  assert.equal(e.Items[1].ProductURL, undefined); // producto no enriquecido: sale igual, sin esos campos
  assert.equal(e.ShippingAddress.Address1, "Calle 1 22"); assert.equal(e.BillingAddress.Address1, "Av. Tulum 5"); assert.equal(e.BillingAddress.City, "Cancún");
  const op = m.orderedProductEvents(rich, prods)[0].properties;
  assert.deepEqual([op.ProductURL, op.RowTotal, op.VariantName], ["https://t.mitiendanube.com/p/taza", 200, "Rojo / M"]);
  const f = m.fulfilledOrderEvent({ ...rich, shipping_tracking_number: "ABC", shipping_tracking_url: "http://inseguro" }, prods).properties;
  assert.equal(f.TrackingNumber, "ABC"); assert.equal(f.TrackingURL, undefined); assert.ok(f.Items.length === 2);
  assert.equal(m.cancelledOrderEvent({ ...rich, cancel_reason: "fraud" }, prods).properties.CancelReason, "fraud");
});
await t("mappers: billing_* plano no rompe el perfil (billing_address string) y sirve de ubicación", () => {
  const p = m.orderToProfile({ ...order, billing_address: "Av. Tulum", billing_number: "5", billing_city: "Cancún" });
  assert.equal(p.location.address1, "Av. Tulum 5"); assert.equal(p.location.city, "Cancún");
});
await t("mappers: retiro en tienda (zip 00000 filtrado, billing_name/phone, Address2 con piso/localidad)", () => {
  const pickup = { ...order, contact_phone: null, shipping_address: { name: "Camilo Acosta", address: "", number: "", floor: "", locality: "", city: "Benito Juárez", province: "Quintana Roo", country: "MX", zipcode: "77533", phone: "" },
    billing_address: "", billing_number: "", billing_city: "", billing_country: "MX", billing_zipcode: "00000", billing_name: "Camilo Acosta", billing_phone: "+525530802254" };
  const e = m.placedOrderEvent(pickup, "paid").properties;
  assert.equal(e.ShippingAddress.City, "Benito Juárez"); assert.equal(e.ShippingAddress.Address1, undefined); assert.equal(e.ShippingAddress.Zip, "77533");
  assert.equal(e.ShippingAddress.Phone, undefined); // sin teléfono en ningún lado => se omite, no se inventa
  assert.equal(m.orderToProfile(pickup).location.zip, "77533");
  const home = { ...pickup, billing_address: "Av. Tulum", billing_number: "5", billing_floor: "2", billing_locality: "Centro", billing_zipcode: "00000" };
  const b = m.placedOrderEvent(home, "paid").properties.BillingAddress;
  assert.deepEqual([b.Address1, b.Address2, b.Zip, b.Phone, b.FirstName, b.LastName], ["Av. Tulum 5", "2 Centro", undefined, "+525530802254", "Camilo", "Acosta"]);
});
await t("mappers: envío derivado (total-subtotal+descuento), redondeo, pickup=0, y name_without_variants", () => {
  const real = { ...order, subtotal: "998.00", discount: "99.80", total: "1027.20", products: [{ id: 1, product_id: 9, name: "Audifonos (Azul)", name_without_variants: "Audifonos", variant_values: ["Azul"], quantity: 1, price: "998.00" }] };
  const e = m.placedOrderEvent(real, "paid").properties;
  assert.equal(e.ShippingRate, 129); assert.equal(e.DiscountValue, 99.8); // sin ruido de coma flotante
  assert.deepEqual([e.Items[0].ProductName, e.Items[0].VariantName, e.ItemNames[0]], ["Audifonos", "Azul", "Audifonos"]);
  assert.equal(m.placedOrderEvent({ ...order, subtotal: "1285.7", discount: "0", total: "1285.70" }, "paid").properties.ShippingRate, 0);
  assert.equal(m.placedOrderEvent({ ...order, subtotal: "100", discount: "0", total: "50" }, "paid").properties.ShippingRate, undefined); // negativo => no se inventa
  assert.equal(m.placedOrderEvent({ ...order, subtotal: undefined }, "paid").properties.ShippingRate, undefined);
});
const product = { id: 5, name: { es: "Taza" }, description: { es: "d" }, canonical_url: "https://t.mitiendanube.com/p/taza", published: true,
  tags: "a, b", categories: [{ id: 1, name: { es: "Cocina" } }], images: [{ id: 9, src: "https://img/1.jpg" }, { id: 10, src: "https://img/2.jpg" }],
  variants: [
    { id: 50, sku: "T-R", price: "100.00", promotional_price: "80.00", stock: 3, stock_management: true, values: [{ es: "Rojo" }, { es: "M" }], image_id: 10 },
    { id: 51, sku: null, price: "100.00", stock: null, stock_management: false, values: [] },
    { id: 52, sku: "T-X", price: null, stock: 0, stock_management: true, values: [{ es: "Azul" }] },
  ] };
await t("mappers: variantes (título, sku fallback, stock, promo => compare_at, imagen por image_id)", () => {
  const [a, b, c] = m.productToVariants(product);
  assert.deepEqual([a.external_id, a.title, a.sku, a.inventory_quantity, a.price, a.custom_metadata.compare_at_price, a.image_full_url], ["50", "Taza - Rojo / M", "T-R", 3, 80, 100, "https://img/2.jpg"]);
  assert.deepEqual([b.title, b.sku, b.inventory_quantity, b.price, b.image_full_url], ["Taza", "tn-51", m.UNLIMITED_STOCK, 100, "https://img/1.jpg"]);
  assert.deepEqual([c.inventory_quantity, c.price], [0, undefined]); // agotada y sin precio (consulta)
  assert.equal(m.productToCatalog(product).custom_metadata.categories, "Cocina"); assert.equal(m.productToCatalog(product).price, 80);
  assert.deepEqual(m.productToVariants({ ...product, canonical_url: "http://x" }), []);
});
await t("sanitize quita emails, keys y bearer tokens", () => {
  const s = sanitize("fail ana@x.com key pk_abcdefghij12345 Bearer abc.def.ghi");
  assert.ok(!/ana@x|pk_abc|abc\.def/.test(s), s);
});

// ---- fetch simulado ----
const calls = []; let responder = () => new Response("{}", { status: 202 });
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body && JSON.parse(init.body) }); return responder(calls.length); };
const ctx = (settings) => ({ admin: {}, storeId: "1", tn: {}, apiKey: "pk_test_key_000000000000", settings: { sync_profiles: true, sync_orders: true, sync_catalog: true, subscribe_marketing_consent: false, klaviyo_list_id: null, placed_order_trigger: "paid", ...settings } });
const metrics = () => calls.filter((c) => c.url.endsWith("/api/events/")).map((c) => c.body.data.attributes.metric.data.attributes.name);

await t("trigger=paid: order/created NO emite; order/paid emite Placed + 2 Ordered Product", async () => {
  calls.length = 0;
  assert.equal(await sync.pushOrder(ctx({}), order, "order/created"), "skipped"); assert.deepEqual(metrics(), []);
  assert.equal(await sync.pushOrder(ctx({}), order, "order/paid"), "ok");
  assert.deepEqual(metrics(), ["Placed Order", "Ordered Product", "Ordered Product"]);
});
await t("trigger=created: order/created emite, order/paid no", async () => {
  calls.length = 0; const c = ctx({ placed_order_trigger: "created" });
  await sync.pushOrder(c, order, "order/paid"); assert.deepEqual(metrics(), []);
  await sync.pushOrder(c, order, "order/created"); assert.equal(metrics()[0], "Placed Order");
});
await t("fulfilled/cancelled emiten su métrica; sync_orders=false no emite eventos", async () => {
  calls.length = 0;
  await sync.pushOrder(ctx({}), order, "order/fulfilled"); await sync.pushOrder(ctx({}), order, "order/cancelled");
  assert.deepEqual(metrics(), ["Fulfilled Order", "Cancelled Order"]);
  calls.length = 0; await sync.pushOrder(ctx({ sync_orders: false }), order, "order/paid"); assert.deepEqual(metrics(), []);
});
await t("consentimiento: solo si setting activo Y accepts_marketing", async () => {
  const cust = { id: 1, name: "A B", email: "a@b.com", accepts_marketing: true };
  calls.length = 0; await sync.pushCustomer(ctx({}), cust);
  assert.ok(!calls.some((c) => c.url.includes("subscription")));
  await sync.pushCustomer(ctx({ subscribe_marketing_consent: true, klaviyo_list_id: "AbC123" }), cust);
  const sub = calls.find((c) => c.url.includes("subscription-bulk-create-jobs"));
  assert.equal(sub.body.data.relationships.list.data.id, "AbC123");
  calls.length = 0; await sync.pushCustomer(ctx({ subscribe_marketing_consent: true }), { ...cust, accepts_marketing: false });
  assert.ok(!calls.some((c) => c.url.includes("subscription")));
});
await t("Klaviyo: headers de auth/revision y reintento en 429 con Retry-After", async () => {
  calls.length = 0; responder = (i) => i === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "1" } }) : new Response("{}", { status: 202 });
  const t0 = Date.now(); await kl.upsertProfile("pk_test_key_000000000000", { email: "a@b.com" });
  assert.equal(calls.length, 2); assert.ok(Date.now() - t0 >= 900);
  assert.equal(calls[0].headers.Authorization, "Klaviyo-API-Key pk_test_key_000000000000"); assert.ok(calls[0].headers.revision);
  responder = () => new Response("{}", { status: 202 });
});
await t("Klaviyo: error 4xx no filtra la key ni reintenta; catálogo 409 => PATCH", async () => {
  calls.length = 0; responder = () => new Response(JSON.stringify({ errors: [{ detail: "bad" }] }), { status: 400 });
  await assert.rejects(() => kl.upsertProfile("pk_test_key_000000000000", { email: "a@b.com" }), (e) => !e.message.includes("pk_test") && e.status === 400);
  assert.equal(calls.length, 1);
  calls.length = 0; responder = (i) => i === 1 ? new Response(JSON.stringify({ errors: [{ detail: "dup" }] }), { status: 409 }) : new Response("{}", { status: 200 });
  await kl.upsertCatalogItem("pk_x_000000000000000000", { external_id: "5", title: "t", description: "d", url: "https://u", published: true });
  assert.deepEqual(calls.map((c) => c.method), ["POST", "PATCH"]); assert.ok(calls[1].url.includes(encodeURIComponent("$custom:::$default:::5")));
  assert.equal(calls[1].body.data.attributes.external_id, undefined);
});
await t("pushProduct: item primero, luego variantes con relación al item; cleanup borra las huérfanas", async () => {
  calls.length = 0;
  responder = (i) => String(calls[i - 1].url).includes("/variants/") && calls[i - 1].method === "GET"
    ? new Response(JSON.stringify({ data: [{ id: "$custom:::$default:::50" }, { id: "$custom:::$default:::999" }] }), { status: 200 })
    : new Response("{}", { status: 201 });
  assert.equal(await sync.pushProduct(ctx({}), product, { cleanup: true }), "ok");
  const seq = calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.equal(seq[0], "POST /api/catalog-items/");
  assert.deepEqual(seq.slice(1, 4), Array(3).fill("POST /api/catalog-variants/"));
  const v = calls[1].body.data;
  assert.equal(v.relationships.item.data.id, "$custom:::$default:::5"); assert.equal(v.attributes.integration_type, "$custom");
  const del = calls.filter((c) => c.method === "DELETE"); assert.equal(del.length, 1); assert.ok(del[0].url.includes(encodeURIComponent("$custom:::$default:::999")));
  calls.length = 0; await sync.pushProduct(ctx({}), product); // sin cleanup (backfill): no lista ni borra
  assert.ok(!calls.some((c) => c.method === "GET" || c.method === "DELETE"));
  responder = () => new Response("{}", { status: 202 });
});
await t("pushProduct: una variante que falla no corta a las demás y el error se reporta", async () => {
  calls.length = 0;
  responder = (i) => calls[i - 1].url.endsWith("/api/catalog-variants/") && calls[i - 1].body.data.attributes.external_id === "50"
    ? new Response(JSON.stringify({ errors: [{ detail: "bad variant" }] }), { status: 400 }) : new Response("{}", { status: 201 });
  await assert.rejects(() => sync.pushProduct(ctx({}), product), (e) => e.status === 400);
  assert.equal(calls.filter((c) => c.url.endsWith("/api/catalog-variants/")).length, 3);
  responder = () => new Response("{}", { status: 202 });
});
console.log(`\n${n} pruebas OK`);
