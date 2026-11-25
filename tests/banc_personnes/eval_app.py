"""La vraie fonction de l'appli (studio_core.voices_by_sentence) sur tout le banc."""
import pickle, sys, os, json, pathlib, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench as b, sherpa_onnx
sc = b.sc
if os.environ.get("RATIO"): sc.SAME_RATIO = float(os.environ["RATIO"])
if os.environ.get("SPLIT"): sc.SPLIT = float(os.environ["SPLIT"])
QUICK = os.environ.get("QUICK")
ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model=r"C:\Users\Zayknn\AppData\Local\JoueTaReplique\_model_cache\diarization\embedding.onnx", num_threads=8))
data = b.dataset(); y, w = b.real_scary(); data = data + [("scary-3p", y, w)]
data += [(n, y, w) for n, y, w, _, _ in pickle.load(open(os.path.join(b.B, "solo.pkl"), "rb"))]
res = []
for name, y, words in data:
    ws = [dict(x) for x in words]; sc.fix_punctuation(ws)
    segs = sc.voices_by_sentence(ws, y, 16000, ex, -1); n = sc.assign_speakers(ws, segs)
    truth = [x["sp"] for x in words]; acc = b.score(truth, [x["sp"] for x in ws])
    res.append((acc, n == len(set(truth)), name, n, len(set(truth))))
print(f"mots justes {np.mean([r[0] for r in res]) * 100:.1f} % | bon nombre {sum(r[1] for r in res)}/{len(res)}")
print("ratés :", " ".join(f"{r[2]}:{r[3]}/{r[4]}({r[0]*100:.0f}%)" for r in res if not r[1]))
print("faibles :", " ".join(f"{r[2]}:{r[0]*100:.0f}%" for r in res if r[1] and r[0] < .9))
if QUICK: sys.exit()
sc.MODELS = pathlib.Path(r"C:\Users\Zayknn\AppData\Local\JoueTaReplique\_model_cache\diarization")
for proj in ["oss117 25-11 16h09", "Grotte 24-11 17h43"]:
    p = pathlib.Path(r"C:\Users\Zayknn\AppData\Local\JoueTaReplique\studio") / proj
    ws = json.loads((p / "words.json").read_text(encoding="utf-8")); sc.fix_punctuation(ws)
    print(proj, "->", sc.assign_speakers(ws, sc.diarize(p / "vocals.m4a", -1, None, ws)), "personnes")
