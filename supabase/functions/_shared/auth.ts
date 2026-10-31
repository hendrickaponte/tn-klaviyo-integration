// Autenticación de la API de configuración (la llama el iframe embebido).
//
// ESTOY SUPONIENDO: que el SDK Nexo entrega un session token JWT HS256 firmado con el
// client secret de la app. Verificar contra la doc oficial de Tiendanube (nombre del método,
// claim que contiene el store_id, iss/aud). Si algo no coincide, falla CERRADO (401).
// Ajustable por env: SESSION_STORE_CLAIM (default "sub"), SESSION_ISS, SESSION_AUD.

import { b64urlToBytes } from "./crypto.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** SOLO desarrollo local. Se ignora si ENVIRONMENT=production. Nunca activar en producción. */
function devBypassAllowed(): boolean {
  return Deno.env.get("ALLOW_INSECURE_DEV_AUTH") === "true" &&
    Deno.env.get("ENVIRONMENT") !== "production";
}

export async function authenticate(req: Request): Promise<string> {
  if (devBypassAllowed()) {
    const h = req.headers.get("x-dev-store-id");
    if (h && /^\d{1,12}$/.test(h)) return h;
  }

  const secret = Deno.env.get("TN_APP_SECRET");
  if (!secret) throw new HttpError(500, "server_misconfigured");

  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
    req.headers.get("authorization") ?? "",
  );
  if (!m) throw new HttpError(401, "unauthorized");
  const [, h, p, s] = m;

  try {
    const header = JSON.parse(dec.decode(b64urlToBytes(h)));
    if (header?.alg !== "HS256") throw new Error("alg");

    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(s), enc.encode(`${h}.${p}`));
    if (!ok) throw new Error("sig");

    const payload = JSON.parse(dec.decode(b64urlToBytes(p)));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp <= now) throw new Error("exp");
    if (typeof payload.nbf === "number" && payload.nbf > now + 5) throw new Error("nbf");

    const iss = Deno.env.get("SESSION_ISS");
    if (iss && payload.iss !== iss) throw new Error("iss");
    // Verificado con un token real: aud = ID de la app. Se exige que coincida (evita aceptar tokens de otra app).
    const aud = Deno.env.get("SESSION_AUD") ?? Deno.env.get("TN_APP_ID");
    if (aud) {
      const auds = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).map(String);
      if (!auds.includes(aud)) throw new Error("aud");
    }

    // Verificado con un token real: `storeId` = tienda; `sub` = usuario del admin (NO usar sub).
    const claim = Deno.env.get("SESSION_STORE_CLAIM") ?? "storeId";
    const storeId = String(payload[claim] ?? "");
    if (!/^\d{1,12}$/.test(storeId)) throw new Error("store claim");
    return storeId;
  } catch {
    throw new HttpError(401, "unauthorized");
  }
}
