// Mapeo Tiendanube -> Klaviyo. Funciones puras (sin I/O) para poder testearlas.
import type { CatalogAttrs, CatalogVariantAttrs, KlaviyoEvent, ProfileAttrs } from "./klaviyo.ts";
import type { TNAddress, TNCustomer, TNOrder, TNOrderLine, TNProduct, TNVariant } from "./tiendanube.ts";

/** Productos ya consultados (id -> producto) para enriquecer las líneas de un pedido. Opcional. */
export type ProductMap = Map<number, TNProduct>;

// Klaviyo exige inventory_quantity en variantes. Con stock ilimitado (stock_management=false, stock=null)
// se envía un valor alto para que nunca figure como agotado. DECISIÓN de diseño, no viene de la doc de Klaviyo.
export const UNLIMITED_STOCK = 999_999;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const httpsOnly = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return /^https:\/\//i.test(s) ? s : undefined;
};

export function cleanEmail(v: unknown): string | null {
  const e = String(v ?? "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** Klaviyo exige E.164. Si no podemos garantizarlo, se omite (un teléfono inválido rechaza todo el perfil). */
export function normalizePhone(v: unknown): string | undefined {
  const p = String(v ?? "").replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : undefined;
}

export function localized(v: Record<string, string> | null | undefined): string {
  if (!v) return "";
  return v.es ?? v.pt ?? v.en ?? Object.values(v)[0] ?? "";
}

/** Algunos pedidos (retiro en tienda) traen zip de relleno "00000": no es un dato real. */
const realZip = (z: unknown): string | undefined => {
  const s = String(z ?? "").trim();
  return s && !/^0+$/.test(s) ? s : undefined;
};

function compact<T extends Record<string, unknown>>(o: T): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(o)) {
    const s = String(val ?? "").trim();
    if (s) out[k] = s;
  }
  return Object.keys(out).length ? out : undefined;
}

function location(a?: TNAddress | null): Record<string, string> | undefined {
  if (!a) return undefined;
  return compact({
    address1: [a.address, a.number].filter(Boolean).join(" "),
    city: a.city,
    region: a.province,
    country: a.country,
    zip: realZip(a.zipcode),
  });
}

function splitName(name?: string | null): { first_name?: string; last_name?: string } {
  const [first, ...rest] = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  return { first_name: first || undefined, last_name: rest.join(" ") || undefined };
}

/** Según la doc de TN, billing_* son campos planos; si algún día llega como objeto también se acepta. */
function billingAsAddress(o: TNOrder): TNAddress | null {
  if (o.billing_address && typeof o.billing_address === "object") return o.billing_address;
  const a: TNAddress = {
    address: typeof o.billing_address === "string" ? o.billing_address : null,
    number: o.billing_number,
    floor: o.billing_floor,
    locality: o.billing_locality,
    city: o.billing_city,
    province: o.billing_province,
    country: o.billing_country,
    zipcode: realZip(o.billing_zipcode),
  };
  // Con retiro en tienda solo llegan nombre/teléfono/país: se devuelve la dirección solo si hay algún dato de ubicación.
  if (!Object.values(a).some((v) => String(v ?? "").trim())) return null;
  return { ...a, name: o.billing_name, phone: o.billing_phone };
}

export function customerToProfile(c: TNCustomer): ProfileAttrs | null {
  const email = cleanEmail(c.email);
  if (!email) return null;
  return {
    email,
    ...splitName(c.name),
    phone_number: normalizePhone(c.phone ?? c.default_address?.phone),
    location: location(c.default_address),
    properties: {
      tn_customer_id: c.id,
      tn_total_spent: num(c.total_spent),
      tn_accepts_marketing: !!c.accepts_marketing,
    },
  };
}

export function orderToProfile(o: TNOrder): ProfileAttrs | null {
  const email = cleanEmail(o.contact_email);
  if (!email) return null;
  const addr = o.shipping_address ?? billingAsAddress(o);
  return {
    email,
    ...splitName(o.contact_name),
    phone_number: normalizePhone(o.contact_phone ?? addr?.phone),
    location: location(addr),
  };
}

