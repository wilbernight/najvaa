// Cap widget settings (loaded before cap.min.js). Everything is served from
// this site: no CDN, no third-party requests, no page URL sent anywhere.
window.CAP_CUSTOM_WASM_URL = '/cap/cap_wasm_bg.wasm';
window.CAP_CUSTOM_HASHWX_URL = '/cap/unused.wasm';   // only for hashwx challenges, which this relay never sends
window.CAP_PAKO_URL = '/cap/unused.js';              // only for instrumentation, likewise unused
window.CAP_DISABLE_WIDGET_REF = true;
window.CAP_DISABLE_HAPTICS = true;
