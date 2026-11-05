/* Tiendanube ⇄ Klaviyo — script onsite. ANTES DE SUBIRLO: reemplaza <YOUR_PROJECT_REF> en CONFIG_URL.
 * Partner Portal: Store, sin NubeSDK, instalación automática (disparador: el que tenga configurado el portal).
 * 1) Lee la tienda desde LS.store.id y pide la public key a la app. Sin key => no hace nada.
 * 2) Carga klaviyo.js (habilita pop-ups/formularios y Active on Site).
 * Viewed Product, Added to Cart y Started Checkout ya NO salen de acá: los manda el script NubeSDK
 * (onsite/nube-sdk). Este script solo carga klaviyo.js. */
(function () {
  "use strict";
  if (window.__tnKlaviyoOnsite) return;
  window.__tnKlaviyoOnsite = true;

  var CONFIG_URL = "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/onsite-config";

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

  fetch(CONFIG_URL + "?store=" + storeId, { credentials: "omit" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (c) { if (c && /^[A-Za-z0-9]{6}$/.test(c.company_id || "")) boot(c.company_id); })
    .catch(function () { /* silencioso: nunca romper la tienda */ });
})();
