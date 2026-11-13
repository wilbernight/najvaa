import re
r=lambda f:re.sub(r'<\?xml[^>]*>\s*','',open(f,encoding='utf-8').read())
P='/e/code/panah/design/panah-brand/logo/'
A='<svg viewBox="0 0 40 40" width="{s}" height="{s}"><rect width="40" height="40" rx="11" fill="#3EDF97"/><g fill="none" stroke="#06140D" stroke-width="3.2" stroke-linecap="round"><path d="M13 29V11"/></g><g fill="#06140D"><circle cx="20" cy="26.5" r="2.1"/><circle cx="24.2" cy="21.5" r="2.1"/><circle cx="28.4" cy="16.5" r="2.1"/></g></svg>'
def sized(svgtxt,s): return re.sub(r'width="\d+" height="\d+"',f'width="{s}" height="{s}"',svgtxt,count=1)
pan=r('E:/code/panah/design/panah-brand/logo/panah-mark-tile.svg'); old=r('../najva-logo.svg'); new=r('najva-mark-tile.svg')
fam=''.join(f'<div class="c"><div>{x}</div><b>{n}</b><span>{t}</span></div>' for x,n,t in [
 (sized(pan,120),'پناه','کمانِ «پ»'),(A.format(s=120),'اندوخته','الف و سکه‌ها'),(sized(new,120),'نجوا','لب، نجوا، گوش')])
sizes=''.join(f'<div class="z">{sized(new,s)}<i>{s}</i></div>' for s in (16,24,32,48,72,120))
tiles=''.join(f'<div class="z">{sized(r(f),110)}<i>{f.split("-")[2][:-4]}</i></div>' for f in ('najva-tile-ios.svg','najva-tile-android.svg','najva-tile-macos.svg','najva-tile-windows.svg'))
cmp=f'<div class="z">{sized(old,96)}<i>نسخه‌ی قبلی</i></div><div class="z">{sized(new,96)}<i>نسخه‌ی ۲</i></div>'
html=f'''<!doctype html><meta charset=utf-8><style>
@font-face{{font-family:Vazirmatn;src:url(vazirmatn-arabic.woff2)}}@font-face{{font-family:'JetBrains Mono';src:url(jetbrains-mono-latin.woff2)}}
body{{margin:0;background:#0A0E14;color:#EEF2F6;font-family:Vazirmatn;direction:rtl;padding:48px;width:1104px}}
h1{{font-size:40px;font-weight:900;margin:0}}p{{color:#7D8898;margin:6px 0 32px}}h2{{font-size:15px;color:#B1BBC8;margin:36px 0 14px;font-weight:700}}
.row{{display:flex;gap:28px;align-items:flex-end;flex-wrap:wrap}}.c{{background:#121A25;border-radius:22px;padding:26px 30px;text-align:center;flex:1}}
.c b{{display:block;font-size:22px;margin-top:14px}}.c span{{color:#7D8898;font-size:13px}}.z{{text-align:center}}.z i{{display:block;font-style:normal;color:#7D8898;font-size:12px;margin-top:8px;font-family:'JetBrains Mono',Vazirmatn}}
.lt{{background:#EEF2F6;border-radius:22px;padding:22px}}</style>
<h1>نجوا — نشان</h1><p>لبی که می‌گوید، گوشی که می‌شنود، و نجوایی که میانشان می‌گذرد؛ حرفی که فقط برای یک گوش است. همان شبکه‌ی ۴۰ و ضخامت ۳٫۲ پناه و اندوخته.</p>
<h2>خانواده</h2><div class="row">{fam}</div>
<h2>اندازه‌های کوچک</h2><div class="row">{sizes}</div>
<h2>آیکون پلتفرم‌ها</h2><div class="row">{tiles}</div>
<h2>نام‌نشان</h2><div class="row" style="direction:ltr"><div>{r("najva-wordmark-light.svg")}</div><div class="lt">{r("najva-wordmark-dark.svg")}</div></div>
<h2>قبل و بعد</h2><div class="row">{cmp}</div>'''
open('preview.html','w',encoding='utf-8').write(html)
