# Doublage

Double tes vidéos (fichiers MP4 ou liens YouTube) dans une autre langue, depuis ton PC ou ton téléphone.
Transcription, traduction, nouvelle voix, mixage avec la musique d'origine et sous-titres : tout est automatique.

Le moteur tourne sur ton PC (idéalement avec une carte NVIDIA) ; l'interface web est accessible
depuis n'importe quel navigateur, et s'installe comme une appli sur le téléphone.

## Deux façons de doubler

- **Doubler** : la vidéo est traduite et une voix (synthétique ou clonée) parle dans la nouvelle langue. Automatique.
- **Studio** : un vrai studio de doublage maison. Tu mets n'importe quelle vidéo (extrait, épisode, film) :
  les voix d'origine sont retirées et l'ambiance reste (musique, bruits). Doublage détecte **combien de personnes
  parlent** et qui dit quoi, puis affiche **une bande rythmo de couleur par personne**. Le texte défile et se colore
  sous le trait rouge au moment exact où il faut le dire. Chacun enregistre ses répliques, et Doublage monte la vidéo finale.

### Le Studio pas à pas

1. Onglet **Studio** → choisis la vidéo, sa langue, et le nombre de personnes (ou « Détection auto »).
2. Préparation automatique : séparation voix / ambiance, repérage de chaque mot, détection de qui parle.
3. **Je double** : choisis la personne (Lucas, Personne 2…). ⏮ ⏭ sautent à ses répliques.
4. **▶ Original** pour apprendre le rythme, puis **● Enregistrer** : 3, 2, 1, la vidéo repart de là où tu es,
   sans les voix. Tu entends les prises déjà faites par les autres, et en option la voix d'origine en guide.
5. Refais une réplique autant de fois que tu veux : la nouvelle prise remplace l'ancienne sur ce passage.
6. **Mixage** : calage, volumes, et option pour garder la voix d'origine des personnes que personne n'a doublées.
   **Créer la vidéo** et c'est prêt.

Conseils : mettez des écouteurs (sinon le micro capte l'ambiance). Si la détection se trompe, renomme les personnes,
change la personne d'une réplique dans « Texte des répliques », ou **Recompter** avec le bon nombre.
Sur téléphone, le micro du navigateur ne fonctionne qu'avec l'adresse https « Accès depuis partout ».

## Ce qui est combiné

| Brique | Projet open source | Ce qu'elle apporte |
|---|---|---|
| Pipeline complet, traduction en 3 passes, sous-titres d'une ligne | [VideoLingo](https://github.com/Huanshere/VideoLingo) (Apache 2.0) | Le cœur de l'appli |
| Transcription au mot près | Qwen3-ASR / WhisperX (via VideoLingo) | Des sous-titres bien calés |
| Qui parle quand (Studio) | sherpa-onnx (Apache 2.0) + pyannote segmentation 3.0 (MIT) + 3D-Speaker (Apache 2.0) | Une bande par personne, sans compte ni clé |
| Séparation voix / musique | Demucs (Meta, MIT) | La musique et les bruits d'origine sont gardés sous le doublage, et le Studio part de l'ambiance seule |
| Téléchargement YouTube et autres sites | yt-dlp (Unlicense) | Coller un lien suffit |
| Voix rapides et gratuites | Edge TTS | Voix naturelles en 15 langues |
| Voix 100 % locale, légère | [Kokoro-82M](https://github.com/hexgrad/kokoro) (Apache 2.0) | Gratuit, hors ligne, tourne même sans carte graphique |
| Clonage de la voix d'origine | [Chatterbox Multilingual](https://github.com/resemble-ai/chatterbox) (MIT) | La personne de la vidéo « parle » français avec sa propre voix |
| Clonage haut de gamme (option payante) | Fish Audio, CosyVoice2 via SiliconFlow | Pour la meilleure qualité |
| Traduction gratuite sans IA | Google Traduction (comme pyVideoTrans) | Marche sans rien installer |
| Traduction par IA | Ollama (gratuit, local) ou toute API compatible OpenAI | Plus naturelle : DeepSeek, Mistral, OpenAI… |
| Interface web mobile, assistant de configuration, tunnel intégré, bibliothèque | Écrit pour Doublage | Utilisable depuis le téléphone, même hors de chez toi |

Ce qui n'a **pas** été repris, et pourquoi : pyVideoTrans (licence GPL-3 et une appli de bureau séparée ;
ses meilleures idées — voix multiples, YouTube, clonage — sont déjà couvertes ici), open-dubbing
(mêmes briques Whisper + TTS, en moins complet), XTTS v2 (licence non commerciale, et Chatterbox fait mieux).
L'interface d'origine de VideoLingo reste disponible pour les réglages avancés (`uv run start.py --streamlit`).

## Installation

**Rien à configurer à la main.** Télécharge le dépôt (bouton vert **Code → Download ZIP**), dézippe-le, puis :

- **Windows** : double-clique **`Lancer-Doublage.bat`**
- **Mac** : double-clique **`Lancer-Doublage.command`** (la 1re fois : clic droit → Ouvrir → Ouvrir)
- **Linux** : `./lancer-doublage.sh`

Le premier lancement installe tout seul ce qu'il faut (10 à 20 minutes). Ensuite la page s'ouvre
dans le navigateur et un **assistant** guide en 3 écrans :

1. **Traduction** : *Gratuit, tout de suite* (Google Traduction, rien à installer), *Gratuit et plus naturel*
   (Ollama : un bouton pour le télécharger, un autre pour récupérer le modèle, avec la progression), ou une clé API.
2. **Voix** : les voix Edge sont prêtes ; un bouton installe en arrière-plan les voix locales Kokoro et Chatterbox.
3. **Téléphone** : QR code pour l'ouvrir sur le même Wi-Fi, et un interrupteur « Accès depuis partout »
   qui télécharge et lance tout seul un tunnel Cloudflare gratuit (QR code et mot de passe affichés).

Laisse la fenêtre noire (Terminal) ouverte pendant l'utilisation : c'est le moteur.
Tout se règle ensuite dans l'onglet **Réglages**, où l'assistant peut être relancé.

Sur Mac, une puce Apple (M1, M2, M3, M4…) est idéale. Sur PC, une carte NVIDIA accélère beaucoup ;
sans elle, ça marche, plus lentement. Prévoir environ 15 Go d'espace libre.

## Mot de passe

Sur l'ordinateur lui-même, aucun mot de passe n'est demandé. Depuis un téléphone ou un autre appareil,
le mot de passe affiché dans l'assistant (et dans la fenêtre noire) est demandé une fois.
Il est rangé dans `.doublage_password` ; modifie ce fichier ou la variable `DOUBLAGE_MOT_DE_PASSE` pour le changer.

## Bon à savoir

- Les clés API sont enregistrées dans `config.yaml`. Ne pousse pas ce fichier sur un dépôt public une fois tes clés dedans.
- Une vidéo à la fois. Tu peux fermer la page pendant le traitement : il continue sur le PC.
- Les vidéos terminées sont rangées dans `history/` et visibles dans l'onglet Bibliothèque.
- Port différent : variable `DOUBLAGE_PORT`.

## Licence

Apache 2.0, comme VideoLingo dont ce projet est dérivé (voir `LICENSE` et `NOTICE`).
Le README d'origine de VideoLingo est conservé dans `README.videolingo.md`.
