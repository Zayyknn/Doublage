"""Studio Rythmo — l'application à double-cliquer (Windows .exe, Mac .app).

Studio Rythmo s'ouvre dans sa propre fenêtre (pywebview : Edge WebView2 sur Windows, WebKit sur Mac).
Sans pywebview, une petite fenêtre simple prend le relais et Studio Rythmo s'ouvre dans le navigateur.

Elle contient le code de l'appli et l'outil `uv`. Au premier lancement, elle copie l'appli dans le dossier
de l'utilisateur et installe tout (Python, modèles…) en montrant la progression. Ensuite elle démarre le moteur
sans fenêtre de console, ouvre le navigateur, et l'arrête proprement quand on clique sur Quitter.
"""
from __future__ import annotations

import os
import queue
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

APP = "Studio Rythmo"
APP_DIR = "JoueTaReplique"  # nom des dossiers et fichiers : sans espace ni accent
PORT = 8765
RESTART = 75  # code de sortie du moteur après « Mettre à jour » (updater.py) : on le relance
URL = f"http://localhost:{PORT}"
WINDOWS = sys.platform == "win32"
NO_WINDOW = 0x08000000 if WINDOWS else 0  # CREATE_NO_WINDOW : pas de console qui s'ouvre
KEEP = {"config.yaml", "custom_terms.xlsx"}  # réglages de l'utilisateur : jamais écrasés par une mise à jour
USER_DIRS = {".venv", "output", "history", "studio", "uploads", "_model_cache", "tools", "logs", ".doublage_password"}


