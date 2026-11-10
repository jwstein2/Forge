/**
 * Shared site components for staging builds: checkout button, email capture, ledger beacon.
 * Everything is disconnected by default. A staging build can never take live payments:
 * checkout mode is "off" or "test" only, and the beacon only fires on hosts listed in config.
 */
export interface SiteRuntimeConfig {
  checkout: { mode: "off" | "test"; urls: Record<string, string | null> };
  email: { action: string | null };
  beacon: { url: string | null; hosts: string[]; site: string };
}

export function runtimeConfigJs(c: SiteRuntimeConfig): string {
  return `/* Staging runtime config. Edit to connect test-mode services; never put secrets here. */\nwindow.FORGE_SITE = ${JSON.stringify(c, null, 2)};\n`;
}

export const COMPONENTS_JS = `/* FORGE shared components (staging). No cookies, no storage, no identifiers. */
(function () {
  'use strict';
  var C = window.FORGE_SITE || { checkout: { mode: 'off', urls: {} }, email: { action: null }, beacon: { url: null, hosts: [], site: '' } };
  var safeUrl = function (u) { try { var x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch (e) { return null; } };

  // Checkout buttons: <a class="btn" data-checkout="prd_...">. Disabled unless test mode has an https URL for that product.
  document.querySelectorAll('[data-checkout]').forEach(function (el) {
    var id = el.getAttribute('data-checkout');
    var url = C.checkout.mode === 'test' ? safeUrl((C.checkout.urls || {})[id] || '') : null;
    var note = el.parentNode && el.parentNode.querySelector('.btn-note');
    if (url) { el.setAttribute('href', url); el.removeAttribute('aria-disabled'); if (note) note.textContent = 'Test-mode checkout: no real payment is taken.'; }
    else {
      el.removeAttribute('href'); el.setAttribute('aria-disabled', 'true'); el.setAttribute('role', 'link');
      el.addEventListener('click', function (e) { e.preventDefault(); });
      if (note) note.textContent = 'Checkout is not connected on this staging preview.';
    }
  });

  // Email capture: <form data-signup>. Disabled unless an https action is configured.
  document.querySelectorAll('form[data-signup]').forEach(function (f) {
    var action = safeUrl(C.email.action || '');
    var note = f.querySelector('.form-note');
    if (action) { f.setAttribute('action', action); f.setAttribute('method', 'post'); }
    else {
      f.querySelectorAll('input,button').forEach(function (i) { i.disabled = true; });
      if (note) note.textContent = 'Email signup is not connected on this staging preview.';
      f.addEventListener('submit', function (e) { e.preventDefault(); });
    }
  });

  // Beacon: anonymous daily counts, only on configured hosts, never with Do Not Track or GPC.
  var b = C.beacon || {};
  var url = safeUrl(b.url || '');
  if (!url || (b.hosts || []).indexOf(location.hostname) === -1) return;
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  function send(n) {
    try {
      var body = JSON.stringify({ n: n, p: location.pathname.toLowerCase() || '/', s: document.referrer ? 'ref' : 'direct', site: b.site });
      if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    } catch (e) { /* metrics are optional */ }
  }
  send('page_view');
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-track]') : null;
    if (el) send(el.getAttribute('data-track'));
  });
})();
`;