// ---------- Pedidos ----------

interface ProductInfo {
  url?: string;
  image?: string;
  categories: string[];
  brand?: string;
}

function productInfo(p: TNProduct | undefined): ProductInfo {
  if (!p) return { categories: [] };
  const brand = typeof p.brand === "string" ? p.brand : localized(p.brand);
  return {
    url: httpsOnly(p.canonical_url),
    image: httpsOnly(p.images?.[0]?.src),
    categories: (p.categories ?? []).map((c) => localized(c.name).trim()).filter(Boolean),
    brand: brand.trim() || undefined,
  };
}

function lineImage(l: TNOrderLine): string | undefined {
  const i = l.image;
  return httpsOnly(typeof i === "string" ? i : i?.src);
}

/** variant_values no está tipado en la doc: acepta array de strings o de objetos localizados. */
function variantName(l: TNOrderLine): string | undefined {
  const v = l.variant_values;
  if (!Array.isArray(v)) return undefined;
  const parts = v.map((x) => typeof x === "string" ? x : typeof x === "object" && x ? localized(x as Record<string, string>) : "")
    .map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts.join(" / ") : undefined;
}

function lines(o: TNOrder, products?: ProductMap) {
  return (o.products ?? []).map((l, i) => {
    const info = productInfo(l.product_id ? products?.get(l.product_id) : undefined);
    const price = num(l.price);
    const qty = num(l.quantity);
    return {
      idx: l.id ?? i,
      ProductID: l.product_id,
      VariantID: l.variant_id,
      SKU: l.sku ?? undefined,
      ProductName: l.name_without_variants || l.name || "",
      VariantName: variantName(l),
      Quantity: qty,
      ItemPrice: price,
      RowTotal: price * qty,
      ProductURL: info.url,
      ImageURL: lineImage(l) ?? info.image,
      Categories: info.categories,
      Brand: info.brand,
    };
  });
}

/** Quita claves undefined/vacías para no ensuciar el evento. */
function clean<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

function eventAddress(a: TNAddress | null | undefined, fallbackName?: string | null, fallbackPhone?: string | null) {
  if (!a) return undefined;
  const { first_name, last_name } = splitName(a.name || fallbackName);
  const addr = clean({
    FirstName: first_name,
    LastName: last_name,
    Address1: [a.address, a.number].filter(Boolean).join(" ") || undefined,
    Address2: [a.floor, a.locality].filter(Boolean).join(" ") || undefined,
    City: a.city ?? undefined,
    Region: a.province ?? undefined,
    Country: a.country ?? undefined,
    Zip: realZip(a.zipcode),
    Phone: normalizePhone(a.phone) ?? normalizePhone(fallbackPhone),
  });
  return Object.keys(addr).length ? addr : undefined;
}

/**
 * TN (API 2025-03) no trae costo de envío como campo en el pedido (verificado con pedidos reales).
 * Se deriva: total = subtotal - descuento + envío  =>  envío = total - subtotal + descuento.
 * Validado con 2 pedidos reales (MX, sin impuestos aparte). ESTOY SUPONIENDO que no hay impuestos fuera del subtotal.
 * Si algún día el pedido trae shipping_cost_customer, tiene prioridad.
 */
function shippingRate(o: TNOrder): number | undefined {
  if (o.shipping_cost_customer !== undefined && o.shipping_cost_customer !== null) return num(o.shipping_cost_customer);
  if (o.total === undefined || o.subtotal === undefined) return undefined;
  const r = Math.round((num(o.total) - num(o.subtotal) + num(o.discount)) * 100) / 100;
  return r >= 0 ? r : undefined;
}

