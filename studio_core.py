"""Logique du Studio sans serveur web : qui parle quand, prises, mixage. Testable seule."""
from __future__ import annotations

import os
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "_model_cache" / "diarization"
RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
SEGMENTATION_URL = RELEASES + "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
EMBEDDING_URL = RELEASES + "speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
COLORS = ["#2f62e8", "#e0193f", "#12a058", "#ee7a00", "#9a2fd4", "#0098ad", "#d01d88", "#6a8a00"]


# ------------------------------------------------------------------ outils

def ffmpeg(*args):
    result = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *args], capture_output=True, text=True,
                            encoding="utf-8", errors="replace")
    if result.returncode:
        lines = [l for l in result.stderr.strip().splitlines() if l.strip()]
        raise RuntimeError("ffmpeg : " + (lines[-1] if lines else "échec"))


def probe(path: Path, stream: str, entry: str) -> str:
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", entry,
                             "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
    out = result.stdout.strip().splitlines()
    return out[0] if out else ""


def speakers_meta(count: int, previous: list | None = None) -> list:
    previous = previous or []
    return [{"id": i, "name": previous[i]["name"] if i < len(previous) else f"Personne {i + 1}",
             "color": COLORS[i % len(COLORS)]} for i in range(max(1, count))]


# ------------------------------------------------------------------ qui parle quand (diarisation)

def _download(url: str, target: Path, progress=None):
    import requests
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    with requests.get(url, stream=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        done = 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if progress and total:
                    progress(done / total)
    tmp.replace(target)


def ensure_models(progress=None) -> tuple[Path, Path]:
    """Modèles libres (pyannote segmentation 3.0, MIT ; 3D-Speaker, Apache 2.0), sans compte ni clé."""
    segmentation = MODELS / "segmentation.onnx"
    embedding = MODELS / "embedding.onnx"
    if not segmentation.exists():
        archive = MODELS / "segmentation.tar.bz2"
        _download(SEGMENTATION_URL, archive, progress)
        with tarfile.open(archive) as tar:
            member = next(m for m in tar.getmembers() if m.name.endswith("/model.onnx") or m.name == "model.onnx")
            with tar.extractfile(member) as src, open(segmentation, "wb") as dst:
                shutil.copyfileobj(src, dst)
        archive.unlink()
    if not embedding.exists():
        _download(EMBEDDING_URL, embedding, progress)
    return segmentation, embedding


def diarize(audio: Path, num_speakers: int = -1, progress=None) -> list[tuple[float, float, int]]:
    """Segments (début, fin, personne) de la piste de voix. num_speakers = -1 : compte automatique."""
    import numpy as np
    import sherpa_onnx
    import soundfile as sf

    segmentation, embedding = ensure_models()
    threads = max(1, min(8, (os.cpu_count() or 2) // 2))
    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segmentation)),
            num_threads=threads,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding), num_threads=threads),
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=int(num_speakers), threshold=0.6),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        raise RuntimeError("Configuration de la détection des voix invalide")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)

    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "voix16k.wav"
        ffmpeg("-i", str(audio), "-ac", "1", "-ar", str(sd.sample_rate), "-c:a", "pcm_s16le", str(wav))
        samples, rate = sf.read(str(wav), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples[:, 0]
    samples = np.ascontiguousarray(samples)

    def callback(done, total):
        if progress and total:
            progress(done / total)
        return 0

    result = sd.process(samples, callback=callback).sort_by_start_time()
    return [(float(r.start), float(r.end), int(r.speaker)) for r in result]


def assign_speakers(words: list[dict], segments: list[tuple[float, float, int]]) -> int:
    """Donne à chaque mot la personne qui parle à ce moment. Renvoie le nombre de personnes."""
    if not segments:
        for w in words:
            w["sp"] = 0
        return 1
    segments = sorted(segments)
    for w in words:
        best, best_overlap, best_gap = None, 0.0, 1e9
        for start, end, sp in segments:
            if start > w["e"] + 5:
                break
            overlap = min(end, w["e"]) - max(start, w["s"])
            gap = max(start - w["e"], w["s"] - end, 0)
            if overlap > best_overlap:
                best, best_overlap = sp, overlap
            elif best_overlap <= 0 and gap < best_gap:
                best, best_gap = sp, gap
        w["sp"] = best if best is not None else 0
    # Un mot isolé entre deux mots d'une autre personne, à moins d'une demi-seconde : on le lisse
    for i in range(1, len(words) - 1):
        a, w, b = words[i - 1], words[i], words[i + 1]
        if a["sp"] == b["sp"] != w["sp"] and w["s"] - a["e"] < 0.5 and b["s"] - w["e"] < 0.5:
            w["sp"] = a["sp"]
    # Numérotation dans l'ordre d'apparition : Personne 1 est la première qui parle
    order = {}
    for w in words:
        order.setdefault(w["sp"], len(order))
    for w in words:
        w["sp"] = order[w["sp"]]
    return max(1, len(order))


# ------------------------------------------------------------------ prises et mixage

def kept_parts(clips: list[dict]) -> list[tuple[dict, float, float]]:
    """Ce qu'on garde de chaque prise : une prise plus récente de la même personne remplace l'ancienne là où elles se chevauchent."""
    parts = []
    for i, clip in enumerate(clips):
        pieces = [(clip["from"], clip["to"])]
        for later in clips[i + 1:]:
            if later["sp"] != clip["sp"]:
                continue
            cut = []
            for a, b in pieces:
                if later["to"] <= a or later["from"] >= b:
                    cut.append((a, b))
                    continue
                if later["from"] > a:
                    cut.append((a, later["from"]))
                if later["to"] < b:
                    cut.append((later["to"], b))
            pieces = cut
        parts.extend((clip, a, b) for a, b in pieces if b - a > 0.05)
    return parts


def speech_ranges(words: list[dict], speakers: set[int], gap=0.8, pad=0.12) -> list[tuple[float, float]]:
    ranges = []
    for w in sorted((w for w in words if w.get("sp", 0) in speakers), key=lambda w: w["s"]):
        s, e = max(0.0, w["s"] - pad), w["e"] + pad
        if ranges and s - ranges[-1][1] < gap:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], e))
        else:
            ranges.append((s, e))
    return ranges


