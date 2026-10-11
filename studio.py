"""Studio de doublage : remplacer une voix par la sienne, avec une bande rythmo.

1. La vidéo est séparée en deux : les voix d'un côté, l'ambiance (musique, bruits) de l'autre (Demucs).
2. Les voix sont transcrites mot à mot avec leur minutage : c'est le texte de la bande rythmo.
3. Dans le navigateur, on s'enregistre en suivant la bande ; la prise est envoyée ici.
4. La prise est mixée avec l'ambiance, sur l'image d'origine.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import time
from importlib import import_module
from importlib.util import find_spec
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import FileResponse

import api as engine
from core.utils.config_utils import load_key_or, update_key
from core.utils.models import _2_CLEANED_CHUNKS, _BACKGROUND_AUDIO_FILE

ROOT = Path(__file__).resolve().parent
STUDIO = ROOT / "studio"
UPLOADS = ROOT / "uploads"
OUTPUT = ROOT / "output"
PROJECT_ID = re.compile(r"^[\w .()'-]{1,120}$")
TAKE_TYPES = {"webm", "ogg", "mp4", "m4a", "wav", "mp3"}

router = APIRouter(prefix="/api/studio")
clear_output = None  # donné par web.py : range le travail précédent avant d'en commencer un nouveau


def ffmpeg(*args):
    result = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *args], capture_output=True, text=True,
                            encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError("ffmpeg : " + result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "ffmpeg a échoué")


def probe(path: Path, stream: str, entry: str) -> str:
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-show_entries", entry,
                             "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True)
    return result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""


def project(project_id: str) -> Path:
    if not PROJECT_ID.match(project_id) or project_id.startswith("."):
        raise HTTPException(422, "Projet invalide")
    path = STUDIO / project_id
    if not path.is_dir():
        raise HTTPException(404, "Projet introuvable")
    return path


# ------------------------------------------------------------------ préparation

def _transcribe_with_separation():
    """La transcription du moteur, avec la séparation des voix forcée : elle produit aussi l'ambiance."""
    if find_spec("demucs") is None:
        raise RuntimeError("La séparation voix / ambiance (Demucs) n'est pas installée. "
                           "Relance Doublage : l'installation la répare automatiquement.")
    before = load_key_or("demucs", False)
    update_key("demucs", True)
    try:
        import_module("core._2_asr").transcribe()
    finally:
        update_key("demucs", before)
    if not Path(_BACKGROUND_AUDIO_FILE).exists():
        raise RuntimeError("L'ambiance n'a pas pu être séparée de la voix.")


def _build(project_dir: Path, title: str):
    from core._1_ytdlp import find_media_file
    import pandas as pd
    media, _ = find_media_file()
    media = Path(media)
    project_dir.mkdir(parents=True, exist_ok=True)

    # Vidéos lisibles par tous les navigateurs (téléphone compris) : H.264 + AAC dans du MP4
    h264 = probe(media, "v:0", "stream=codec_name") == "h264"
    video_args = ["-c:v", "copy"] if h264 else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
    ffmpeg("-i", str(media), "-map", "0:v:0", "-map", "0:a:0", *video_args, "-c:a", "aac", "-b:a", "160k",
           "-movflags", "+faststart", str(project_dir / "original.mp4"))
    ffmpeg("-i", str(project_dir / "original.mp4"), "-i", _BACKGROUND_AUDIO_FILE, "-map", "0:v:0", "-map", "1:a:0",
           "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
           str(project_dir / "ambiance.mp4"))

    df = pd.read_excel(_2_CLEANED_CHUNKS)
    words = []
    for _, row in df.iterrows():
        text = str(row["text"]).strip().strip('"').strip()
        if text and row["start"] == row["start"] and row["end"] == row["end"]:  # pas de NaN
            words.append({"w": text, "s": round(float(row["start"]), 3), "e": round(float(row["end"]), 3)})
    (project_dir / "words.json").write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
    duration = float(probe(project_dir / "original.mp4", "v:0", "format=duration") or 0) or None
    (project_dir / "meta.json").write_text(json.dumps({"title": title, "created": time.time(), "duration": duration},
                                                      ensure_ascii=False), encoding="utf-8")


