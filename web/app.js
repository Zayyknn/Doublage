"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------------------------------------------------------- données

const LANGS = [
  ["fr", "Français"], ["en", "Anglais", "English"], ["es", "Espagnol", "Español"], ["de", "Allemand", "Deutsch"],
  ["it", "Italien", "Italiano"], ["pt", "Portugais", "Português"], ["nl", "Néerlandais", "Nederlands"],
  ["ru", "Russe", "Русский"], ["pl", "Polonais", "Polski"], ["tr", "Turc", "Türkçe"], ["ar", "Arabe", "العربية"],
  ["hi", "Hindi", "हिन्दी"], ["ja", "Japonais", "日本語"], ["ko", "Coréen", "한국어"], ["zh", "Chinois", "简体中文"],
];

const ENGINES = {
  edge_tts: { name: "Edge", desc: "Gratuit, rapide, voix naturelles. Internet requis.", tag: "" },
  kokoro_tts: { name: "Kokoro", desc: "Gratuit, 100 % sur ton PC, très léger.", tag: "local" },
  chatterbox_tts: { name: "Chatterbox", desc: "Garde la voix d'origine, en local.", tag: "clone" },
  fish_audio: { name: "Fish Audio", desc: "Clonage haut de gamme, payant.", tag: "clone" },
};

const EDGE = {
  fr: [["fr-FR-HenriNeural", "Henri — homme"], ["fr-FR-DeniseNeural", "Denise — femme"], ["fr-FR-RemyMultilingualNeural", "Rémy — homme, très naturel"],
       ["fr-FR-VivienneMultilingualNeural", "Vivienne — femme, très naturelle"], ["fr-FR-EloiseNeural", "Éloïse — jeune"],
       ["fr-CA-AntoineNeural", "Antoine — Québec"], ["fr-CA-SylvieNeural", "Sylvie — Québec"], ["fr-BE-GerardNeural", "Gérard — Belgique"], ["fr-CH-ArianeNeural", "Ariane — Suisse"]],
  en: [["en-US-AndrewMultilingualNeural", "Andrew — US"], ["en-US-AvaMultilingualNeural", "Ava — US"], ["en-US-GuyNeural", "Guy — US"], ["en-GB-RyanNeural", "Ryan — UK"], ["en-GB-SoniaNeural", "Sonia — UK"]],
  es: [["es-ES-AlvaroNeural", "Álvaro — Espagne"], ["es-ES-ElviraNeural", "Elvira — Espagne"], ["es-MX-JorgeNeural", "Jorge — Mexique"], ["es-MX-DaliaNeural", "Dalia — Mexique"]],
  de: [["de-DE-ConradNeural", "Conrad"], ["de-DE-KatjaNeural", "Katja"], ["de-DE-FlorianMultilingualNeural", "Florian"]],
  it: [["it-IT-DiegoNeural", "Diego"], ["it-IT-ElsaNeural", "Elsa"], ["it-IT-GiuseppeMultilingualNeural", "Giuseppe"]],
  pt: [["pt-BR-AntonioNeural", "Antônio — Brésil"], ["pt-BR-FranciscaNeural", "Francisca — Brésil"], ["pt-PT-DuarteNeural", "Duarte — Portugal"]],
  nl: [["nl-NL-MaartenNeural", "Maarten"], ["nl-NL-ColetteNeural", "Colette"]],
  ru: [["ru-RU-DmitryNeural", "Dmitry"], ["ru-RU-SvetlanaNeural", "Svetlana"]],
  pl: [["pl-PL-MarekNeural", "Marek"], ["pl-PL-ZofiaNeural", "Zofia"]],
  tr: [["tr-TR-AhmetNeural", "Ahmet"], ["tr-TR-EmelNeural", "Emel"]],
  ar: [["ar-SA-HamedNeural", "Hamed"], ["ar-SA-ZariyahNeural", "Zariyah"]],
  hi: [["hi-IN-MadhurNeural", "Madhur"], ["hi-IN-SwaraNeural", "Swara"]],
  ja: [["ja-JP-KeitaNeural", "Keita"], ["ja-JP-NanamiNeural", "Nanami"]],
  ko: [["ko-KR-InJoonNeural", "InJoon"], ["ko-KR-SunHiNeural", "SunHi"]],
  zh: [["zh-CN-YunxiNeural", "Yunxi"], ["zh-CN-XiaoxiaoNeural", "Xiaoxiao"]],
};

