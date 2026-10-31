// Cliente mínimo de la REST API de Tiendanube.
// Header de auth NO estándar: "Authentication: bearer <token>" (no "Authorization").

export const TN_API_BASE = () => Deno.env.get("TN_API_BASE") ?? "https://api.tiendanube.com";
export const TN_API_VERSION = () => Deno.env.get("TN_API_VERSION") ?? "2025-03";
const userAgent = () => Deno.env.get("TN_USER_AGENT") ?? "TN-Klaviyo-MVP (contact@example.com)";

export interface TnStore {
  store_id: string;
  access_token: string;
}

export interface TNAddress {
  name?: string | null;
  address?: string | null;
  number?: string | null;
  floor?: string | null;
  locality?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  zipcode?: string | null;
  phone?: string | null;
}

export interface TNCustomer {
  id: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  total_spent?: string | null;
  accepts_marketing?: boolean;
  default_address?: TNAddress | null;
}

export interface TNOrderLine {
  id?: number;
  product_id?: number;
  variant_id?: number;
  name?: string | null;
  name_without_variants?: string | null; // verificado en un pedido real: "name" incluye la variante, este no
  sku?: string | null;
  quantity?: number | string;
  price?: string | number;
  // Solo aparecen en los ejemplos de la doc (no en la tabla de propiedades): tipo no garantizado.
  image?: string | { src?: string | null } | null;
  variant_values?: unknown;
}

export interface TNOrder {
  id: number;
  number?: number;
  status?: string;
  payment_status?: string;
  shipping_status?: string;
  total?: string;
  subtotal?: string;
  discount?: string;
  currency?: string;
  contact_email?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  products?: TNOrderLine[];
  shipping_address?: TNAddress | null;
  // Según la doc, billing_* son campos PLANOS (billing_address es un string de calle), no un objeto.
  billing_address?: string | TNAddress | null;
  billing_number?: string | null;
  billing_floor?: string | null;
  billing_locality?: string | null;
  billing_name?: string | null;
  billing_phone?: string | null;
  billing_city?: string | null;
  billing_province?: string | null;
  billing_country?: string | null;
  billing_zipcode?: string | null;
  coupon?: Array<{ code?: string | null }> | null;
  shipping_cost_customer?: string | null;
  shipping_option?: string | null;
  shipping_pickup_type?: string | null;
  shipping_tracking_number?: string | null;
  shipping_tracking_url?: string | null;
  gateway?: string | null;
  gateway_name?: string | null;
  payment_details?: { method?: string | null; installments?: number | null } | null;
  cancel_reason?: string | null;
  language?: string | null;
  created_at?: string;
  updated_at?: string;
  paid_at?: string | null;
  cancelled_at?: string | null;
  closed_at?: string | null;
}

export interface TNVariant {
  id: number;
  sku?: string | null;
  price?: string | null; // null => el producto abre una consulta en vez de checkout
  promotional_price?: string | null;
  stock?: number | null; // null cuando stock_management=false (stock ilimitado)
  stock_management?: boolean;
  values?: Array<Record<string, string>> | null; // [{ es: "Rojo" }, { es: "M" }]
  barcode?: string | null;
  image_id?: number | null;
}

export interface TNProduct {
  id: number;
  name?: Record<string, string> | null;
  description?: Record<string, string> | null;
  canonical_url?: string | null;
  published?: boolean;
  brand?: string | Record<string, string> | null; // tipo no documentado
  tags?: string | null; // "a, b, c"
  categories?: Array<{ id?: number; name?: Record<string, string> | null }> | null;
  variants?: TNVariant[];
  images?: { id?: number; src?: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function assertId(id: unknown): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("invalid id");
  return n;
}

export async function tnFetch(
  store: TnStore,
  path: string,
  init: RequestInit = {},
  maxAttempts = 4,
): Promise<Response> {
  const url = `${TN_API_BASE()}/${TN_API_VERSION()}/${store.store_id}${path}`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resp = await fetch(url, {
      ...init,
      headers: {
        Authentication: `bearer ${store.access_token}`,
        "User-Agent": userAgent(),
        "Content-Type": "application/json; charset=utf-8",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    // 429 (rate limit leaky bucket) y 5xx: backoff exponencial 1s, 2s, 4s
    if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
      await resp.body?.cancel();
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return resp;
  }
  throw new Error("TN request failed after retries");
}

/** GET que devuelve JSON o null si 404. Lanza en otros errores (sin incluir cuerpo/URL con secretos). */
export async function tnGet<T>(store: TnStore, path: string): Promise<T | null> {
  const resp = await tnFetch(store, path);
  if (resp.status === 404) {
    await resp.body?.cancel();
    return null;
  }
  if (!resp.ok) {
    await resp.body?.cancel();
    throw new Error(`TN GET failed (${resp.status})`);
  }
  return await resp.json() as T;
}
