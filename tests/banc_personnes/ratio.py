import pickle, sys, os, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench as b
A = pickle.load(open(os.path.join(b.B, "emb_embedding.onnx.pkl"), "rb")); solo = pickle.load(open(os.path.join(b.B, "solo.pkl"), "rb"))
data = b.dataset(); y, w = b.real_scary(); data = data + [("scary-3p", y, w)]
def unit(v): return v / (np.linalg.norm(v) or 1)
def within(G): S = G @ G.T; n = len(G); return (S.sum() - n) / (n * (n - 1)) if n > 1 else 1.0
def ratio(Ga, Gb): return float((Ga @ Gb.T).mean() / ((within(Ga) + within(Gb)) / 2))
def truth_groups(spans, V, words):
    g = {}
    for i, (s, e) in enumerate(spans):
        if e - s < .8 or V[i] is None: continue
        ws = [x["sp"] for x in words if s - .01 <= x["s"] <= e]
        if ws: g.setdefault(max(set(ws), key=ws.count), []).append(V[i])
    return [np.stack(v) for v in g.values() if len(v) > 1]
diff, same = [], []
for name, y, words in data:
    G = truth_groups(*A[name], words)
    diff += [(ratio(G[i], G[j]), name) for i in range(len(G)) for j in range(i + 1, len(G))]
for name, y, words, spans, V in solo:
    solid = [i for i, (s, e) in enumerate(spans) if e - s >= .8 and V[i] is not None]
    mu = np.mean([V[i] for i in solid], 0); Vc = [None if v is None else unit(v - mu) for v in V]
    lab = b.ahc(np.stack([Vc[i] for i in solid]), .03)
    gg = {}
    for i, l in zip(solid, lab): gg.setdefault(l, []).append(V[i])
    G = [np.stack(v) for v in gg.values() if len(v) > 1]
    same += [ratio(G[i], G[j]) for i in range(len(G)) for j in range(i + 1, len(G))]
d = sorted(diff, reverse=True)
print("voix différentes, rapport : max", [(round(r, 2), n) for r, n in d[:6]], "médiane %.2f" % np.median([r for r, _ in diff]))
print("même voix coupée, rapport : min %.2f  5e centile %.2f  médiane %.2f" % (min(same), np.percentile(same, 5), np.median(same)))
