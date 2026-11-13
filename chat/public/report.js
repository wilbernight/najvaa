'use strict';
// Abuse report form: POST /h/report on the relay (rate-limited there).
(function () {
  const $ = (id) => document.getElementById(id);
  const latin = (s) => s.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const say = (text, err) => { const m = $('msg'); m.hidden = false; m.textContent = text; m.className = err ? 'err' : ''; };
  const params = new URLSearchParams(location.search);
  if (/^\d{7}$/.test(latin(params.get('code') || ''))) $('code').value = params.get('code');

  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = latin($('code').value.trim());
    const reason = $('reason').value;
    if (!/^\d{7}$/.test(code)) return say('کد اتاق باید ۷ رقم باشد.', true);
    if (!reason) return say('نوع تخلف را انتخاب کنید.', true);
    const cap = $('cap');
    const capToken = cap && (cap.token || (cap.querySelector('input[name="cap-token"]') || {}).value);
    if (!capToken) return say('ابتدا روی «تأیید کنید که انسان هستید» بزنید و صبر کنید تا تأیید شود.', true);
    $('send').disabled = true;
    try {
      const r = await fetch('/h/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, reason, text: $('text').value.trim(), contact: $('contact').value.trim(), cap: capToken }),
      });
      if (r.ok) {
        const d = await r.json();
        $('f').reset();
        say(`گزارش شما ثبت شد. شماره‌ی پیگیری: ${d.ref || ''}`);
      } else if (r.status === 403) {
        say('تأیید انسان بودن منقضی شده؛ دوباره تأیید کنید و ارسال را بزنید.', true);
      } else if (r.status === 429) {
        say('تعداد گزارش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.', true);
      } else {
        say('گزارش ثبت نشد؛ اطلاعات را بررسی کنید.', true);
      }
    } catch {
      say('اتصال برقرار نشد؛ دوباره تلاش کنید.', true);
    } finally {
      $('send').disabled = false;
      // Each token works once: a new check for the next report or retry.
      if (cap && typeof cap.reset === 'function') cap.reset();
    }
  });
})();
