# Najva v3 "Nun-bubble": the bowl of ن drawn as a chat bubble. The opening at the top
# is where the letter's dot sits, so the dot reads both as ن and as the word leaving
# the bubble. Family rule (Panah, Andookhteh): 40u grid, stroke 3.2 round, dot r2.1.
import math, io
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
import uharfbuzz as hb

# Corporate palette = the website's (chat/public/style.css): brand green tile, white mark,
# saffron dot. Saffron is also the Android app's accent, so it ties site and app together.
GREEN='#4F7F64'; INK='#0D1A13'; AMBER='#F4B860'; DARK='#121212'; LIGHT='#EEF2F6'; LINE='#3B3B3B'; WHITE='#FFFFFF'
CX,CY,RX,RY=19.6,20.8,11.2,9.4
def E(a): t=math.radians(a); return f'{CX+RX*math.cos(t):.2f} {CY+RY*math.sin(t):.2f}'
BUBBLE=(f'M{E(-60)}A{RX} {RY} 0 0 1 {E(22)}L31.6 32.2L{E(68)}'
        f'A{RX} {RY} 0 1 1 {E(240)}')
DOT=(CX, round(CY-RY-0.1,2))
def glyph(c,d=None):
    return (f'<path d="{BUBBLE}" fill="none" stroke="{c}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="{DOT[0]}" cy="{DOT[1]}" r="2.1" fill="{d or c}"/>')
RX_TILE=9.2  # 23% corner, same as the site's .brand-mark
H='<?xml version="1.0" encoding="UTF-8"?>\n'
def svg(w,h,body,vb=None): return H+f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="{vb or f"0 0 {w} {h}"}">{body}</svg>\n'
def placed(c,x,y,s,d=None): return f'<g transform="translate({x} {y}) scale({s})">{glyph(c,d)}</g>'

def text_path(fontfile,txt,wght,size,x,y,anchor='start',spacing=0,rtl=False):
    vf=TTFont(fontfile); inst=instantiateVariableFont(vf,{'wght':wght})
    buf=io.BytesIO(); inst.flavor=None; inst.save(buf); data=buf.getvalue()
    face=hb.Face(data); font=hb.Font(face); upem=face.upem
    b=hb.Buffer(); b.add_str(txt); b.guess_segment_properties(); hb.shape(font,b)
    gs=inst.getGlyphSet(); order=inst.getGlyphOrder(); k=size/upem
    adv=sum(p.x_advance for p in b.glyph_positions)+spacing/k*(len(b.glyph_infos)-1)
    x0={'start':x,'end':x-adv*k,'middle':x-adv*k/2}[anchor]
    pen=SVGPathPen(gs); pen_x=0
    for i,p in zip(b.glyph_infos,b.glyph_positions):
        tp=TransformPen(pen,(k,0,0,-k,x0+(pen_x+p.x_offset)*k,y-p.y_offset*k))
        gs[order[i.codepoint]].draw(tp); pen_x+=p.x_advance+spacing/k
    return pen.getCommands(), adv*k

V='../v2/vazirmatn-arabic.woff2'; J='../v2/jetbrains-mono-latin.woff2'
def wordmark(bg,tile_bg,tile_fg,fa,en,dot=AMBER):
    fa_d,fa_w=text_path(V,'نجوا',850,46,0,0)
    en_d,en_w=text_path(J,'NAJVA',700,12,0,0,spacing=4.2)
    # horizontal, RTL reading: mark on the right, name to its left
    W=60+18+fa_w+28; Hh=92
    mx=W-14-60
    body=(f'<rect width="{W:.1f}" height="{Hh}" rx="18" fill="{bg}"/>' if bg else '')
    body+=f'<g transform="translate({mx} 16) scale(1.5)"><rect width="40" height="40" rx="{RX_TILE}" fill="{tile_bg}"/>{glyph(tile_fg,dot)}</g>'
    tx=mx-18-fa_w
    body+=f'<path transform="translate({tx:.2f} 52)" d="{fa_d}" fill="{fa}"/>'
    body+=f'<path transform="translate({tx+fa_w-en_w:.2f} 80)" d="{en_d}" fill="{en}"/>'
    return svg(round(W,1),Hh,body)

files={
 'najva-glyph-color.svg': svg(40,40,glyph(GREEN,AMBER)),
 'najva-glyph-ink.svg': svg(40,40,glyph(INK)),
 'najva-glyph-white.svg': svg(40,40,glyph('#FFFFFF')),
 'najva-mark-tile.svg': svg(40,40,f'<rect width="40" height="40" rx="{RX_TILE}" fill="{GREEN}"/>'+glyph(WHITE,AMBER)),
 'najva-mark-dark.svg': svg(40,40,f'<rect width="40" height="40" rx="{RX_TILE}" fill="{INK}"/>'+glyph(WHITE,AMBER)),
 'najva-tile-ios.svg': svg(1024,1024,f'<rect width="1024" height="1024" fill="{GREEN}"/>'+placed(WHITE,112,112,20,AMBER)),
 'najva-tile-android-fg.svg': svg(108,108,placed(WHITE,27,27,1.35,AMBER)),
 'najva-tile-android.svg': svg(108,108,f'<circle cx="54" cy="54" r="54" fill="{GREEN}"/>'+placed(WHITE,19.6,19.6,1.72,AMBER)),
 'najva-tile-macos.svg': svg(1024,1024,f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{GREEN}"/>'+placed(WHITE,192,192,16,AMBER)),
 'najva-tile-windows.svg': svg(100,100,f'<rect width="100" height="100" rx="10" fill="{GREEN}"/>'+placed(WHITE,10,10,2,AMBER)),
 'najva-wordmark-on-dark.svg': wordmark(None,GREEN,WHITE,LIGHT,'#8B8B8B'),
 'najva-wordmark-on-light.svg': wordmark(None,GREEN,WHITE,INK,'#5E5E5E'),
}
for n,s in files.items(): open(n,'w',encoding='utf-8').write(s)
print('\n'.join(files))
