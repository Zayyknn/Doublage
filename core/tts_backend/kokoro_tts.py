"""Kokoro (hexgrad/Kokoro-82M, Apache 2.0) : voix locale, rapide, gratuite, tourne même sans carte graphique.

Installation : pip install "kokoro>=0.9.4" soundfile  (+ espeak-ng pour le français, voir le README)
"""
from pathlib import Path
import threading

import numpy as np
import soundfile as sf

from core.utils import *
from core.tts_backend.lang import dubbing_language_code

SAMPLE_RATE = 24000
# Code de langue de Kokoro et voix par défaut, pour chaque langue qu'il sait parler
LANGS = {
    "fr": ("f", "ff_siwis"),
    "en": ("a", "af_heart"),
    "es": ("e", "ef_dora"),
    "it": ("i", "if_sara"),
    "pt": ("p", "pf_dora"),
    "hi": ("h", "hf_alpha"),
    "ja": ("j", "jf_alpha"),
    "zh": ("z", "zf_xiaobei"),
}

_pipelines = {}
_lock = threading.Lock()


def _pipeline(lang_code):
    with _lock:
        if lang_code not in _pipelines:
            try:
                from kokoro import KPipeline
            except ImportError as exc:
                raise RuntimeError("Kokoro n'est pas installé : lance `installer-voix-locales` (voir le README).") from exc
            _pipelines[lang_code] = KPipeline(lang_code=lang_code)
        return _pipelines[lang_code]


def kokoro_tts(text, save_path):
    language = dubbing_language_code()
    if language not in LANGS:
        raise ValueError(f"Kokoro ne parle pas la langue « {language} ». Choisis Edge ou Chatterbox pour cette langue.")
    lang_code, default_voice = LANGS[language]
    settings = load_key_or("kokoro_tts", None) or {}
    voice = str(settings.get("voice") or "").strip()
    if not voice or voice[0] not in ("ab" if language == "en" else lang_code):
        voice = default_voice  # une voix d'une autre langue : celle par défaut
    lang_code = voice[0]  # anglais : « a » américain, « b » britannique
    speed = float(settings.get("speed") or 1.0)

    chunks = [np.asarray(audio) for _, _, audio in _pipeline(lang_code)(text, voice=voice, speed=speed)
              if audio is not None]
    if not chunks:
        raise RuntimeError("Kokoro n'a produit aucun son")
    Path(save_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(save_path, np.concatenate(chunks), SAMPLE_RATE)


if __name__ == "__main__":
    kokoro_tts("Bonjour, ceci est un essai de doublage.", "kokoro_test.wav")