def bundle() -> Path:
    """Dossier des fichiers embarqués dans l'application."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent / "build" / "bundle"))


def home() -> Path:
    if WINDOWS:
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / APP_DIR


def version_key(version: str) -> tuple:
    return tuple(int(n) for n in re.findall(r"\d+", version)) or (0,)


def install_files(src: Path, dst: Path) -> bool:
    """Copie le code de l'appli s'il a changé. Garde les réglages et les vidéos de l'utilisateur.

    Le bouton « Mettre à jour » de l'appli pose une version plus récente que celle de l'installateur :
    on ne la remplace jamais par une plus ancienne."""
    version = (src / "VERSION").read_text(encoding="utf-8").strip() if (src / "VERSION").exists() else "dev"
    current = dst / "VERSION"
    if current.exists():
        installed = current.read_text(encoding="utf-8").strip()
        if installed == version:
            return False
        if re.search(r"\d+\.\d+", installed) and re.search(r"\d+\.\d+", version) \
                and version_key(installed) > version_key(version) and (dst / "web.py").exists():
            return False
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dst / item.name
        if item.name in USER_DIRS or (item.name in KEEP and target.exists()):
            continue
        if item.is_dir():
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)
    for script in ("lancer-jouetareplique.sh",):
        if (dst / script).exists():
            (dst / script).chmod(0o755)
    return True


def uv_path() -> Path:
    exe = bundle() / ("uv.exe" if WINDOWS else "uv")
    if not WINDOWS and exe.exists():
        exe.chmod(0o755)
    return exe


def server_ready() -> bool:
    try:
        with urllib.request.urlopen(URL + "/login", timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


# Lignes de l'installation traduites en étapes compréhensibles
STEPS = [
    (re.compile(r"\[1/3\]|Checking uv", re.I), "Préparation de l'installation"),
    (re.compile(r"\[2/3\]|Creating virtual environment|Using CPython|Downloading cpython", re.I), "Installation de Python"),
    (re.compile(r"\[1/6\]|\[2/6\]|\[3/6\]|torch|CUDA", re.I), "Installation du moteur IA (le plus long)"),
    (re.compile(r"\[4/6\]", re.I), "Installation des outils"),
    (re.compile(r"\[5/6\]|spacy", re.I), "Installation de l'analyse du langage"),
    (re.compile(r"\[6/6\]|demucs", re.I), "Installation de la séparation des voix"),
    (re.compile(r"ffmpeg", re.I), "Installation des outils vidéo"),
    (re.compile(r"est prêt", re.I), "Démarrage"),
]


class Engine:
    """Le moteur, lancé sans console. Les messages arrivent dans `events`."""

    def __init__(self, root: Path, source: Path | None = None, uv: Path | None = None, install_only: bool = False):
        self.root = root
        self.source = source or bundle() / "app"     # code de l'appli à copier
        self.uv = uv or uv_path()
        self.install_only = install_only           # installateur : installe le moteur puis s'arrête
        self.proc: subprocess.Popen | None = None
        self.events: queue.Queue = queue.Queue()
        self.password = None
        self.lan = None
        self.log = root / "logs" / "doublage.log"

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            self.events.put(("step", "Préparation des fichiers"))
            fresh = install_files(self.source, self.root)
            if fresh:
                self.events.put(("log", f"Installé dans {self.root}"))
                if not WINDOWS and server_ready():  # un moteur de l'ancienne version tourne encore : on le remplace
                    subprocess.run(f"lsof -ti tcp:{PORT} -sTCP:LISTEN | xargs kill", shell=True, capture_output=True)
                    for _ in range(20):
                        if not server_ready():
                            break
                        time.sleep(0.5)
            if not self.install_only and server_ready():  # déjà lancé (deuxième clic sur l'icône)
                self.events.put(("ready", None))
                return
            self.log.parent.mkdir(exist_ok=True)
            env = dict(os.environ, PYTHONUTF8="1", PYTHONUNBUFFERED="1", DOUBLAGE_NO_BROWSER="1", DOUBLAGE_LAUNCHER="1",
                       UV_PYTHON_PREFERENCE="only-managed", PATH=str(self.uv.parent) + os.pathsep + os.environ.get("PATH", ""))
            while True:
                code = self._launch(env)
                if code == RESTART and not self.install_only and not getattr(self, "stopping", False):
                    self.events.put(("log", "Mise à jour installée : redémarrage du moteur"))
                    continue  # « Mettre à jour » dans l'appli : le nouveau code est posé, on relance
                break
            if self.install_only and code == 0:
                self.events.put(("done", None))
            elif code not in (0, None) and not getattr(self, "stopping", False):
                self.events.put(("error", f"Studio Rythmo s'est arrêté (code {code}). Le détail est dans {self.log}"))
        except Exception as exc:
            self.events.put(("error", f"Impossible de démarrer Studio Rythmo : {exc}"))

    def _launch(self, env: dict) -> int:
            self.proc = subprocess.Popen(
                [str(self.uv), "run", "--no-project", "--python", "3.12", "start.py",
                 "--install-only" if self.install_only else "--web"],
                cwd=self.root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW,
                start_new_session=not WINDOWS)
            if not self.install_only:
                threading.Thread(target=self._watch_ready, daemon=True).start()
            with open(self.log, "a", encoding="utf-8") as log:
                log.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
                for line in self.proc.stdout:
                    log.write(line)
                    log.flush()
                    self._read(line.rstrip())
            return self.proc.wait()

    def _read(self, line: str):
        if not line.strip():
            return
        self.events.put(("log", line))
        for pattern, label in STEPS:
            if pattern.search(line):
                self.events.put(("step", label))
                break
        found = re.search(r"Mot de passe\s*:\s*(\S+)", line)
        if found:
            self.password = found.group(1)
        found = re.search(r"Téléphone \(Wi-Fi\)\s*:\s*(\S+)", line)
        if found:
            self.lan = found.group(1)

    def _watch_ready(self):
        while self.proc and self.proc.poll() is None:
            if server_ready():
                self.events.put(("ready", None))
                return
            time.sleep(1)

    def stop(self):
        self.stopping = True
        if not self.proc or self.proc.poll() is not None:
            return
        try:
            if WINDOWS:  # uv -> python -> moteur : on arrête toute la famille
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], capture_output=True,
                               creationflags=NO_WINDOW)
            else:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass


# ---------------------------------------------------------------------------------------------- fenêtre

def run_window():
    import tkinter as tk
    from tkinter import ttk

    BG, CARD, TEXT, MUTED, ACCENT, ACCENT2, BAD = "#0b0c13", "#151724", "#f3f4f8", "#8d90a6", "#8b7bff", "#4fd6ff", "#ff6b81"
    root = tk.Tk()
    root.title(APP)
    root.configure(bg=BG)
    root.geometry("440x360")
    root.minsize(400, 320)
    icon = bundle() / "icon.png"
    if icon.exists():
        try:
            root.iconphoto(True, tk.PhotoImage(file=str(icon)))
        except Exception:
            pass
    sans = ("Segoe UI", 11) if WINDOWS else ("Helvetica Neue", 13)
    title_font = (sans[0], sans[1] + 9, "bold")

    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass
    style.configure("D.Horizontal.TProgressbar", troughcolor=CARD, background=ACCENT, bordercolor=CARD,
                    lightcolor=ACCENT2, darkcolor=ACCENT, thickness=6)

    frame = tk.Frame(root, bg=BG, padx=28, pady=24)
    frame.pack(fill="both", expand=True)
    logo = None
    if icon.exists():
        try:
            logo = tk.PhotoImage(file=str(icon)).subsample(4, 4)
            tk.Label(frame, image=logo, bg=BG).pack(anchor="w")
        except Exception:
            pass
    tk.Label(frame, text=APP, font=title_font, fg=TEXT, bg=BG).pack(anchor="w", pady=(8, 0))
    status = tk.Label(frame, text="Démarrage…", font=sans, fg=MUTED, bg=BG, justify="left", wraplength=380)
    status.pack(anchor="w", pady=(4, 12))
    bar = ttk.Progressbar(frame, mode="indeterminate", style="D.Horizontal.TProgressbar")
    bar.pack(fill="x")
    bar.start(12)
    detail = tk.Label(frame, text="", font=(sans[0], sans[1] - 2), fg=MUTED, bg=BG, justify="left", wraplength=380, anchor="w")
    detail.pack(anchor="w", fill="x", pady=(10, 0))
    info = tk.Label(frame, text="", font=(sans[0], sans[1] - 1), fg=TEXT, bg=BG, justify="left", wraplength=380)
    info.pack(anchor="w", pady=(6, 0))

    buttons = tk.Frame(frame, bg=BG)
    buttons.pack(side="bottom", fill="x", pady=(16, 0))

    def button(parent, text, command, primary=False):
        b = tk.Label(parent, text=text, font=(sans[0], sans[1], "bold"), fg="#0b0b12" if primary else TEXT,
                     bg=ACCENT if primary else CARD, padx=18, pady=9, cursor="hand2")
        b.bind("<Button-1>", lambda e: command())
        b.bind("<Enter>", lambda e: b.configure(bg=ACCENT2 if primary else "#20233a"))
        b.bind("<Leave>", lambda e: b.configure(bg=ACCENT if primary else CARD))
        return b

    engine = Engine(home())
    state = {"ready": False, "first": not (home() / ".venv").exists()}

    def open_app():
        webbrowser.open(URL)

    def quit_app():
        status.configure(text="Arrêt de Studio Rythmo…")
        root.update()
        engine.stop()
        root.destroy()

    open_btn = button(buttons, "Ouvrir Studio Rythmo", open_app, primary=True)
    quit_btn = button(buttons, "Quitter", quit_app)
    quit_btn.pack(side="right")
    root.protocol("WM_DELETE_WINDOW", quit_app)

    if state["first"]:
        status.configure(text="Première ouverture : installation de Studio Rythmo.\nCompte 10 à 20 minutes, une seule fois. "
                              "Laisse cette fenêtre ouverte.")

    def poll():
        try:
            while True:
                kind, value = engine.events.get_nowait()
                if kind == "step" and not state["ready"]:
                    detail.configure(text=value + "…")
                elif kind == "log" and not state["ready"]:
                    short = value if len(value) < 90 else value[:87] + "…"
                    if not state["first"]:
                        detail.configure(text=short)
                elif kind == "ready" and not state["ready"]:
                    state["ready"] = True
                    bar.stop()
                    bar.configure(mode="determinate", value=100)
                    status.configure(text="Studio Rythmo est prêt. Garde cette fenêtre ouverte (tu peux la réduire).", fg=TEXT)
                    lines = []
                    if engine.lan:
                        lines.append(f"Sur ton téléphone (même Wi-Fi) : {engine.lan}")
                    if engine.password:
                        lines.append(f"Mot de passe pour le téléphone : {engine.password}")
                    detail.configure(text="")
                    info.configure(text="\n".join(lines))
                    open_btn.pack(side="left")
                    open_app()
                elif kind == "error":
                    bar.stop()
                    status.configure(text=value, fg=BAD)
                    detail.configure(text="")
        except queue.Empty:
            pass
        root.after(200, poll)

    engine.start()
    poll()
    root.mainloop()


def run_webview():
    import json
    import webview

    engine = Engine(home())
    first = not (home() / ".venv").exists()
    splash = (bundle() / "splash.html").read_text(encoding="utf-8")
    state = {"ready": False, "window": None}

    class Api:
        def camera_ok(self):
            # La page n'allume la webcam dans la fenêtre Mac que si l'application a l'autorisation caméra
            # (NSCameraUsageDescription, depuis la 1.5.4) : sans elle, macOS tue l'application.
            return True

        def open_log(self):
            path = engine.log
            if WINDOWS:
                os.startfile(str(path))  # noqa
            else:
                subprocess.run(["open" if sys.platform == "darwin" else "xdg-open", str(path)])

        def retry(self):
            state["window"].load_html(splash)
            time.sleep(0.5)
            js("setFirst", first)
            engine.stopping = False
            engine.start()  # même file de messages : la boucle d'affichage continue de la lire

        def open_browser(self):
            webbrowser.open(URL)

    window = webview.create_window(APP, html=splash, js_api=Api(), width=1180, height=860, min_size=(380, 600),
                                   background_color="#07080d", text_select=True)
    state["window"] = window

    def js(fn, *args):
        try:
            window.evaluate_js(f"window.{fn} && window.{fn}({', '.join(json.dumps(a) for a in args)})")
        except Exception:
            pass

    def pump():
        time.sleep(0.6)
        js("setFirst", first)
        engine.start()
        while True:
            kind, value = engine.events.get()
            if kind == "step":
                js("setStep", value)
            elif kind == "log":
                js("setLog", value if len(value) < 140 else value[:137] + "…")
            elif kind == "error":
                js("setError", value)
            elif kind == "ready" and not state["ready"]:
                state["ready"] = True
                js("setReady")
                time.sleep(0.6)
                version_file = home() / "VERSION"
                version = version_file.read_text(encoding="utf-8").strip() if version_file.exists() else str(int(time.time()))
                window.load_url(f"{URL}/?v={version}")  # adresse nouvelle à chaque version : la fenêtre ne ressort pas l'ancienne page

    def on_closing():
        engine.stop()

    window.events.closing += on_closing
    webview.start(pump, private_mode=False, storage_path=str(home() / "webview"))


def main():
    if "--uninstall" in sys.argv:
        import setup_app
        setup_app.run(uninstall=True)
        return
    if "--headless" in sys.argv:  # test sans fenêtre
        engine = Engine(home())
        engine.start()
        while True:
            kind, value = engine.events.get()
            print(kind, value or "")
            if kind in ("ready", "error"):
                engine.stop()
                return
    try:
        run_webview()
    except Exception:
        run_window()


if __name__ == "__main__":
    main()
