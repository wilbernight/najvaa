# Najva v2 "Lab o Goosh" (lip and ear): a lip on the left, an ear on the right and the
# whisper passing between them; najva is exactly that, words meant for one ear.
# Same grid and weights as Panah (taq of پ) and Andookhteh (alef + coins): 40u grid,
# strokes 3.2 round, dots r2.1.
# Family rule shared with Panah (arch of پ) and Andookhteh (alef + coins): 40u grid,
# one letter stroke 3.2 round + three dots r2.1.
INK='#06201D'; TEAL='#45D6C8'; DARK='#0A0E14'; LIGHT='#EEF2F6'; LINE='#2A384A'
STROKES=['M12.4 10.2C9.2 12.6 7.6 16 7.6 20S9.2 27.4 12.4 29.8',
 'M22.4 11.4C23.6 10.6 25 10.2 26.4 10.2C30 10.2 32.6 13.2 32.6 17C32.6 20.4 30.6 21.8 29.6 23.8C28.6 25.8 28.2 29.8 24.6 29.8C23.2 29.8 22.2 29 21.8 27.8',
 'M24.6 21.6C23.6 18.2 25.2 15.6 27.4 15.6C28.8 15.6 29.6 16.6 29.6 17.8']
DOTS=[(13.4,20),(18.8,20)]
def glyph(c):
    d=''.join(f'<circle cx="{x}" cy="{y}" r="2.1" fill="{c}"/>' for x,y in DOTS)
    return ''.join(f'<path d="{p}" fill="none" stroke="{c}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>' for p in STROKES)+d
H='<?xml version="1.0" encoding="UTF-8"?>\n'
def svg(w,h,body,vb=None): return H+f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb or f"0 0 {w} {h}"}">{body}</svg>\n'
files={
 'najva-glyph-teal.svg': svg(40,40,glyph(TEAL)),
 'najva-glyph-dark.svg': svg(40,40,glyph(INK)),
 'najva-glyph-white.svg': svg(40,40,glyph('#FFFFFF')),
 'najva-mark-tile.svg': svg(40,40,f'<rect width="40" height="40" rx="11" fill="{TEAL}"/>'+glyph(INK)),
 'najva-mark-ink.svg': svg(40,40,f'<rect width="40" height="40" rx="11" fill="{INK}"/>'+glyph(TEAL)),
 'najva-tile-ios.svg': svg(100,100,f'<rect width="100" height="100" rx="23" fill="{TEAL}"/><g transform="translate(10 10) scale(2)">{glyph(INK)}</g>'),
 'najva-tile-android.svg': svg(108,108,f'<circle cx="54" cy="54" r="54" fill="{TEAL}"/><g transform="translate(19.6 19.6) scale(1.72)">{glyph(INK)}</g>'),
 'najva-tile-macos.svg': svg(100,100,f'<rect x="6" y="6" width="88" height="88" rx="20" fill="{DARK}" stroke="{LINE}" stroke-width="1.2"/><g transform="translate(14 14) scale(1.8)">{glyph(TEAL)}</g>'),
 'najva-tile-windows.svg': svg(100,100,f'<rect width="100" height="100" rx="10" fill="{TEAL}"/><g transform="translate(10 10) scale(2)">{glyph(INK)}</g>'),
}
def word(bg,tile,fg,sub,gl):
    return svg(300,64,f'<rect width="300" height="64" rx="16" fill="{bg}"/><g transform="translate(210 6)"><svg width="52" height="52" viewBox="0 0 40 40"><rect width="40" height="40" rx="11" fill="{tile}"/>{glyph(gl)}</svg></g>'
      f'<text x="196" y="35" text-anchor="end" direction="ltr" font-family="Vazirmatn, Tahoma, sans-serif" font-size="34" font-weight="900" fill="{fg}">&#1606;&#1580;&#1608;&#1575;</text>'
      f'<text x="196" y="54" text-anchor="end" direction="ltr" font-family="JetBrains Mono, monospace" font-size="11" font-weight="700" letter-spacing="3" fill="{sub}">NAJVA</text>')
files['najva-wordmark-dark.svg']=word(LIGHT,INK,INK,'#3B4555',TEAL)
files['najva-wordmark-light.svg']=word(DARK,TEAL,LIGHT,'#7D8898',INK)
for n,s in files.items(): open(n,'w',encoding='utf-8').write(s)
print(len(files),'files')
