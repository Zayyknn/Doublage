# Banc d'essai de la détection des personnes

Mesure `studio_core.voices_by_sentence` (le compte automatique du Studio) sur 23 scènes :
16 dialogues de synthèse (2 à 4 voix, voix proches obtenues en changeant la hauteur, voix au téléphone, écho,
bruit), 6 scènes à une seule voix, et Scary Movie (vérité dans `scary_truth.json`, à placer à côté).

1. `powershell -File synth.ps1 -dir .` : synthétise les 60 répliques de `lines.txt` (voix Windows Hortense, Julie,
   Paul, Zira) dans `lines/`.
2. `python eval_app.py` : mots bien attribués et bon nombre de personnes. Réglages essayables par variables
   d'environnement `SPLIT` et `SAME_RATIO`.

Résultats (25/11/2026) : ancien seuil fixe 0,35 -> 87,8 % des mots, bon nombre 11/17 ; empreintes recentrées +
fusion par rapport (SPLIT 0,15, SAME_RATIO 0,72) -> 99,7 %, 23/23, parfait de SPLIT 0,10 à 0,20.
`bench.py` compare aussi d'autres moteurs d'empreinte (wespeaker, CAM++, TitaNet) : aucun ne fait mieux que
celui de l'appli une fois recentré.
