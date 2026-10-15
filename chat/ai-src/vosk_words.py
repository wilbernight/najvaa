# Pull the word symbol table out of a Vosk lookahead Gr.fst (OpenFst header
# with embedded isymbols/osymbols): entries are <int32 len><bytes><int64 id>.
import re, sys, struct

data = open(sys.argv[1], 'rb').read()
words = set()
for m in re.finditer(rb'(?:[\xd8-\xdb][\x80-\xbf]|\xe2\x80\x8c)+', data):
    a, b = m.span()
    if a >= 4 and struct.unpack('<i', data[a-4:a])[0] == b - a:
        words.add(m.group().decode('utf-8', 'ignore'))
words = sorted(words)
open(sys.argv[2], 'w', encoding='utf-8').write('\n'.join(words))
print(len(words))
