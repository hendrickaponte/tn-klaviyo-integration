import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los inyecta Supabase en las Edge Functions.
export function adminClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function must<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(`db: ${res.error.message}`);
  return res.data;
}
