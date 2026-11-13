import re
r=lambda f:re.sub(r'<\?xml[^>]*>\s*','',open(f,encoding='utf-8').read())
def sized(t,s): return re.sub(r'width="[\d.]+" height="[\d.]+"',f'width="{s}" height="{s}"',t,count=1)
def h(t,hh):
    w,H=map(float,re.search(r'width="([\d.]+)" height="([\d.]+)"',t).groups())
    return re.sub(r'width="[\d.]+" height="[\d.]+"',f'width="{w*hh/H:.0f}" height="{hh}"',t,count=1)
new=r('najva-mark-tile.svg')
sizes=''.join(f'<div class="z">{sized(new,s)}<i>{s}</i></div>' for s in (120,72,48,32,24,16))
tiles=''.join(f'<div class="z">{sized(r(f"najva-tile-{p}.svg"),120)}<i>{p}</i></div>' for p in ('ios','android','macos','windows'))
cmp=''.join(f'<div class="z">{sized(r(f),96)}<i>{n}</i></div>' for f,n in (('../najva-logo.svg','v1'),('../v2/najva-mark-tile.svg','v2'),('najva-mark-tile.svg','v3 · رنگ سایت')))
html=f'''<!doctype html><meta charset=utf-8><style>
@font-face{{font-family:Vazirmatn;src:url(../v2/vazirmatn-arabic.woff2)}}@font-face{{font-family:JB;src:url(../v2/jetbrains-mono-latin.woff2)}}
body{{margin:0;background:#121212;color:#EEF2F6;font-family:Vazirmatn;direction:rtl;padding:48px;width:1104px}}
h1{{font-size:40px;font-weight:900;margin:0}}p{{color:#7D8898;margin:6px 0 28px;font-size:15px}}h2{{font-size:15px;color:#B1BBC8;margin:34px 0 14px}}
.row{{display:flex;gap:28px;align-items:flex-end;flex-wrap:wrap}}.z{{text-align:center}}.z i{{display:block;font-style:normal;color:#7D8898;font-size:12px;margin-top:8px;font-family:JB}}
.hero{{display:flex;gap:28px}}.hero>div{{flex:1;border-radius:24px;display:flex;align-items:center;justify-content:center;height:300px}}
</style>
<h1>نجوا — نشان ۳</h1><p>کاسه‌ی «ن» که حباب گفتگو شده؛ نقطه‌ی نون در دهانه‌ی حباب می‌نشیند، همان‌جا که حرف بیرون می‌رود. یک خط ۳٫۲ و یک نقطه، روی شبکه‌ی ۴۰ پناه و اندوخته.</p>
<div class="hero"><div style="background:#4F7F64">{sized(r("najva-glyph-white.svg").replace('r="2.1" fill="#FFFFFF"','r="2.1" fill="#F4B860"'),230)}</div><div style="background:#121212">{sized(r("najva-mark-tile.svg"),230)}</div><div style="background:#EEF2F6">{sized(r("najva-glyph-color.svg"),230)}</div></div>
<h2>نام‌نشان</h2><div class="row" style="direction:ltr"><div style="background:#1b1b1b;border-radius:22px;padding:28px 40px">{h(r("najva-wordmark-on-dark.svg"),92)}</div><div style="background:#EEF2F6;border-radius:22px;padding:28px 40px">{h(r("najva-wordmark-on-light.svg"),92)}</div></div>
<h2>اندازه‌های کوچک</h2><div class="row">{sizes}</div>
<h2>آیکون پلتفرم‌ها</h2><div class="row">{tiles}</div>
<h2>سیر نسخه‌ها</h2><div class="row">{cmp}</div>'''
open('preview.html','w',encoding='utf-8').write(html)
