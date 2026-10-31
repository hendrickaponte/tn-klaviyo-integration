/* Tiendanube ⇄ Klaviyo — script onsite. ANTES DE SUBIRLO: reemplaza <YOUR_PROJECT_REF> en CONFIG_URL.
 * Partner Portal: Store, onload, sin NubeSDK, instalación automática.
 * 1) Lee la tienda desde LS.store.id y pide la public key a la app. Sin key => no hace nada.
 * 2) Carga klaviyo.js (habilita pop-ups/formularios y Active on Site).
 * 3) Envía "Viewed Product" en páginas de producto. */
(function () {
  "use strict";
  if (window.__tnKlaviyoOnsite) return;
  window.__tnKlaviyoOnsite = true;

  var CONFIG_URL = "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/onsite-config";

  var LS = window.LS || {};
  var storeId = LS.store && LS.store.id != null ? String(LS.store.id) : "";
  if (!/^\d{1,12}$/.test(storeId)) return;

  function meta(prop) {
    var el = document.querySelector('meta[property="' + prop + '"]');
    var v = el && el.getAttribute("content");
    return v && /^https:\/\//i.test(v) ? v : undefined;
  }

  function viewedProduct() {
    var p = LS.product;
    if (!p || p.id == null) return;
    var url = location.origin + location.pathname;
    var item = { Name: p.name, ProductID: String(p.id), URL: url, ImageURL: meta("og:image") };
    if (LS.currency) item.Currency = LS.currency;
    if (typeof p.tags === "string" && p.tags) item.Tags = p.tags;
    window._learnq.push(["track", "Viewed Product", item]);
    window._learnq.push(["trackViewedItem", {
      Title: p.name, ItemId: String(p.id), ImageUrl: item.ImageURL, Url: url,
      Metadata: { Currency: LS.currency },
    }]);
  }

  function boot(companyId) {
    window._learnq = window._learnq || [];
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=" + encodeURIComponent(companyId);
    document.head.appendChild(s);
    viewedProduct();
  }

  fetch(CONFIG_URL + "?store=" + storeId, { credentials: "omit" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (c) { if (c && /^[A-Za-z0-9]{6}$/.test(c.company_id || "")) boot(c.company_id); })
    .catch(function () { /* silencioso: nunca romper la tienda */ });
})();
