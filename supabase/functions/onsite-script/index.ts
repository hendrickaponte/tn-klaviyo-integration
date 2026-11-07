// Sirve el script DOM de Klaviyo (carga klaviyo.js en la primera interacción) para instalarlo en el footer
// del tema:  <script async src="https://<ref>.supabase.co/functions/v1/onsite-script"></script>
// Es código público y estático (sin secretos ni datos de tiendas); la company se resuelve en el navegador
// llamando a `onsite-config`. CORS "*" porque lo cargan tiendas en dominios arbitrarios. Solo GET/HEAD.
import { SCRIPT } from "./script.ts";

const HEADERS: Record<string, string> = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: HEADERS });
  return new Response(req.method === "HEAD" ? null : SCRIPT, { status: 200, headers: HEADERS });
});
