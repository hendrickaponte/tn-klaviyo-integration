// Lógica de sincronización compartida por el webhook y el backfill inicial.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { decryptSecret } from "./crypto.ts";
import { logSync } from "./log.ts";
import * as kl from "./klaviyo.ts";
import * as m from "./mappers.ts";
import { assertId, tnFetch, tnGet, type TNCustomer, type TNOrder, type TNProduct, type TnStore } from "./tiendanube.ts";

export interface Settings {
  sync_profiles: boolean;
  sync_orders: boolean;
  sync_catalog: boolean;
  subscribe_marketing_consent: boolean;
  klaviyo_list_id: string | null;
  placed_order_trigger: "created" | "paid";
}

export interface Ctx {
  admin: SupabaseClient;
  storeId: string;
  tn: TnStore;
  apiKey: string;
  settings: Settings;
  /** Caché de productos por invocación (enriquece las líneas de pedido sin repetir llamadas a TN). */
  products?: m.ProductMap;
}

export type OrderSource = "order/created" | "order/paid" | "order/fulfilled" | "order/cancelled" | "backfill";
export type Result = "ok" | "skipped";

export async function loadCtx(admin: SupabaseClient, storeId: string): Promise<Ctx | null> {
  const { data: store } = await admin
    .from("stores").select("access_token_enc, status").eq("store_id", storeId).maybeSingle();
  if (!store || store.status !== "active") return null;
  const { data: conn } = await admin
    .from("klaviyo_connections").select("api_key_enc").eq("store_id", storeId).maybeSingle();
  if (!conn) return null;
  const { data: settings } = await admin
    .from("klaviyo_settings")
    .select("sync_profiles, sync_orders, sync_catalog, subscribe_marketing_consent, klaviyo_list_id, placed_order_trigger")
    .eq("store_id", storeId).maybeSingle();
  if (!settings) return null;
  return {
    admin,
    storeId,
    tn: { store_id: storeId, access_token: await decryptSecret(store.access_token_enc) },
    apiKey: await decryptSecret(conn.api_key_enc),
    settings: settings as Settings,
  };
}

const MAX_ENRICH_PRODUCTS = 20;

/**
 * Trae (con caché) los productos de las líneas del pedido para añadir URL, imagen, categorías y marca a los eventos.
 * Best-effort: si TN falla o el producto ya no existe, el evento sale igual, solo sin esos campos.
 */
async function loadOrderProducts(ctx: Ctx, o: TNOrder): Promise<m.ProductMap> {
  const cache = (ctx.products ??= new Map());
  const ids = [...new Set((o.products ?? []).map((l) => Number(l.product_id)).filter((n) => Number.isSafeInteger(n) && n > 0))]
    .filter((id) => !cache.has(id))
    .slice(0, MAX_ENRICH_PRODUCTS);
  await Promise.allSettled(ids.map(async (id) => {
    const p = await tnGet<TNProduct>(ctx.tn, `/products/${assertId(id)}`);
    if (p) cache.set(id, p);
  }));
  return cache;
}

export async function pushCustomer(ctx: Ctx, c: TNCustomer): Promise<Result> {
  if (!ctx.settings.sync_profiles) return "skipped";
  const attrs = m.customerToProfile(c);
  if (!attrs) return "skipped";
  await kl.upsertProfile(ctx.apiKey, attrs);
  if (ctx.settings.subscribe_marketing_consent && c.accepts_marketing) {
    await kl.subscribeEmails(ctx.apiKey, [attrs.email], ctx.settings.klaviyo_list_id);
  }
  return "ok";
}

