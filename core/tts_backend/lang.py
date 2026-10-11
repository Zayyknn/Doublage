"""Code ISO de la langue du doublage, pour les moteurs de voix locaux (Kokoro, Chatterbox)."""
import unicodedata

from core.utils.config_utils import load_key, load_key_or

# Noms tels qu'on peut les écrire dans `target_language` (langage naturel) -> code ISO 639-1
NAMES = {
    "fr": ("francais", "french", "fr"),
    "en": ("anglais", "english", "en"),
    "es": ("espagnol", "spanish", "espanol", "es"),
    "de": ("allemand", "german", "deutsch", "de"),
    "it": ("italien", "italian", "italiano", "it"),
    "pt": ("portugais", "portuguese", "portugues", "pt"),
    "nl": ("neerlandais", "dutch", "nederlands", "nl"),
    "ru": ("russe", "russian", "ru"),
    "ja": ("japonais", "japanese", "ja"),
    "zh": ("chinois", "chinese", "zh", "简体中文", "中文"),
    "ko": ("coreen", "korean", "ko"),
    "ar": ("arabe", "arabic", "ar"),
    "hi": ("hindi", "hi"),
    "pl": ("polonais", "polish", "pl"),
    "tr": ("turc", "turkish", "tr"),
}


def _plain(text):
    text = unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode() or str(text)
    return text.strip().lower()


def dubbing_language_code(default="fr"):
    """`dubbing_language_code` s'il est réglé, sinon déduit de `target_language`."""
    code = str(load_key_or("dubbing_language_code", "") or "").strip().lower()
    if code:
        return code
    target = load_key("target_language")
    plain = _plain(target)
    for code, names in NAMES.items():
        if any(_plain(name) in plain.split() or _plain(name) == plain or name == target for name in names):
            return code
    return default
