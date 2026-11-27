"""Construit l'application Studio Rythmo (Windows .exe ou Mac .app) avec PyInstaller.

    python launcher/build.py

Prépare build/bundle/ : le code de l'appli (app/), l'outil uv, l'icône ; puis lance PyInstaller.
"""
import io
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BUNDLE = BUILD / "bundle"
UV_VERSION = os.environ.get("UV_VERSION", "latest")
SKIP = {".git", ".github", "build", "dist", "launcher", "docs", "tests", "output", "history", "studio", "uploads",
        "_model_cache", ".venv", "tools", "logs", "__pycache__", "VideoLingo_colab.ipynb", "OneKeyStart.bat"}


def uv_asset():
    machine = platform.machine().lower()
    arch = "aarch64" if machine in {"arm64", "aarch64"} else "x86_64"
    if sys.platform == "win32":
        return "uv-x86_64-pc-windows-msvc.zip"
    if sys.platform == "darwin":
        return f"uv-{arch}-apple-darwin.tar.gz"
    return f"uv-{arch}-unknown-linux-gnu.tar.gz"


def fetch_uv():
    asset = uv_asset()
    base = "https://github.com/astral-sh/uv/releases/" + ("latest/download/" if UV_VERSION == "latest" else f"download/{UV_VERSION}/")
    data = urllib.request.urlopen(base + asset, timeout=120).read()
    name = "uv.exe" if sys.platform == "win32" else "uv"
    if asset.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            member = next(n for n in z.namelist() if n.endswith(name))
            (BUNDLE / name).write_bytes(z.read(member))
    else:
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            member = next(m for m in t.getmembers() if m.name.endswith("/" + name) or m.name == name)
            (BUNDLE / name).write_bytes(t.extractfile(member).read())
    (BUNDLE / name).chmod(0o755)


def main():
    shutil.rmtree(BUILD, ignore_errors=True)
    shutil.rmtree(ROOT / "dist", ignore_errors=True)
    app = BUNDLE / "app"
    app.mkdir(parents=True)
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
    for rel in filter(None, tracked):
        if rel.split("/")[0] in SKIP:
            continue
        dst = app / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)
    version = os.environ.get("DOUBLAGE_VERSION") or subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    (app / "VERSION").write_text(version, encoding="utf-8")
    shutil.copy2(ROOT / "launcher" / "icon.png", BUNDLE / "icon.png")
    shutil.copy2(ROOT / "launcher" / "splash.html", BUNDLE / "splash.html")
    shutil.copy2(ROOT / "launcher" / "setup.html", BUNDLE / "setup.html")
    fetch_uv()

    sep = ";" if sys.platform == "win32" else ":"
    icon = ROOT / "launcher" / ("icon.ico" if sys.platform == "win32" else "icon.icns")
    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--windowed", "--name", "JoueTaReplique",
            "--icon", str(icon), "--distpath", str(ROOT / "dist"), "--workpath", str(BUILD / "work"),
            "--specpath", str(BUILD), "--add-data", f"{app}{sep}app", "--add-data", f"{BUNDLE / 'icon.png'}{sep}.",
            "--add-data", f"{BUNDLE / 'splash.html'}{sep}.", "--add-data", f"{BUNDLE / 'setup.html'}{sep}.",
            "--paths", str(ROOT / "launcher"), "--hidden-import", "setup_app",
            "--add-binary", f"{BUNDLE / ('uv.exe' if sys.platform == 'win32' else 'uv')}{sep}."]
    if sys.platform == "darwin":
        args += ["--osx-bundle-identifier", "app.jouetareplique"]
    args.append(str(ROOT / "launcher" / "doublage_launcher.py"))
    subprocess.run(args, check=True)
    if sys.platform == "darwin":  # le micro du Studio : macOS exige une phrase d'explication
        import plistlib
        built = ROOT / "dist" / "JoueTaReplique.app"
        app_path = ROOT / "dist" / "Studio Rythmo.app"  # le nom que montre le Finder
        shutil.rmtree(app_path, ignore_errors=True)
        built.rename(app_path)
        plist = app_path / "Contents" / "Info.plist"
        info = plistlib.loads(plist.read_bytes())
        info.update({"NSMicrophoneUsageDescription": "Studio Rythmo enregistre ta voix dans le Studio.",
                     "NSCameraUsageDescription": "Studio Rythmo affiche ta webcam pendant que tu doubles.",
                     "CFBundleDisplayName": "Studio Rythmo", "CFBundleName": "Studio Rythmo", "CFBundleShortVersionString": version.lstrip("v"),
                     "NSHighResolutionCapable": True, "LSMinimumSystemVersion": "11.0"})
        plist.write_bytes(plistlib.dumps(info))
        subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(plist.parent.parent)], check=True)
    if sys.platform == "win32":  # JoueTaReplique-Setup.exe : un seul fichier qui contient l'application et l'installateur
        subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
                        "--name", "StudioRythmo-Setup", "--icon", str(icon), "--distpath", str(ROOT / "dist"),
                        "--workpath", str(BUILD / "work-setup"), "--specpath", str(BUILD),
                        "--paths", str(ROOT / "launcher"),
                        "--add-data", f"{ROOT / 'dist' / 'JoueTaReplique'}{sep}payload/JoueTaReplique",
                        "--add-data", f"{BUNDLE / 'setup.html'}{sep}.", "--add-data", f"{BUNDLE / 'icon.png'}{sep}.",
                        str(ROOT / "launcher" / "setup_entry.py")], check=True)
    print("Construit dans", ROOT / "dist")


if __name__ == "__main__":
    main()
