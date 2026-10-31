import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/** Quita emails y secretos probables y recorta. Nunca se persiste PII ni credenciales en logs. */
export function sanitize(input: unknown): string {
  return String(input ?? "")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b(pk|sk)_[A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/bearer\s+[A-Za-z0-9._-]+/gi, "bearer [token]")
    .slice(0, 300);
}

export async function logSync(
  admin: SupabaseClient,
  storeId: string,
  event: string,
  resourceId: string | number | null,
  status: "ok" | "error" | "skipped",
  detail?: unknown,
): Promise<void> {
  const { error } = await admin.from("sync_logs").insert({
    store_id: storeId,
    event,
    resource_id: resourceId == null ? null : String(resourceId),
    status,
    detail: detail == null ? null : sanitize(detail),
  });
  if (error) console.error("logSync failed:", sanitize(error.message));
}
