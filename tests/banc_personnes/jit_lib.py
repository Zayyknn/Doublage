
import random
def jitter(words, seed):
    if seed == 0: return [dict(x) for x in words]
    rnd = random.Random(seed); amp = [0.15, 0.3][seed % 2]; out = []
    for x in words:
        d = dict(x); sh = rnd.uniform(-amp, amp)
        d["s"] = max(0, x["s"] + sh); d["e"] = max(d["s"] + .05, x["e"] + sh + rnd.uniform(-amp / 2, amp / 2))
        if seed >= 3 and d["w"][-1:] in ".?!" and rnd.random() < .3: d["w"] = d["w"][:-1]
        out.append(d)
    return out

