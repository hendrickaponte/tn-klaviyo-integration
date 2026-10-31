// Config pública para el script onsite de la tienda: devuelve SOLO la public key de Klaviyo (company_id).
// Esa key ya viaja en el HTML de cualquier tienda que use klaviyo.js, así que no es un secreto.
// CORS "*" es intencional: el script corre en dominios de tienda arbitrarios (propios del merchant) y no hay
// credenciales ni cookies. Solo GET, sin escritura. Respuesta idéntica para tienda inexistente o sin Klaviyo.
import { adminClient } from "../_shared/db.ts";

const BASE: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "X-Content-Type-Options": "nosniff",
  "Content-Type": "application/json; charset=utf-8",
};
const reply = (status: number, companyId: string | null, cache: string) =>
  new Response(JSON.stringify({ company_id: companyId }), { status, headers: { ...BASE, "Cache-Control": cache } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: BASE });
  if (req.method !== "GET") return new Response(null, { status: 405, headers: BASE });

  const store = new URL(req.url).searchParams.get("store") ?? "";
  if (!/^\d{1,12}$/.test(store)) return reply(200, null, "public, max-age=300");

  try {
    const admin = adminClient();
    const { data: st } = await admin.from("stores").select("status").eq("store_id", store).maybeSingle();
    if (st?.status !== "active") return reply(200, null, "public, max-age=300");
    const { data: conn } = await admin.from("klaviyo_connections").select("public_key").eq("store_id", store).maybeSingle();
    const { data: cfg } = await admin.from("klaviyo_settings").select("onsite_enabled").eq("store_id", store).maybeSingle();
    const key = conn?.public_key;
    const ok = cfg?.onsite_enabled === true && typeof key === "string" && /^[A-Za-z0-9]{6}$/.test(key);
    return reply(200, ok ? key : null, "public, max-age=300");
  } catch {
    return reply(500, null, "no-store");
  }
});
