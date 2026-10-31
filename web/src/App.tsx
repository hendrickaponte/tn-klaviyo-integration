import { useCallback, useEffect, useState } from "react";
import { Alert, Box, Button, Card, Checkbox, Input, Select, Spinner, Table, Tag, Text, Title } from "@nimbus-ds/components";
import { ApiError, call, type Settings, type Status } from "./api";

const ERRORS: Record<string, string> = {
  invalid_api_key_format: "La API key no tiene un formato válido.",
  klaviyo_rejected_key: "Klaviyo rechazó la API key. Verifica que sea una Private API key con permisos de lectura de cuentas, perfiles, eventos y catálogo.",
  not_connected: "Primero conecta tu cuenta de Klaviyo.",
  unauthorized: "No se pudo validar tu sesión. Recarga la página desde el admin de Tiendanube.",
  store_not_active: "La app no está activa en esta tienda. Reinstálala desde el App Store.",
  invalid_public_key: "La Public API key debe tener 6 caracteres (letras y números).",
  invalid_klaviyo_list_id: "El ID de lista no es válido.",
};
const msg = (e: unknown) =>
  e instanceof ApiError ? (ERRORS[e.code] ?? `Error (${e.code}).`) : e instanceof Error ? e.message : "Error inesperado.";

const RESOURCE_LABEL = { customers: "Clientes", products: "Productos", orders: "Pedidos (últimos 12 meses)" } as const;
const RESOURCES = ["customers", "products", "orders"] as const;

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await call<Status>("status");
      setStatus(s);
      setSettings(s.settings);
      setError(null);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    run(async () => {
      await call("connect", { api_key: apiKey.trim() });
      setApiKey(""); // la key no permanece en memoria del navegador
      setNotice("Cuenta de Klaviyo conectada.");
      await load();
    });

  const disconnect = () =>
    run(async () => {
      await call("disconnect");
      setNotice("Cuenta desconectada. Se eliminó la API key.");
      await load();
    });

  const savePublicKey = () =>
    run(async () => {
      await call("save_public_key", { public_key: publicKey.trim() });
      setPublicKey("");
      setNotice("Public API key guardada.");
      await load();
    });

  const save = () =>
    run(async () => {
      if (!settings) return;
      const { sync_profiles, sync_orders, sync_catalog, subscribe_marketing_consent, onsite_enabled, klaviyo_list_id, placed_order_trigger } =
        settings;
      await call("save_settings", {
        settings: { sync_profiles, sync_orders, sync_catalog, subscribe_marketing_consent, onsite_enabled, klaviyo_list_id: klaviyo_list_id ?? "", placed_order_trigger },
      });
      setNotice("Configuración guardada.");
      await load();
    });

  const initialSync = () =>
    run(async () => {
      let failed = false;
      try {
        for (const resource of RESOURCES) {
          let page = 1;
          for (;;) {
            setProgress(`${RESOURCE_LABEL[resource]}: página ${page}…`);
            const r = await call<{ count: number; errors: number; done: boolean }>("sync_step", { resource, page });
            if (r.errors) failed = true;
            if (r.done) break;
            page++;
          }
        }
      } catch (e) {
        failed = true;
        throw e;
      } finally {
        setProgress(null);
        await call("sync_finish", { ok: !failed }).catch(() => undefined);
        await load();
      }
      if (!failed) setNotice("Sincronización inicial completada.");
      else setError("La sincronización terminó con errores. Revisa la actividad reciente.");
    });

  if (loading) {
    return (
      <Box padding="6" display="flex" justifyContent="center">
        <Spinner size="large" />
      </Box>
    );
  }

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => (s ? { ...s, [k]: v } : s));

  return (
    <Box padding="6" display="flex" flexDirection="column" gap="4" maxWidth="860px" marginX="auto">
      <Title as="h1" fontSize="h3">Klaviyo para Tiendanube</Title>

      {error && (
        <Alert appearance="danger" onRemove={() => setError(null)}>
          <Text>{error}</Text>
        </Alert>
      )}
      {notice && (
        <Alert appearance="success" onRemove={() => setNotice(null)}>
          <Text>{notice}</Text>
        </Alert>
      )}

      <Card>
        <Card.Header title="1. Conexión con Klaviyo" />
        <Card.Body>
          {status?.connected ? (
            <Box display="flex" flexDirection="column" gap="3">
              <Box display="flex" alignItems="center" gap="2">
                <Tag appearance="success">Conectado</Tag>
                <Text>{status.account_name ?? "Cuenta de Klaviyo"}</Text>
              </Box>
              <Box>
                <Button appearance="danger" onClick={disconnect} disabled={busy}>Desconectar</Button>
              </Box>
            </Box>
          ) : (
            <Box display="flex" flexDirection="column" gap="3">
              <Text>
                Crea una Private API key en Klaviyo (Configuración → API keys) con acceso a cuentas, perfiles, eventos,
                catálogo y suscripciones, y pégala aquí.
              </Text>
              <Input.Password
                id="klaviyo_api_key"
                name="klaviyo_api_key"
                autoComplete="off"
                placeholder="Private API key"
                value={apiKey}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)}
              />
              <Box>
                <Button appearance="primary" onClick={connect} disabled={busy || apiKey.trim().length < 20}>
                  Conectar
                </Button>
              </Box>
            </Box>
          )}
        </Card.Body>
      </Card>

      {status?.connected && settings && (
        <>
          <Card>
            <Card.Header title="2. Qué sincronizar" />
            <Card.Body>
              <Box display="flex" flexDirection="column" gap="3">
                <Checkbox name="sync_profiles" label="Clientes (perfiles)" checked={settings.sync_profiles}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("sync_profiles", e.target.checked)} />
                <Checkbox name="sync_orders" label="Pedidos (Placed Order, Ordered Product, Fulfilled Order, Cancelled Order)"
                  checked={settings.sync_orders}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("sync_orders", e.target.checked)} />
                <Checkbox name="sync_catalog" label="Catálogo de productos" checked={settings.sync_catalog}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("sync_catalog", e.target.checked)} />

                <Box display="flex" flexDirection="column" gap="1">
                  <Text fontWeight="bold">Evento "Placed Order" cuando el pedido…</Text>
                  <Select id="placed_order_trigger" name="placed_order_trigger" value={settings.placed_order_trigger}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      set("placed_order_trigger", e.target.value === "created" ? "created" : "paid")}>
                    <Select.Option value="paid" label="se paga (recomendado: no infla ingresos con pedidos impagos)" />
                    <Select.Option value="created" label="se crea" />
                  </Select>
                </Box>

                <Checkbox name="subscribe_marketing_consent"
                  label="Suscribir a marketing en Klaviyo a los clientes que aceptaron marketing en Tiendanube"
                  checked={settings.subscribe_marketing_consent}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("subscribe_marketing_consent", e.target.checked)} />
                {settings.subscribe_marketing_consent && (
                  <Alert appearance="warning" title="Revisa tu cumplimiento">
                    <Text>
                      Solo se suscriben clientes con consentimiento de marketing registrado en Tiendanube. Confirma que
                      cumple la normativa de tu país y la configuración de opt-in de tu lista en Klaviyo.
                    </Text>
                  </Alert>
                )}
                <Checkbox name="onsite_enabled"
                  label="Pop-ups, formularios y seguimiento de navegación en la tienda (script de Klaviyo)"
                  checked={settings.onsite_enabled}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("onsite_enabled", e.target.checked)} />
                {settings.onsite_enabled && !status?.public_key && (
                  <Box display="flex" flexDirection="column" gap="2">
                    <Alert appearance="warning" title="Falta la Public API key">
                      <Text>
                        Para activar los pop-ups pega tu Public API key de Klaviyo (6 caracteres; Configuración → API keys → Public API key / Site ID).
                      </Text>
                    </Alert>
                    <Box display="flex" gap="2">
                      <Input id="klaviyo_public_key" name="klaviyo_public_key" placeholder="Ej. AbC123" value={publicKey}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPublicKey(e.target.value)} />
                      <Button onClick={savePublicKey} disabled={busy || publicKey.trim().length !== 6}>Guardar key</Button>
                    </Box>
                  </Box>
                )}
                <Box display="flex" flexDirection="column" gap="1">
                  <Text fontWeight="bold">ID de lista de Klaviyo (opcional)</Text>
                  <Input id="klaviyo_list_id" name="klaviyo_list_id" placeholder="Ej. AbC123" value={settings.klaviyo_list_id ?? ""}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => set("klaviyo_list_id", e.target.value)} />
                </Box>
              </Box>
            </Card.Body>
            <Card.Footer>
              <Button appearance="primary" onClick={save} disabled={busy}>Guardar</Button>
            </Card.Footer>
          </Card>

          <Card>
            <Card.Header title="3. Sincronización inicial" />
            <Card.Body>
              <Box display="flex" flexDirection="column" gap="3">
                <Box display="flex" alignItems="center" gap="2">
                  <Text>Estado:</Text>
                  <Tag appearance={settings.initial_sync_status === "done" ? "success" : settings.initial_sync_status === "error" ? "danger" : settings.initial_sync_status === "running" ? "warning" : "neutral"}>
                    {{ idle: "Pendiente", running: "En curso", done: "Completa", error: "Con errores" }[settings.initial_sync_status]}
                  </Tag>
                </Box>
                <Text fontSize="caption">
                  Envía a Klaviyo tus clientes, productos y pedidos pagados de los últimos 12 meses. Mantén esta pestaña
                  abierta hasta que termine. Es seguro repetirla: no duplica datos.
                </Text>
                {progress && (
                  <Box display="flex" alignItems="center" gap="2">
                    <Spinner size="small" />
                    <Text>{progress}</Text>
                  </Box>
                )}
                <Box>
                  <Button appearance="primary" onClick={initialSync} disabled={busy}>Iniciar sincronización inicial</Button>
                </Box>
              </Box>
            </Card.Body>
          </Card>
        </>
      )}

      <Card>
        <Card.Header title="Actividad reciente" />
        <Card.Body>
          {status?.logs.length ? (
            <Table>
              <Table.Head>
                <Table.Row>
                  <Table.Cell as="th"><Text fontWeight="bold" fontSize="caption">Fecha</Text></Table.Cell>
                  <Table.Cell as="th"><Text fontWeight="bold" fontSize="caption">Evento</Text></Table.Cell>
                  <Table.Cell as="th"><Text fontWeight="bold" fontSize="caption">Estado</Text></Table.Cell>
                  <Table.Cell as="th"><Text fontWeight="bold" fontSize="caption">Detalle</Text></Table.Cell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {status.logs.map((l) => (
                  <Table.Row key={l.id}>
                    <Table.Cell><Text fontSize="caption">{new Date(l.created_at).toLocaleString()}</Text></Table.Cell>
                    <Table.Cell><Text fontSize="caption">{l.event}{l.resource_id ? ` #${l.resource_id}` : ""}</Text></Table.Cell>
                    <Table.Cell>
                      <Tag appearance={l.status === "ok" ? "success" : l.status === "error" ? "danger" : "neutral"}>{l.status}</Tag>
                    </Table.Cell>
                    <Table.Cell><Text fontSize="caption">{l.detail ?? ""}</Text></Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          ) : (
            <Text>Aún no hay actividad.</Text>
          )}
        </Card.Body>
      </Card>
    </Box>
  );
}
