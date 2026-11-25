"""Banc d'essai de la détection des personnes : scènes synthétiques (2 à 4 voix, voix proches, téléphone, écho,
bruit) + Scary Movie réel. Compare moteurs d'empreinte de voix et méthodes de regroupement."""
import glob, itertools, json, os, pickle, sys
import numpy as np, soundfile as sf
from scipy.optimize import linear_sum_assignment
from scipy.signal import butter, sosfilt, resample_poly

sys.path.insert(0, r"C:\Users\Zayknn\Doublage")
import studio_core as sc

B = os.path.dirname(os.path.abspath(__file__)); R = 16000
LINES = open(os.path.join(B, "lines.txt"), encoding="utf-8").read().splitlines()


def load(voice, i):
    base, f = {"PaulGrave": ("Paul", .85), "PaulAigu": ("Paul", 1.15), "JulieGrave": ("Julie", .88),
               "HortenseAigu": ("Hortense", 1.1)}.get(voice, (voice, 1.0))
    x, r = sf.read(os.path.join(B, "lines", f"{base}-{i:02d}.wav"), dtype="float32", always_2d=True)
    x = resample_poly(x.mean(1), R, r).astype("float32")
    if f != 1.0:  # hauteur changée (et vitesse) : une voix « proche »
        n = int(len(x) / f); x = np.interp(np.linspace(0, len(x), n, endpoint=False), np.arange(len(x)), x).astype("float32")
    nz = np.nonzero(np.abs(x) > 0.01)[0]
    return x[nz[0]:nz[-1]] if len(nz) else x


def scene(seed, voices):
    rng = np.random.default_rng(seed)
    fx = {v: ("phone" if rng.random() < .25 else "reverb" if rng.random() < .35 else "") for v in voices}
    order, last = [], None
    for _ in range(int(rng.integers(16, 26))):
        cand = ([v for v in voices if v != last] if rng.random() < .85 else voices) or voices
        last = cand[int(rng.integers(len(cand)))]; order.append(last)
    used = rng.permutation(len(LINES))
    out, words, t = [], [], 0.0
    for k, v in enumerate(order):
        x = load(v, int(used[k % len(used)]))
        if fx[v] == "phone":
            x = np.tanh(sosfilt(butter(4, [300, 3400], btype="band", fs=R, output="sos"), x) * 3) / 2
        elif fx[v] == "reverb":
            ir = np.exp(-np.arange(int(.25 * R)) / (.05 * R)) * rng.normal(0, 1, int(.25 * R)); ir[0] = 6
            x = np.convolve(x, ir / np.abs(ir).sum() * 3)[:len(x) + int(.1 * R)]
        x = (x / (np.abs(x).max() + 1e-6) * rng.uniform(.3, .6)).astype("float32")
        gap = rng.uniform(.08, .5); out.append(np.zeros(int(gap * R), "float32")); t += gap
        ws = LINES[int(used[k % len(used)])].split(); d = len(x) / R / len(ws)
        for j, w in enumerate(ws):
            words.append({"w": w, "s": round(t + j * d, 3), "e": round(t + (j + 1) * d - .02, 3), "sp": voices.index(v)})
        out.append(x); t += len(x) / R
    y = np.concatenate(out)
    y += rng.normal(0, .004, len(y)).astype("float32")
    tt = np.arange(len(y)) / R; y += (.01 * np.sin(2 * np.pi * 90 * tt) * (rng.random() < .5)).astype("float32")
    return y, words


SCENES = [
    (1, ["Hortense", "Paul"]), (2, ["Julie", "Zira"]), (3, ["Paul", "PaulGrave"]), (4, ["Hortense", "Julie"]),
    (5, ["Hortense", "Paul", "Zira"]), (6, ["Paul", "PaulGrave", "Julie"]), (7, ["Hortense", "Julie", "Paul"]),
    (8, ["PaulAigu", "PaulGrave", "Hortense"]), (9, ["Julie", "JulieGrave", "Paul"]),
    (10, ["Hortense", "Julie", "Paul", "Zira"]), (11, ["Paul", "PaulGrave", "Hortense", "Julie"]),
    (12, ["HortenseAigu", "Julie", "PaulAigu", "Zira"]), (13, ["Paul", "PaulGrave", "PaulAigu", "Hortense"]),
    (14, ["Zira", "Paul"]), (15, ["Hortense", "HortenseAigu", "Paul"]), (16, ["Julie", "Paul", "PaulGrave", "Zira"]),
]


def real_scary():
    p = r"C:\Users\Zayknn\AppData\Local\JoueTaReplique\studio\scary-movie 25-11 15h24"
    import tempfile
    wav = tempfile.mktemp(suffix=".wav"); sc.ffmpeg("-i", p + r"\vocals.m4a", "-ac", "1", "-ar", "16000", wav)
    y, _ = sf.read(wav, dtype="float32")
    truth = json.load(open(os.path.join(B, "scary_truth.json"), encoding="utf-8"))
    return y, truth


def dataset():
    cache = os.path.join(B, "scenes.pkl")
    if os.path.exists(cache):
        return pickle.load(open(cache, "rb"))
    data = [(f"s{seed}-{len(v)}p", *scene(seed, v)) for seed, v in SCENES]
    pickle.dump(data, open(cache, "wb"))
    return data


def embeddings(model, y, spans):
    import sherpa_onnx
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=8))
    V = []
    for s, e in spans:
        if e - s < .25:
            V.append(None); continue
        st = ex.create_stream(); st.accept_waveform(R, np.ascontiguousarray(y[int(max(0, s - .05) * R):int((e + .05) * R)])); st.input_finished()
        v = np.array(ex.compute(st), dtype=np.float32); V.append(v / (np.linalg.norm(v) or 1))
    return V