const KOKORO = {
  fr: [["ff_siwis", "Siwis — femme"]],
  en: [["af_heart", "Heart — femme"], ["af_bella", "Bella — femme"], ["am_michael", "Michael — homme"], ["am_fenrir", "Fenrir — homme"], ["bf_emma", "Emma — UK"], ["bm_george", "George — UK"]],
  es: [["ef_dora", "Dora — femme"], ["em_alex", "Alex — homme"]],
  it: [["if_sara", "Sara — femme"], ["im_nicola", "Nicola — homme"]],
  pt: [["pf_dora", "Dora — femme"], ["pm_alex", "Alex — homme"]],
  hi: [["hf_alpha", "Alpha — femme"], ["hm_omega", "Omega — homme"]],
  ja: [["jf_alpha", "Alpha — femme"], ["jm_kumo", "Kumo — homme"]],
  zh: [["zf_xiaobei", "Xiaobei — femme"], ["zm_yunjian", "Yunjian — homme"]],
};
const CHATTERBOX_LANGS = new Set("ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh".split(" "));

const STEP_FR = {
  "Prepare input": "Préparation de la vidéo",
  "Word-level transcription and alignment": "Transcription de la voix",
  "Sentence segmentation using NLP and LLM": "Découpage des phrases",
  "Summarization and multi-step translation": "Traduction",
  "Cutting and aligning long subtitles": "Calage des sous-titres",
  "Merging subtitles into the video": "Vidéo sous-titrée",
  "Finalize subtitle outputs": "Sous-titres prêts",
  "Generate audio tasks and chunks": "Préparation du doublage",
  "Extract reference audio": "Séparation voix et musique",
  "Generate and merge audio files": "Génération des voix",
  "Merge full audio": "Mixage",
  "Merge final audio into video": "Montage final",
  "Finalize dubbing outputs": "Finalisation",
};
const DUB_STEPS = Object.keys(STEP_FR);
const STUDIO_STEPS = 4;
const SUB_STEPS = DUB_STEPS.slice(0, 7);

const LLM_PRESETS = [
  { id: "google", name: "Google Traduction — gratuit, rien à installer", url: "", model: "", key: false, fields: false,
    hint: "Marche tout de suite. Traduction un peu plus littérale qu'avec une IA." },
  { id: "ollama", name: "Ollama — gratuit, sur ton ordi, plus naturel", url: "http://localhost:11434/v1", model: "qwen2.5:7b", key: false, fields: false,
    hint: "Une IA qui tourne sur ton ordi : aucun compte, aucun coût." },
  { id: "deepseek", name: "DeepSeek — très bon marché", url: "https://api.deepseek.com", model: "deepseek-chat", key: true,
    hint: "Clé sur platform.deepseek.com. Une vidéo de 10 min coûte quelques centimes." },
  { id: "openai", name: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4.1-mini", key: true, hint: "Clé sur platform.openai.com." },
  { id: "mistral", name: "Mistral (français)", url: "https://api.mistral.ai/v1", model: "mistral-small-latest", key: true, hint: "Clé sur console.mistral.ai." },
  { id: "openrouter", name: "OpenRouter — tous les modèles", url: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash", key: true, hint: "Clé sur openrouter.ai." },
  { id: "custom", name: "Autre (compatible OpenAI)", url: "", model: "", key: true, hint: "N'importe quel service compatible avec l'API d'OpenAI." },
];

// ---------------------------------------------------------------- état

let settings = {};
let system = {};
let source = "file";
let mode = "dub";
let engine = "edge_tts";
let pickedFile = null;
let polling = null;
let lastMode = "dub";

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) { location.href = "/login"; throw new Error("401"); }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    throw new Error(detail);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : res;
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

function toast(text, ms = 3200) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

function fill(select, items, value) {
  select.innerHTML = items.map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
  if (value != null && items.some(([v]) => v === String(value))) select.value = String(value);
}

const fmtSize = (n) => n > 1e9 ? (n / 1e9).toFixed(1) + " Go" : (n / 1e6).toFixed(0) + " Mo";

// ---------------------------------------------------------------- onglets

function show(view) {
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === view));
  $$("nav.tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  if (view === "v-lib") loadLibrary();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
$$("nav.tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-goto]");
  if (link) { e.preventDefault(); show(link.dataset.goto); }
});

