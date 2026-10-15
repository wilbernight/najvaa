"""Build Najva's animated emoji set from Animated Fluent Emojis.

Source: https://github.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis (personal
use only; the images belong to Microsoft). The set is ~2 GB of 256px APNGs, so
it is never committed: this script turns it into small WebPs under
chat/public/emoji/ (git-ignored), which are copied to the server as they are.

    git clone --depth 1 https://github.com/Tarikul-Islam-Anik/Animated-Fluent-Emojis afe
    curl -O https://unicode.org/Public/emoji/15.1/emoji-test.txt
    python chat/emoji-src/build_emoji.py afe emoji-test.txt chat/public/emoji

Output
    a/<key>.webp   animated, 96px  (reactions, big-emoji messages, picker hover)
    s/<key>.webp   still, 64px     (inline in text, picker grid)
    index.json     picker groups in Unicode order, skin tones, English names
<key> is the code points in lowercase hex joined by "-", without FE0F.
Re-running skips files that already exist.
"""
import json
import os
import re
import sys
import unicodedata
from multiprocessing import Pool

from PIL import Image, ImageChops, ImageStat

ANIM_PX, STILL_PX = 96, 64
GROUPS = {
    'Smileys & Emotion': 'شکلک‌ها',
    'People & Body': 'آدم‌ها و دست‌ها',
    'Animals & Nature': 'حیوانات و طبیعت',
    'Food & Drink': 'خوراکی',
    'Travel & Places': 'سفر و مکان‌ها',
    'Activities': 'فعالیت‌ها',
    'Objects': 'اشیا',
    'Symbols': 'نمادها',
    'Flags': 'پرچم‌ها',
}
# Repo file names that differ from the current Unicode names.
ALIASES = {
    'ginger': 'ginger root',
    'dizzy face': 'face with crossed out eyes',
    'hugging face': 'smiling face with open hands',
}
DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']
TONES = ('light skin tone', 'medium-light skin tone', 'medium skin tone', 'medium-dark skin tone', 'dark skin tone')


def norm(s):
    s = unicodedata.normalize('NFKD', s.lower()).encode('ascii', 'ignore').decode()  # piñata -> pinata, drops ’
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9]+', ' ', s)).strip()


def key_of(glyph):
    return '-'.join(f'{ord(c):x}' for c in glyph if ord(c) != 0xFE0F)


def parse_unicode(path):
    """name -> glyph, plus the ordered (group, glyph, name) list."""
    by_name, order, group = {}, [], None
    for line in open(path, encoding='utf-8'):
        if line.startswith('# group:'):
            group = line.split(':', 1)[1].strip()
            continue
        m = re.match(r'^([0-9A-F ]+?)\s*;\s*fully-qualified\s*#\s*(\S+)\s+E[\d.]+\s+(.+)$', line)
        if not m:
            continue
        glyph, name = m.group(2), m.group(3).strip()
        n = norm(name)
        if name.startswith('keycap:'):  # "keycap: 8" / "keycap: *" / "keycap: #"
            ch = name.split(':', 1)[1].strip()
            if ch in ('*', '#'):
                n = {'*': 'keycap asterisk', '#': 'keycap number sign'}[ch]
            elif len(ch) == 1 and ch.isdigit():
                n = f'keycap digit {DIGITS[int(ch)]}'  # "keycap: 10" keeps its own name
        by_name.setdefault(n, glyph)
        order.append((group, glyph, name))
    return by_name, order


def convert(job):
    src, out_dir, key = job
    a, s = os.path.join(out_dir, 'a', key + '.webp'), os.path.join(out_dir, 's', key + '.webp')
    need_a, need_s = not os.path.exists(a), not os.path.exists(s)
    if not (need_a or need_s):
        return key
    im = Image.open(src)
    frames, durations, best, best_score = [], [], None, -1
    for i in range(getattr(im, 'n_frames', 1)):
        im.seek(i)
        full = im.convert('RGBA')
        if need_a:
            frames.append(full.resize((ANIM_PX, ANIM_PX), Image.LANCZOS))
            durations.append(im.info.get('duration', 33) or 33)
        if need_s:
            # Some animations start dark or empty (a pumpkin before it lights
            # up), so the still is the frame with the most visible brightness.
            small = full.resize((32, 32))
            score = ImageStat.Stat(ImageChops.multiply(small.convert('L'), small.getchannel('A'))).sum[0]
            if score > best_score:
                best, best_score = full, score
    if need_a:
        frames[0].save(a + '.tmp', 'WEBP', save_all=True, append_images=frames[1:], duration=durations, loop=0, quality=70, method=4)  # method 6: ~60x slower for ~1% smaller
        os.replace(a + '.tmp', a)  # an interrupted run never leaves half a file
    if need_s:
        best.resize((STILL_PX, STILL_PX), Image.LANCZOS).save(s + '.tmp', 'WEBP', quality=82, method=4)
        os.replace(s + '.tmp', s)
    return key


def main(repo, emoji_test, out_dir):
    by_name, order = parse_unicode(emoji_test)
    os.makedirs(os.path.join(out_dir, 'a'), exist_ok=True)
    os.makedirs(os.path.join(out_dir, 's'), exist_ok=True)

    jobs, have, missed = [], set(), []
    root = os.path.join(repo, 'Emojis')
    for cat in sorted(os.listdir(root)):
        for fn in sorted(os.listdir(os.path.join(root, cat))):
            if not fn.endswith('.png'):
                continue
            n = norm(fn[:-4])
            glyph = by_name.get(ALIASES.get(n, n))
            if not glyph:
                missed.append(f'{cat}/{fn}')
                continue
            have.add(glyph)
            jobs.append((os.path.join(root, cat, fn), out_dir, key_of(glyph)))

    with Pool() as pool:
        for i, _ in enumerate(pool.imap_unordered(convert, jobs, chunksize=4), 1):
            if i % 100 == 0 or i == len(jobs):
                print(f'{i}/{len(jobs)}', flush=True)

    # Picker: base emoji in Unicode order; skin tones hang off their base.
    groups, tones, names = {}, {}, {}
    for group, glyph, name in order:
        if glyph not in have:
            continue
        base_name = name.split(':', 1)[0] if ':' in name and any(t in name for t in TONES) else None
        if base_name:
            base = by_name.get(norm(base_name))
            if base in have:
                tones.setdefault(base, []).append(glyph)
                continue
        groups.setdefault(GROUPS.get(group, group), []).append(glyph)
        names[glyph] = name
    index = {'v': 1, 'g': [[title, items] for title, items in groups.items()], 't': tones, 'n': names}
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(have)} emoji, {sum(len(v) for v in groups.values())} in the picker, {len(missed)} unmatched: {missed}')


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main(*sys.argv[1:4])