export async function pushOrder(ctx: Ctx, o: TNOrder, source: OrderSource): Promise<Result> {
  if (!ctx.settings.sync_orders && !ctx.settings.sync_profiles) return "skipped";
  const profile = m.orderToProfile(o);
  if (!profile) return "skipped"; // pedido sin email válido

  if (ctx.settings.sync_profiles) await kl.upsertProfile(ctx.apiKey, profile);
  if (!ctx.settings.sync_orders) return "ok";

  const products = await loadOrderProducts(ctx, o);

  if (source === "order/fulfilled") {
    const ev = m.fulfilledOrderEvent(o, products);
    if (ev) await kl.createEvent(ctx.apiKey, ev);
    return "ok";
  }
  if (source === "order/cancelled") {
    const ev = m.cancelledOrderEvent(o, products);
    if (ev) await kl.createEvent(ctx.apiKey, ev);
    return "ok";
  }

  const trig = ctx.settings.placed_order_trigger;
  const emitPlaced = source === "backfill" ||
    (source === "order/created" && trig === "created") ||
    (source === "order/paid" && trig === "paid");
  if (!emitPlaced) return "skipped";

  const placed = m.placedOrderEvent(o, source === "backfill" ? "backfill" : trig, products);
  if (placed) await kl.createEvent(ctx.apiKey, placed);
  for (const ev of m.orderedProductEvents(o, products)) await kl.createEvent(ctx.apiKey, ev);
  return "ok";
}

/**
 * Sube el item y luego sus variantes. Con `cleanup` (webhooks) borra de Klaviyo las variantes que ya no existen en TN.
 * Una variante que falla no corta a las demás: se reporta el primer error al final.
 */
export async function pushProduct(ctx: Ctx, p: TNProduct, opts: { cleanup?: boolean } = {}): Promise<Result> {
  if (!ctx.settings.sync_catalog) return "skipped";
  const attrs = m.productToCatalog(p);
  if (!attrs) return "skipped";
  await kl.upsertCatalogItem(ctx.apiKey, attrs);

  const variants = m.productToVariants(p);
  let firstError: unknown = null;
  for (const v of variants) {
    try {
      await kl.upsertCatalogVariant(ctx.apiKey, attrs.external_id, v);
    } catch (e) {
      firstError ??= e;
    }
  }

  if (opts.cleanup && !firstError) {
    try {
      const keep = new Set(variants.map((v) => kl.variantFullId(v.external_id)));
      for (const id of await kl.listCatalogVariantIds(ctx.apiKey, attrs.external_id)) {
        if (!keep.has(id)) await kl.deleteCatalogVariantById(ctx.apiKey, id);
      }
    } catch (e) {
      firstError = e;
    }
  }
  if (firstError) throw firstError;
  return "ok";
}

export async function removeProduct(ctx: Ctx, productId: number): Promise<Result> {
  if (!ctx.settings.sync_catalog) return "skipped";
  await kl.deleteCatalogItem(ctx.apiKey, String(productId));
  return "ok";
}

// ---------- Backfill (sync inicial), una página por llamada ----------

export type Resource = "customers" | "products" | "orders";
const PER_PAGE = 25;
const CONCURRENCY = 3;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runSyncPage(
  ctx: Ctx,
  resource: Resource,
  page: number,
): Promise<{ count: number; errors: number; done: boolean }> {
  let path = `/${resource}?per_page=${PER_PAGE}&page=${page}`;
  if (resource === "orders") {
    const since = new Date(Date.now() - 365 * 86_400_000).toISOString();
    path += `&payment_status=paid&created_at_min=${encodeURIComponent(since)}`;
  }

  const resp = await tnFetch(ctx.tn, path);
  if (resp.status === 404) { // TN responde 404 al pedir una página fuera de rango
    await resp.body?.cancel();
    return { count: 0, errors: 0, done: true };
  }
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`TN list ${resource} failed (${resp.status})`);
  }
  const items = await resp.json() as Array<TNCustomer & TNOrder & TNProduct>;

  let count = 0;
  let errors = 0;
  await mapLimit(items, CONCURRENCY, async (item) => {
    try {
      const r = resource === "customers"
        ? await pushCustomer(ctx, item)
        : resource === "orders"
        ? await pushOrder(ctx, item, "backfill")
        : await pushProduct(ctx, item);
      if (r === "ok") count++;
    } catch (e) {
      errors++;
      await logSync(ctx.admin, ctx.storeId, `backfill/${resource}`, item.id, "error", e instanceof Error ? e.message : e);
    }
  });

  await logSync(ctx.admin, ctx.storeId, `backfill/${resource}`, `page ${page}`, errors ? "error" : "ok", `${count} ok, ${errors} errores`);
  return { count, errors, done: items.length < PER_PAGE };
}
