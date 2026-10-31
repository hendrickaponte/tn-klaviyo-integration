// Callback OAuth de instalación. TN redirige aquí con ?code=XXX (expira en 5 min).
// Intercambia el code, guarda el token CIFRADO, registra webhooks y devuelve al merchant a su admin.
import { adminClient, must } from "../_shared/db.ts";
import { encryptSecret } from "../_shared/crypto.ts";
import { sanitize } from "../_shared/log.ts";
import { tnFetch, tnGet, TN_API_BASE, TN_API_VERSION } from "../_shared/tiendanube.ts";

const TOKEN_URL = "https://www.tiendanube.com/apps/authorize/token";

// Eventos a registrar. Los webhooks de privacidad (store/redact, customers/redact,
// customers/data_request) se configuran como URL en el portal de partners (ver README).
const WEBHOOK_EVENTS = [
  "app/uninstalled",
  "customer/created",
  "customer/updated",
  "order/created",
  "order/paid",
  "order/fulfilled",
  "order/cancelled",
  "product/created",
  "product/updated",
  "product/deleted",
];

// Solo redirigimos a dominios de admin conocidos (evita open redirect).
const ADMIN_HOST = /^[a-z0-9-]+\.mitiendanube\.com$/;

function fail(status: number): Response {
  return new Response("No se pudo completar la instalación. Intenta nuevamente desde el App Store.", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return fail(405);
  const code = new URL(req.url).searchParams.get("code") ?? "";
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(code)) return fail(400);

  const appId = Deno.env.get("TN_APP_ID");
  const appSecret = Deno.env.get("TN_APP_SECRET");
  if (!appId || !appSecret) return fail(500);

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: appId, client_secret: appSecret, grant_type: "authorization_code", code }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!tokenResp.ok) return fail(502);
    const tok = await tokenResp.json() as { access_token?: string; user_id?: number | string };
    const storeId = String(tok.user_id ?? "");
    if (!tok.access_token || !/^\d{1,12}$/.test(storeId)) return fail(502);

    const tn = { store_id: storeId, access_token: tok.access_token };
    const info = await tnGet<{
      name?: Record<string, string> | string;
      country?: string;
      main_currency?: string;
      main_language?: string;
      original_domain?: string;
    }>(tn, "/store");

    const storeName = typeof info?.name === "string"
      ? info.name
      : (info?.name?.es ?? info?.name?.pt ?? Object.values(info?.name ?? {})[0] ?? null);

    const admin = adminClient();
    must(
      await admin.from("stores").upsert({
        store_id: storeId,
        access_token_enc: await encryptSecret(tok.access_token),
        store_name: storeName,
        country: info?.country ?? null,
        main_currency: info?.main_currency ?? null,
        main_language: info?.main_language ?? null,
        status: "active",
        updated_at: new Date().toISOString(),
      }, { onConflict: "store_id" }),
    );

    // Registro de webhooks (idempotente: no duplica los ya registrados). Un fallo aquí no bloquea la instalación.
    try {
      const hookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/tn-webhook`;
      const existingResp = await tnFetch(tn, "/webhooks");
      const existing = existingResp.ok
        ? (await existingResp.json() as Array<{ event: string; url: string }>)
        : [];
      for (const event of WEBHOOK_EVENTS) {
        if (existing.some((w) => w.event === event && w.url === hookUrl)) continue;
        const r = await tnFetch(tn, "/webhooks", { method: "POST", body: JSON.stringify({ event, url: hookUrl }) });
        if (!r.ok) console.error(`webhook ${event} registration failed (${r.status})`);
        await r.body?.cancel();
      }
    } catch (e) {
      console.error("webhook registration error:", sanitize(e instanceof Error ? e.message : e));
    }

    const host = (info?.original_domain ?? "").toLowerCase();
    const target = ADMIN_HOST.test(host)
      ? `https://${host}/admin/` // NO usar /admin/apps/<id>/authorize: reinicia el OAuth y genera un bucle infinito.
      : "https://www.tiendanube.com/";
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("oauth callback error:", sanitize(e instanceof Error ? e.message : e), TN_API_BASE(), TN_API_VERSION());
    return fail(500);
  }
});
