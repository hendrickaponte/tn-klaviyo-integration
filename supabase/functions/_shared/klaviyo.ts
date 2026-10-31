// Cliente mínimo de la API de Klaviyo (JSON:API). Auth con private API key por tienda.
// Docs: https://developers.klaviyo.com/en/reference/api_overview
// Header de versión: "revision" (configurable con KLAVIYO_REVISION).
// ESTOY SUPONIENDO que la revisión 2025-10-15 sigue soportada; verificar en la política de deprecación de Klaviyo.

const BASE = "https://a.klaviyo.com";
const revision = () => Deno.env.get("KLAVIYO_REVISION") ?? "2025-10-15";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class KlaviyoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface KlaviyoResult {
  status: number;
  // deno-lint-ignore no-explicit-any
  body: any;
}

export async function klaviyo(
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
  maxAttempts = 4,
): Promise<KlaviyoResult> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resp = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${apiKey}`,
        revision: revision(),
        accept: "application/vnd.api+json",
        "content-type": "application/vnd.api+json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if ((resp.status === 429 || resp.status >= 500) && attempt < maxAttempts - 1) {
      const ra = Number(resp.headers.get("retry-after"));
      await resp.body?.cancel();
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 20) * 1000 : 1000 * 2 ** attempt);
      continue;
    }

    const text = await resp.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch { /* respuesta no JSON */ }
    }
    if (resp.status >= 400) {
      // deno-lint-ignore no-explicit-any
      const detail = (parsed as any)?.errors?.[0]?.detail ?? "request failed";
      throw new KlaviyoError(resp.status, `Klaviyo ${resp.status}: ${String(detail).slice(0, 200)}`);
    }
    return { status: resp.status, body: parsed };
  }
  throw new KlaviyoError(0, "Klaviyo request failed after retries");
}

export async function getAccount(apiKey: string): Promise<{ id: string; name: string | null; publicKey: string | null }> {
  const r = await klaviyo(apiKey, "GET", "/api/accounts/");
  const acct = r.body?.data?.[0];
  if (!acct?.id) throw new KlaviyoError(422, "No account returned");
  // ESTOY SUPONIENDO que attributes.public_api_key existe en esta revisión; si no, queda null y se pide en la UI.
  const pk = String(acct.attributes?.public_api_key ?? "").trim();
  return {
    id: String(acct.id),
    name: acct.attributes?.contact_information?.organization_name ?? null,
    publicKey: /^[A-Za-z0-9]{6}$/.test(pk) ? pk : null,
  };
}

export interface ProfileAttrs {
  email: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  location?: Record<string, string>;
  properties?: Record<string, unknown>;
}

/** Create-or-update (idempotente) por email. */
export async function upsertProfile(apiKey: string, attrs: ProfileAttrs): Promise<void> {
  await klaviyo(apiKey, "POST", "/api/profile-import/", { data: { type: "profile", attributes: attrs } });
}

export interface KlaviyoEvent {
  metric: string;
  profile: ProfileAttrs;
  properties: Record<string, unknown>;
  time: string;
  value?: number;
  currency?: string;
  uniqueId: string; // dedupe en Klaviyo => reintentos de webhooks no duplican eventos
}

export async function createEvent(apiKey: string, ev: KlaviyoEvent): Promise<void> {
  await klaviyo(apiKey, "POST", "/api/events/", {
    data: {
      type: "event",
      attributes: {
        properties: ev.properties,
        time: ev.time,
        value: ev.value,
        value_currency: ev.currency,
        unique_id: ev.uniqueId,
        metric: { data: { type: "metric", attributes: { name: ev.metric } } },
        profile: { data: { type: "profile", attributes: ev.profile } },
      },
    },
  });
}

/** Suscribe emails a marketing (opcionalmente a una lista). Máx. 1000 por job (lo respetamos por página de 25). */
export async function subscribeEmails(apiKey: string, emails: string[], listId?: string | null): Promise<void> {
  if (!emails.length) return;
  const profiles = emails.map((email) => ({
    type: "profile",
    attributes: { email, subscriptions: { email: { marketing: { consent: "SUBSCRIBED" } } } },
  }));
  const data: Record<string, unknown> = {
    type: "profile-subscription-bulk-create-job",
    attributes: { profiles: { data: profiles } },
  };
  if (listId) data.relationships = { list: { data: { type: "list", id: listId } } };
  await klaviyo(apiKey, "POST", "/api/profile-subscription-bulk-create-jobs/", { data });
}

export interface CatalogAttrs {
  external_id: string;
  title: string;
  description: string;
  url: string;
  image_full_url?: string;
  price?: number;
  published: boolean;
  custom_metadata?: Record<string, unknown>;
}

export interface CatalogVariantAttrs {
  external_id: string;
  title: string;
  description: string;
  url: string;
  sku: string;
  inventory_quantity: number;
  // La doc de Klaviyo es inconsistente con los valores (una página dice 1=ocultar sin stock, otra que el default es 0).
  // Solo se envía si el llamador lo pide; si Klaviyo lo rechaza, el error queda en sync_logs.
  inventory_policy?: number;
  image_full_url?: string;
  price?: number;
  published: boolean;
  custom_metadata?: Record<string, unknown>;
}

const catalogId = (externalId: string) => `$custom:::$default:::${externalId}`;

export async function upsertCatalogItem(apiKey: string, a: CatalogAttrs): Promise<void> {
  try {
    await klaviyo(apiKey, "POST", "/api/catalog-items/", {
      data: { type: "catalog-item", attributes: { integration_type: "$custom", catalog_type: "$default", ...a } },
    });
  } catch (e) {
    if (!(e instanceof KlaviyoError) || e.status !== 409) throw e;
    const { external_id: _omit, ...patchAttrs } = a;
    const id = catalogId(a.external_id);
    await klaviyo(apiKey, "PATCH", `/api/catalog-items/${encodeURIComponent(id)}/`, {
      data: { type: "catalog-item", id, attributes: patchAttrs },
    });
  }
}

export async function deleteCatalogItem(apiKey: string, externalId: string): Promise<void> {
  try {
    await klaviyo(apiKey, "DELETE", `/api/catalog-items/${encodeURIComponent(catalogId(externalId))}/`);
  } catch (e) {
    if (e instanceof KlaviyoError && e.status === 404) return;
    throw e;
  }
}

/** Crea/actualiza una variante colgada de un item. El item padre debe existir ANTES. */
export async function upsertCatalogVariant(apiKey: string, itemExternalId: string, a: CatalogVariantAttrs): Promise<void> {
  try {
    await klaviyo(apiKey, "POST", "/api/catalog-variants/", {
      data: {
        type: "catalog-variant",
        attributes: { integration_type: "$custom", catalog_type: "$default", ...a },
        relationships: { item: { data: { type: "catalog-item", id: catalogId(itemExternalId) } } },
      },
    });
  } catch (e) {
    if (!(e instanceof KlaviyoError) || e.status !== 409) throw e;
    const { external_id: _omit, ...patchAttrs } = a;
    const id = catalogId(a.external_id);
    await klaviyo(apiKey, "PATCH", `/api/catalog-variants/${encodeURIComponent(id)}/`, {
      data: { type: "catalog-variant", id, attributes: patchAttrs },
    });
  }
}

/** IDs completos de las variantes que Klaviyo tiene para un item (primera página, máx. 100). */
export async function listCatalogVariantIds(apiKey: string, itemExternalId: string): Promise<string[]> {
  try {
    const r = await klaviyo(apiKey, "GET", `/api/catalog-items/${encodeURIComponent(catalogId(itemExternalId))}/variants/`);
    return ((r.body?.data ?? []) as Array<{ id?: string }>).map((v) => String(v.id ?? "")).filter(Boolean);
  } catch (e) {
    if (e instanceof KlaviyoError && e.status === 404) return [];
    throw e;
  }
}

export async function deleteCatalogVariantById(apiKey: string, fullId: string): Promise<void> {
  try {
    await klaviyo(apiKey, "DELETE", `/api/catalog-variants/${encodeURIComponent(fullId)}/`);
  } catch (e) {
    if (e instanceof KlaviyoError && e.status === 404) return;
    throw e;
  }
}

export const variantFullId = (externalId: string) => catalogId(externalId);
