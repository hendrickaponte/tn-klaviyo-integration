-- Tiendanube <-> Klaviyo MVP
-- Todas las tablas: RLS activo y SIN policies => solo accesibles con service_role (Edge Functions).
-- Tokens/API keys se guardan cifrados (AES-256-GCM) desde la aplicación, nunca en claro.

create table public.stores (
  store_id          text primary key check (store_id ~ '^[0-9]{1,12}$'),
  access_token_enc  text not null,
  store_name        text,
  country           text,
  main_currency     text,
  main_language     text,
  status            text not null default 'active' check (status in ('active', 'uninstalled')),
  installed_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.klaviyo_connections (
  store_id          text primary key references public.stores (store_id) on delete cascade,
  api_key_enc       text not null,
  account_id        text,
  account_name      text,
  connected_at      timestamptz not null default now()
);

create table public.klaviyo_settings (
  store_id                     text primary key references public.stores (store_id) on delete cascade,
  sync_profiles                boolean not null default true,
  sync_orders                  boolean not null default true,
  sync_catalog                 boolean not null default true,
  -- Por defecto NO suscribimos a marketing automáticamente (riesgo legal/consentimiento).
  subscribe_marketing_consent  boolean not null default false,
  klaviyo_list_id              text check (klaviyo_list_id is null or klaviyo_list_id ~ '^[A-Za-z0-9]{4,20}$'),
  placed_order_trigger         text not null default 'paid' check (placed_order_trigger in ('created', 'paid')),
  initial_sync_status          text not null default 'idle' check (initial_sync_status in ('idle', 'running', 'done', 'error')),
  initial_sync_at              timestamptz,
  updated_at                   timestamptz not null default now()
);

create table public.sync_logs (
  id           bigint generated always as identity primary key,
  store_id     text not null references public.stores (store_id) on delete cascade,
  event        text not null,
  resource_id  text,
  status       text not null check (status in ('ok', 'error', 'skipped')),
  detail       text,
  created_at   timestamptz not null default now()
);

create index sync_logs_store_created_idx on public.sync_logs (store_id, created_at desc);

alter table public.stores              enable row level security;
alter table public.klaviyo_connections enable row level security;
alter table public.klaviyo_settings    enable row level security;
alter table public.sync_logs           enable row level security;

revoke all on public.stores, public.klaviyo_connections, public.klaviyo_settings, public.sync_logs from anon, authenticated;
