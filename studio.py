"""Studio de doublage : n'importe quelle vidéo, sans les voix d'origine, avec une bande rythmo par personne.

1. La vidéo est séparée : les voix d'un côté, l'ambiance (musique, bruits) de l'autre (Demucs).
2. Les voix sont transcrites mot à mot avec leur minutage.
3. Le nombre de personnes qui parlent est détecté, et chaque mot est attribué à sa personne.
4. Dans le navigateur, chacun enregistre ses répliques en suivant sa bande ; les prises arrivent ici.
5. Les prises sont mixées avec l'ambiance sur l'image d'origine.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from importlib import import_module
from importlib.util import find_spec
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import FileResponse

import api as engine
import studio_core as core
from core.utils.config_utils import load_key_or, update_key
from core.utils.models import _2_CLEANED_CHUNKS, _BACKGROUND_AUDIO_FILE, _VOCAL_AUDIO_FILE

ROOT = Path(__file__).resolve().parent
STUDIO = ROOT / "studio"
UPLOADS = ROOT / "uploads"
PROJECT_ID = re.compile(r"^[\w .()'-]{1,120}$")
TAKE_TYPES = {"webm", "ogg", "mp4", "m4a", "wav", "mp3"}
STEP_LABELS = ("Prepare input", "Studio: separation", "Studio: build", "Studio: speakers")

router = APIRouter(prefix="/api/studio")
clear_output = None  # donné par web.py : range le travail précédent avant d'en commencer un nouveau
jobs: dict[str, dict] = {}  # détection des personnes relancée à la main, par projet
lock = threading.Lock()


def project(project_id: str) -> Path:
    if not PROJECT_ID.match(project_id) or project_id.startswith("."):
        raise HTTPException(422, "Projet invalide")
    path = STUDIO / project_id
    if not (path / "meta.json").is_file():
        raise HTTPException(404, "Projet introuvable")
    return path


def read(path: Path, name: str, default):
    file = path / name
    return json.loads(file.read_text(encoding="utf-8")) if file.exists() else default


def write(path: Path, name: str, data):
    tmp = path / f".{name}.tmp"
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path / name)


# ------------------------------------------------------------------ préparation

def _separate_and_transcribe():
    """La transcription du moteur, avec la séparation des voix forcée : elle produit aussi l'ambiance."""
    if find_spec("demucs") is None:
        raise RuntimeError("La séparation voix / ambiance (Demucs) n'est pas installée. "
                           "Relance Studio Rythmo : l'installation se répare automatiquement.")
    before = load_key_or("demucs", False)
    update_key("demucs", True)
    try:
        import_module("core._2_asr").transcribe()
    finally:
        update_key("demucs", before)
    if not Path(_BACKGROUND_AUDIO_FILE).exists():
        raise RuntimeError("L'ambiance n'a pas pu être séparée des voix.")


def _build(project_dir: Path, title: str):
    from core._1_ytdlp import find_media_file
    import pandas as pd
    media = Path(find_media_file()[0])
    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "clips").mkdir(exist_ok=True)

    # Lisible par tous les navigateurs, téléphones compris : H.264 + AAC dans du MP4
    h264 = core.probe(media, "v:0", "stream=codec_name") == "h264"
    video = ["-c:v", "copy"] if h264 else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
    core.ffmpeg("-i", str(media), "-map", "0:v:0", "-map", "0:a:0", *video, "-c:a", "aac", "-b:a", "160k",
                "-movflags", "+faststart", str(project_dir / "original.mp4"))
    # Ambiance sans les voix : BS-RoFormer sur le son d'origine en pleine qualité. La séparation Demucs de la
    # transcription (mono, 32 kHz, MP3) ne sert plus que de repli.
    ambiance, vocals, separation = Path(_BACKGROUND_AUDIO_FILE), Path(_VOCAL_AUDIO_FILE), "demucs"
    separation_error = None
    try:
        hq_ambiance, hq_vocals = project_dir / "_ambiance.wav", project_dir / "_vocals.wav"
        core.separate_voices(media, hq_ambiance, hq_vocals)
        ambiance, vocals, separation = hq_ambiance, hq_vocals, "roformer"
    except Exception as exc:
        separation_error = f"{type(exc).__name__}: {exc}"[:300]  # affiché dans Mixage : le repli ne doit pas passer inaperçu
        print(f"Séparation haute qualité impossible, repli sur Demucs : {separation_error}")
    core.ffmpeg("-i", str(project_dir / "original.mp4"), "-i", str(ambiance), "-map", "0:v:0", "-map", "1:a:0",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart",
                str(project_dir / "ambiance.mp4"))
    core.ffmpeg("-i", str(vocals), "-c:a", "aac", "-b:a", "160k", str(project_dir / "vocals.m4a"))
    for tmp in (project_dir / "_ambiance.wav", project_dir / "_vocals.wav"):
        tmp.unlink(missing_ok=True)

    words = []
    for _, row in pd.read_excel(_2_CLEANED_CHUNKS).iterrows():
        text = str(row["text"]).strip().strip('"').strip()
        if text and row["start"] == row["start"] and row["end"] == row["end"]:  # pas de valeur vide
            words.append({"w": text, "s": round(float(row["start"]), 3), "e": round(float(row["end"]), 3), "sp": 0})
    write(project_dir, "words.json", words)
    write(project_dir, "clips.json", [])
    duration = float(core.probe(project_dir / "original.mp4", "v:0", "format=duration") or 0) or None
    write(project_dir, "meta.json", {"title": title, "created": time.time(), "duration": duration, "separation": separation,
                                     **({"separation_error": separation_error} if separation_error else {}),
                                     "speakers": core.speakers_meta(1), "latency_ms": 0,
                                     "mix": {"voice": 1.2, "ambience": 1.0, "keep_original": True, "original": 1.0}})


