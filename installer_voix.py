"""Installe les voix locales optionnelles : Kokoro (rapide, léger) et Chatterbox (clonage de voix).

Lancé par : uv run start.py --voix     (ou Installer-Voix-Locales.bat sous Windows)
Utilise l'environnement Python de Doublage, comme le reste de l'application.
"""
import subprocess
import sys


def pip(*args):
    print("  pip install", " ".join(args))
    return subprocess.run([sys.executable, "-m", "pip", "install", *args]).returncode == 0


def check(module):
    return subprocess.run([sys.executable, "-c", f"import {module}"], capture_output=True).returncode == 0


def main():
    print("\n[1/2] Kokoro — voix locale rapide (français, anglais, espagnol, italien, portugais, japonais, chinois, hindi)")
    pip("kokoro>=0.9.4", "soundfile")
    print("  OK" if check("kokoro") else "  ÉCHEC : Kokoro ne s'est pas installé (voir les messages au-dessus).")

    print("\n[2/2] Chatterbox Multilingual — clonage de la voix d'origine (23 langues)")
    # Chatterbox fige d'anciennes versions de torch et transformers : on l'installe sans
    # ses dépendances pour garder celles de Doublage, puis on ajoute ce qui lui manque.
    pip("--no-deps", "chatterbox-tts>=0.1.4")
    pip("conformer>=0.3.2", "diffusers>=0.29", "resemble-perth>=1.0.1", "s3tokenizer", "omegaconf", "pykakasi", "safetensors")
    if check("chatterbox.mtl_tts"):
        print("  OK — le modèle (~3 Go) se téléchargera au premier doublage.")
    else:
        print("  ÉCHEC : Chatterbox ne s'est pas installé. Edge et Kokoro restent disponibles.")
    print("\nTerminé. Relance Doublage pour voir les nouvelles voix.\n")


if __name__ == "__main__":
    main()
