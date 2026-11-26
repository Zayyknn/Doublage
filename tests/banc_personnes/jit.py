"""Robustesse : les mêmes scènes avec une transcription un peu différente (temps décalés, ponctuation perdue),
comme celle du Mac (Qwen3-ASR en MLX 8 bits) face à celle du PC."""
import pickle, sys, os, json, random, pathlib, collections, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench as b, sherpa_onnx
sc = b.sc
for k in ("SPLIT", "SAME_RATIO", "MIN_SPEECH", "TURN", "SMALL", "SMALL_SIM"):
    if os.environ.get(k): setattr(sc, k, float(os.environ[k]))
ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(
    model=r"C:\Users\Zayknn\AppData\Local\JoueTaReplique\_model_cache\diarization\embedding.onnx", num_threads=8))
data = b.dataset(); y, w = b.real_scary(); data = data + [("scary-3p", y, w)]
data += [(n, y, w) for n, y, w, _, _ in pickle.load(open(os.path.join(b.B, "solo.pkl"), "rb"))]
def jitter(words, seed):
    if seed == 0: return [dict(x) for x in words]
    rnd = random.Random(seed); amp = [0.15, 0.3][seed % 2]; out = []
    for x in words:
        d = dict(x); sh = rnd.uniform(-amp, amp)
        d["s"] = max(0, x["s"] + sh); d["e"] = max(d["s"] + .05, x["e"] + sh + rnd.uniform(-amp / 2, amp / 2))
        if seed >= 3 and d["w"][-1:] in ".?!" and rnd.random() < .3: d["w"] = d["w"][:-1]
        out.append(d)
    return out
SEEDS = [0, 1, 2, 3, 4]
res = []
for name, y, words in data:
    truth = [x["sp"] for x in words]
    for seed in SEEDS:
        ws = jitter(words, seed); sc.fix_punctuation(ws)
        n = sc.assign_speakers(ws, sc.voices_by_sentence(ws, y, 16000, ex, -1))
        res.append((b.score(truth, [x["sp"] for x in ws]), n == len(set(truth)), name, seed, n, len(set(truth))))
for seed in SEEDS:
    r = [x for x in res if x[3] == seed]
    print(f"variante {seed}: mots {np.mean([x[0] for x in r]) * 100:.1f} % | bon nombre {sum(x[1] for x in r)}/{len(r)}")
print(f"TOTAL mots {np.mean([x[0] for x in res]) * 100:.1f} % | bon nombre {sum(x[1] for x in res)}/{len(res)}")
print("ratés :", " ".join(f"{x[2]}#{x[3]}:{x[4]}/{x[5]}" for x in res if not x[1]))
# OSS 117 réel : vérité inconnue, on regarde le nombre (3) sur 12 variantes
sc.MODELS = pathlib.Path(r"C:\Users\Zayknn\AppData\Local\JoueTaReplique\_model_cache\diarization")
p = pathlib.Path(r"C:\Users\Zayknn\AppData\Local\JoueTaReplique\studio\oss117 25-11 16h09")
base = json.loads((p / "words.json").read_text(encoding="utf-8"))
import soundfile as sf, tempfile
wav = tempfile.mktemp(suffix=".wav"); sc.ffmpeg("-i", str(p / "vocals.m4a"), "-ac", "1", "-ar", "16000", wav); yo, _ = sf.read(wav, dtype="float32")
ref = None; cnt = collections.Counter(); agree = []
for seed in range(12):
    ws = jitter(base, seed) if seed else [dict(x) for x in base]; sc.fix_punctuation(ws)
    n = sc.assign_speakers(ws, sc.voices_by_sentence(ws, yo, 16000, ex, -1)); cnt[n] += 1
    labs = [x["sp"] for x in ws]
    if ref is None: ref = labs
    else: agree.append(b.score(ref, labs))
print("OSS nombres:", dict(cnt), "| accord avec la variante 0: %.0f %%" % (np.mean(agree) * 100))