@router.post("", status_code=202)
def create(data: dict = Body(...)):
    with engine.operation_lock:
        if engine.runner.is_active:
            raise HTTPException(409, "Un traitement est déjà en cours.")
        source = Path(str(data.get("source", ""))).resolve()
        if not source.is_file() or source.parent != UPLOADS.resolve():
            raise HTTPException(422, "Vidéo introuvable : renvoie-la.")
        if data.get("source_language"):
            update_key("whisper.language", str(data["source_language"]))
        title = re.sub(r"[^\w .()'-]", "", source.stem).strip() or "Projet"
        project_id = f"{title[:80]} {time.strftime('%d-%m %Hh%M')}"
        project_dir = STUDIO / project_id

        def prepare():
            clear_output()
            engine.prepare_input(str(source), "replace")
            source.unlink(missing_ok=True)

        engine.runner.start([
            ("Prepare input", prepare),
            ("Studio: separation", _transcribe_with_separation),
            ("Studio: build", lambda: _build(project_dir, title)),
        ])
        return {"id": project_id}


# ------------------------------------------------------------------ projets

def _finals(project_dir: Path):
    return sorted((p.name for p in project_dir.glob("final_*.mp4")), reverse=True)


@router.get("")
def projects():
    items = []
    if STUDIO.exists():
        for path in STUDIO.iterdir():
            meta_file = path / "meta.json"
            if path.is_dir() and meta_file.exists():
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
                items.append({"id": path.name, **meta, "finals": _finals(path)})
    return sorted(items, key=lambda item: item.get("created", 0), reverse=True)


@router.get("/{project_id}")
def get_project(project_id: str):
    path = project(project_id)
    meta = json.loads((path / "meta.json").read_text(encoding="utf-8"))
    words = json.loads((path / "words.json").read_text(encoding="utf-8"))
    return {"id": project_id, **meta, "words": words, "finals": _finals(path),
            "take": next((p.name for p in path.glob("take.*")), None)}


@router.put("/{project_id}/words")
def save_words(project_id: str, words: list = Body(...)):
    """Texte corrigé à la main (la transcription peut se tromper sur un nom)."""
    path = project(project_id)
    clean = [{"w": str(w["w"])[:40], "s": float(w["s"]), "e": float(w["e"])} for w in words if str(w.get("w", "")).strip()]
    (path / "words.json").write_text(json.dumps(clean, ensure_ascii=False), encoding="utf-8")
    return {"ok": True}


@router.get("/{project_id}/file/{name}")
def project_file(project_id: str, name: str):
    path = (project(project_id) / name).resolve()
    if path.parent != (STUDIO / project_id).resolve() or not path.is_file() or name.startswith("."):
        raise HTTPException(404, "Fichier introuvable")
    return FileResponse(path, filename=name if name.startswith("final_") else None)


@router.delete("/{project_id}")
def delete_project(project_id: str):
    shutil.rmtree(project(project_id))
    return {"ok": True}


# ------------------------------------------------------------------ prise et mixage

@router.post("/{project_id}/take")
async def upload_take(project_id: str, request: Request, ext: str = "webm", trim_ms: int = 0):
    path = project(project_id)
    ext = ext.lower().strip(".")
    if ext not in TAKE_TYPES:
        raise HTTPException(422, "Format d'enregistrement non pris en charge")
    for old in path.glob("take.*"):
        old.unlink()
    target = path / f"take.{ext}"
    with open(target, "wb") as file:
        async for chunk in request.stream():
            file.write(chunk)
    if target.stat().st_size < 1000:
        target.unlink()
        raise HTTPException(422, "L'enregistrement est vide : vérifie l'accès au micro.")
    meta_file = path / "meta.json"
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    meta["take_trim"] = int(trim_ms)  # décalage mesuré par le navigateur entre le micro et l'image
    meta_file.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return {"take": target.name}


@router.post("/{project_id}/render")
def render(project_id: str, data: dict = Body(...)):
    path = project(project_id)
    take = next(path.glob("take.*"), None)
    if take is None:
        raise HTTPException(409, "Enregistre d'abord ta voix.")
    # trim : millisecondes de l'enregistrement à couper au début pour être calé sur l'image
    trim = max(-5000, min(60000, int(data.get("trim_ms", 0)))) / 1000
    voice = max(0.0, min(3.0, float(data.get("voice_gain", 1.0))))
    ambiance = max(0.0, min(2.0, float(data.get("ambience_gain", 1.0))))
    shift = f"atrim=start={trim:.3f},asetpts=PTS-STARTPTS" if trim >= 0 else f"adelay={int(-trim * 1000)}:all=1"
    chain = (f"[1:a]{shift},highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,"
             f"volume={voice:.2f}[v];[0:a]volume={ambiance:.2f}[b];"
             f"[b][v]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]")
    name = f"final_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
    ffmpeg("-i", str(path / "ambiance.mp4"), "-i", str(take), "-filter_complex", chain,
           "-map", "0:v:0", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
           "-movflags", "+faststart", str(path / name))
    return {"final": name}
