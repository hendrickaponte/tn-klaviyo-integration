// API de configuración que consume el iframe embebido. Una sola función, POST { action, ... }.
// Auth: session token (ver _shared/auth.ts). Nunca devuelve secretos.
import { adminClient, must } from "../_shared/db.ts";
import { authenticate, HttpError } from "../_shared/auth.ts";
import { encryptSecret } from "../_shared/crypto.ts";
import { corsHeaders, json } from "../_shared/http.ts";
import { sanitize } from "../_shared/log.ts";
import * as kl from "../_shared/klaviyo.ts";
import { loadCtx, runSyncPage, type Resource } from "../_shared/sync.ts";

const BOOL_KEYS = ["sync_profiles", "sync_orders", "sync_catalog", "subscribe_marketing_consent", "onsite_enabled"] as const;
const RESOURCES: Resource[] = ["customers", "products", "orders"];

const DEFAULT_SETTINGS = {
  sync_profiles: true,
  sync_orders: true,
  sync_catalog: true,
  subscribe_marketing_consent: false,
  onsite_enabled: true,
  klaviyo_list_id: null,
  placed_order_trigger: "paid",
  initial_sync_status: "idle",
  initial_sync_at: null,
};

Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, cors);

  try {
    const storeId = await authenticate(req);

    const raw = await req.text();
    if (raw.length > 16_384) throw new HttpError(413, "payload_too_large");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "invalid_json");
    }

    const admin = adminClient();
    const store = must(
      await admin.from("stores").select("store_name, status").eq("store_id", storeId).maybeSingle(),
    );
    if (!store || store.status !== "active") throw new HttpError(403, "store_not_active");

    switch (body.action) {
      case "status": {
        const conn = must(
          await admin.from("klaviyo_connections").select("account_name, connected_at, public_key").eq("store_id", storeId)
            .maybeSingle(),
        );
        const settings = must(
          await admin.from("klaviyo_settings")
            .select("sync_profiles, sync_orders, sync_catalog, subscribe_marketing_consent, onsite_enabled, klaviyo_list_id, placed_order_trigger, initial_sync_status, initial_sync_at")
            .eq("store_id", storeId).maybeSingle(),
        );
        const logs = must(
          await admin.from("sync_logs").select("id, event, resource_id, status, detail, created_at")
            .eq("store_id", storeId).order("created_at", { ascending: false }).limit(20),
        );
        return json(200, {
          store_name: store.store_name,
          connected: !!conn,
          account_name: conn?.account_name ?? null,
          public_key: conn?.public_key ?? null,
          settings: settings ?? DEFAULT_SETTINGS,
          logs: logs ?? [],
        }, cors);
      }

      case "connect": {
        const apiKey = String(body.api_key ?? "").trim();
        if (!/^[A-Za-z0-9_-]{20,128}$/.test(apiKey)) throw new HttpError(400, "invalid_api_key_format");
        let acct;
        try {
          acct = await kl.getAccount(apiKey);
        } catch {
          // Posibles causas: key inválida o sin scope accounts:read. No se filtra detalle al cliente.
          throw new HttpError(422, "klaviyo_rejected_key");
        }
        must(
          await admin.from("klaviyo_connections").upsert({
            store_id: storeId,
            api_key_enc: await encryptSecret(apiKey),
            account_id: acct.id,
            account_name: acct.name,
            connected_at: new Date().toISOString(),
            ...(acct.publicKey ? { public_key: acct.publicKey } : {}),
          }, { onConflict: "store_id" }),
        );
        must(
          await admin.from("klaviyo_settings").upsert({ store_id: storeId }, {
            onConflict: "store_id",
            ignoreDuplicates: true,
          }),
        );
        return json(200, { ok: true, account_name: acct.name }, cors);
      }

      case "disconnect": {
        must(await admin.from("klaviyo_connections").delete().eq("store_id", storeId));
        must(
          await admin.from("klaviyo_settings").update({ initial_sync_status: "idle", updated_at: new Date().toISOString() })
            .eq("store_id", storeId),
        );
        return json(200, { ok: true }, cors);
      }

      case "save_public_key": {
        const pk = String(body.public_key ?? "").trim();
        if (!/^[A-Za-z0-9]{6}$/.test(pk)) throw new HttpError(400, "invalid_public_key");
        const rows = must(
          await admin.from("klaviyo_connections").update({ public_key: pk }).eq("store_id", storeId).select("store_id"),
        );
        if (!rows?.length) throw new HttpError(409, "not_connected");
        return json(200, { ok: true }, cors);
      }

      case "save_settings": {
        const s = body.settings as Record<string, unknown> | undefined;
        if (!s || typeof s !== "object") throw new HttpError(400, "invalid_settings");
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        for (const k of BOOL_KEYS) {
          if (k in s) {
            if (typeof s[k] !== "boolean") throw new HttpError(400, `invalid_${k}`);
            patch[k] = s[k];
          }
        }
        if ("placed_order_trigger" in s) {
          if (s.placed_order_trigger !== "created" && s.placed_order_trigger !== "paid") {
            throw new HttpError(400, "invalid_placed_order_trigger");
          }
          patch.placed_order_trigger = s.placed_order_trigger;
        }
        if ("klaviyo_list_id" in s) {
          const v = String(s.klaviyo_list_id ?? "").trim();
          if (v && !/^[A-Za-z0-9]{4,20}$/.test(v)) throw new HttpError(400, "invalid_klaviyo_list_id");
          patch.klaviyo_list_id = v || null;
        }
        must(await admin.from("klaviyo_settings").update(patch).eq("store_id", storeId));
        return json(200, { ok: true }, cors);
      }

      case "sync_step": {
        const resource = body.resource as Resource;
        const page = Number(body.page);
        if (!RESOURCES.includes(resource) || !Number.isInteger(page) || page < 1 || page > 2000) {
          throw new HttpError(400, "invalid_sync_params");
        }
        const ctx = await loadCtx(admin, storeId);
        if (!ctx) throw new HttpError(409, "not_connected");
        if (resource === "customers" && page === 1) {
          must(
            await admin.from("klaviyo_settings").update({ initial_sync_status: "running", updated_at: new Date().toISOString() })
              .eq("store_id", storeId),
          );
        }
        const r = await runSyncPage(ctx, resource, page);
        return json(200, r, cors);
      }

      case "sync_finish": {
        const ok = body.ok === true;
        must(
          await admin.from("klaviyo_settings").update({
            initial_sync_status: ok ? "done" : "error",
            initial_sync_at: ok ? new Date().toISOString() : null,
            updated_at: new Date().toISOString(),
          }).eq("store_id", storeId),
        );
        return json(200, { ok: true }, cors);
      }

      default:
        throw new HttpError(400, "unknown_action");
    }
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message }, cors);
    console.error("klaviyo-api error:", sanitize(e instanceof Error ? e.message : e));
    return json(500, { error: "internal_error" }, cors);
  }
});