// ---------------------------------------------------------------- source

$$("#src-seg button").forEach((b) => b.addEventListener("click", () => {
  source = b.dataset.src;
  $$("#src-seg button").forEach((x) => x.classList.toggle("on", x === b));
  $$("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== source));
}));

function pick(file) {
  if (!file) return;
  pickedFile = file;
  $("#drop").classList.add("filled");
  $("#drop-title").textContent = file.name;
  $("#drop-sub").textContent = `${fmtSize(file.size)} · touche pour changer`;
}
$("#file").addEventListener("change", (e) => pick(e.target.files[0]));
const drop = $("#drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => pick(e.dataTransfer.files[0]));

$$("#mode-seg button").forEach((b) => b.addEventListener("click", () => {
  mode = b.dataset.mode;
  $$("#mode-seg button").forEach((x) => x.classList.toggle("on", x === b));
  $("#go").textContent = mode === "dub" ? "Lancer le doublage" : "Créer les sous-titres";
}));

// ---------------------------------------------------------------- langues et voix

function dstCode() { return $("#dst-lang").value; }

function renderEngines() {
  const code = dstCode();
  $("#engines").innerHTML = Object.entries(ENGINES).map(([id, e]) => {
    const installed = system.engines ? system.engines[id] !== false : true;
    const speaks = id === "kokoro_tts" ? !!KOKORO[code] : id === "chatterbox_tts" ? CHATTERBOX_LANGS.has(code) : true;
    const why = !installed ? "Non installé — voir le README" : !speaks ? "Ne parle pas cette langue" : e.desc;
    return `<button class="engine ${engine === id ? "on" : ""}" data-engine="${id}" ${installed && speaks ? "" : "disabled"}>
      ${e.tag ? `<span class="tag">${e.tag}</span>` : ""}<b>${e.name}</b><small>${why}</small></button>`;
  }).join("");
  $$(".engine").forEach((b) => b.addEventListener("click", () => { engine = b.dataset.engine; renderEngines(); }));
  renderVoices();
}

function renderVoices() {
  const code = dstCode();
  const field = $("#voice-field");
  $("#fish-box").classList.toggle("hidden", engine !== "fish_audio");
  $("#preview").classList.toggle("hidden", engine === "fish_audio");
  if (engine === "edge_tts") {
    field.classList.remove("hidden");
    fill($("#voice"), EDGE[code] || EDGE.en, settings["edge_tts.voice"]);
  } else if (engine === "kokoro_tts") {
    field.classList.remove("hidden");
    fill($("#voice"), KOKORO[code] || [], settings["kokoro_tts.voice"]);
  } else {
    field.classList.add("hidden");
  }
}

$("#dst-lang").addEventListener("change", () => {
  const code = dstCode();
  const usable = (engine === "kokoro_tts" && !KOKORO[code]) || (engine === "chatterbox_tts" && !CHATTERBOX_LANGS.has(code));
  if (usable) engine = "edge_tts";
  renderEngines();
});

function voiceSettings() {
  const out = { tts_method: engine, dubbing_language_code: dstCode() };
  if (engine === "edge_tts") out["edge_tts.voice"] = $("#voice").value;
  if (engine === "kokoro_tts") out["kokoro_tts.voice"] = $("#voice").value;
  if (engine === "fish_audio") { out["fish_audio.mode"] = "clone"; out["fish_audio.api_key"] = $("#fish-key").value.trim(); }
  out.burn_subtitles = $("#burn").checked;
  return out;
}

$("#preview").addEventListener("click", async () => {
  const btn = $("#preview");
  btn.disabled = true;
  btn.lastChild.textContent = "Génération…";
  try {
    settings = await post("/api/settings", voiceSettings());
    const lang = LANGS.find(([c]) => c === dstCode());
    const sample = {
      fr: "Bonjour ! Voici à quoi ressemblera ta vidéo une fois doublée.",
      en: "Hello! This is how your video will sound once it is dubbed.",
      es: "¡Hola! Así sonará tu vídeo una vez doblado.",
    }[dstCode()];
    const res = await fetch("/api/preview", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sample || (lang ? lang[2] || lang[1] : "") }) });
    if (!res.ok) throw new Error((await res.json()).detail);
    const audio = $("#preview-audio");
    audio.src = URL.createObjectURL(await res.blob());
    await audio.play();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.lastChild.textContent = "Écouter";
  }
});

