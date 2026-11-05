// Funciones puras del script de Added to Cart, separadas de main.ts para que el entrypoint que se
// bundlea y se sube al Partner Portal exporte ÚNICAMENTE `App` (igual que el template oficial de NubeSDK).
// Los tests importan este archivo directo; main.ts también lo importa, pero no reexporta nada de acá.
export type AddedItem = {
  product_id?: number;
  variant_id?: number;
  name?: string;
  price?: string | number;
  quantity?: number;
  sku?: string | null;
  url?: string;
  thumbnail?: string;
  variant_values?: string;
};

export type ProfileIdentifier = { email: string } | { anonymous_id: string };

export function isValidCompanyId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9]{6}$/.test(v);
}

/** state.eventPayload es un único item en Storefront y un array de items en Checkout. */
export function cartAddItems(eventPayload: unknown): AddedItem[] {
  if (Array.isArray(eventPayload)) return eventPayload as AddedItem[];
  if (eventPayload && typeof eventPayload === "object") return [eventPayload as AddedItem];
  return [];
}

export function money(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function httpsOnly(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https:\/\//i.test(s) ? s : undefined;
}

function clean<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out as T;
}

/** Body JSON:API para POST https://a.klaviyo.com/client/events/?company_id=... (Create Client Event). */
export function addedToCartEventBody(item: AddedItem, currency: string | undefined, profile: ProfileIdentifier) {
  const price = money(item.price);
  const quantity = money(item.quantity) || 1;
  const properties = clean({
    ProductID: item.product_id,
    VariantID: item.variant_id,
    ProductName: item.name,
    VariantName: item.variant_values,
    SKU: item.sku ?? undefined,
    Quantity: quantity,
    ItemPrice: price,
    RowTotal: price * quantity,
    ProductURL: httpsOnly(item.url),
    ImageURL: httpsOnly(item.thumbnail),
    "Source Name": "Tiendanube",
  });
  return {
    data: {
      type: "event",
      attributes: {
        properties,
        metric: { data: { type: "metric", attributes: { name: "Added to Cart" } } },
        profile: { data: { type: "profile", attributes: profile } },
        value: price * quantity,
        value_currency: currency,
        time: new Date().toISOString(),
      },
    },
  };
}
