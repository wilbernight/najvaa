import sys, time, unicodedata
import torch
_exp = torch.onnx.export
torch.onnx.export = lambda *a, **k: _exp(*a, **{**k, "dynamo": False})
from piper.phonemize_espeak import EspeakPhonemizer
class Ph:
    def __init__(self): self.e = EspeakPhonemizer()
    def phonemize(self, text, separator="", language=None):
        return unicodedata.normalize("NFC", " ".join("".join(s) for s in self.e.phonemize("fa", text)))
    def name(self): return "espeak"
    def print_logs(self, level=0): pass
import TTS.tts.utils.text.tokenizer as _tok
_tok.get_phonemizer_by_name = lambda *a, **k: Ph()
from TTS.tts.configs.vits_config import VitsConfig
from TTS.tts.models.vits import Vits
M = "C:/xampp/tmp/vc-models/karim/"
cfg = VitsConfig(); cfg.load_json(M + "config.json")
m = Vits.init_from_config(cfg); m.load_checkpoint(cfg, M + "model.pth", eval=True)
m.export_onnx(output_path="C:/xampp/tmp/vc-models/karim/karim.onnx", verbose=False)
import json
json.dump({"chars": m.tokenizer.characters.vocab, "sr": cfg.audio.sample_rate, "add_blank": cfg.add_blank}, open("C:/xampp/tmp/vc-models/karim/tokens.json", "w", encoding="utf-8"), ensure_ascii=False)
print("exported")
