# Phonemizes every word Vosk can output (espeak-ng fa, stress marks removed,
# hand lexicon overrides) -> word<TAB>phonemes, gzipped, for the browser TTS.
import sys, gzip, time, unicodedata
from multiprocessing import Pool
from fa_lexicon import LEX

def init():
    global E
    from piper.phonemize_espeak import EspeakPhonemizer
    E = EspeakPhonemizer()

def ph(w):
    if w in LEX: return w, LEX[w]
    try:
        p = "".join("".join(x) for x in E.phonemize("fa", w)).strip()
    except Exception:
        return w, ""
    return w, unicodedata.normalize("NFC", p.replace("ˈ", "").replace("ˌ", "").rstrip("."))

if __name__ == "__main__":
    words = open(sys.argv[1], encoding="utf-8").read().split("\n")
    words = sorted(set(words) | set(LEX))
    if len(sys.argv) > 3: words = words[: int(sys.argv[3])]
    t = time.time()
    with Pool(8, initializer=init) as pool:
        rows = pool.map(ph, words, chunksize=500)
    rows = [f"{w}\t{p}" for w, p in rows if p]
    with gzip.open(sys.argv[2], "wt", encoding="utf-8", compresslevel=9) as f:
        f.write("\n".join(rows))
    print(len(rows), f"{time.time()-t:.1f}s")
