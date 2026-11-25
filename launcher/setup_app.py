"""Installateur et désinstallateur Windows de @Raphicollas, aux couleurs de l'application.

JoueTaReplique-Setup.exe contient l'application (dossier `payload/JoueTaReplique`). L'installation :
1. copie l'application dans le dossier choisi (par défaut %LOCALAPPDATA%\\Programs\\JoueTaReplique) ;
2. crée les raccourcis et l'entrée « Applications installées » de Windows (sans droits administrateur) ;
3. installe le moteur (Python, IA) avec la progression, pour que l'appli s'ouvre tout de suite ensuite.
`JoueTaReplique.exe --uninstall` affiche la désinstallation.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import doublage_launcher as L

UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\JoueTaReplique"


def default_dir() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "Programs" / "JoueTaReplique"


def payload() -> Path:
    return L.bundle() / "payload" / "JoueTaReplique"


def version() -> str:
    for candidate in (payload() / "_internal" / "app" / "VERSION", L.bundle() / "app" / "VERSION"):
        if candidate.exists():
            return candidate.read_text(encoding="utf-8").strip()
    return "1.0.0"


KNOWN_FOLDERS = {  # identifiants Windows des dossiers spéciaux
    "Desktop": "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}",
    "Programs": "{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}",
}


def shell_folder(name: str) -> Path:
    """Bureau / menu Démarrer de l'utilisateur, même déplacés (OneDrive…) ou avec des accents."""
    import ctypes
    from ctypes import wintypes
    import uuid

    class GUID(ctypes.Structure):
        _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]

    u = uuid.UUID(KNOWN_FOLDERS[name])
    guid = GUID(u.fields[0], u.fields[1], u.fields[2], (ctypes.c_ubyte * 8)(*u.bytes[8:]))
    out = ctypes.c_wchar_p()
    if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) != 0:
        fallback = {"Desktop": Path.home() / "Desktop",
                    "Programs": Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs"}
        return fallback[name]
    try:
        return Path(out.value)
    finally:
        ctypes.windll.ole32.CoTaskMemFree(out)


def shortcut(path: Path, target: Path, args: str = "", description: str = "@Raphicollas"):
    """Raccourci .lnk. Les chemins passent par des variables d'environnement : accents, espaces et
    apostrophes arrivent intacts à PowerShell, sans aucun échappement."""
    path.parent.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, JTR_LNK=str(path), JTR_TARGET=str(target), JTR_ARGS=args,
               JTR_DIR=str(target.parent), JTR_ICON=f"{target},0", JTR_DESC=description)
    ps = ("$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:JTR_LNK); $s.TargetPath = $env:JTR_TARGET; "
          "$s.Arguments = $env:JTR_ARGS; $s.WorkingDirectory = $env:JTR_DIR; $s.IconLocation = $env:JTR_ICON; "
          "$s.Description = $env:JTR_DESC; $s.Save()")
    result = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
                            env=env, capture_output=True, creationflags=L.NO_WINDOW)
    if result.returncode != 0 or not path.exists():
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise RuntimeError(f"le raccourci « {path.name} » n'a pas pu être créé ({detail[-1] if detail else 'erreur inconnue'})")


def register(install_dir: Path, size_mb: int):
    import winreg
    exe = install_dir / "JoueTaReplique.exe"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as key:
        for name, value in {"DisplayName": "@Raphicollas", "DisplayVersion": version(), "Publisher": "@Raphicollas",
                            "DisplayIcon": f"{exe},0", "InstallLocation": str(install_dir),
                            "UninstallString": f'"{exe}" --uninstall', "QuietUninstallString": f'"{exe}" --uninstall'}.items():
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
        for name, value in {"NoModify": 1, "NoRepair": 1, "EstimatedSize": size_mb * 1024}.items():
            winreg.SetValueEx(key, name, 0, winreg.REG_DWORD, value)


def installed_dir() -> Path | None:
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as key:
            return Path(winreg.QueryValueEx(key, "InstallLocation")[0])
    except Exception:
        return None


def stop_running():
    """Ferme l'appli si elle tourne (mise à jour ou désinstallation)."""
    subprocess.run(["taskkill", "/F", "/T", "/IM", "JoueTaReplique.exe", "/FI", f"PID ne {os.getpid()}"],
                   capture_output=True, creationflags=L.NO_WINDOW)