# ------------------------------------------------------------------ regroupements
def ahc(V, th):
    S = V @ V.T; cl = [[i] for i in range(len(V))]
    while len(cl) > 1:
        best, bi = -9, None
        for a in range(len(cl)):
            for b in range(a + 1, len(cl)):
                m = S[np.ix_(cl[a], cl[b])].mean()
                if m > best: best, bi = m, (a, b)
        if best < th: break
        a, b = bi; cl[a] += cl.pop(b)
    lab = np.zeros(len(V), int)
    for k, c in enumerate(cl): lab[c] = k
    return lab


def nme_sc(V, max_spk=8):
    """Regroupement spectral à seuil automatique (NME-SC, Park et al. 2019, celui de NVIDIA NeMo)."""
    from sklearn.cluster import KMeans
    n = len(V)
    if n < 4: return ahc(V, .35)
    A = np.clip(V @ V.T, 0, 1)
    best = None
    for p in range(1, max(2, int(.5 * n)) + 1):
        Ap = np.zeros_like(A)
        idx = np.argsort(-A, axis=1)[:, :p + 1]
        for i in range(n): Ap[i, idx[i]] = 1
        Ap = (Ap + Ap.T) / 2
        L = np.diag(Ap.sum(1)) - Ap
        lam = np.sort(np.linalg.eigvalsh(L))[:max_spk + 1]
        gaps = np.diff(lam); k = int(np.argmax(gaps)) + 1
        g = gaps.max() / (lam.max() + 1e-10)
        r = (p / n) / (g + 1e-10)
        if best is None or r < best[0]: best = (r, p, k, Ap)
    _, p, k, Ap = best
    if k == 1: return np.zeros(n, int)
    L = np.diag(Ap.sum(1)) - Ap
    w, U = np.linalg.eigh(L); U = U[:, :k]
    return KMeans(k, n_init=10, random_state=0).fit_predict(U)


def finish(words, spans, V, solid, lab_solid, min_speech=2.5):
    """Phrases courtes -> voix la plus ressemblante ; petits groupes -> fusion ; puis attribution aux mots."""
    groups = {}
    for i, l in zip(solid, lab_solid): groups.setdefault(int(l), []).append(i)
    groups = list(groups.values())
    cent = lambda g: (lambda v: v / np.linalg.norm(v))(np.mean([V[i] for i in g], 0))
    while len(groups) > 1:
        talk = [sum(spans[i][1] - spans[i][0] for i in g) for g in groups]
        k = int(np.argmin(talk))
        if talk[k] >= min_speech: break
        small = groups.pop(k); c = cent(small)
        groups[max(range(len(groups)), key=lambda o: float(cent(groups[o]) @ c))] += small
    label = {i: n for n, g in enumerate(groups) for i in g}
    cs = [cent(g) for g in groups]
    for i, (s, e) in enumerate(spans):
        if i in label: continue
        if V[i] is not None: label[i] = int(np.argmax([float(c @ V[i]) for c in cs]))
        else: label[i] = label[min(label, key=lambda j: abs(spans[j][0] - s))]
    segs = [(s, e, label[i]) for i, (s, e) in enumerate(spans)]
    ws = [dict(w) for w in words]; n = sc.assign_speakers(ws, segs)
    return [w["sp"] for w in ws], n


def score(truth, pred):
    T, P = sorted(set(truth)), sorted(set(pred))
    M = np.zeros((len(T), len(P)))
    for t, p in zip(truth, pred): M[T.index(t), P.index(p)] += 1
    r, c = linear_sum_assignment(-M)
    return M[r, c].sum() / len(truth)


METHODS = ["ahc.40", "ahc.45", "ahc.50"] + [f"c-ahc{x}" for x in (".00", ".05", ".10", ".15", ".20", ".25", ".30")]

if __name__ == "__main__":
    models = sys.argv[1:]
    data = dataset()
    if os.path.exists(os.path.join(B, "scary_truth.json")):
        y, w = real_scary(); data = data + [("scary-3p", y, w)]
    for model in models:
        cache = os.path.join(B, "emb_" + os.path.basename(model) + ".pkl")
        E = pickle.load(open(cache, "rb")) if os.path.exists(cache) else {}
        rows = {}
        for name, y, words in data:
            spans = sc.sentences([dict(w) for w in words])
            if name not in E: E[name] = (spans, embeddings(model, y, spans))
            spans, V = E[name]
            solid = [i for i, (s, e) in enumerate(spans) if e - s >= .8 and V[i] is not None]
            truth = [w["sp"] for w in words]; true_n = len(set(truth))
            mu = np.mean([V[i] for i in solid], 0)
            Vc = [None if v is None else (lambda u: u / (np.linalg.norm(u) or 1))(v - mu) for v in V]   # recentré sur l'extrait
            for meth in METHODS:
                W = Vc if meth.startswith("c-") else V
                Vs = np.stack([W[i] for i in solid]); m = meth[2:] if meth.startswith("c-") else meth
                lab = nme_sc(Vs) if m == "nme" else ahc(Vs, float(m[3:]))
                pred, n = finish(words, spans, W, solid, lab)
                rows.setdefault(meth, []).append((score(truth, pred), n == true_n, name, n, true_n))
        pickle.dump(E, open(cache, "wb"))
        print(f"\n== {os.path.basename(model)}")
        for meth, rs in rows.items():
            acc = np.mean([r[0] for r in rs]); ok = sum(r[1] for r in rs)
            bad = " ".join(f"{r[2]}:{r[3]}/{r[4]}" for r in rs if not r[1])
            print(f"  {meth:7s} mots justes {acc * 100:5.1f} % | bon nombre {ok}/{len(rs)} | ratés {bad}")
