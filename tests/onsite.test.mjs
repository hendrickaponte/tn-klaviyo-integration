import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../onsite/klaviyo-onsite.js", import.meta.url), "utf8").replaceAll("<YOUR_PROJECT_REF>", "testref");
let n = 0; const t = async (name, fn) => { try { await fn(); n++; console.log("PASS", name); } catch (e) { console.log("FAIL", name, "\n  ", e.message); process.exitCode = 1; } };

function run({ LS, config, fetchFails = false, ogImage = "https://cdn.x/img.jpg" }) {
  const appended = []; const fetched = [];
  const win = { LS };
  const ctx = {
    window: win, location: { origin: "https://shop.example", pathname: "/productos/mouse/" },
    document: {
      head: { appendChild: (el) => appended.push(el) },
      createElement: () => ({}),
      querySelector: (q) => q.includes("og:image") && ogImage ? { getAttribute: () => ogImage } : null,
    },
    fetch: (url, o) => { fetched.push({ url, o }); return fetchFails ? Promise.reject(new Error("net")) : Promise.resolve({ ok: true, json: async () => config }); },
    encodeURIComponent, console,
  };
  win.window = win; vm.createContext(ctx); vm.runInContext(src, ctx);
  return { win, appended, fetched, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

await t("sin LS.store.id no hace nada (ni fetch)", async () => {
  const r = run({ LS: {}, config: { company_id: "AbC123" } }); await r.settle();
  assert.equal(r.fetched.length, 0); assert.equal(r.appended.length, 0);
});
await t("sin company_id (tienda sin Klaviyo/onsite apagado) no carga klaviyo.js", async () => {
  const r = run({ LS: { store: { id: 1234567 } }, config: { company_id: null } }); await r.settle();
  assert.equal(r.fetched[0].url, "https://testref.supabase.co/functions/v1/onsite-config?store=1234567");
  assert.equal(r.fetched[0].o.credentials, "omit"); assert.equal(r.appended.length, 0);
});
await t("company_id inválido (no 6 alfanum.) se ignora: no inyecta nada", async () => {
  const r = run({ LS: { store: { id: 1 } }, config: { company_id: "x\"><script>" } }); await r.settle();
  assert.equal(r.appended.length, 0);
});
await t("con key válida solo carga klaviyo.js (los eventos de producto los manda el SDK)", async () => {
  const r = run({ LS: { store: { id: 1234567 }, currency: "MXN", product: { id: 319628246, name: "Audifonos" } }, config: { company_id: "AbC123" } }); await r.settle();
  assert.equal(r.appended[0].src, "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=AbC123");
  assert.equal(r.win._learnq.length, 0);
});
await t("idempotente: cargarlo dos veces no duplica", async () => {
  const r = run({ LS: { store: { id: 5 } }, config: { company_id: "AbC123" } });
  vm.runInContext(src, vm.createContext({ window: r.win })); // 2.º intento con la misma window
  assert.equal(r.fetched.length, 1);
});
console.log(`\n${n} pruebas onsite OK`);
