"""Joue ta réplique — application web (PC et smartphone) au-dessus du moteur VideoLingo.

Lancement : uv run start.py --web   (ou double-clic sur Lancer-JoueTaReplique.bat sous Windows)
Ouvre ensuite http://localhost:8765 sur le PC, ou l'adresse affichée dans la console sur le téléphone.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import shutil
import socket
import sys
import subprocess
import threading
import time
import webbrowser
from importlib.util import find_spec
from pathlib import Path
from urllib.parse import urlparse

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)  # le moteur travaille avec des chemins relatifs (config.yaml, output/)

import requests  # noqa: E402
import api as engine  # noqa: E402  (FastAPI du moteur : /input, /run, /status, /files…)
from core.pipeline import get_steps  # noqa: E402
from core.utils.config_utils import load_key, load_key_or, update_key  # noqa: E402

PORT = int(os.environ.get("DOUBLAGE_PORT", "8765"))
HOST = os.environ.get("DOUBLAGE_HOST", "0.0.0.0")
UPLOADS = ROOT / "uploads"
HISTORY = ROOT / "history"
OUTPUT = ROOT / "output"
WEB = ROOT / "web"
PASSWORD_FILE = ROOT / ".doublage_password"
COOKIE = "doublage_session"
PUBLIC = {"/login", "/manifest.webmanifest", "/icon.svg", "/app.css", "/login.js", "/favicon.ico"}

# ------------------------------------------------------------------ mot de passe

def password() -> str:
    env = os.environ.get("DOUBLAGE_MOT_DE_PASSE", "").strip()
    if env:
        return env
    if not PASSWORD_FILE.exists():
        words = ["lune", "orage", "cafe", "vague", "piano", "renard", "sable", "neon", "brume", "cobalt",
                 "ambre", "falaise", "comete", "tilleul", "corail", "givre"]
        PASSWORD_FILE.write_text(f"{secrets.choice(words)}-{secrets.choice(words)}-{secrets.randbelow(900) + 100}",
                                 encoding="utf-8")
    return PASSWORD_FILE.read_text(encoding="utf-8").strip()


def session_token() -> str:
    return hmac.new(password().encode(), b"doublage-session-v1", hashlib.sha256).hexdigest()


app = FastAPI(title="Joue ta réplique", docs_url=None, redoc_url=None)


def is_local(request: Request) -> bool:
    """Ouvert sur le PC lui-même : pas de mot de passe. Le tunnel arrive aussi en local,
    mais avec les en-têtes de Cloudflare, donc il demande le mot de passe."""
    host = request.client.host if request.client else ""
    proxied = any(h in request.headers for h in ("cf-connecting-ip", "x-forwarded-for", "cf-ray"))
    return host in {"127.0.0.1", "::1", "localhost"} and not proxied


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    ok = is_local(request) or hmac.compare_digest(request.cookies.get(COOKIE, ""), session_token())
    if ok or path in PUBLIC:
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "Connexion requise"}, status_code=401)
    return RedirectResponse("/login")


@app.get("/login")
def login_page():
    return FileResponse(WEB / "login.html")


@app.post("/login")
def login(data: dict = Body(...)):
    time.sleep(0.4)  # freine les essais à la chaîne
    if not hmac.compare_digest(str(data.get("password", "")).strip(), password()):
        raise HTTPException(401, "Mot de passe incorrect")
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE, session_token(), max_age=60 * 60 * 24 * 90, httponly=True, samesite="lax")
    return response


@app.post("/logout")
def logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE)
    return response


# ------------------------------------------------------------------ réglages

SECRETS = {"api.key", "fish_audio.api_key", "whisper.elevenlabs_api_key"}
SETTINGS = [
    "translation_engine", "target_language", "dubbing_language_code", "whisper.language",
    "tts_method", "edge_tts.voice", "kokoro_tts.voice", "kokoro_tts.speed",
    "chatterbox_tts.clone", "chatterbox_tts.exaggeration", "fish_audio.mode", "fish_audio.api_key",
    "api.key", "api.base_url", "api.model", "api.llm_support_json", "max_workers",
    "burn_subtitles", "subtitle.dub_video_subtitles", "demucs", "ytb_resolution",
]


def _is_set(value) -> bool:
    return bool(value) and not str(value).startswith(("YOUR_", "your_"))


@app.get("/api/settings")
def get_settings():
    values = {}
    for key in SETTINGS:
        value = load_key_or(key, None)
        if key in SECRETS:
            values[key] = {"set": _is_set(value), "end": str(value)[-4:] if _is_set(value) else ""}
        else:
            values[key] = value
    return values


@app.post("/api/settings")
def save_settings(data: dict = Body(...)):
    if engine.runner.is_active:
        raise HTTPException(409, "Un doublage est en cours : attends la fin pour changer les réglages.")
    for key, value in data.items():
        if key not in SETTINGS:
            continue
        if key in SECRETS and (value is None or value == ""):
            continue  # champ laissé vide : on garde la clé déjà enregistrée
        if key in {"max_workers"}:
            value = max(1, int(value))
        if key in {"kokoro_tts.speed", "chatterbox_tts.exaggeration"}:
            value = float(value)
        update_key(key, value, add_missing=True)
    return get_settings()


@app.get("/api/system")
def system():
    gpu = None
    try:
        import torch
        if torch.cuda.is_available():
            gpu = torch.cuda.get_device_name(0)
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            gpu = "Apple Silicon"
    except Exception:
        pass
    return {
        "gpu": gpu,
        "engines": {
            "edge_tts": find_spec("edge_tts") is not None,
            "kokoro_tts": find_spec("kokoro") is not None,
            "chatterbox_tts": find_spec("chatterbox") is not None,
            "fish_audio": True,
            "demucs": find_spec("demucs") is not None,
        },
        "llm_ready": load_key_or("translation_engine", "llm") == "google"
                     or _is_set(load_key_or("api.key", "")) or "localhost" in str(load_key_or("api.base_url", "")),
    }


# ------------------------------------------------------------------ envoi de vidéo par morceaux
# Les tunnels Cloudflare gratuits refusent les envois de plus de 100 Mo : le navigateur envoie
# la vidéo par morceaux de 32 Mo, recollés ici.

UPLOAD_ID = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")


def _partial(upload_id: str) -> Path:
    if not UPLOAD_ID.match(upload_id):
        raise HTTPException(422, "Identifiant d'envoi invalide")
    UPLOADS.mkdir(exist_ok=True)
    return UPLOADS / f".partial_{upload_id}"


@app.post("/api/upload/{upload_id}")
async def upload_chunk(upload_id: str, request: Request, offset: int = 0):
    path = _partial(upload_id)
    size = path.stat().st_size if path.exists() else 0
    if offset != size:
        return JSONResponse({"size": size}, status_code=409)  # le navigateur reprend au bon endroit
    with open(path, "ab") as file:
        async for chunk in request.stream():
            file.write(chunk)
    return {"size": path.stat().st_size}


@app.post("/api/upload/{upload_id}/finish")
def upload_finish(upload_id: str, name: str):
    path = _partial(upload_id)
    if not path.exists():
        raise HTTPException(404, "Envoi introuvable")
    stem, suffix = os.path.splitext(os.path.basename(name))
    suffix = suffix.lower()
    allowed = {"." + f for f in load_key("allowed_video_formats") + load_key("allowed_audio_formats")} | {".srt"}
    if suffix not in allowed:
        path.unlink(missing_ok=True)
        raise HTTPException(422, f"Format non pris en charge : {suffix or 'inconnu'}")
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", stem).strip(". ") or "video"
    final = UPLOADS / f"{stem[:80]}{suffix}"
    if final.exists():
        final.unlink()
    path.rename(final)
    return {"path": str(final)}


# ------------------------------------------------------------------ lancer un doublage

def _clear_output():
    """Range le travail précédent dans l'historique avant d'en commencer un nouveau."""
    if not OUTPUT.exists() or not any(OUTPUT.iterdir()):
        return
    try:
        engine.archive_output()
    except Exception:
        HISTORY.mkdir(exist_ok=True)
        shutil.move(str(OUTPUT), str(HISTORY / f"inacheve_{time.strftime('%Y%m%d_%H%M%S')}"))


@app.post("/api/job", status_code=202)
def start_job(data: dict = Body(...)):
    with engine.operation_lock:
        if engine.runner.is_active:
            raise HTTPException(409, "Un doublage est déjà en cours.")
        source = str(data.get("source", "")).strip()
        if not source:
            raise HTTPException(422, "Ajoute une vidéo ou un lien.")
        if urlparse(source).scheme not in {"http", "https"}:
            path = Path(source).resolve()
            if not path.is_file() or path.parent != UPLOADS.resolve():
                raise HTTPException(422, "Vidéo introuvable : renvoie-la.")
            source = str(path)
        mode = data.get("mode", "dub")  # dub | subtitles
        if data.get("target_language"):
            update_key("target_language", str(data["target_language"]))
        if data.get("dubbing_language_code"):
            update_key("dubbing_language_code", str(data["dubbing_language_code"]), add_missing=True)
        if data.get("source_language"):
            update_key("whisper.language", str(data["source_language"]))

        def prepare():
            _clear_output()
            engine.prepare_input(source, "replace")
            if urlparse(source).scheme not in {"http", "https"}:
                Path(source).unlink(missing_ok=True)  # copiée dans output/ : on libère la place

        steps = [("Prepare input", prepare)] + get_steps("all", dubbing=(mode == "dub"))
        engine.runner.start(steps)
        return {"accepted": True}


@app.post("/api/run", status_code=202)
def rerun(data: dict = Body(...)):
    """Réessayer après une erreur : les étapes déjà faites sont gardées."""
    return engine.run(engine.RunRequest(stage="all", dubbing=bool(data.get("dubbing", True))))


@app.post("/api/stop")
def stop_job():
    engine.runner.stop()
    return {"state": engine.runner.state}


@app.post("/api/resume")
def resume_job():
    engine.runner.resume()
    return {"state": engine.runner.state}


@app.get("/api/status")
def status():
    return engine.status()


@app.get("/api/files/{name}")
def output_file(name: str):
    return engine.file(name)


# ------------------------------------------------------------------ bibliothèque

@app.get("/api/library")
def library():
    items = []
    folders = [p for p in HISTORY.iterdir() if p.is_dir()] if HISTORY.exists() else []
    for folder in folders:
        videos = [n for n in ("output_dub.mp4", "output_sub.mp4") if (folder / n).exists()]
        if not videos:
            continue
        items.append({"id": folder.name, "title": folder.name, "video": videos[0],
                      "files": sorted(p.name for p in folder.iterdir() if p.is_file() and p.suffix in {".mp4", ".srt", ".mp3", ".wav"}),
                      "date": (folder / videos[0]).stat().st_mtime})
    return sorted(items, key=lambda item: item["date"], reverse=True)


@app.get("/api/library/{folder}/{name}")
def library_file(folder: str, name: str):
    path = (HISTORY / folder / name).resolve()
    if path.parent.parent != HISTORY.resolve() or not path.is_file():
        raise HTTPException(404, "Fichier introuvable")
    return FileResponse(path, filename=path.name)


@app.delete("/api/library/{folder}")
def library_delete(folder: str):
    path = (HISTORY / folder).resolve()
    if path.parent != HISTORY.resolve() or not path.is_dir():
        raise HTTPException(404, "Introuvable")
    shutil.rmtree(path)
    return {"ok": True}


# ------------------------------------------------------------------ écouter une voix

@app.post("/api/preview")
def preview(data: dict = Body(...)):
    if engine.runner.is_active:
        raise HTTPException(409, "Un doublage est en cours.")
    text = str(data.get("text") or "Bonjour ! Voici à quoi ressemble cette voix pour ton doublage.")[:300]
    method = load_key("tts_method")
    UPLOADS.mkdir(exist_ok=True)
    out = UPLOADS / f".preview_{method}.{'mp3' if method == 'edge_tts' else 'wav'}"
    out.unlink(missing_ok=True)
    try:
        if method == "edge_tts":
            from core.tts_backend.edge_tts import edge_tts
            edge_tts(text, str(out))
        elif method == "kokoro_tts":
            from core.tts_backend.kokoro_tts import kokoro_tts
            kokoro_tts(text, str(out))
        elif method == "chatterbox_tts":
            from core.tts_backend.chatterbox_tts import chatterbox_tts
            chatterbox_tts(text, str(out))  # sans la vidéo : voix par défaut, le clonage se fait pendant le doublage
        else:
            raise HTTPException(422, "Aperçu disponible pour Edge, Kokoro et Chatterbox.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"La voix n'a pas pu être générée : {exc}") from exc
    return FileResponse(out, media_type="audio/mpeg" if out.suffix == ".mp3" else "audio/wav")


# ------------------------------------------------------------------ assistant de configuration
# Tout ce qui demandait des commandes se fait ici, par des boutons : modèle Ollama, voix locales,
# accès depuis le téléphone.

OLLAMA = "http://localhost:11434"
OLLAMA_MODEL = "qwen2.5:7b"
TOOLS = ROOT / "tools"
jobs = {
    "ollama": {"running": False, "percent": 0, "status": "", "error": None},
    "voices": {"running": False, "done": False, "ok": None, "log": []},
    "tunnel": {"running": False, "url": None, "error": None, "status": ""},
}


def ollama_info():
    try:
        tags = requests.get(f"{OLLAMA}/api/tags", timeout=1.5).json()
        models = [m.get("name", "") for m in tags.get("models", [])]
        return {"running": True, "models": models, "ready": any(m.split(":")[0] == OLLAMA_MODEL.split(":")[0] for m in models)}
    except Exception:
        return {"running": False, "models": [], "ready": False}


def use_ollama(model):
    for key, value in {"translation_engine": "llm", "api.base_url": f"{OLLAMA}/v1", "api.model": model,
                       "api.key": "ollama", "max_workers": 1, "api.llm_support_json": False}.items():
        update_key(key, value, add_missing=True)


@app.get("/api/setup")
def setup_state(request: Request):
    local = is_local(request)
    return {
        "done": bool(load_key_or("doublage_setup_done", False)),
        "local": local,
        "password": password() if local else None,
        "lan": [f"http://{a}:{PORT}" for a in local_addresses()],
        "ollama": ollama_info(),
        "ollama_model": OLLAMA_MODEL,
        "jobs": jobs,
        "remote_access": bool(load_key_or("remote_access", False)),
        "platform": sys.platform,
    }


@app.post("/api/setup/finish")
def setup_finish():
    update_key("doublage_setup_done", True, add_missing=True)
    return {"ok": True}


@app.post("/api/setup/translation")
def setup_translation(data: dict = Body(...)):
    choice = data.get("engine")
    if choice == "google":
        update_key("translation_engine", "google", add_missing=True)
    elif choice == "ollama":
        info = ollama_info()
        installed = next((m for m in info["models"] if m.split(":")[0] == OLLAMA_MODEL.split(":")[0]), None)
        use_ollama(installed or OLLAMA_MODEL)
    elif choice == "api":
        update_key("translation_engine", "llm", add_missing=True)
    return get_settings()


@app.post("/api/ollama/pull")
def ollama_pull():
    job = jobs["ollama"]
    if job["running"]:
        return job
    if not ollama_info()["running"]:
        raise HTTPException(409, "Ollama n'est pas lancé : installe-le puis ouvre-le.")

    def run():
        job.update(running=True, percent=0, status="Démarrage…", error=None)
        try:
            with requests.post(f"{OLLAMA}/api/pull", json={"model": OLLAMA_MODEL, "stream": True}, stream=True, timeout=3600) as r:
                for line in r.iter_lines():
                    if not line:
                        continue
                    event = __import__("json").loads(line)
                    if event.get("error"):
                        raise RuntimeError(event["error"])
                    if event.get("total"):
                        job["percent"] = round(100 * event.get("completed", 0) / event["total"])
                    job["status"] = event.get("status", "")
            use_ollama(OLLAMA_MODEL)
            job.update(percent=100, status="Prêt")
        except Exception as exc:
            job["error"] = str(exc)
        finally:
            job["running"] = False

    threading.Thread(target=run, daemon=True).start()
    job["running"] = True
    return job


@app.post("/api/install/voices")
def install_voices():
    job = jobs["voices"]
    if job["running"]:
        return job
    if engine.runner.is_active:
        raise HTTPException(409, "Attends la fin du doublage en cours.")

    def run():
        job.update(running=True, done=False, ok=None, log=["Installation de Kokoro et Chatterbox (quelques minutes)…"])
        try:
            proc = subprocess.Popen([sys.executable, "-u", "installer_voix.py"], cwd=ROOT, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
            for line in proc.stdout:
                line = line.strip()
                if line:
                    job["log"] = (job["log"] + [line])[-40:]
            proc.wait()
            job["ok"] = find_spec("kokoro") is not None or proc.returncode == 0
        except Exception as exc:
            job["log"].append(f"Erreur : {exc}")
            job["ok"] = False
        finally:
            import importlib
            importlib.invalidate_caches()
            job.update(running=False, done=True)

    threading.Thread(target=run, daemon=True).start()
    job["running"] = True
    return job


def cloudflared_path():
    found = shutil.which("cloudflared")
    if found:
        return found
    name = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    return str(TOOLS / name) if (TOOLS / name).exists() else None


def download_cloudflared(job):
    """Télécharge cloudflared (un seul fichier) dans tools/, depuis les versions officielles de Cloudflare."""
    import platform
    import tarfile
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "amd64"
    base = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
    TOOLS.mkdir(exist_ok=True)
    job["status"] = "Téléchargement de cloudflared…"
    if os.name == "nt":
        target, url = TOOLS / "cloudflared.exe", base + "cloudflared-windows-amd64.exe"
    elif sys.platform == "darwin":
        target, url = TOOLS / "cloudflared", base + f"cloudflared-darwin-{arch}.tgz"
    else:
        target, url = TOOLS / "cloudflared", base + f"cloudflared-linux-{arch}"
    tmp = target.with_suffix(".download")
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    if url.endswith(".tgz"):
        with tarfile.open(tmp) as archive:
            member = next(m for m in archive.getmembers() if m.name.endswith("cloudflared"))
            with archive.extractfile(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
        tmp.unlink()
    else:
        tmp.replace(target)
    target.chmod(0o755)
    return str(target)


tunnel_process = None


def start_tunnel():
    global tunnel_process
    job = jobs["tunnel"]
    if job["running"]:
        return
    job.update(running=True, url=None, error=None, status="Préparation…")

    def run():
        global tunnel_process
        try:
            exe = cloudflared_path() or download_cloudflared(job)
            job["status"] = "Ouverture du tunnel…"
            tunnel_process = subprocess.Popen([exe, "tunnel", "--no-autoupdate", "--url", f"http://localhost:{PORT}"],
                                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                              encoding="utf-8", errors="replace")
            for line in tunnel_process.stdout:
                found = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
                if found and not job["url"]:
                    job.update(url=found.group(), status="Actif")
                    print(f"  Accès depuis partout : {job['url']}")
            job["error"] = job["error"] or "Le tunnel s'est arrêté."
        except Exception as exc:
            job["error"] = f"Impossible d'ouvrir l'accès à distance : {exc}"
        finally:
            job.update(running=False, url=None, status="")

    threading.Thread(target=run, daemon=True).start()


@app.post("/api/tunnel")
def tunnel_toggle(data: dict = Body(...)):
    enable = bool(data.get("enable"))
    update_key("remote_access", enable, add_missing=True)
    if enable:
        start_tunnel()
    elif tunnel_process and tunnel_process.poll() is None:
        tunnel_process.terminate()
    return jobs["tunnel"]


# ------------------------------------------------------------------ mise à jour depuis l'appli

import updater  # noqa: E402


def _restart_engine():
    """Le lanceur (DOUBLAGE_LAUNCHER) relance le moteur quand il sort avec le code RESTART."""
    if not os.environ.get("DOUBLAGE_LAUNCHER"):
        updater.state["step"] = "manual"  # lancé à la main : il faut le relancer soi-même
        return

    def leave():
        if tunnel_process and tunnel_process.poll() is None:
            tunnel_process.terminate()
        os._exit(updater.RESTART)
    threading.Timer(1.5, leave).start()


@app.get("/api/update")
def update_check(force: bool = False):
    try:
        return updater.check(force)
    except Exception as exc:
        return {"current": updater.current(), "newer": False, "error": f"GitHub injoignable : {exc}",
                "step": updater.state["step"]}


@app.post("/api/update")
def update_apply():
    try:
        return updater.apply(_restart_engine)
    except Exception as exc:
        raise HTTPException(502, f"Mise à jour impossible : {exc}")


# ------------------------------------------------------------------ studio (ma voix à la place)

import studio  # noqa: E402
studio.clear_output = _clear_output
app.include_router(studio.router)

# ------------------------------------------------------------------ interface

# La fenêtre de l'appli Mac garde les pages en cache : chaque version porte son numéro dans les adresses
# des scripts et des styles, et rien n'est servi sans revalidation.
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip() if (ROOT / "VERSION").exists() else str(int(time.time()))


@app.middleware("http")
async def no_stale_pages(request: Request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
@app.get("/index.html")
def index_page():
    html = (WEB / "index.html").read_text(encoding="utf-8")
    html = re.sub(r'((?:src|href)="/[\w.-]+\.(?:js|css))"', rf'\1?v={VERSION}"', html)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")


def local_addresses():
    addresses = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.168.1.1", 80))
            addresses.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(a for a in addresses if not a.startswith("127."))


if __name__ == "__main__":
    import uvicorn
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    print("\n  Joue ta réplique est prêt — la page s'ouvre dans ton navigateur.")
    print(f"  Sur ce PC          : http://localhost:{PORT}")
    for address in local_addresses():
        print(f"  Téléphone (Wi-Fi)  : http://{address}:{PORT}")
    print(f"  Mot de passe       : {password()}  (demandé seulement depuis un autre appareil)")
    print("  Laisse cette fenêtre ouverte tant que tu utilises Joue ta réplique.\n")
    if load_key_or("remote_access", False):
        start_tunnel()
    if not os.environ.get("DOUBLAGE_NO_BROWSER"):
        threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
