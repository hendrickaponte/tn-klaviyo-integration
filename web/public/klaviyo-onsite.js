/* Tiendanube ⇄ Klaviyo — script onsite (DOM, sin NubeSDK).
 * Se instala en el footer del tema (Brand editor), NO en el Partner Portal:
 *   <script async src="https://<dominio-del-frontend>/klaviyo-onsite.js"></script>
 * Si cambia el proyecto de Supabase, edita CONFIG_URL.
 * 1) Espera la primera interacción del visitante (scroll, clic, tecla, mouse o toque).
 * 2) Lee la tienda desde LS.store.id y pide la public key a la app. Sin key => no hace nada.
 * 3) Carga klaviyo.js (habilita pop-ups/formularios y Active on Site).
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
