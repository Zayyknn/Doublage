"""Chatterbox Multilingual (Resemble AI, licence MIT) : clonage de la voix d'origine, en local.

La voix de la personne qui parle dans la vidéo est reprise (15 à 30 s d'extrait suffisent),
puis elle parle la langue du doublage. 23 langues, dont le français.
Installation : voir `installer-voix-locales` dans le README. Une carte NVIDIA est fortement conseillée.
"""
from pathlib import Path
import threading

import soundfile as sf

from core.utils import *
from core.utils.models import _AUDIO_REFERS_DIR
from core.tts_backend.lang import dubbing_language_code

LANGUAGES = {"ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms",
             "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh"}
REFERENCE = Path(_AUDIO_REFERS_DIR).parent / "clone_reference.wav"

_model = None
_lock = threading.Lock()


def _device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load():
    global _model
    with _lock:
        if _model is None:
            try:
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS
            except ImportError as exc:
                raise RuntimeError("Chatterbox n'est pas installé : lance `installer-voix-locales` (voir le README).") from exc
            _model = ChatterboxMultilingualTTS.from_pretrained(device=_device())
        return _model


def _reference(task_df):
    """Un seul extrait de la voix d'origine pour toutes les répliques : la voix reste la même d'un bout à l'autre."""
    if REFERENCE.exists():
        return str(REFERENCE)
    from core.tts_backend.fish_audio_tts import stable_reference
    wav, _ = stable_reference(task_df)
    REFERENCE.parent.mkdir(parents=True, exist_ok=True)
    REFERENCE.write_bytes(wav)
    return str(REFERENCE)


def chatterbox_tts(text, save_path, number=None, task_df=None):
    language = dubbing_language_code()
    if language not in LANGUAGES:
        raise ValueError(f"Chatterbox ne parle pas la langue « {language} ».")
    settings = load_key_or("chatterbox_tts", None) or {}
    model = _load()
    kwargs = {
        "language_id": language,
        "exaggeration": float(settings.get("exaggeration", 0.5)),
        "cfg_weight": float(settings.get("cfg_weight", 0.5)),
    }
    if task_df is not None and settings.get("clone", True):
        kwargs["audio_prompt_path"] = _reference(task_df)
    wav = model.generate(text, **kwargs)
    Path(save_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(save_path, wav.squeeze(0).detach().cpu().numpy(), model.sr)
