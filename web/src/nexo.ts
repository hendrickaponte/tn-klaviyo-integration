// Único punto de contacto con el SDK Nexo (doc oficial: tiendanube.github.io/devhub-apps/es/docs/developer-tools/nexo).
//
// Flujo documentado: nexo.create({ clientId }) -> connect(nexo) (handshake, ttl por defecto 3000 ms)
// -> iAmReady(nexo). Si la app no completa el handshake a tiempo, el admin muestra
// "No fue posible cargar la aplicación". El session token se pide con getSessionToken(nexo).
//
// ESTOY SUPONIENDO (la doc no lo especifica): que el token es un JWT HS256 firmado con el client secret
// y que el store_id viaja en el claim `sub`. Se valida en supabase/functions/_shared/auth.ts (falla cerrado).
import nexo, { connect, getSessionToken, iAmReady } from "@tiendanube/nexo";

const DEV_STORE_ID = import.meta.env.VITE_DEV_STORE_ID as string | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let instance: any = null;
let ready: Promise<void> | null = null;

/** Handshake con el admin. Idempotente: llamarlo varias veces reutiliza la misma promesa. */
export function initNexo(): Promise<void> {
  if (DEV_STORE_ID) return Promise.resolve();
  if (!ready) {
    instance = nexo.create({ clientId: String(import.meta.env.VITE_TN_APP_ID), log: false });
    ready = connect(instance).then(() => {
      iAmReady(instance);
    });
  }
  return ready;
}

export interface Session {
  token: string | null; // null => modo desarrollo (header x-dev-store-id)
  devStoreId: string | null;
}

export async function getSession(): Promise<Session> {
  if (DEV_STORE_ID) return { token: null, devStoreId: DEV_STORE_ID };
  await initNexo();
  const token = await getSessionToken(instance);
  if (typeof token !== "string" || !token) throw new Error("Token de sesión inválido.");
  return { token, devStoreId: null };
}