/** Propiedades comunes a todos los eventos de pedido (los nombres siguen la convención del evento Shopify de Klaviyo). */
function orderCommon(o: TNOrder, products?: ProductMap) {
  const ls = lines(o, products);
  const items = ls.map(({ idx: _i, ...rest }) => clean(rest));
  const codes = (o.coupon ?? []).map((c) => String(c?.code ?? "").trim()).filter(Boolean);
  const categories = [...new Set(ls.flatMap((l) => l.Categories))];
  const method = o.payment_details?.method ?? o.gateway_name ?? o.gateway ?? undefined;
  return {
    ls,
    props: clean({
      OrderId: o.id,
      OrderNumber: o.number,
      Currency: o.currency,
      Subtotal: o.subtotal !== undefined ? num(o.subtotal) : undefined,
      DiscountCode: codes.join(", ") || undefined,
      DiscountValue: num(o.discount),
      ShippingRate: shippingRate(o),
      ShippingOption: o.shipping_option ?? undefined,
      PickupType: o.shipping_pickup_type ?? undefined,
      PaymentMethod: method ?? undefined,
      Installments: o.payment_details?.installments ?? undefined,
      ItemCount: ls.reduce((s, i) => s + i.Quantity, 0),
      ItemNames: ls.map((i) => i.ProductName),
      Categories: categories,
      Items: items,
      ShippingAddress: eventAddress(o.shipping_address, o.contact_name, o.contact_phone),
      BillingAddress: eventAddress(billingAsAddress(o), o.contact_name, o.contact_phone),
      Language: o.language ?? undefined,
      "Source Name": "Tiendanube",
    }),
  };
}

export function placedOrderEvent(
  o: TNOrder,
  trigger: "created" | "paid" | "backfill",
  products?: ProductMap,
): KlaviyoEvent | null {
  const profile = orderToProfile(o);
  if (!profile) return null;
  const time = (trigger === "created" ? o.created_at : o.paid_at ?? o.created_at) ?? new Date().toISOString();
  return {
    metric: "Placed Order",
    profile,
    time,
    value: num(o.total),
    currency: o.currency,
    uniqueId: `tn-placed-order-${o.id}`,
    properties: { $event_id: String(o.id), $value: num(o.total), ...orderCommon(o, products).props },
  };
}

export function orderedProductEvents(o: TNOrder, products?: ProductMap): KlaviyoEvent[] {
  const profile = orderToProfile(o);
  if (!profile) return [];
  const time = o.paid_at ?? o.created_at ?? new Date().toISOString();
  const { ls } = orderCommon(o, products);
  return ls.map((l) => ({
    metric: "Ordered Product",
    profile,
    time,
    value: l.RowTotal,
    currency: o.currency,
    uniqueId: `tn-ordered-product-${o.id}-${l.idx}`,
    properties: clean({
      $event_id: `${o.id}-${l.idx}`,
      $value: l.RowTotal,
      OrderId: o.id,
      ProductID: l.ProductID,
      VariantID: l.VariantID,
      SKU: l.SKU,
      ProductName: l.ProductName,
      VariantName: l.VariantName,
      Quantity: l.Quantity,
      ItemPrice: l.ItemPrice,
      RowTotal: l.RowTotal,
      ProductURL: l.ProductURL,
      ImageURL: l.ImageURL,
      Categories: l.Categories,
      Brand: l.Brand,
      "Source Name": "Tiendanube",
    }),
  }));
}

export function fulfilledOrderEvent(o: TNOrder, products?: ProductMap): KlaviyoEvent | null {
  const profile = orderToProfile(o);
  if (!profile) return null;
  return {
    metric: "Fulfilled Order",
    profile,
    time: o.closed_at ?? o.updated_at ?? new Date().toISOString(),
    value: num(o.total),
    currency: o.currency,
    uniqueId: `tn-fulfilled-order-${o.id}`,
    properties: {
      $event_id: `${o.id}-fulfilled`,
      $value: num(o.total),
      ...orderCommon(o, products).props,
      ...clean({ TrackingNumber: o.shipping_tracking_number ?? undefined, TrackingURL: httpsOnly(o.shipping_tracking_url) }),
    },
  };
}

