# Doublage

Double tes vidéos (fichiers MP4 ou liens YouTube) dans une autre langue, depuis ton PC ou ton téléphone.
Transcription, traduction, nouvelle voix, mixage avec la musique d'origine et sous-titres : tout est automatique.

Le moteur tourne sur ton PC (idéalement avec une carte NVIDIA) ; l'interface web est accessible
depuis n'importe quel navigateur, et s'installe comme une appli sur le téléphone.

## Ce qui est combiné

| Brique | Projet open source | Ce qu'elle apporte |
|---|---|---|
| Pipeline complet, traduction en 3 passes, sous-titres d'une ligne | [VideoLingo](https://github.com/Huanshere/VideoLingo) (Apache 2.0) | Le cœur de l'appli |
| Transcription au mot près | Qwen3-ASR / WhisperX (via VideoLingo) | Des sous-titres bien calés |
| Séparation voix / musique | Demucs (Meta, MIT) | La musique et les bruits d'origine sont gardés sous le doublage |
| Téléchargement YouTube et autres sites | yt-dlp (Unlicense) | Coller un lien suffit |
| Voix rapides et gratuites | Edge TTS | Voix naturelles en 15 langues |
| Voix 100 % locale, légère | [Kokoro-82M](https://github.com/hexgrad/kokoro) (Apache 2.0) | Gratuit, hors ligne, tourne même sans carte graphique |
| Clonage de la voix d'origine | [Chatterbox Multilingual](https://github.com/resemble-ai/chatterbox) (MIT) | La personne de la vidéo « parle » français avec sa propre voix |
| Clonage haut de gamme (option payante) | Fish Audio, CosyVoice2 via SiliconFlow | Pour la meilleure qualité |
| Traduction | Ollama (gratuit, local) ou toute API compatible OpenAI | DeepSeek, Mistral, OpenAI, OpenRouter… |
| Interface web mobile, envoi par morceaux, bibliothèque, mot de passe | Écrit pour Doublage | Utilisable depuis le téléphone, même hors de chez toi |

Ce qui n'a **pas** été repris, et pourquoi : pyVideoTrans (licence GPL-3 et une appli de bureau séparée ;
ses meilleures idées — voix multiples, YouTube, clonage — sont déjà couvertes ici), open-dubbing
(mêmes briques Whisper + TTS, en moins complet), XTTS v2 (licence non commerciale, et Chatterbox fait mieux).
L'interface d'origine de VideoLingo reste disponible pour les réglages avancés (`uv run start.py --streamlit`).

## Installation (Windows)

1. Télécharge le dépôt : bouton vert **Code → Download ZIP**, puis dézippe-le (ou `git clone`).
2. Double-clique **`Lancer-Doublage.bat`**. Le premier lancement installe tout (10 à 20 minutes).
3. La console affiche l'adresse et le **mot de passe** :
   - sur le PC : http://localhost:8765
   - sur le téléphone, sur le même Wi-Fi : http://192.168.x.x:8765

Mac / Linux : `./lancer-doublage.sh`.

### La traduction : choisis une IA (Réglages → Traduction)

- **Ollama, gratuit** : installe [Ollama](https://ollama.com), puis `ollama pull qwen3:8b`. Rien d'autre à faire.
- **DeepSeek, quelques centimes par vidéo** : crée une clé sur platform.deepseek.com et colle-la dans Réglages.

### Voix locales (optionnel)

Double-clique **`Installer-Voix-Locales.bat`** (ou `uv run start.py --voix`) pour ajouter Kokoro et Chatterbox.
Chatterbox télécharge environ 3 Go au premier doublage et demande une carte NVIDIA pour aller vite.

## Accès depuis partout (4G, travail…)

Installe `cloudflared` une fois :

```
winget install --id Cloudflare.cloudflared
```

`Lancer-Doublage.bat` ouvre alors aussi un tunnel Cloudflare gratuit, sans compte : une adresse
`https://quelque-chose.trycloudflare.com` s'affiche dans la deuxième fenêtre. Ouvre-la sur le téléphone,
entre le mot de passe, puis **Partager → Sur l'écran d'accueil** pour l'avoir comme une appli.
L'adresse change à chaque lancement ; pour une adresse fixe sur ton propre domaine, crée un tunnel nommé
dans le tableau de bord Cloudflare (Zero Trust → Tunnels) pointant vers `http://localhost:8765`.

Les vidéos sont envoyées par morceaux de 32 Mo, donc la limite de 100 Mo des tunnels gratuits ne gêne pas.

## Mot de passe

Créé au premier lancement dans le fichier `.doublage_password` (jamais envoyé sur GitHub).
Modifie ce fichier, ou définis la variable `DOUBLAGE_MOT_DE_PASSE`, pour le changer.

## Bon à savoir

- Les clés API sont enregistrées dans `config.yaml`. Ne pousse pas ce fichier sur un dépôt public une fois tes clés dedans.
- Une vidéo à la fois. Tu peux fermer la page pendant le traitement : il continue sur le PC.
- Les vidéos terminées sont rangées dans `history/` et visibles dans l'onglet Bibliothèque.
- Port différent : variable `DOUBLAGE_PORT`.

## Licence

Apache 2.0, comme VideoLingo dont ce projet est dérivé (voir `LICENSE` et `NOTICE`).
Le README d'origine de VideoLingo est conservé dans `README.videolingo.md`.
