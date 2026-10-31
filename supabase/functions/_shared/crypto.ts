// Cifrado de secretos en reposo (AES-256-GCM) y utilidades HMAC.
// ENCRYPTION_KEY = 32 bytes aleatorios en base64 (openssl rand -base64 32).

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64e(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64d(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return b64d(t);
}

let keyPromise: Promise<CryptoKey> | null = null;

function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const raw = Deno.env.get("ENCRYPTION_KEY");
    if (!raw) throw new Error("ENCRYPTION_KEY not configured");
    const bytes = b64d(raw);
    if (bytes.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (base64)");
    keyPromise = crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return keyPromise;
}

/** Formato: v1.<iv b64>.<ciphertext+tag b64>. IV aleatorio de 12 bytes por cada cifrado (nunca se reutiliza). */
export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await getKey(), enc.encode(plain));
  return `v1.${b64e(iv)}.${b64e(ct)}`;
}

export async function decryptSecret(token: string): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("invalid secret format");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64d(parts[1]) },
    await getKey(),
    b64d(parts[2]),
  );
  return dec.decode(pt);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