export function cancelledOrderEvent(o: TNOrder, products?: ProductMap): KlaviyoEvent | null {
  const profile = orderToProfile(o);
  if (!profile) return null;
  return {
    metric: "Cancelled Order",
    profile,
    time: o.cancelled_at ?? o.updated_at ?? new Date().toISOString(),
    value: num(o.total),
    currency: o.currency,
    uniqueId: `tn-cancelled-order-${o.id}`,
    properties: {
      $event_id: `${o.id}-cancelled`,
      $value: num(o.total),
      ...orderCommon(o, products).props,
      ...clean({ CancelReason: o.cancel_reason ?? undefined }),
    },
  };
}

// ---------- Catálogo ----------

function cleanDescription(p: TNProduct, fallback: string): string {
  return localized(p.description).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000) || fallback;
}

function variantLabel(v: TNVariant): string {
  return (v.values ?? []).map((x) => localized(x).trim()).filter(Boolean).join(" / ");
}

/** Precio efectivo (promocional si existe) y, si hay promo, el precio regular como "compare at". */
function variantPrices(v: TNVariant): { price?: number; compareAt?: number } {
  const regular = num(v.price);
  const promo = num(v.promotional_price);
  if (promo > 0 && (regular === 0 || promo < regular)) return { price: promo, compareAt: regular > 0 ? regular : undefined };
  return { price: regular > 0 ? regular : undefined };
}

/** Item de catálogo a nivel producto. Precio = mínimo entre variantes. Las variantes se mapean aparte. */
export function productToCatalog(p: TNProduct): CatalogAttrs | null {
  const url = p.canonical_url;
  if (!url || !/^https:\/\//i.test(url)) return null; // Klaviyo exige URL válida
  const title = localized(p.name).trim() || `Producto ${p.id}`;
  const prices = (p.variants ?? []).map((v) => variantPrices(v).price).filter((n): n is number => !!n);
  const img = p.images?.[0]?.src;
  const categories = (p.categories ?? []).map((c) => localized(c.name).trim()).filter(Boolean);
  const brand = typeof p.brand === "string" ? p.brand.trim() : localized(p.brand).trim();
  const meta = clean({
    categories: categories.join(", ") || undefined,
    brand: brand || undefined,
    tags: p.tags?.trim() || undefined,
  });
  return {
    external_id: String(p.id),
    title,
    description: cleanDescription(p, title),
    url,
    image_full_url: img && /^https:\/\//i.test(img) ? img : undefined,
    price: prices.length ? Math.min(...prices) : undefined,
    published: p.published !== false,
    custom_metadata: Object.keys(meta).length ? meta : undefined,
  };
}

/**
 * Variantes de un producto. `sku` es obligatorio en Klaviyo: si la variante no tiene, se usa `tn-<id>`.
 * La URL de la variante es la del producto (no está verificado que TN soporte un parámetro de variante).
 */
export function productToVariants(p: TNProduct): CatalogVariantAttrs[] {
  const item = productToCatalog(p);
  if (!item) return [];
  const published = item.published;
  return (p.variants ?? []).map((v) => {
    const label = variantLabel(v);
    const { price, compareAt } = variantPrices(v);
    const tracked = v.stock_management === true && typeof v.stock === "number";
    const imgSrc = p.images?.find((i) => i.id !== undefined && i.id === v.image_id)?.src;
    const meta = clean({
      compare_at_price: compareAt,
      barcode: v.barcode ?? undefined,
      stock_tracked: tracked,
    });
    return {
      external_id: String(v.id),
      title: label ? `${item.title} - ${label}` : item.title,
      description: item.description,
      url: item.url,
      sku: String(v.sku ?? "").trim() || `tn-${v.id}`,
      inventory_quantity: tracked ? Math.max(0, Math.trunc(v.stock as number)) : UNLIMITED_STOCK,
      image_full_url: httpsOnly(imgSrc) ?? item.image_full_url,
      price,
      published,
      custom_metadata: meta,
    };
  });
}