// ---------------------------------------------------------------- envoi par morceaux

async function upload(file, onProgress) {
  const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  const CHUNK = 32 * 1024 * 1024;
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + CHUNK, file.size);
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch(`/api/upload/${id}?offset=${offset}`, { method: "POST", body: file.slice(offset, end) });
        if (res.ok || res.status === 409) break;
      } catch (e) { if (attempt === 3) throw new Error("Connexion perdue pendant l'envoi"); }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    if (!res) throw new Error("Connexion perdue pendant l'envoi");
    if (res.status === 401) { location.href = "/login"; return; }
    const data = await res.json();
    if (!res.ok && res.status !== 409) throw new Error(data.detail || "Envoi refusé");
    offset = data.size;
    onProgress(offset / file.size);
  }
  return post(`/api/upload/${id}/finish?name=${encodeURIComponent(file.name)}`);
}

// ---------------------------------------------------------------- lancer

$("#go").addEventListener("click", async () => {
  let src;
  if (source === "url") {
    src = $("#url").value.trim();
    if (!/^https?:\/\//.test(src)) return toast("Colle un lien qui commence par https://");
  } else if (!pickedFile) {
    return toast("Choisis d'abord une vidéo");
  }
  const go = $("#go");
  go.disabled = true;
  try {
    settings = await post("/api/settings", voiceSettings());
    if (source === "file") {
      showRun({ state: "running", step: null, total_steps: 0 });
      $("#run-title").textContent = "Envoi de la vidéo";
      const up = await upload(pickedFile, (p) => {
        $("#run-step").textContent = `Envoi… ${fmtSize(pickedFile.size * p)} / ${fmtSize(pickedFile.size)}`;
        $("#run-pct").textContent = Math.round(p * 100) + " %";
        $("#bar").style.width = p * 100 + "%";
      });
      src = up.path;
    }
    const lang = LANGS.find(([c]) => c === dstCode());
    lastMode = mode;
    await post("/api/job", {
      source: src, mode,
      target_language: lang[1],
      dubbing_language_code: lang[0],
      source_language: $("#src-lang").value,
    });
    startPolling();
  } catch (err) {
    toast(err.message, 5000);
    $("#run").classList.add("hidden");
    $("#setup").classList.remove("hidden");
  } finally {
    go.disabled = false;
  }
});

// ---------------------------------------------------------------- progression

function showRun(s) {
  $("#setup").classList.add("hidden");
  $("#result").classList.add("hidden");
  $("#run").classList.remove("hidden");
  const labels = (s.total_steps && s.total_steps <= SUB_STEPS.length) || lastMode === "subtitles" ? SUB_STEPS : DUB_STEPS;
  const index = s.step_index ?? -1;
  const pct = s.state === "completed" ? 100 : Math.max(2, Math.round(((index + 0.5) / (s.total_steps || labels.length)) * 100));
  $("#run-title").textContent = { running: "En cours", paused: "En pause", stopping: "Arrêt…", stopped: "Arrêté", error: "Erreur", completed: "Terminé" }[s.state] || "En cours";
  $("#run-step").textContent = s.step ? STEP_FR[s.step] || s.step : "Préparation…";
  $("#run-pct").textContent = (s.state === "running" ? pct : s.state === "completed" ? 100 : pct) + " %";
  $("#bar").style.width = pct + "%";
  $("#steps").innerHTML = labels.map((label, i) =>
    `<li class="${i < index || s.state === "completed" ? "done" : i === index ? "now" : ""}">${STEP_FR[label]}</li>`).join("");
  const err = $("#run-error");
  err.classList.toggle("hidden", !s.error);
  err.textContent = s.error ? explain(s.error) : "";
  const pause = $("#run-pause");
  pause.classList.toggle("hidden", !s.pause_message);
  pause.textContent = s.pause_message || "";
  const active = ["running", "paused", "stopping"].includes(s.state);
  $("#stop").classList.toggle("hidden", !active);
  $("#resume").classList.toggle("hidden", s.state !== "paused");
  $("#retry").classList.toggle("hidden", !["error", "stopped"].includes(s.state));
  $("#new1").classList.toggle("hidden", active);
}

function explain(error) {
  if (/api|key|401|auth|connection|connect/i.test(error)) return "La traduction n'a pas pu joindre l'IA. Vérifie le service et la clé dans Réglages. Détail : " + error;
  if (/kokoro|chatterbox/i.test(error) && /install/i.test(error)) return error;
  return error;
}

function showResult(files) {
  $("#run").classList.add("hidden");
  $("#setup").classList.add("hidden");
  $("#result").classList.remove("hidden");
  const video = files.includes("output_dub.mp4") ? "output_dub.mp4" : files.includes("output_sub.mp4") ? "output_sub.mp4" : null;
  const player = $("#player");
  if (video) {
    player.classList.remove("hidden");
    const src = `/api/files/${video}`;
    if (!player.src.endsWith(src)) player.src = src;
  } else {
    player.classList.add("hidden");
  }
  const names = { "output_dub.mp4": "Vidéo doublée", "output_sub.mp4": "Vidéo sous-titrée", "trans.srt": "Sous-titres traduits", "src.srt": "Sous-titres d'origine", "dub.mp3": "Voix seule" };
  $("#downloads").innerHTML = Object.entries(names).filter(([f]) => files.includes(f))
    .map(([f, label]) => `<a class="btn small" href="/api/files/${f}" download>${label}</a>`).join("");
}

async function poll() {
  try {
    const s = await api("/api/status");
    if (s.total_steps === STUDIO_STEPS) { stopPolling(); return; } // préparation du Studio : gérée par studio.js
    if (["running", "paused", "stopping"].includes(s.state)) {
      showRun(s);
    } else {
      stopPolling();
      if (s.state === "completed" && s.files.some((f) => f.startsWith("output_"))) showResult(s.files);
      else if (s.state === "error" || s.state === "stopped") showRun(s);
    }
  } catch (e) { /* réseau coupé : on réessaie au prochain tour */ }
}
function startPolling() { stopPolling(); poll(); polling = setInterval(poll, 2000); }
function stopPolling() { clearInterval(polling); polling = null; }
document.addEventListener("visibilitychange", () => { if (!document.hidden && !polling) poll(); });

function newJob() {
  stopPolling();
  $("#player").pause();
  $("#run").classList.add("hidden");
  $("#result").classList.add("hidden");
  $("#setup").classList.remove("hidden");
}
$("#new1").addEventListener("click", newJob);
$("#new2").addEventListener("click", newJob);
$("#stop").addEventListener("click", async () => { await post("/api/stop"); toast("Arrêt demandé"); });
$("#resume").addEventListener("click", async () => { await post("/api/resume"); startPolling(); });
$("#retry").addEventListener("click", async () => {
  try {
    await post("/api/run", { stage: "all", dubbing: lastMode === "dub" });
    startPolling();
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- bibliothèque

async function loadLibrary() {
  const box = $("#lib");
  box.innerHTML = `<div class="empty">Chargement…</div>`;
  const items = await api("/api/library");
  if (!items.length) {
    box.innerHTML = `<div class="glass card empty">Rien pour l'instant.<br>Tes vidéos apparaîtront ici après chaque nouveau doublage.</div>`;
    return;
  }
  box.innerHTML = items.map((it, i) => `
    <div class="glass lib-item">
      <div class="thumb"><svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div>
      <div class="meta"><b>${escapeHtml(it.title)}</b><small>${new Date(it.date * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></div>
      <button class="btn small" data-play="${i}">Voir</button>
      <button class="btn small ghost danger" data-del="${i}" aria-label="Supprimer">✕</button>
    </div>`).join("");
  box.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", () => {
    const it = items[b.dataset.play];
    const base = `/api/library/${encodeURIComponent(it.id)}/`;
    $("#lib-player-card").classList.remove("hidden");
    $("#lib-player").src = base + it.video;
    $("#lib-downloads").innerHTML = it.files.map((f) => `<a class="btn small" href="${base + encodeURIComponent(f)}" download>${f}</a>`).join("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    const it = items[b.dataset.del];
    if (!confirm(`Supprimer « ${it.title} » ?`)) return;
    await api(`/api/library/${encodeURIComponent(it.id)}`, { method: "DELETE" });
    loadLibrary();
  }));
}
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- réglages

function presetFor(url) {
  if (settings.translation_engine === "google") return LLM_PRESETS[0];
  return LLM_PRESETS.find((p) => p.url && url && url.replace(/\/$/, "") === p.url) || LLM_PRESETS.at(-1);
}
function applyPreset(p, keepValues) {
  if (!keepValues && p.url) { $("#llm-url").value = p.url; $("#llm-model").value = p.model; }
  const fields = p.fields !== false;
  $("#llm-url").closest(".field").classList.toggle("hidden", !fields);
  $("#llm-model").closest(".field").classList.toggle("hidden", !fields);
  $("#llm-key-field").classList.toggle("hidden", !p.key);
  $("#llm-hint").textContent = p.hint;
  $("#ollama-box").classList.toggle("hidden", p.id !== "ollama");
  if (p.id === "ollama" && window.renderOllama) window.renderOllama($("#ollama-box"));
}
fill($("#llm-preset"), LLM_PRESETS.map((p) => [p.id, p.name]));
$("#llm-preset").addEventListener("change", () => applyPreset(LLM_PRESETS.find((p) => p.id === $("#llm-preset").value)));

function renderSettings() {
  const url = settings["api.base_url"] || "";
  const preset = presetFor(url);
  $("#llm-preset").value = preset.id;
  $("#llm-url").value = url;
  $("#llm-model").value = settings["api.model"] || "";
  applyPreset(preset, true);
  const key = settings["api.key"];
  $("#llm-key").placeholder = key && key.set ? `Clé enregistrée (…${key.end}) — laisser vide pour la garder` : "Colle ta clé ici";
  const fish = settings["fish_audio.api_key"];
  $("#fish-key").placeholder = fish && fish.set ? `Clé enregistrée (…${fish.end})` : "Colle ta clé fish.audio";
  $("#ytb").value = String(settings.ytb_resolution || "1080");
  $("#demucs").checked = !!settings.demucs;
  $("#cb-exag").value = String(settings["chatterbox_tts.exaggeration"] ?? 0.5);
  $("#burn").checked = settings.burn_subtitles !== false;
  if (ENGINES[settings.tts_method]) engine = settings.tts_method;
  const code = settings.dubbing_language_code || "fr";
  if (LANGS.some(([c]) => c === code)) $("#dst-lang").value = code;
  $("#src-lang").value = LANGS.some(([c]) => c === settings["whisper.language"]) ? settings["whisper.language"] : "auto";
  $("#llm-warn").classList.toggle("hidden", !!system.llm_ready);
}

$("#save").addEventListener("click", async () => {
  const preset = LLM_PRESETS.find((p) => p.id === $("#llm-preset").value);
  const url = $("#llm-url").value.trim();
  const local = /localhost|127\.0\.0\.1/.test(url);
  try {
    if (preset.id === "google" || preset.id === "ollama") await post("/api/setup/translation", { engine: preset.id });
    const llm = preset.id === "google" || preset.id === "ollama" ? {} : {
      "translation_engine": "llm",
      "api.base_url": url,
      "api.model": $("#llm-model").value.trim(),
      "api.key": preset.key ? $("#llm-key").value.trim() : (local ? "ollama" : ""),
      "max_workers": local ? 1 : 4,
    };
    settings = await post("/api/settings", {
      ...llm,
      "ytb_resolution": $("#ytb").value,
      "demucs": $("#demucs").checked,
      "chatterbox_tts.exaggeration": $("#cb-exag").value,
    });
    $("#llm-key").value = "";
    system = await api("/api/system");
    renderSettings();
    renderSystem();
    toast("Réglages enregistrés");
  } catch (err) { toast(err.message); }
});

$("#rerun-wizard").addEventListener("click", () => window.openWizard && window.openWizard());
$("#logout").addEventListener("click", async () => { await post("/logout"); location.href = "/login"; });

function renderSystem() {
  const pill = $("#sys");
  pill.innerHTML = `<span class="dot ${system.gpu ? "ok" : "warn"}"></span>${system.gpu ? "Carte graphique OK" : "Sans carte graphique"}`;
  const installed = Object.entries(system.engines || {}).filter(([, v]) => v).map(([k]) => (ENGINES[k] || { name: k === "demucs" ? "Séparation voix/musique" : k }).name);
  $("#sys-detail").innerHTML = `${system.gpu ? "Carte graphique : " + escapeHtml(system.gpu) : "Aucune carte graphique détectée : ça marche, mais plus lentement."}<br>Installé : ${installed.join(", ") || "—"}`;
}

window.doublage = { api, post, toast, upload, fmtSize, LANGS, get settings() { return settings; }, set settings(v) { settings = v; },
  get system() { return system; }, set system(v) { system = v; }, renderSettings: () => renderSettings(), renderEngines: () => renderEngines(),
  renderSystem: () => renderSystem() };

// ---------------------------------------------------------------- mise à jour depuis l'appli

let update = null;
async function checkUpdate(force) {
  try { update = await api("/api/update" + (force ? "?force=true" : "")); } catch (e) { update = { error: e.message }; }
  const info = $("#upd-info");
  if (update.error && !update.latest) info.textContent = `Version ${update.current || "?"} — ${update.error}`;
  else if (update.newer) info.textContent = `Version ${update.current} — la version ${update.latest} est disponible.`;
  else info.textContent = `Version ${update.current} — à jour.`;
  $("#upd-go").classList.toggle("hidden", !update.newer);
  $("#upd-badge").classList.toggle("hidden", !update.newer);  // pastille rouge sur Réglages
  $("#upd-go").textContent = update.newer ? `Mettre à jour (${update.latest})` : "Mettre à jour";
  return update;
}

async function applyUpdate() {
  const veil = $("#upd-veil"), msg = $("#upd-msg");
  veil.classList.remove("hidden");
  msg.textContent = "Téléchargement de la nouvelle version…";
  let target;
  try { target = (await post("/api/update")).latest; } catch (e) { msg.textContent = e.message; setTimeout(() => veil.classList.add("hidden"), 4000); return; }
  const started = Date.now();
  const tick = async () => {
    let r = null;
    try { r = await fetch("/api/update", { cache: "no-store" }).then((x) => x.ok ? x.json() : null); } catch {}
    if (r && r.step === "error") { msg.textContent = "La mise à jour a échoué : " + r.error; setTimeout(() => veil.classList.add("hidden"), 6000); return; }
    if (r && r.step === "manual") { msg.textContent = "Mise à jour installée. Ferme puis rouvre @Raphicollas pour l'utiliser."; return; }
    // le nouveau moteur répond « idle » ; l'ancien, qui a déjà le nouveau fichier VERSION, dit « restart »
    if (r && r.current === target && r.step === "idle") { msg.textContent = "C'est fait, ouverture…"; location.replace("/?v=" + encodeURIComponent(target)); return; }
    if (r && r.step === "install") msg.textContent = "Installation…";
    else if (!r) msg.textContent = Date.now() - started > 60000
      ? "Redémarrage… s'il faut installer de nouveaux outils, ça peut prendre quelques minutes."
      : "Redémarrage de @Raphicollas…";
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
}

$("#upd-go").addEventListener("click", applyUpdate);
$("#upd-check").addEventListener("click", async () => {
  const u = await checkUpdate(true);
  if (!u.newer) toast(u.error && !u.latest ? u.error : "@Raphicollas est à jour");
});

// ---------------------------------------------------------------- fond d'écran (Réglages)

const BG_KEY = "doublage.fond";
function bgMode() { try { return localStorage.getItem(BG_KEY) || "aurora"; } catch { return "aurora"; } }
async function applyBackground() {
  const mode = bgMode();
  $("#bg-mode").value = mode;
  let has = false;
  try { has = (await fetch("/api/background", { method: "HEAD", cache: "no-store" })).ok; } catch {}
  const mine = has ? `url("/api/background?t=${Date.now()}")` : "";
  const src = mode === "studio" ? 'url("/fond-studio.jpg")' : mine;   // la photo fournie avec l'appli, ou la sienne
  $("#wallpaper").style.backgroundImage = src;
  $("#bg-preview").style.backgroundImage = mode === "studio" ? src : mine;
  $("#bg-remove").disabled = !has;
  document.body.classList.toggle("photo-bg", mode === "studio" || (mode === "photo" && has));
}
// La photo est convertie en JPEG (2560 px au plus) avant l'envoi : les photos d'iPhone (HEIC) passent aussi.
function toJpeg(file) {
  return new Promise((ok, fail) => {
    const img = new Image(), src = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 2560 / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(src);
      c.toBlob((b) => (b ? ok(b) : fail(new Error("Image illisible"))), "image/jpeg", 0.88);
    };
    img.onerror = () => { URL.revokeObjectURL(src); fail(new Error("Ce format d'image n'est pas lu ici")); };
    img.src = src;
  });
}
$("#bg-mode").addEventListener("change", (e) => {
  try { localStorage.setItem(BG_KEY, e.target.value); } catch {}
  applyBackground();
  if (e.target.value === "photo" && $("#bg-remove").disabled) $("#bg-file").click();
});
$("#bg-file").addEventListener("change", async (e) => {
  const file = e.target.files[0]; e.target.value = "";
  if (!file) return;
  try {
    const body = await toJpeg(file);
    await api("/api/background", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body });
    try { localStorage.setItem(BG_KEY, "photo"); } catch {}
    await applyBackground(); toast("Fond d'écran changé");
  } catch (err) { toast(err.message); }
});
$("#bg-remove").addEventListener("click", async () => {
  await api("/api/background", { method: "DELETE" });
  try { localStorage.setItem(BG_KEY, "aurora"); } catch {}
  applyBackground();
});

// ---------------------------------------------------------------- démarrage

(async function init() {
  fill($("#src-lang"), [["auto", "Détection auto"], ...LANGS.map(([c, n]) => [c, n])], "auto");
  fill($("#dst-lang"), LANGS.map(([c, n]) => [c, n]), "fr");
  try {
    [settings, system] = await Promise.all([api("/api/settings"), api("/api/system")]);
  } catch (e) { return; }
  renderSettings();
  renderSystem();
  renderEngines();
  if (window.initSetup) window.initSetup();
  checkUpdate(false);
  applyBackground();
  setInterval(() => checkUpdate(true), 30 * 60 * 1000);  // une nouvelle version apparaît sans relancer l'appli
  const s = await api("/api/status");
  if (s.total_steps === STUDIO_STEPS) return;
  if (["running", "paused", "stopping"].includes(s.state)) startPolling();
  else if (s.files.some((f) => f.startsWith("output_dub") || f.startsWith("output_sub"))) showResult(s.files);
})();