def run(uninstall: bool = False):
    import webview

    html = (L.bundle() / "setup.html").read_text(encoding="utf-8")
    state = {"dir": installed_dir() or default_dir(), "window": None, "engine": None}

    def js(fn, *args):
        try:
            state["window"].evaluate_js(f"window.{fn}({', '.join(json.dumps(a) for a in args)})")
        except Exception:
            pass

    class Api:
        def ready(self):
            js("init", {"dir": str(state["dir"]), "version": version(), "uninstall": uninstall})

        def browse(self):
            chosen = state["window"].create_file_dialog(webview.FOLDER_DIALOG, directory=str(state["dir"].parent))
            if chosen:
                folder = Path(chosen[0] if isinstance(chosen, (list, tuple)) else chosen)
                state["dir"] = folder if folder.name.lower() == "jouetareplique" else folder / "JoueTaReplique"
                js("setDir", str(state["dir"]))

        def install(self, options):
            threading.Thread(target=do_install, args=(options,), daemon=True).start()

        def launch(self):
            subprocess.Popen([str(state["dir"] / "JoueTaReplique.exe")], cwd=state["dir"], creationflags=0x00000008)  # DETACHED
            state["window"].destroy()

        def log(self):
            engine = state["engine"]
            if engine and engine.log.exists():
                os.startfile(str(engine.log))  # noqa

        def uninstall(self, purge):
            threading.Thread(target=do_uninstall, args=(purge,), daemon=True).start()

        def close(self):
            state["window"].destroy()

    def do_install(options):
        try:
            target = state["dir"]
            stop_running()
            js("setStep", "Copie des fichiers")
            if target.exists():
                for item in target.iterdir():  # remplace l'ancienne version de l'application, pas les données
                    shutil.rmtree(item) if item.is_dir() else item.unlink()
            shutil.copytree(payload(), target, dirs_exist_ok=True)
            exe = target / "JoueTaReplique.exe"
            js("setStep", "Création des raccourcis")
            for wanted, folder in (("desktop", "Desktop"), ("startmenu", "Programs")):
                if options.get(wanted):
                    try:
                        shortcut(shell_folder(folder) / "@Raphicollas.lnk", exe)
                    except Exception as exc:  # l'appli reste installée, on le signale seulement
                        js("setLog", f"Raccourci non créé : {exc}")
            size = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) // (1 << 20)
            register(target, size + 6000)  # + le moteur installé au premier lancement

            # Le moteur : même code et même outil que l'application installée
            internal = target / "_internal"
            engine = L.Engine(L.home(), source=internal / "app", uv=internal / "uv.exe", install_only=True)
            state["engine"] = engine
            engine.start()
            while True:
                kind, value = engine.events.get()
                if kind == "step" and value != "Préparation des fichiers":
                    js("setStep", value)
                elif kind == "log":
                    js("setLog", value if len(value) < 140 else value[:137] + "…")
                elif kind == "error":
                    js("setError", value)
                    return
                elif kind == "done":
                    js("setDone")
                    return
        except Exception as exc:
            js("setError", f"L'installation a échoué : {exc}")

    def do_uninstall(purge):
        try:
            stop_running()
            target = installed_dir() or Path(sys.executable).parent
            for link in (shell_folder("Desktop") / "@Raphicollas.lnk", shell_folder("Programs") / "@Raphicollas.lnk"):
                link.unlink(missing_ok=True)
            data = L.home()
            if purge:
                shutil.rmtree(data, ignore_errors=True)
            else:  # le moteur (plusieurs Go) part, les vidéos et réglages restent
                for name in (".venv", "_model_cache", "tools", "webview", "logs"):
                    shutil.rmtree(data / name, ignore_errors=True)
            import winreg
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
            except OSError:
                pass
            # Le dossier de l'application contient ce programme : il est effacé juste après sa fermeture
            script = Path(tempfile.gettempdir()) / "doublage-uninstall.cmd"
            script.write_text(f'@echo off\r\nchcp 65001 >nul\r\ntimeout /t 2 /nobreak >nul\r\nrmdir /s /q "{target}"\r\ndel "%~f0"\r\n', encoding="utf-8")
            subprocess.Popen(["cmd", "/c", str(script)], creationflags=L.NO_WINDOW | 0x00000008)
            kept = "" if purge else f"Tes vidéos et réglages sont gardés dans {data}."
            js("setUninstalled", kept)
        except Exception as exc:
            js("setUninstallError", f"La désinstallation a échoué : {exc}")

    window = webview.create_window("Désinstaller @Raphicollas" if uninstall else "Installer @Raphicollas", html=html,
                                   js_api=Api(), width=640, height=580, resizable=False, background_color="#07080d")
    state["window"] = window
    window.events.closing += lambda: state["engine"] and state["engine"].stop()
    webview.start(private_mode=True)


if __name__ == "__main__":
    run(uninstall="--uninstall" in sys.argv)
