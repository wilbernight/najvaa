// Applied before first paint: light/dark choice and sidebar width (per browser only).
(function () {
  try {
    var t = localStorage.getItem('panel-theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    var n = localStorage.getItem('panel-nav');
    if (n === 'mini' || n === 'full') document.documentElement.setAttribute('data-nav', n);
  } catch (e) { /* storage blocked: follow the system */ }
})();
