import pickle, sys, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench as b
MODEL = r"C:\Users\Zayknn\AppData\Local\JoueTaReplique\_model_cache\diarization\embedding.onnx"
cache = os.path.join(b.B, "solo.pkl")
if os.path.exists(cache): solo = pickle.load(open(cache, "rb"))
else:
    solo = []
    for seed, v in [(21, "Hortense"), (22, "Paul"), (23, "Zira"), (24, "Julie"), (25, "PaulGrave"), (26, "HortenseAigu")]:
        y, w = b.scene(seed, [v]); spans = b.sc.sentences([dict(x) for x in w]); solo.append((f"solo-{v}", y, w, spans, b.embeddings(MODEL, y, spans)))
    pickle.dump(solo, open(cache, "wb"))
A = pickle.load(open(os.path.join(b.B, "emb_embedding.onnx.pkl"), "rb"))
data = b.dataset(); y, w = b.real_scary(); data = data + [("scary-3p", y, w)]
def unit(v): return v / (np.linalg.norm(v) or 1)
diff, same_split = [], []
# voix différentes : ressemblance (brute) entre les centres des vraies personnes
for name, y, words in data:
    spans, V = A[name]
    lab = {}
    for i, (s, e) in enumerate(spans):
        if e - s < .8 or V[i] is None: continue
        sp = max(set(x["sp"] for x in words if s - .01 <= x["s"] <= e), key=lambda k: sum(1 for x in words if x["sp"] == k and s - .01 <= x["s"] <= e))
        lab.setdefault(sp, []).append(V[i])
    cs = [unit(np.mean(v, 0)) for v in lab.values()]
    diff += [float(cs[i] @ cs[j]) for i in range(len(cs)) for j in range(i + 1, len(cs))]
# une seule voix : ce que donne le regroupement recentré, et la ressemblance brute entre ses groupes
for name, y, words, spans, V in solo:
    solid = [i for i, (s, e) in enumerate(spans) if e - s >= .8 and V[i] is not None]
    mu = np.mean([V[i] for i in solid], 0); Vc = [None if v is None else unit(v - mu) for v in V]
    lab = b.ahc(np.stack([Vc[i] for i in solid]), .03)
    groups = {}
    for i, l in zip(solid, lab): groups.setdefault(l, []).append(V[i])
    cs = [unit(np.mean(v, 0)) for v in groups.values()]
    sims = [float(cs[i] @ cs[j]) for i in range(len(cs)) for j in range(i + 1, len(cs))]
    same_split += sims
    print(name, "groupes recentrés:", len(groups), "ressemblance brute entre eux:", np.round(sims, 2))
print("voix différentes, centres bruts : min %.2f médiane %.2f max %.2f" % (min(diff), np.median(diff), max(diff)))
print("même voix coupée, centres bruts : min %.2f médiane %.2f" % (min(same_split), np.median(same_split)))
