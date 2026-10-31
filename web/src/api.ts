import { getSession } from "./nexo";

const BASE = (import.meta.env.VITE_FUNCTIONS_URL as string | undefined)?.replace(/\/$/, "");

export class ApiError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface Settings {
  sync_profiles: boolean;
  sync_orders: boolean;
  sync_catalog: boolean;
  subscribe_marketing_consent: boolean;
  onsite_enabled: boolean;
  klaviyo_list_id: string | null;
  placed_order_trigger: "created" | "paid";
  initial_sync_status: "idle" | "running" | "done" | "error";
  initial_sync_at: string | null;
}

export interface LogRow {
  id: number;
  event: string;
  resource_id: string | null;
  status: "ok" | "error" | "skipped";
  detail: string | null;
  created_at: string;
}

export interface Status {
  store_name: string | null;
  connected: boolean;
  account_name: string | null;
  public_key: string | null;
  settings: Settings;
  logs: LogRow[];
}

export async function call<T = unknown>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!BASE) throw new ApiError("missing_VITE_FUNCTIONS_URL");
  const session = await getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (session.devStoreId) headers["x-dev-store-id"] = session.devStoreId;

  const resp = await fetch(`${BASE}/klaviyo-api`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new ApiError(typeof data?.error === "string" ? data.error : `http_${resp.status}`);
  return data as T;
}
