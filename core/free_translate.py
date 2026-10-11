"""Traduction gratuite sans IA à installer (même service que pyVideoTrans : Google Traduction).

Activée par `translation_engine: 'google'` dans config.yaml (le réglage par défaut de Doublage).
Les étapes qui demandaient une IA ont alors un équivalent sans IA : découpage mécanique des phrases,
pas de résumé ni de glossaire, sous-titres longs coupés en proportion.
"""
import threading
import time

import requests

from core.utils.config_utils import load_key_or

URL = "https://translate.googleapis.com/translate_a/single"
# Codes de Google qui diffèrent du code ISO de Doublage
GOOGLE_CODES = {"zh": "zh-CN", "he": "iw"}
_session = threading.local()


def using_free_translation() -> bool:
    return str(load_key_or("translation_engine", "llm")).strip().lower() == "google"


def _http():
    if not hasattr(_session, "s"):
        _session.s = requests.Session()
        _session.s.headers["User-Agent"] = "Mozilla/5.0"
    return _session.s


def target_code():
    from core.tts_backend.lang import dubbing_language_code
    code = dubbing_language_code()
    return GOOGLE_CODES.get(code, code)


def translate_text(text: str, target: str | None = None) -> str:
    text = str(text).strip()
    if not text:
        return text
    params = {"client": "gtx", "sl": "auto", "tl": target or target_code(), "dt": "t", "q": text}
    for attempt in range(5):
        try:
            response = _http().get(URL, params=params, timeout=20)
            if response.status_code == 429:
                raise RuntimeError("trop de demandes")
            response.raise_for_status()
            data = response.json()
            return "".join(part[0] for part in data[0] if part and part[0]).strip()
        except Exception as exc:
            if attempt == 4:
                raise RuntimeError(f"Google Traduction ne répond pas ({exc}). Réessaie dans quelques minutes, "
                                   "ou choisis Ollama dans Réglages.") from exc
            time.sleep(2 * (attempt + 1))


def translate_lines_free(lines: str):
    """Même sortie que translate_lines : (texte traduit ligne à ligne, texte d'origine)."""
    from core.task_runner import TaskRunner
    out = []
    for line in lines.split("\n"):
        TaskRunner.check_cancel()
        out.append(translate_text(line).replace("\n", " "))
    return "\n".join(out), lines


def split_like(translation: str, source_parts: list[str]) -> list[str]:
    """Coupe une traduction en autant de morceaux que la phrase d'origine, en proportion de leur longueur."""
    words = translation.split()
    if len(words) < len(source_parts):
        return []
    total = sum(len(p) for p in source_parts) or 1
    parts, start = [], 0
    for i, part in enumerate(source_parts[:-1]):
        share = round(len(words) * sum(len(p) for p in source_parts[: i + 1]) / total)
        end = min(max(share, start + 1), len(words) - (len(source_parts) - i - 1))
        parts.append(" ".join(words[start:end]))
        start = end
    parts.append(" ".join(words[start:]))
    return parts