def _speakers(project_dir: Path, num: int = -1, progress=None):
    """Compte les personnes et attribue chaque mot. Si la détection échoue, tout reste à une personne."""
    words = read(project_dir, "words.json", [])
    meta = read(project_dir, "meta.json", {})
    try:
        core.fix_punctuation(words)  # « quoi » « ? Ou » -> « quoi ? » « Ou » : aussi pour les vidéos déjà préparées
        segments = core.diarize(project_dir / "vocals.m4a", num, progress, words)
        count = core.assign_speakers(words, segments)
        meta.pop("speakers_error", None)
    except Exception as exc:
        for w in words:
            w["sp"] = 0
        count = 1
        meta["speakers_error"] = f"Détection des personnes impossible ({exc}). Tu peux les attribuer à la main."
    meta["speakers"] = core.speakers_meta(count, meta.get("speakers"))
    write(project_dir, "words.json", words)
    write(project_dir, "meta.json", meta)


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
        count = int(data.get("speakers", -1) or -1)
        title = re.sub(r"[^\w .()'-]", "", source.stem).strip() or "Projet"
        project_id = f"{title[:80]} {time.strftime('%d-%m %Hh%M')}"
        project_dir = STUDIO / project_id

        def prepare():
            clear_output()
            engine.prepare_input(str(source), "replace")
            source.unlink(missing_ok=True)

        engine.runner.start([
            (STEP_LABELS[0], prepare),
            (STEP_LABELS[1], _separate_and_transcribe),
            (STEP_LABELS[2], lambda: _build(project_dir, title)),
            (STEP_LABELS[3], lambda: _speakers(project_dir, count)),
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
            if path.is_dir() and (path / "meta.json").exists():
                meta = read(path, "meta.json", {})
                items.append({"id": path.name, "title": meta.get("title", path.name), "created": meta.get("created", 0),
                              "duration": meta.get("duration"), "speakers": len(meta.get("speakers", [])) or 1,
                              "finals": _finals(path), "clips": len(read(path, "clips.json", []))})
    return sorted(items, key=lambda item: item["created"], reverse=True)


@router.get("/{project_id}")
def get_project(project_id: str):
    path = project(project_id)
    meta = read(path, "meta.json", {})
    meta.setdefault("speakers", core.speakers_meta(1))
    words = read(path, "words.json", [])
    for w in words:
        w.setdefault("sp", 0)
    return {"id": project_id, **meta, "words": words, "clips": read(path, "clips.json", []),
            "finals": _finals(path), "job": jobs.get(project_id)}


@router.put("/{project_id}")
def update_project(project_id: str, data: dict = Body(...)):
    """Texte corrigé, réplique donnée à une autre personne, noms, réglages du mixage."""
    path = project(project_id)
    with lock:
        meta = read(path, "meta.json", {})
        if "words" in data:
            ids = {s["id"] for s in data.get("speakers") or meta.get("speakers", [])}
            words = [{"w": str(w["w"]).strip()[:40], "s": float(w["s"]), "e": float(w["e"]),
                      "sp": int(w.get("sp", 0)) if int(w.get("sp", 0)) in ids else 0}
                     for w in data["words"] if str(w.get("w", "")).strip()]
            write(path, "words.json", sorted(words, key=lambda w: w["s"]))
        if "speakers" in data:
            meta["speakers"] = [{"id": int(s["id"]), "name": str(s["name"]).strip()[:30] or f"Personne {int(s['id']) + 1}",
                                 "color": core.COLORS[int(s["id"]) % len(core.COLORS)],
                                 # image de présentation choisie à la main (seconde de la vidéo)
                                 **({"portrait": round(float(s["portrait"]), 2)} if isinstance(s.get("portrait"), (int, float)) else {})}
                                for s in data["speakers"]]
        if "latency_ms" in data:
            meta["latency_ms"] = max(-1000, min(1000, int(data["latency_ms"])))
        if "mix" in data:
            meta["mix"] = {**meta.get("mix", {}), **{k: data["mix"][k] for k in ("voice", "ambience", "keep_original", "original")
                                                    if k in data["mix"]}}
        write(path, "meta.json", meta)
    return {"ok": True}


@router.post("/{project_id}/speakers", status_code=202)
def recount(project_id: str, data: dict = Body(...)):
    """Relance la détection avec un nombre de personnes imposé (ou automatique)."""
    path = project(project_id)
    if jobs.get(project_id, {}).get("running"):
        return jobs[project_id]
    num = int(data.get("count", -1) or -1)
    job = jobs[project_id] = {"running": True, "progress": 0.0, "error": None}

    def run():
        try:
            _speakers(path, num, lambda p: job.update(progress=round(p, 3)))
            job["error"] = read(path, "meta.json", {}).get("speakers_error")
        except Exception as exc:
            job["error"] = str(exc)
        finally:
            job["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return job


@router.post("/{project_id}/separate", status_code=202)
def reseparate(project_id: str):
    """Refait l'ambiance d'un projet existant avec la séparation haute qualité."""
    path = project(project_id)
    if jobs.get(project_id, {}).get("running"):
        return jobs[project_id]
    job = jobs[project_id] = {"running": True, "progress": 0.0, "error": None, "kind": "separate"}

    def run():
        hq_ambiance, hq_vocals = path / "_ambiance.wav", path / "_vocals.wav"
        try:
            def progress(part, step):
                job["progress"], job["step"] = round(part, 3), step
            core.separate_voices(path / "original.mp4", hq_ambiance, hq_vocals, progress)
            job["progress"], job["step"] = 0.97, "Création des pistes"
            core.ffmpeg("-i", str(path / "original.mp4"), "-i", str(hq_ambiance), "-map", "0:v:0", "-map", "1:a:0",
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart",
                        str(path / "ambiance.new.mp4"))
            core.ffmpeg("-i", str(hq_vocals), "-c:a", "aac", "-b:a", "160k", str(path / "vocals.new.m4a"))
            os.replace(path / "ambiance.new.mp4", path / "ambiance.mp4")
            os.replace(path / "vocals.new.m4a", path / "vocals.m4a")
            with lock:
                meta = read(path, "meta.json", {})
                meta["separation"] = "roformer"
                meta.pop("separation_error", None)
                write(path, "meta.json", meta)
        except Exception as exc:
            job["error"] = f"Retrait des voix impossible : {type(exc).__name__}: {exc}"[:400]
            with lock:
                meta = read(path, "meta.json", {})
                meta["separation_error"] = job["error"]
                write(path, "meta.json", meta)
        finally:
            for tmp in (hq_ambiance, hq_vocals, path / "ambiance.new.mp4", path / "vocals.new.m4a"):
                tmp.unlink(missing_ok=True)
            job["running"] = False

    threading.Thread(target=run, daemon=True).start()
    return job


# ------------------------------------------------------------------ scène prête à doubler (onglet Doubler)
# Le Studio exporte un MP4 sans les voix ; la bande rythmo (mots, personnages) voyage dans ses métadonnées.
# L'onglet Doubler importe ce MP4 (ou n'importe quel MP4 déjà sans voix) et en fait une scène à doubler.
SCENE_TAG = "studio_rythmo"


def _ffmeta_escape(text: str) -> str:
    return re.sub(r"([=;#\\\n])", r"\\\1", text)


@router.get("/{project_id}/export")
def export_scene(project_id: str):
    path = project(project_id)
    meta = read(path, "meta.json", {})
    scene = {"v": 1, "title": meta.get("title", project_id), "words": read(path, "words.json", []),
             "speakers": [{k: s[k] for k in ("id", "name", "portrait") if k in s} for s in meta.get("speakers", [])],
             "latency_ms": meta.get("latency_ms", 0)}
    title = re.sub(r"[^\w .()'-]", "", str(scene["title"])).strip() or "scene"
    out = path / ".export.mp4"
    ffmeta = path / ".export.ffmeta"
    ffmeta.write_text(";FFMETADATA1\n" + f"{SCENE_TAG}=" + _ffmeta_escape(json.dumps(scene, ensure_ascii=False)) + "\n"
                      + "title=" + _ffmeta_escape(str(scene["title"])) + "\n", encoding="utf-8")
    try:
        core.ffmpeg("-i", str(path / "ambiance.mp4"), "-f", "ffmetadata", "-i", str(ffmeta), "-map", "0", "-map_metadata", "1",
                    "-c", "copy", "-movflags", "+faststart+use_metadata_tags", str(out))
    except RuntimeError as exc:
        raise HTTPException(500, f"Export impossible : {exc}") from exc
    finally:
        ffmeta.unlink(missing_ok=True)
    from starlette.background import BackgroundTask
    return FileResponse(out, media_type="video/mp4", filename=f"{title} - scène à doubler.mp4",
                        background=BackgroundTask(out.unlink, missing_ok=True))  # copie temporaire, effacée une fois envoyée


def _read_scene(media: Path) -> dict | None:
    """La bande rythmo glissée dans un MP4 exporté par le Studio (None pour un MP4 ordinaire)."""
    import subprocess
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                              f"format_tags={SCENE_TAG}", "-of", "json", str(media)],
                             capture_output=True, text=True, encoding="utf-8", timeout=60).stdout
        tags = json.loads(out or "{}").get("format", {}).get("tags", {})
        raw = next((v for k, v in tags.items() if k.lower() == SCENE_TAG), None)
        scene = json.loads(raw) if raw else None
        return scene if isinstance(scene, dict) and isinstance(scene.get("words"), list) else None
    except Exception:
        return None


@router.post("/import")
def import_scene(data: dict = Body(...)):
    source = Path(str(data.get("source", ""))).resolve()
    if not source.is_file() or source.parent != UPLOADS.resolve():
        raise HTTPException(422, "Vidéo introuvable : renvoie-la.")
    scene = _read_scene(source)
    name = str(data.get("name") or source.stem)
    title = (scene or {}).get("title") or re.sub(r"\s*-\s*scène à doubler$", "", Path(name).stem)
    title = re.sub(r"[^\w .()'-]", "", str(title)).strip()[:80] or "Scène"
    project_id = f"{title} {time.strftime('%d-%m %Hh%M')}"
    project_dir = STUDIO / project_id
    if project_dir.exists():
        project_id += f" {uuid.uuid4().hex[:4]}"
        project_dir = STUDIO / project_id
    project_dir.mkdir(parents=True)
    (project_dir / "clips").mkdir()
    try:
        h264 = core.probe(source, "v:0", "stream=codec_name") == "h264"
        has_audio = bool(core.probe(source, "a:0", "stream=codec_name"))
        video = ["-c:v", "copy"] if h264 else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
        # sans piste son, une piste muette : le montage final mixe les prises sur l'ambiance
        silent = [] if has_audio else ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        audio = ["-map", "0:a:0" if has_audio else "1:a:0", "-c:a", "aac", "-b:a", "256k"] + ([] if has_audio else ["-shortest"])
        core.ffmpeg("-i", str(source), *silent, "-map", "0:v:0", *audio, *video, "-map_metadata", "-1",
                    "-movflags", "+faststart", str(project_dir / "ambiance.mp4"))
    except Exception as exc:
        shutil.rmtree(project_dir, ignore_errors=True)
        raise HTTPException(422, f"Cette vidéo ne peut pas être lue : {exc}"[:400]) from exc
    finally:
        source.unlink(missing_ok=True)
    words, speakers = [], core.speakers_meta(1)
    if scene:
        words = [{"w": str(w["w"])[:40], "s": float(w["s"]), "e": float(w["e"]), "sp": int(w.get("sp", 0))}
                 for w in scene["words"] if str(w.get("w", "")).strip()]
        if scene.get("speakers"):
            speakers = [{"id": int(s["id"]), "name": str(s.get("name") or f"Personne {int(s['id']) + 1}")[:30],
                         "color": core.COLORS[int(s["id"]) % len(core.COLORS)],
                         **({"portrait": float(s["portrait"])} if isinstance(s.get("portrait"), (int, float)) else {})}
                        for s in scene["speakers"]]
    write(project_dir, "words.json", words)
    write(project_dir, "clips.json", [])
    duration = float(core.probe(project_dir / "ambiance.mp4", "v:0", "format=duration") or 0) or None
    write(project_dir, "meta.json", {"title": title, "created": time.time(), "duration": duration, "imported": True,
                                     "separation": "import", "speakers": speakers,
                                     "latency_ms": int((scene or {}).get("latency_ms", 0) or 0),
                                     "mix": {"voice": 1.2, "ambience": 1.0, "keep_original": False, "original": 1.0}})
    return {"id": project_id, "rythmo": bool(words)}


@router.get("/{project_id}/file/{name:path}")
def project_file(project_id: str, name: str):
    base = project(project_id).resolve()
    if name == "original.mp4" and not (base / name).is_file():  # scène importée : déjà sans les voix, pas d'original
        name = "ambiance.mp4"
    path = (base / name).resolve()
    if base not in path.parents or not path.is_file() or path.name.startswith("."):
        raise HTTPException(404, "Fichier introuvable")
    return FileResponse(path, filename=path.name if path.name.startswith("final_") else None)


@router.delete("/{project_id}")
def delete_project(project_id: str):
    shutil.rmtree(project(project_id))
    return {"ok": True}


# ------------------------------------------------------------------ prises

@router.post("/{project_id}/clips")
async def add_clip(project_id: str, request: Request, sp: int, start: float, end: float, at: float, ext: str = "webm"):
    """Une prise : la personne `sp`, enregistrée de `start` à `end` (temps de la vidéo).
    `at` : temps de la vidéo qui correspond au tout début du fichier audio."""
    path = project(project_id)
    ext = ext.lower().strip(".")
    if ext not in TAKE_TYPES:
        raise HTTPException(422, "Format d'enregistrement non pris en charge")
    if end - start < 0.2:
        raise HTTPException(422, "Prise trop courte")
    clip_id = uuid.uuid4().hex[:12]
    target = path / "clips" / f"{clip_id}.{ext}"
    target.parent.mkdir(exist_ok=True)
    with open(target, "wb") as file:
        async for chunk in request.stream():
            file.write(chunk)
    if target.stat().st_size < 1000:
        target.unlink()
        raise HTTPException(422, "L'enregistrement est vide : vérifie l'accès au micro.")
    clip = {"id": clip_id, "sp": int(sp), "file": target.name, "from": round(start, 3), "to": round(end, 3),
            "at": round(at, 3), "created": time.time()}
    with lock:
        clips = read(path, "clips.json", [])
        clips.append(clip)
        write(path, "clips.json", clips)
    return clip


@router.delete("/{project_id}/clips/{clip_id}")
def delete_clip(project_id: str, clip_id: str):
    path = project(project_id)
    with lock:
        clips = read(path, "clips.json", [])
        gone = [c for c in clips if c["id"] == clip_id]
        write(path, "clips.json", [c for c in clips if c["id"] != clip_id])
    for clip in gone:
        (path / "clips" / clip["file"]).unlink(missing_ok=True)
    return {"ok": True}


@router.post("/{project_id}/render")
def render(project_id: str):
    path = project(project_id)
    meta = read(path, "meta.json", {})
    mix = meta.get("mix", {})
    name = f"final_{time.strftime('%Y%m%d_%H%M%S')}.mp4"
    try:
        core.render(path, read(path, "words.json", []), read(path, "clips.json", []), meta.get("speakers", []),
                    path / name, latency_ms=meta.get("latency_ms", 0),
                    voice=float(mix.get("voice", 1.2)), ambience=float(mix.get("ambience", 1.0)),
                    keep_original=bool(mix.get("keep_original", True)), original=float(mix.get("original", 1.0)))
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(500, f"Le montage a échoué : {exc}") from exc
    return {"final": name}
