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

// ---- Viewed Product y Started Checkout (mismo patrón: Create Client Event con Public API key) ----

export type LocalizedName = Record<string, string | undefined> | string | undefined | null;

/** Los nombres de producto vienen localizados ({ es: "..." }). Prefiere el idioma de la tienda. */
export function localized(v: LocalizedName, lang?: string): string | undefined {
  if (typeof v === "string") return v || undefined;
  if (!v || typeof v !== "object") return undefined;
  if (lang && v[lang]) return v[lang];
  return Object.values(v).find((x) => typeof x === "string" && x) as string | undefined;
}

type ViewedProduct = {
  id?: number;
  name?: LocalizedName;
  images?: { src?: string }[];
  variants?: { price?: string | number | null }[];
  tags?: string;
};

export function viewedProductEventBody(
  product: ViewedProduct, url: string, currency: string | undefined, lang: string | undefined, profile: ProfileIdentifier,
) {
  const price = product.variants?.length ? money(product.variants[0].price) : undefined;
  const properties = clean({
    ProductID: product.id,
    ProductName: localized(product.name, lang),
    URL: httpsOnly(url),
    ImageURL: httpsOnly(product.images?.[0]?.src),
    Price: price || undefined,
    Currency: currency,
    Tags: product.tags || undefined,
    "Source Name": "Tiendanube",
  });
  return eventBody("Viewed Product", properties, profile, price, currency);
}

type CheckoutCart = {
  id?: string;
  items?: AddedItem[];
  prices?: { total?: number; subtotal?: number };
};

export function startedCheckoutEventBody(
  cart: CheckoutCart, checkoutUrl: string | undefined, currency: string | undefined, profile: ProfileIdentifier,
) {
  const items = (cart.items ?? []).map((i) => {
    const price = money(i.price);
    const quantity = money(i.quantity) || 1;
    return clean({
      ProductID: i.product_id,
      VariantID: i.variant_id,
      SKU: i.sku ?? undefined,
      ProductName: i.name,
      Quantity: quantity,
      ItemPrice: price,
      RowTotal: price * quantity,
      ProductURL: httpsOnly(i.url),
      ImageURL: httpsOnly(i.thumbnail),
    });
  });
  const value = money(cart.prices?.total) || money(cart.prices?.subtotal);
  const properties = clean({
    $event_id: cart.id,
    $value: value,
    ItemNames: items.map((i) => i.ProductName).filter(Boolean),
    CheckoutURL: httpsOnly(checkoutUrl),
    Items: items,
    "Source Name": "Tiendanube",
  });
  return eventBody("Started Checkout", properties, profile, value, currency);
}

function eventBody(
  metric: string, properties: Record<string, unknown>, profile: ProfileIdentifier,
  value: number | undefined, currency: string | undefined,
) {
  return {
    data: {
      type: "event",
      attributes: {
        properties,
        metric: { data: { type: "metric", attributes: { name: metric } } },
        profile: { data: { type: "profile", attributes: profile } },
        value,
        value_currency: currency,
        time: new Date().toISOString(),
      },
    },
  };
}

/** Ruta sin parámetros de seguimiento (utm_*, etc.): solo origen + path. */
export function cleanPageUrl(url: string | undefined): string | undefined {
  try {
    if (!url) return undefined;
    const u = new URL(url);
    return httpsOnly(u.origin + u.pathname);
  } catch {
    return undefined;
  }
}

/** "Active on Site" enviado por la API (klaviyo.js solo lo genera para navegadores identificados). */
export function activeOnSiteEventBody(pageUrl: string | undefined, profile: ProfileIdentifier) {
  const properties = clean({ page: cleanPageUrl(pageUrl), "Source Name": "Tiendanube" });
  return eventBody("Active on Site", properties, profile, undefined, undefined);
}
