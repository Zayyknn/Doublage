"""Mise à jour de Joue ta réplique depuis l'appli, sans retélécharger l'installateur.

L'appli lit la dernière version publiée sur GitHub, télécharge son code et le pose dans son dossier
(réglages, vidéos et moteur installé gardés). Elle se relance ensuite : le lanceur reconnaît le code
RESTART et redémarre le moteur, qui réinstalle les dépendances si requirements.txt a changé.
Rien ne passe par le navigateur, donc macOS ne bloque pas la nouvelle version.
"""
from __future__ import annotations

import io
import re
import shutil
import threading
import time
import zipfile
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
REPO = "Zayyknn/Doublage"
RESTART = 75  # code de sortie : « relance-moi », compris par le lanceur
# mêmes exclusions que launcher/build.py, plus ce qui appartient à l'utilisateur
SKIP = {".git", ".github", "build", "dist", "launcher", "docs", "tests", "output", "history", "studio", "uploads",
        "_model_cache", ".venv", "tools", "logs", "__pycache__", "VideoLingo_colab.ipynb", "OneKeyStart.bat",
        "webview", ".doublage_password", "_update"}
KEEP = {"config.yaml", "custom_terms.xlsx"}  # réglages : jamais écrasés

state = {"step": "idle", "error": None, "latest": None}
_cache = {"at": 0.0, "data": None}


def parse(version: str) -> tuple:
    return tuple(int(n) for n in re.findall(r"\d+", version or "")) or (0,)


def current() -> str:
    path = ROOT / "VERSION"
    return path.read_text(encoding="utf-8").strip().lstrip("v") if path.exists() else "dev"


def check(force: bool = False) -> dict:
    if force or not _cache["data"] or time.time() - _cache["at"] > 600:
        r = requests.get(f"https://api.github.com/repos/{REPO}/releases/latest", timeout=10,
                         headers={"Accept": "application/vnd.github+json"})
        r.raise_for_status()
        release = r.json()
        _cache.update(at=time.time(), data={"tag": release["tag_name"], "notes": release.get("body") or ""})
    tag = _cache["data"]["tag"]
    latest = tag.lstrip("v")
    mine = current()
    return {"current": mine, "latest": latest, "tag": tag,
            "newer": mine == "dev" or parse(latest) > parse(mine), **{k: state[k] for k in ("step", "error")}}


def _install(tag: str, on_done):
    try:
        state.update(step="download", error=None)
        r = requests.get(f"https://codeload.github.com/{REPO}/zip/refs/tags/{tag}", timeout=300)
        r.raise_for_status()
        state["step"] = "install"
        work = ROOT / "_update"
        shutil.rmtree(work, ignore_errors=True)
        with zipfile.ZipFile(io.BytesIO(r.content)) as z:
            z.extractall(work)
        src = next(p for p in work.iterdir() if p.is_dir())  # Doublage-1.2.6/
        if not (src / "web.py").exists():
            raise RuntimeError("archive inattendue (web.py absent)")
        for item in src.iterdir():
            target = ROOT / item.name
            if item.name in SKIP or (item.name in KEEP and target.exists()):
                continue
            if item.is_dir():
                shutil.rmtree(target, ignore_errors=True)
                shutil.copytree(item, target)
            else:
                shutil.copy2(item, target)
        (ROOT / "VERSION").write_text(tag.lstrip("v"), encoding="utf-8")
        shutil.rmtree(work, ignore_errors=True)
        for script in ROOT.glob("*.sh"):
            script.chmod(0o755)
        state["step"] = "restart"
        on_done()
    except Exception as exc:
        state.update(step="error", error=str(exc))


def apply(on_done) -> dict:
    if state["step"] in ("download", "install", "restart"):
        return state
    info = check(force=True)
    if not info["newer"]:
        state.update(step="idle", error=None)
        return {**state, "error": "Déjà à jour"}
    state["latest"] = info["latest"]
    state["step"] = "download"
    threading.Thread(target=_install, args=(info["tag"], on_done), daemon=True).start()
    return state
