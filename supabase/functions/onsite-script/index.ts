// Sirve el script DOM de Klaviyo (carga klaviyo.js en la primera interacción) para instalarlo en el footer
// del tema:  <script async src="https://<ref>.supabase.co/functions/v1/onsite-script"></script>
// Es código público y estático (sin secretos ni datos de tiendas); la company se resuelve en el navegador
// llamando a onsite-config. Un solo archivo para poder pegarlo en el editor del dashboard de Supabase.
// El script se guarda con String.raw para conservar las barras invertidas de las regex tal cual.
// CORS "*" porque lo cargan tiendas en dominios arbitrarios. Solo GET/HEAD.

const SCRIPT = String.raw`/* Tiendanube ⇄ Klaviyo — script onsite (DOM, sin NubeSDK).
 * Se instala en el footer del tema (Brand editor), NO en el Partner Portal:
 *   <script async src="https://darqvjlojlsfjhfipubd.supabase.co/functions/v1/onsite-script"></script>
 * Si cambia el proyecto de Supabase, edita CONFIG_URL.
 * 1) Espera la primera interacción del visitante (scroll, clic, tecla, mouse o toque).
 * 2) Lee la tienda desde LS.store.id y pide la public key a la app. Sin key => no hace nada.
 * 3) Carga klaviyo.js, que pinta formularios y pop-ups. (Active on Site lo manda el SDK por API.)
 * Viewed Product, Added to Cart y Started Checkout ya NO salen de acá: los manda el script NubeSDK
 * (onsite/nube-sdk). Este script solo carga klaviyo.js. */
(function () {
  "use strict";
  if (window.__tnKlaviyoOnsite) return;
  window.__tnKlaviyoOnsite = true;

  var CONFIG_URL = "https://darqvjlojlsfjhfipubd.supabase.co/functions/v1/onsite-config";

  var LS = window.LS || {};
  var storeId = LS.store && LS.store.id != null ? String(LS.store.id) : "";
  if (!/^\d{1,12}$/.test(storeId)) return;

  function boot(companyId) {
    window._learnq = window._learnq || [];
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=" + encodeURIComponent(companyId);
    document.head.appendChild(s);
  }

  function start() {
    fetch(CONFIG_URL + "?store=" + storeId, { credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (c) { if (c && /^[A-Za-z0-9]{6}$/.test(c.company_id || "")) boot(c.company_id); })
      .catch(function () { /* silencioso: nunca romper la tienda */ });
  }

  var EVENTS = ["scroll", "click", "keydown", "mousemove", "touchstart"];
  var started = false;
  function onFirstInteraction() {
    if (started) return;
    started = true;
    for (var i = 0; i < EVENTS.length; i++) window.removeEventListener(EVENTS[i], onFirstInteraction);
    start();
  }
  for (var i = 0; i < EVENTS.length; i++) window.addEventListener(EVENTS[i], onFirstInteraction, { passive: true, once: true });
})();
`;

const HEADERS: Record<string, string> = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEADERS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: HEADERS });
  return new Response(req.method === "HEAD" ? null : SCRIPT, { status: 200, headers: HEADERS });
});
