// Receptor de webhooks de Tiendanube. Verifica HMAC, responde 200 rápido (TN corta a los 3 s)
// y procesa en segundo plano. El payload solo trae { store_id, event, id }: se consulta la API por el detalle.
import { adminClient } from "../_shared/db.ts";
import { constantTimeEqual, hmacSha256Hex } from "../_shared/crypto.ts";
import { logSync, sanitize } from "../_shared/log.ts";
import { assertId, tnGet, type TNCustomer, type TNOrder, type TNProduct } from "../_shared/tiendanube.ts";
import { loadCtx, pushCustomer, pushOrder, pushProduct, removeProduct, type OrderSource } from "../_shared/sync.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

const RESOURCE_EVENTS = new Set([
  "customer/created", "customer/updated",
  "order/created", "order/paid", "order/fulfilled", "order/cancelled",
  "product/created", "product/updated", "product/deleted",
]);
const LIFECYCLE_EVENTS = new Set([
  "app/uninstalled", "store/redact", "customers/redact", "customers/data_request",
]);

async function processEvent(storeId: string, event: string, id: number | null): Promise<void> {
  const admin = adminClient();

  if (event === "app/uninstalled" || event === "store/redact") {
    if (event === "store/redact") {
      await admin.from("stores").delete().eq("store_id", storeId); // cascade: conexión, settings, logs
    } else {
      // Minimización de datos: se elimina la API key de Klaviyo y se marca la tienda como desinstalada.
      await admin.from("klaviyo_connections").delete().eq("store_id", storeId);
      await admin.from("stores").update({ status: "uninstalled", updated_at: new Date().toISOString() })
        .eq("store_id", storeId);
    }
    return;
  }

  if (event === "customers/redact" || event === "customers/data_request") {
    // No almacenamos PII de clientes (solo ids en logs); los datos viven en Klaviyo bajo la cuenta del merchant.
    await logSync(admin, storeId, event, id, "skipped", "no customer PII stored by this app");
    return;
  }

  const ctx = await loadCtx(admin, storeId);
  if (!ctx) return; // tienda sin Klaviyo conectado
  if (id === null) return;

  try {
    let result = "skipped";
    if (event.startsWith("customer/")) {
      const c = await tnGet<TNCustomer>(ctx.tn, `/customers/${id}`);
      if (c) result = await pushCustomer(ctx, c);
    } else if (event.startsWith("order/")) {
      const o = await tnGet<TNOrder>(ctx.tn, `/orders/${id}`);
      if (o) result = await pushOrder(ctx, o, event as OrderSource);
    } else if (event === "product/deleted") {
      result = await removeProduct(ctx, id);
    } else if (event.startsWith("product/")) {
      const p = await tnGet<TNProduct>(ctx.tn, `/products/${id}`);
      if (p) result = await pushProduct(ctx, p, { cleanup: true });
    }
    await logSync(admin, storeId, event, id, result === "ok" ? "ok" : "skipped");
  } catch (e) {
    await logSync(admin, storeId, event, id, "error", e instanceof Error ? e.message : e);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });

  const secret = Deno.env.get("TN_APP_SECRET");
  if (!secret) return new Response(null, { status: 500 });

  const raw = await req.text();
  if (raw.length > 65_536) return new Response(null, { status: 413 });

  const sig = (req.headers.get("x-linkedstore-hmac-sha256") ?? "").toLowerCase();
  const expected = await hmacSha256Hex(secret, raw);
  if (!sig || !constantTimeEqual(sig, expected)) return new Response(null, { status: 401 });

  let p: { store_id?: unknown; event?: unknown; id?: unknown };
  try {
    p = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }

  const storeId = String(p.store_id ?? "");
  const event = String(p.event ?? "");
  if (!/^\d{1,12}$/.test(storeId) || !(RESOURCE_EVENTS.has(event) || LIFECYCLE_EVENTS.has(event))) {
    return new Response(null, { status: 200 }); // evento que no manejamos: ack para que TN no reintente
  }

  let id: number | null = null;
  if (p.id !== undefined && p.id !== null) {
    try {
      id = assertId(p.id);
    } catch {
      return new Response(null, { status: 400 });
    }
  }

  EdgeRuntime.waitUntil(
    processEvent(storeId, event, id).catch((e) =>
      console.error("webhook processing error:", sanitize(e instanceof Error ? e.message : e))
    ),
  );
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