def render(project_dir: Path, words: list[dict], clips: list[dict], speakers: list[dict], out: Path,
           latency_ms=0, voice=1.0, ambience=1.0, keep_original=True, original=1.0):
    """Ambiance + prises (+ voix d'origine des personnes qu'on n'a pas doublées), sur l'image d'origine."""
    parts = kept_parts(clips)
    dubbed = {c["sp"] for c in clips}
    others = {s["id"] for s in speakers} - dubbed
    keep = speech_ranges(words, others) if keep_original and (project_dir / "vocals.m4a").exists() else []
    if not parts and not keep:
        raise ValueError("Enregistre au moins une réplique.")

    shift = float(latency_ms) / 1000
    inputs = ["-i", str(project_dir / "ambiance.mp4")]
    graph = [f"[0:a]volume={ambience:.3f}[amb]"]
    mix = ["[amb]"]
    n = 1
    if keep:
        inputs += ["-i", str(project_dir / "vocals.m4a")]
        expr = "+".join(f"between(t,{a:.2f},{b:.2f})" for a, b in keep)
        graph.append(f"[{n}:a]volume={original:.3f},volume=0:enable='not({expr})'[orig]")
        mix.append("[orig]")
        n += 1
    files = {}
    for clip, a, b in parts:
        if clip["file"] not in files:
            inputs += ["-i", str(project_dir / "clips" / clip["file"])]
            files[clip["file"]] = n
            n += 1
    for k, (clip, a, b) in enumerate(parts):
        # temps vidéo t <-> temps de la prise t - at - décalage
        start, end = a - clip["at"] - shift, b - clip["at"] - shift
        place = a
        if start < 0:
            place, start = a - start, 0.0
        if end <= start:
            continue
        graph.append(f"[{files[clip['file']]}:a]atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS,"
                     f"highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,volume={voice:.3f},"
                     f"afade=t=in:d=0.02,adelay={int(place * 1000)}:all=1[c{k}]")
        mix.append(f"[c{k}]")
    graph.append(f"{''.join(mix)}amix=inputs={len(mix)}:duration=first:normalize=0,alimiter=limit=0.95[out]")

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(";\n".join(graph))
        script = f.name
    try:
        common = ["-map", "0:v:0", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                  "-movflags", "+faststart", str(out)]
        try:
            ffmpeg(*inputs, "-filter_complex_script", script, *common)
        except RuntimeError as exc:
            if "filter_complex_script" not in str(exc) and "Unrecognized option" not in str(exc):
                raise
            ffmpeg(*inputs, "-/filter_complex", script, *common)  # ffmpeg 8 et plus
    finally:
        os.unlink(script)
