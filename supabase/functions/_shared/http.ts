// CORS estricto (allow-list por env) + headers de seguridad.
// ALLOWED_ORIGINS = "https://tu-frontend.vercel.app,https://otro.dominio" (nunca "*").

export function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = {
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  };
  if (origin && allowed.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Headers"] = "authorization, content-type, x-dev-store-id";
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}
