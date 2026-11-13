// Najva operations console. No inline scripts anywhere (strict CSP): every
// behaviour hangs off data-* attributes in the server-rendered pages.
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const meta = (n) => (document.querySelector(`meta[name="${n}"]`) || {}).content || '';
  const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  const latin = (s) => String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const root = document.documentElement;
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* blocked */ } };
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  // ---- theme ----
  function toggleTheme() {
    const cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    store('panel-theme', next);
  }

  // ---- sidebar: mini / full (desktop), drawer (phone) ----
  const isMini = () => {
    const n = root.getAttribute('data-nav');
    if (n) return n === 'mini';
    return innerWidth >= 900 && innerWidth < 1440;
  };
  function toggleNav() {
    const next = isMini() ? 'full' : 'mini';
    root.setAttribute('data-nav', next);
    store('panel-nav', next);
  }
  const drawer = (open) => document.body.classList.toggle('drawer-open', open);

  // ---- tooltips: only where the visible label is missing ----
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.append(tip);
  let tipFor = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el === tipFor) return;
    tipFor = el;
    tip.classList.remove('on');
    if (!el) return;
    const label = el.querySelector('.nav-text');
    if (label && label.offsetParent !== null) return;   // the label is on screen already
    tip.textContent = el.dataset.tip;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const side = el.closest('.side');
    if (side) {
      tip.style.left = `${Math.max(8, r.left - t.width - 10)}px`;
      tip.style.top = `${r.top + r.height / 2 - t.height / 2}px`;
    } else {
      tip.style.left = `${Math.min(innerWidth - t.width - 8, Math.max(8, r.left + r.width / 2 - t.width / 2))}px`;
      tip.style.top = `${r.top - t.height - 8 < 4 ? r.bottom + 8 : r.top - t.height - 8}px`;
    }
    requestAnimationFrame(() => tip.classList.add('on'));
  });
  document.addEventListener('scroll', () => tip.classList.remove('on'), true);

  // ---- clicks ----
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-theme-toggle]')) { toggleTheme(); return; }
    if (t.closest('[data-nav-toggle]')) { toggleNav(); return; }
    if (t.closest('[data-drawer]')) { drawer(true); return; }
    if (t.closest('[data-drawer-close]')) { drawer(false); return; }
    if (t.closest('[data-palette]')) { openPalette(); return; }
    const open = t.closest('[data-dialog]');
    if (open) {
      const d = document.getElementById(open.dataset.dialog);
      if (d && d.showModal) { d.showModal(); const f = d.querySelector('input:not([type=hidden]),textarea,select'); if (f) f.focus(); }
      return;
    }
    if (t.closest('[data-close]')) { const d = t.closest('dialog'); if (d) d.close(); return; }
    if (t.tagName === 'DIALOG') { t.close(); return; }   // backdrop
    const x = t.closest('.toast-x');
    if (x) { dismiss(x.closest('.toast')); return; }
    if (t.closest('[data-toggle-info]')) { document.body.classList.toggle('info-open'); return; }
    if (document.body.classList.contains('info-open') && !t.closest('#info-pane') && !t.closest('dialog')) {
      document.body.classList.remove('info-open');
    }
    const copy = t.closest('[data-copy]');
    if (copy && navigator.clipboard) navigator.clipboard.writeText(copy.dataset.copy).then(() => toast('کپی شد'));
  });

  // ---- confirmations for destructive forms (styled dialog) ----
  const confirmDlg = $('#confirm-dlg');
  let pending = null;
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.dataset.confirm && f !== pending) {
      e.preventDefault();
      if (!confirmDlg) { if (window.confirm(f.dataset.confirm)) { pending = f; f.requestSubmit(); } return; }
      pending = f;
      $('[data-confirm-text]', confirmDlg).textContent = f.dataset.confirm;
      confirmDlg.showModal();
      return;
    }
    pending = null;
    // No double submits.
    $$('button[type=submit],button:not([type])', f).forEach((b) => { setTimeout(() => { b.disabled = true; }, 0); });
  });
  if (confirmDlg) {
    $('[data-confirm-ok]', confirmDlg).addEventListener('click', () => {
      confirmDlg.close();
      if (pending) pending.requestSubmit();
    });
  }

  // ---- toasts ----
  function dismiss(t) { if (!t) return; t.classList.add('out'); setTimeout(() => t.remove(), 350); }
  function toast(text, kind = 'ok') {
    const box = $('.toasts');
    if (!box) return;
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    const s = document.createElement('span');
    s.textContent = text;
    const bar = document.createElement('i');
    bar.className = 'toast-bar';
    t.append(s, bar);
    box.append(t);
    setTimeout(() => dismiss(t), 4000);
  }
  $$('.toast').forEach((t) => setTimeout(() => dismiss(t), t.classList.contains('err') ? 9000 : 5000));

  // ---- instant filter of list rows ----
  $$('[data-filter]').forEach((inp) => inp.addEventListener('input', () => {
    const q = latin(inp.value.trim()).toLowerCase();
    $$(inp.dataset.filter).forEach((r) => { r.hidden = q !== '' && !latin(r.dataset.search || r.textContent).toLowerCase().includes(q); });
  }));

  // ---- chat wall: start at the newest line ----
  const wall = $('.wall[data-bottom]');
  if (wall) wall.scrollTop = wall.scrollHeight;

  // ---- composer ----
  $$('.composer textarea').forEach((ta) => {
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; };
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.form.requestSubmit(); } });
  });

  // ---- command palette ----
  const pal = $('#palette');
  const palInput = pal && $('[data-pal-input]', pal);
  const palList = pal && $('[data-pal-list]', pal);
  const icons = {};
  let palItems = [];
  let palSel = 0;
  if (pal) {
    const tpl = $('template[data-pal-actions]', pal);
    const frag = tpl ? tpl.content : document.createDocumentFragment();
    $$('[data-icon-src]', frag).forEach((s) => { icons[s.dataset.iconSrc] = s.innerHTML; });
    const base = [];
    $$('.side [data-cmd]').forEach((a) => base.push({ label: a.dataset.cmd, icon: a.dataset.cmdIcon, href: a.href, group: 'بخش‌ها', keys: a.dataset.cmdKeys || '' }));
    $$('[data-cmd]', frag).forEach((a) => base.push({ label: a.dataset.cmd, icon: a.dataset.cmdIcon, href: a.getAttribute('href'), group: a.dataset.cmdGroup || 'کارها', run: a.hasAttribute('data-theme-toggle') ? toggleTheme : null }));
    pal.base = base;
    palInput.addEventListener('input', renderPalette);
    palInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        palSel = (palSel + (e.key === 'ArrowDown' ? 1 : -1) + palItems.length) % Math.max(1, palItems.length);
        paintSel(true);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runItem(palItems[palSel]);
      }
    });
    palList.addEventListener('mousemove', (e) => {
      const it = e.target.closest('.pal-item');
      if (it && Number(it.dataset.i) !== palSel) { palSel = Number(it.dataset.i); paintSel(false); }
    });
    palList.addEventListener('click', (e) => { const it = e.target.closest('.pal-item'); if (it) runItem(palItems[Number(it.dataset.i)]); });
  }
  function openPalette() {
    if (!pal || pal.open) return;
    drawer(false);
    palInput.value = '';
    renderPalette();
    pal.showModal();
    palInput.focus();
  }
  function renderPalette() {
    const raw = palInput.value.trim();
    const q = latin(raw).toLowerCase();
    const items = [];
    const digits = q.replace(/\D/g, '');
    if (/^\d{7}$/.test(digits) && digits.length === q.replace(/\s/g, '').length) {
      items.push({ label: `باز کردن اتاق ${fa(digits)}`, icon: 'chat', href: `${meta('panel-find')}?code=${digits}`, group: 'پرش مستقیم' });
    }
    if (q && meta('panel-cases')) {
      items.push({ label: `جستجو در پرونده‌ها: «${raw}»`, icon: 'scale', href: `${meta('panel-cases')}?f=all&q=${encodeURIComponent(raw)}`, group: 'جستجو' });
    }
    pal.base.forEach((it) => { if (!q || latin(it.label).toLowerCase().includes(q)) items.push(it); });
    palItems = items;
    palSel = 0;
    palList.textContent = '';
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'pal-empty';
      e.textContent = 'چیزی پیدا نشد.';
      palList.append(e);
      return;
    }
    let group = null;
    items.forEach((it, i) => {
      if (it.group !== group) {
        group = it.group;
        const g = document.createElement('div');
        g.className = 'pal-group';
        g.textContent = group;
        palList.append(g);
      }
      const row = document.createElement('div');
      row.className = 'pal-item';
      row.dataset.i = i;
      row.setAttribute('role', 'option');
      const ic = document.createElement('i');
      ic.innerHTML = icons[it.icon] || icons.search || '';   // our own template markup
      const svg = ic.firstElementChild;
      const label = document.createElement('span');
      label.textContent = it.label;
      row.append(svg || ic, label);
      if (it.keys) { const k = document.createElement('kbd'); k.textContent = it.keys; row.append(k); }
      palList.append(row);
    });
    paintSel(false);
  }
  function paintSel(scroll) {
    $$('.pal-item', palList).forEach((r) => {
      const on = Number(r.dataset.i) === palSel;
      r.classList.toggle('on', on);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && scroll) r.scrollIntoView({ block: 'nearest' });
    });
  }
  function runItem(it) {
    if (!it) return;
    pal.close();
    if (it.run) it.run(); else if (it.href) location.href = it.href;
  }

  // ---- keyboard ----
  let gPrefix = 0;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); pal && pal.open ? pal.close() : openPalette(); return; }
    if (e.key === 'Escape') { document.body.classList.remove('info-open'); drawer(false); return; }
    if (typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === '/') { const s = $('.search input, .page input[name=q]'); if (s) { e.preventDefault(); s.focus(); s.select(); } return; }
    if (k === 'g') { gPrefix = Date.now(); return; }
    if (gPrefix && Date.now() - gPrefix < 1200) {
      gPrefix = 0;
      const link = $$('.side [data-cmd-keys]').find((a) => a.dataset.cmdKeys.toLowerCase() === `g ${k}`);
      if (link) { e.preventDefault(); location.href = link.href; }
      return;
    }
    // j / k or arrows: move through the list pane; Enter opens.
    if (['j', 'k', 'arrowdown', 'arrowup'].includes(k)) {
      const rows = $$('.list-pane .rows .row').filter((r) => !r.hidden);
      if (!rows.length) return;
      e.preventDefault();
      let i = rows.findIndex((r) => r.classList.contains('kb'));
      if (i < 0) i = rows.findIndex((r) => r.classList.contains('active'));
      rows.forEach((r) => r.classList.remove('kb'));
      i = Math.max(0, Math.min(rows.length - 1, i + (k === 'j' || k === 'arrowdown' ? 1 : -1)));
      rows[i].classList.add('kb');
      rows[i].scrollIntoView({ block: 'nearest' });
      rows[i].focus({ preventScroll: true });
    }
  });

  // ---- charts: hover read-out ----
  $$('.chart[data-chart]').forEach((box) => {
    let d;
    try { d = JSON.parse(box.dataset.chart); } catch (e) { return; }
    const svg = $('svg', box);
    const cursor = $('.cursor', svg);
    const n = d.a.length;
    if (n < 2) return;
    const tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    tipEl.hidden = true;
    const dot = document.createElement('div');
    dot.className = 'chart-dot';
    dot.hidden = true;
    box.append(tipEl, dot);
    const yOf = (v, h) => (d.t + (1 - Math.min(v, d.max) / d.max) * (d.h - d.t - d.bt)) / d.h * h;
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left) / r.width * (n - 1))));
      const x = i / (n - 1) * r.width;
      cursor.setAttribute('x1', String(i / (n - 1) * 1000));
      cursor.setAttribute('x2', String(i / (n - 1) * 1000));
      cursor.hidden = false;
      dot.hidden = false;
      dot.style.left = `${x}px`;
      dot.style.top = `${yOf(d.a[i], r.height)}px`;
      tipEl.hidden = false;
      tipEl.textContent = '';
      const time = document.createElement('div');
      time.className = 'faint';
      time.textContent = d.l[i];
      const a = document.createElement('div');
      a.innerHTML = '<span class="k1">●</span> دستگاه آنلاین: ';
      const ab = document.createElement('b'); ab.textContent = fa(d.a[i]); a.append(ab);
      const b = document.createElement('div');
      b.innerHTML = '<span class="k2">●</span> اتاق فعال: ';
      const bb = document.createElement('b'); bb.textContent = fa(d.b[i]); b.append(bb);
      tipEl.append(time, a, b);
      const w = tipEl.offsetWidth;
      tipEl.style.left = `${Math.max(w / 2, Math.min(r.width - w / 2, x))}px`;
      tipEl.style.top = `${Math.max(0, yOf(d.a[i], r.height) - tipEl.offsetHeight - 14)}px`;
    });
    svg.addEventListener('mouseleave', () => { cursor.hidden = true; tipEl.hidden = true; dot.hidden = true; });
  });

  // ---- idle warning (the server signs out after the same time) ----
  const idle = Number(meta('panel-idle')) || 900;
  const login = meta('panel-login');
  let deadline = Date.now() + idle * 1000;
  const warn = $('#idle-warn');
  setInterval(() => {
    const left = Math.round((deadline - Date.now()) / 1000);
    if (left <= 0) { location.href = login; return; }
    if (warn) { warn.hidden = left > 60; const l = $('#idle-left'); if (l) l.textContent = fa(left); }
  }, 1000);
  const stay = $('[data-idle-stay]');
  if (stay) stay.addEventListener('click', () => {
    fetch(meta('panel-pulse'), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => { if (r.status === 401) location.href = login; else { deadline = Date.now() + idle * 1000; warn.hidden = true; } });
  });

  // ---- live badges and status (do not count as activity) ----
  const liveDot = $('[data-live-dot]');
  const liveAgo = $('[data-live-ago]');
  let lastOk = Date.now();
  function pulse() {
    if (document.hidden) return;
    fetch(meta('panel-pulse'), { credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Panel-Poll': '1' } })
      .then((r) => { if (r.status === 401) { location.href = login; return null; } return r.ok ? r.json() : null; })
      .then((d) => {
        if (!d) { if (liveDot) liveDot.classList.add('off'); return; }
        lastOk = Date.now();
        if (liveDot) liveDot.classList.remove('off');
        const map = { rooms: d.devices ? d.live : 0, cases: d.cases, reports: d.reports };
        for (const [k, v] of Object.entries(map)) {
          $$(`[data-pulse="${k}"]`).forEach((b) => { b.hidden = !v; b.textContent = v ? fa(v) : ''; });
        }
        $$('[data-live]').forEach((el) => { if (d[el.dataset.live] !== undefined) el.textContent = fa(d[el.dataset.live]); });
      })
      .catch(() => { if (liveDot) liveDot.classList.add('off'); });
  }
  setInterval(pulse, 30000);
  setInterval(() => {
    if (!liveAgo) return;
    const s = Math.round((Date.now() - lastOk) / 1000);
    liveAgo.textContent = s < 45 ? 'همگام' : `${fa(Math.round(s / 60))} دقیقه پیش`;
  }, 15000);
})();
