-- Scripts onsite: public key de Klaviyo (es pública por diseño: va en el HTML de la tienda) e interruptor por tienda.
alter table public.klaviyo_connections add column if not exists public_key text
  check (public_key is null or public_key ~ '^[A-Za-z0-9]{6}$');
alter table public.klaviyo_settings add column if not exists onsite_enabled boolean not null default true;
