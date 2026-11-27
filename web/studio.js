"use strict";
// Studio : n'importe quelle vidéo, sans les voix d'origine, une bande rythmo de couleur par personne.
(function () {
  const D = window.doublage;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (t) => { t = Math.max(0, t || 0); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0"); };
  const STEPS = [["Prepare input", "Préparation de la vidéo"], ["Studio: separation", "Séparation voix / ambiance et repérage des mots"],
    ["Studio: build", "Création des pistes"], ["Studio: speakers", "Détection des personnes qui parlent"]];
  const N_STEPS = STEPS.length;

  const video = $("#st-video");
  const band = $("#st-band");
  let file = null, poller = null, jobPoller = null;
  let proj = null;              // { id, title, words, clips, speakers, latency_ms, mix, finals }
  let parts = [], lines = [], keep = [];
  let who = 0;                  // la personne qu'on double
  let mode = "idle";            // idle | orig | play | countdown | record
  let countdownEnd = 0, recFrom = 0, recTo = 0, recStart = 0, playStart = 0;
  let stream = null, recorder = null, chunks = [];
  const pool = new Map();       // id de prise -> <audio>
  const vocals = new Audio();   // voix d'origine : guide, ou personnes non doublées
  const url = (name) => `/api/studio/${encodeURIComponent(proj.id)}/file/${name.split("/").map(encodeURIComponent).join("/")}`;
  const speaker = (id) => proj.speakers.find((s) => s.id === id) || proj.speakers[0];
  const latency = () => Number($("#st-lat").value) / 1000;
  const PALETTE = ["#3fa9ff", "#ff7a35", "#3ddc84", "#ffd23f", "#c77dff", "#2ee6d6", "#ff5fa2", "#a3e635"];
  let portraits = new Map();    // personne -> image de la vidéo où elle parle

  // ------------------------------------------------------------ calculs (les mêmes que côté serveur)
  function keptParts(clips) {   // une prise récente remplace l'ancienne de la même personne là où elles se chevauchent
    const out = [];
    clips.forEach((clip, i) => {
      let pieces = [[clip.from, clip.to]];
      for (const later of clips.slice(i + 1)) {
        if (later.sp !== clip.sp) continue;
        const cut = [];
        for (const [a, b] of pieces) {
          if (later.to <= a || later.from >= b) { cut.push([a, b]); continue; }
          if (later.from > a) cut.push([a, later.from]);
          if (later.to < b) cut.push([later.to, b]);
        }
        pieces = cut;
      }
      pieces.forEach(([a, b]) => b - a > 0.05 && out.push({ clip, a, b }));
    });
    return out;
  }
  function buildLines(words) {  // répliques : mots qui se suivent, même personne, moins d'1 s d'écart
    const out = [];
    words.forEach((w, i) => {
      const last = out[out.length - 1];
      if (last && last.sp === w.sp && w.s - last.e < 1.0) { last.words.push(i); last.e = w.e; }
      else out.push({ sp: w.sp, s: w.s, e: w.e, words: [i] });
    });
    return out;
  }
  function keepRanges() {       // quand faire entendre la voix d'origine des personnes non doublées
    const dubbed = new Set(proj.clips.map((c) => c.sp));
    const ranges = [];
    proj.words.filter((w) => !dubbed.has(w.sp)).forEach((w) => {
      const s = Math.max(0, w.s - 0.25), e = w.e + 0.3, last = ranges[ranges.length - 1];  // marges larges : pas de voix hachée
      if (last && s - last[1] < 1.2) last[1] = Math.max(last[1], e); else ranges.push([s, e]);
    });
    return ranges;
  }
  let wordRow = [];
  // Une ligne de bande par personnage, dans l'ordre de la liste : changer le personnage d'une réplique (panneau
  // Texte ou glisser) la fait passer sur la ligne de ce personnage, au même moment.
  const rowOf = (sp) => Math.max(0, proj.speakers.findIndex((s) => s.id === sp));
  function placeLines() {
    wordRow = new Array(proj.words.length).fill(0);
    for (const l of lines) {
      l.row = rowOf(l.sp);
      l.words.forEach((k) => (wordRow[k] = l.row));
    }
  }
  function refresh() {
    parts = keptParts(proj.clips); lines = buildLines(proj.words); keep = keepRanges(); placeLines();
    if (W && band.clientHeight !== ROWS() * laneH()) resize();   // nombre de personnages changé : autant de lignes
  }

  // ------------------------------------------------------------ accueil
  D.LANGS.forEach(([c, n]) => $("#st-lang").insertAdjacentHTML("beforeend", `<option value="${c}">${n}</option>`));
  $("#st-lang").insertAdjacentHTML("afterbegin", `<option value="auto">Détection auto</option>`);
  $("#st-lang").value = "fr";

  $("#st-file").addEventListener("change", (e) => {
    file = e.target.files[0];
    if (!file) return;
    $("#st-drop").classList.add("filled");
    $("#st-drop-title").textContent = file.name;
    $("#st-drop-sub").textContent = `${D.fmtSize(file.size)} · touche pour changer`;
  });

  $("#st-go").addEventListener("click", async () => {
    if (!file) return D.toast("Choisis d'abord une vidéo");
    $("#st-go").disabled = true;
    $("#st-new").classList.add("hidden");
    $("#st-run").classList.remove("hidden");
    $("#st-run-error").classList.add("hidden");
    $("#st-run-close").classList.add("hidden");
    $("#st-steps").innerHTML = "";
    try {
      const up = await D.upload(file, (p) => {
        $("#st-run-step").textContent = `Envoi… ${D.fmtSize(file.size * p)} / ${D.fmtSize(file.size)}`;
        $("#st-run-pct").textContent = Math.round(p * 100) + " %";
        $("#st-bar").style.width = p * 100 + "%";
      });
      await D.post("/api/studio", { source: up.path, source_language: $("#st-lang").value, speakers: Number($("#st-count").value) });
      watch();
    } catch (err) { runError(err.message); }
    $("#st-go").disabled = false;
  });

  function runError(message) {
    $("#st-run-error").textContent = message;
    $("#st-run-error").classList.remove("hidden");
    $("#st-run-close").classList.remove("hidden");
  }
  $("#st-run-close").onclick = () => { $("#st-run").classList.add("hidden"); $("#st-new").classList.remove("hidden"); };

  function watch() {
    clearInterval(poller);
    const tick = async () => {
      let s;
      try { s = await D.api("/api/status"); } catch { return; }
      if (s.total_steps !== N_STEPS) return;
      const i = Math.max(0, s.step_index);
      const pct = s.state === "completed" ? 100 : Math.round(((i + 0.4) / N_STEPS) * 100);
      $("#st-run-step").textContent = (STEPS.find(([k]) => k === s.step) || [null, "Préparation…"])[1];
      $("#st-run-pct").textContent = pct + " %";
      $("#st-bar").style.width = pct + "%";
      $("#st-steps").innerHTML = STEPS.map(([, label], k) =>
        `<li class="${k < i || s.state === "completed" ? "done" : k === i ? "now" : ""}">${label}</li>`).join("");
      if (s.state === "completed") {
        clearInterval(poller);
        $("#st-run").classList.add("hidden");
        $("#st-new").classList.remove("hidden");
        file = null; $("#st-drop").classList.remove("filled");
        $("#st-drop-title").textContent = "Choisir une vidéo";
        $("#st-drop-sub").textContent = "Un extrait, un épisode ou un film entier";
        const list = await loadProjects();
        if (list[0]) open(list[0].id);
      } else if (["error", "stopped"].includes(s.state)) {
        clearInterval(poller);
        runError(s.error || "Préparation arrêtée.");
      }
    };
    tick();
    poller = setInterval(tick, 2000);
  }

  async function loadProjects() {
    const list = await D.api("/api/studio");
    $("#st-projects").innerHTML = list.map((p, i) => `
      <div class="glass lib-item">
        <div class="thumb"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg></div>
        <div class="meta"><b>${esc(p.title)}</b><small>${fmt(p.duration)} · ${p.speakers} personne${p.speakers > 1 ? "s" : ""} · ${p.clips} prise${p.clips > 1 ? "s" : ""}</small></div>
        <button class="btn small" data-open="${i}">Ouvrir</button>
        <button class="btn small ghost danger" data-remove="${i}" title="Supprimer la vidéo, ses prises et ses vidéos terminées">Supprimer</button>
      </div>`).join("");
    $("#st-projects").querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => open(list[b.dataset.open].id)));
    // 1er clic : « Confirmer ? » pendant 4 s ; 2e clic : supprime (pas de boîte de dialogue, la fenêtre Mac les gère mal)
    $("#st-projects").querySelectorAll("[data-remove]").forEach((b) => (b.onclick = async () => {
      if (!b.classList.contains("armed")) {
        b.classList.add("armed"); b.textContent = "Confirmer ?";
        setTimeout(() => { b.classList.remove("armed"); b.textContent = "Supprimer"; }, 4000);
        return;
      }
      const p = list[b.dataset.remove];
      b.disabled = true;
      try { await D.api(`/api/studio/${encodeURIComponent(p.id)}`, { method: "DELETE" }); D.toast(`« ${p.title} » supprimée`); }
      catch (e) { D.toast(e.message); }
      loadProjects();
    }));
    return list;
  }

  // ------------------------------------------------------------ ouvrir une vidéo
  // L'éditeur sert aux deux onglets : Studio (préparation complète) et Doubler (les clients : la scène, la bande,
  // le micro et la caméra, sans les outils de préparation). Il est déplacé dans l'onglet qui l'ouvre.
  let client = false;
  const editor = $("#st-editor");
  async function open(id, opts) {
    let next;
    try { next = await D.api(`/api/studio/${encodeURIComponent(id)}`); } catch (e) { return D.toast(e.message); }
    if (proj) stopAll();
    client = !!(opts && opts.client);
    if (client) { $("#db-editor-slot").appendChild(editor); $("#db-home").classList.add("hidden"); }
    else if (editor.parentElement !== $("#v-studio")) $("#v-studio").appendChild(editor);
    editor.classList.toggle("client", client);
    editor.classList.toggle("imported", !!next.imported);
    $("#st-back").textContent = client ? "← Scènes" : "← Vidéos";
    $("#st-export").href = `/api/studio/${encodeURIComponent(id)}/export`;
    $("#st-export").setAttribute("download", "");
    proj = next;
    dirty = false; saveState();
    proj.speakers.forEach((s) => (s.color = PALETTE[s.id % PALETTE.length]));
    pool.forEach((a) => a.pause()); pool.clear();
    portraits = new Map(); grabPortraits(proj);
    $("#st-home").classList.add("hidden");
    $("#st-editor").classList.remove("hidden");
    $("#st-title").textContent = proj.title;
    video.src = url("ambiance.mp4");
    vocals.src = url("vocals.m4a");
    who = proj.speakers[0].id;
    $("#st-lat").value = proj.latency_ms || 0; latText();
    const mix = proj.mix || {};
    $("#st-vgain").value = mix.voice ?? 1.2;
    $("#st-again").value = mix.ambience ?? 1;
    $("#st-keep").checked = mix.keep_original !== false;
    refresh();
    renderAll();
    const secure = window.isSecureContext && navigator.mediaDevices && window.MediaRecorder;
    $("#st-mic-warn").classList.toggle("hidden", !!secure);
    $("#st-mic-warn").textContent = secure ? "" : "Le micro du navigateur demande une adresse sécurisée (https). Sur le téléphone, ouvre Studio Rythmo avec l'adresse « Accès depuis partout » (Réglages → Téléphone).";
    $("#st-sp-warn").classList.toggle("hidden", !proj.speakers_error);
    $("#st-sp-warn").textContent = proj.speakers_error || "";
    sepInfo();
    devicesOnOpen();
    if (proj.job && proj.job.running) (proj.job.kind === "separate" ? watchSep() : watchJob());
    window.scrollTo({ top: 0 });
    resize();
  }
  function closeEditor() {
    stopAll(); camStop();
    $("#st-editor").classList.add("hidden");
    if (client) { $("#db-home").classList.remove("hidden"); loadScenes(); }
    else { $("#st-home").classList.remove("hidden"); loadProjects(); }
  }
  $("#st-back").onclick = async () => { if (dirty) await saveNow(true); closeEditor(); };

  function renderAll() { renderWho(); renderPeople(); renderClips(); renderFinals(); renderLines(); resize(); }

  function renderWho() {
    $("#st-who").innerHTML = proj.speakers.map((s) =>
      `<button class="chip ${s.id === who ? "on" : ""}" style="--c:${s.color}" data-sp="${s.id}"><i></i>${esc(s.name)}</button>`).join("");
    $("#st-who").querySelectorAll("[data-sp]").forEach((b) => (b.onclick = () => { who = Number(b.dataset.sp); renderWho(); }));
  }

  // ------------------------------------------------------------ bande rythmo
  let W = 0, H = 0, DPR = 1;
  const tv = () => document.fullscreenElement === $("#st-tv");
  const ROWS = () => (proj ? Math.max(1, proj.speakers.length) : 1);
  function baseLane() {         // hauteur d'une ligne quand il y en a deux (la vitesse de défilement en dépend)
    const base = W && W < 600 ? 54 : 74;
    return tv() ? Math.round(base * Math.max(1.4, window.innerHeight / 640)) : base;
  }
  function laneH() {            // plus de personnages : des lignes un peu moins hautes, la bande reste lisible
    const base = baseLane(), n = ROWS();
    return n <= 2 ? base : Math.max(Math.round(base * 0.62), Math.round(base * 2.4 / n));
  }
  function resize() {
    if (!proj) return;
    DPR = window.devicePixelRatio || 1;
    W = band.clientWidth;
    band.style.height = (ROWS() * laneH()) + "px";
    W = band.clientWidth; H = band.clientHeight;
    band.width = W * DPR; band.height = H * DPR;
    document.documentElement.style.setProperty("--band-h", H + "px");
  }
  window.addEventListener("resize", resize);
  document.addEventListener("fullscreenchange", () => setTimeout(resize, 50));
  $("#st-tv-go").onclick = () => $("#st-tv").requestFullscreen().catch(() => D.toast("Plein écran refusé par le navigateur"));

  function clock() {
    if (mode === "countdown") return recFrom + Math.min(0, (performance.now() - countdownEnd) / 1000);
    return video.currentTime || 0;
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function draw() {
    requestAnimationFrame(draw);
    if (!proj || $("#st-editor").classList.contains("hidden")) return;
    if (!W) resize();
    sync();
    const ctx = band.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = clock();
    const lh = laneH();
    const pps = baseLane() * (W < 600 ? 3.6 : 4.4);  // pixels par seconde : assez vite pour que les mots tiennent sans se tasser
    const bar = Math.round(W * 0.33);
    const focus = mode === "record" || mode === "countdown";
    const fs = Math.round(lh * 0.5);
    const textY = (r) => r * lh + lh * 0.54;

    // une ligne sombre par personnage, avec sa couleur sur le bord gauche
    for (let r = 0; r < ROWS(); r++) {
      ctx.fillStyle = r % 2 ? "#2c2f36" : "#32353d"; ctx.fillRect(0, r * lh, W, lh);
      if (r) { ctx.fillStyle = "#1d1f24"; ctx.fillRect(0, r * lh - 1, W, 2); }
      if (ROWS() > 1) { ctx.fillStyle = proj.speakers[r].color; ctx.fillRect(0, r * lh + 3, 4, lh - 6); }
    }
    // ce qui est déjà enregistré : un trait sous les répliques concernées
    for (const p of parts) {
      for (const l of lines) {
        if (l.sp !== p.clip.sp || l.e <= p.a || l.s >= p.b) continue;
        const x0 = Math.max(0, bar + (Math.max(p.a, l.s) - t) * pps), x1 = Math.min(W, bar + (Math.min(p.b, l.e) - t) * pps);
        if (x1 <= x0) continue;
        ctx.fillStyle = speaker(p.clip.sp).color; ctx.globalAlpha = 0.7;
        ctx.fillRect(x0, l.row * lh + lh - 5, x1 - x0, 3); ctx.globalAlpha = 1;
      }
    }
    // étiquette du personnage juste avant chaque réplique
    const tagSize = Math.max(10, Math.round(lh * 0.19));
    ctx.textBaseline = "middle";
    tagBoxes = [];
    const dragY = (row) => drag && drag.moved ? Math.max(fs / 2, Math.min(H - fs / 2, drag.y)) : textY(row);
    for (const l of lines) {
      const x = bar + (l.s - t) * pps;
      if (x > W + 200) break;
      if (bar + (l.e - t) * pps < -10) continue;
      const s = speaker(l.sp);
      ctx.font = `800 ${tagSize}px ${getComputedStyle(document.body).fontFamily}`;
      const label = (s.name.length > 16 ? s.name.slice(0, 15) + "…" : s.name).toUpperCase();
      const w = ctx.measureText(label).width + tagSize;
      const h = tagSize * 1.7, gap = tagSize * 0.6;
      const y = drag && drag.moved && drag.line === l ? dragY(l.row) : textY(l.row);
      tagBoxes.push({ line: l, x0: x - w - gap, x1: x, row: l.row });
      ctx.globalAlpha = (focus && l.sp !== who ? 0.4 : 1) * (bar + (l.e - t) * pps < bar ? 0.45 : 1);
      ctx.fillStyle = s.color; roundRect(ctx, x - w - gap, y - h / 2, w, h, 3); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.fillText(label, x - w - gap + tagSize / 2, y + 1);
      ctx.globalAlpha = 1;
    }
    // les mots : chacun couvre exactement sa durée ; s'il est tenu longtemps, un trait le prolonge
    ctx.font = `700 ${fs}px "Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif`;
    boxes = [];
    proj.words.forEach((w, k) => {
      const x = bar + (w.s - t) * pps;
      if (x > W + 10) return;
      const width = Math.max((w.e - w.s) * pps, 4);
      if (x + width + 20 < -10) return;
      const s = speaker(w.sp);
      const dragged = drag && drag.moved && drag.set.has(k);
      const y = dragged ? dragY(wordRow[k] || 0) : textY(wordRow[k] || 0);
      const natural = ctx.measureText(w.w).width || 1;
      const scale = Math.max(0.55, Math.min((width - fs * 0.25) / natural, 1.3));
      const textEnd = x + natural * scale, end = x + width;
      boxes.push({ k, x0: x, x1: Math.max(textEnd, x + width * 0.9), row: wordRow[k] || 0 });
      ctx.globalAlpha = (focus && w.sp !== who ? 0.35 : 1) * (end < bar ? 0.45 : 1);
      ctx.fillStyle = s.color;
      ctx.save(); ctx.translate(x, y); ctx.scale(scale, 1); ctx.fillText(w.w, 0, 1); ctx.restore();
      if (end - textEnd > fs * 1.2) ctx.fillRect(textEnd + 2, y + fs * 0.36, end - textEnd - 2, Math.max(2, fs * 0.07));
      ctx.globalAlpha = 1;
    });
    // trait de synchro
    ctx.fillStyle = "#fff";
    ctx.fillRect(bar - 1, 0, 2, H);
    markActiveLine(t);

    $("#st-time").textContent = fmt(t);
    $("#st-dur").textContent = fmt(video.duration || proj.duration);
    if (video.duration && document.activeElement !== $("#st-seek")) $("#st-seek").value = Math.round((Math.max(t, 0) / video.duration) * 10000);
  }
  requestAnimationFrame(draw);

  $("#st-seek").addEventListener("input", (e) => {
    if (mode === "record" || mode === "countdown") return;
    if (video.duration) video.currentTime = (e.target.value / 10000) * video.duration;
  });

  // ------------------------------------------------------------ lecture synchronisée des prises et des voix d'origine
  function audioFor(clip) {
    let a = pool.get(clip.id);
    if (!a) { a = new Audio(url("clips/" + clip.file)); a.preload = "auto"; pool.set(clip.id, a); }
    return a;
  }
  function sync() {
    const running = (mode === "play" || mode === "record") && !video.paused;
    const t = video.currentTime;
    const active = new Set();
    if (running) {
      for (const p of parts) {
        if (mode === "record" && p.clip.sp === who) continue;   // pas son ancienne prise pendant qu'on enregistre
        if (t < p.a || t >= p.b) continue;
        const target = t - p.clip.at - latency();
        if (target < 0) continue;
        const a = audioFor(p.clip);
        active.add(p.clip.id);
        a.volume = Math.min(1, Number($("#st-vgain").value) / 2);
        if (Math.abs(a.currentTime - target) > 0.15) a.currentTime = target;
        if (a.paused) a.play().catch(() => {});
      }
    }
    pool.forEach((a, id) => { if (!active.has(id) && !a.paused) a.pause(); });
    // voix d'origine : guide pendant l'enregistrement, ou personnes non doublées à l'écoute
    let vol = 0;
    if (running && mode === "record" && $("#st-guide").checked) vol = 0.3;
    // Sans aucune prise, « Écouter » = l'ambiance seule : sinon la voix d'origine revenait par bouts, mot par mot
    // (les « syllabes qui ressortent »), alors que le retrait des voix avait marché.
    if (running && mode === "play" && proj.clips.length && $("#st-keep").checked && keep.some(([a, b]) => t >= a && t < b)) vol = 1;
    if (vol > 0) {
      vocals.volume = vol;
      if (Math.abs(vocals.currentTime - t) > 0.15) vocals.currentTime = t;
      if (vocals.paused) vocals.play().catch(() => {});
    } else if (!vocals.paused) vocals.pause();
    video.volume = mode === "orig" ? 1 : Math.min(1, Number($("#st-again").value));
  }

  function stopAll() {
    video.pause();
    if (introDone) introDone(false);
    if (recorder && recorder.state !== "inactive") { recTo = video.currentTime; recorder.stop(); }
    $("#st-cd").classList.add("hidden");
    $("#st-rec").classList.add("hidden");
    const wasOrig = mode === "orig";
    mode = "idle";
    if (wasOrig && proj) swapSource("ambiance.mp4");
    buttons();
  }
  function buttons() {
    const busy = mode !== "idle";
    $("#st-stop").classList.toggle("hidden", !busy);
    $("#st-pause").classList.toggle("hidden", !(mode === "play" || mode === "orig"));  // pas de pause pendant une prise
    $("#st-pause").textContent = "⏸ Pause";
    ["#st-orig", "#st-play", "#st-record", "#st-prev", "#st-next"].forEach((s) => $(s).classList.toggle("hidden", busy));
  }
  function swapSource(name) {
    const t = video.currentTime || 0;
    if (video.src.endsWith(url(name))) return Promise.resolve();
    return new Promise((ok, fail) => {
      const done = (err) => { clearTimeout(timer); video.onloadedmetadata = video.onerror = null; err ? fail(err) : ok(); };
      const timer = setTimeout(() => done(new Error(`la piste ${name} ne se charge pas`)), 20000);
      video.onloadedmetadata = () => { video.currentTime = t; done(); };
      video.onerror = () => done(new Error(`la piste ${name} est illisible`));
      video.src = url(name);
    });
  }
  // Safari (la fenêtre de l'appli sur Mac) refuse de lancer un son qui ne part pas pendant le clic : après la
  // présentation (3 à 6 s) la lecture était refusée et rien ne se passait. Un play() pendant le clic débloque
  // chaque lecteur pour la suite.
  function unlockMedia() {
    if (proj) proj.clips.forEach(audioFor);   // les prises aussi : leurs lecteurs existent dès maintenant
    [video, vocals, ...pool.values()].forEach((m) => {
      if (m.dataset.unlocked) return;
      const wasMuted = m.muted; m.muted = true;
      const p = m.play();
      const back = (ok) => { if (ok) m.dataset.unlocked = "1"; if (m !== video || mode === "idle" || mode === "intro") m.pause(); m.muted = wasMuted; };
      if (p && p.then) p.then(() => back(true), () => back(false)); else back(true);
    });
  }
  async function play(kind) {
    unlockMedia();
    stopAll();
    try { await swapSource(kind === "orig" ? "original.mp4" : "ambiance.mp4"); }
    catch (e) { return D.toast("Lecture impossible : " + e.message, 6000); }
    if (video.duration && video.currentTime >= video.duration - 0.1) video.currentTime = 0;
    mode = kind; buttons();
    if (video.currentTime < 0.3 && $("#st-intro-auto").checked && (!(await intro()) || mode !== kind)) return;
    try { await video.play(); }
    catch (e) { stopAll(); D.toast("Lecture refusée (" + (e.name || e.message) + "). Reclique sur Écouter.", 6000); }
  }

  // ------------------------------------------------------------ présentation : logo puis les personnages
  // Image de présentation de chaque personne. Celle qui parle n'est pas toujours à l'écran (Ghostface au téléphone :
  // on voit la blonde) : parmi les images prises pendant ses répliques, on garde la plus différente de celles des
  // autres personnes. Une image choisie à la main (bouton 📷 de la carte Personnes) passe avant tout.
  function grabPortraits(p) {
    const byLen = new Map();
    buildLines(p.words).forEach((l) => { if (!byLen.has(l.sp)) byLen.set(l.sp, []); byLen.get(l.sp).push(l); });
    const todo = [];
    p.speakers.forEach((s) => {
      if (typeof s.portrait === "number") { todo.push({ sp: s.id, t: s.portrait, manual: true }); return; }
      (byLen.get(s.id) || []).sort((a, b) => (b.e - b.s) - (a.e - a.s)).slice(0, 6)
        .forEach((l) => todo.push({ sp: s.id, t: (l.s + l.e) / 2 }));
    });
    const shots = [];
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.src = url("original.mp4");
    const thumb = document.createElement("canvas"); thumb.width = 32; thumb.height = 18;
    const tctx = thumb.getContext("2d", { willReadFrequently: true });
    const dist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return d / (a.length * 0.75 * 255); };
    const choose = () => {
      const talk = new Map(); (byLen.size ? [...byLen] : []).forEach(([sp, ls]) => talk.set(sp, ls.reduce((n, l) => n + l.e - l.s, 0)));
      const order = [...new Set(shots.map((x) => x.sp))].sort((a, b) => (talk.get(b) || 0) - (talk.get(a) || 0));
      const chosen = [];
      for (const sp of order) {
        const mine = shots.filter((x) => x.sp === sp), others = shots.filter((x) => x.sp !== sp);
        const manual = mine.find((x) => x.manual);
        let best = manual, score = 1;
        if (!best) for (const c of mine) {
          const near = Math.min(...[...chosen, ...others].map((o) => dist(c.px, o.px)), 1);
          if (!best || near > score) { best = c; score = near; }
        }
        const dup = !manual && chosen.length && Math.min(...chosen.map((o) => dist(best.px, o.px))) < 0.03;
        if (best && !dup) { portraits.set(sp, best.url); chosen.push(best); } else portraits.delete(sp);  // pas deux fois la même image
      }
    };
    const next = () => {
      if (proj !== p) return;
      if (!todo.length) { v.removeAttribute("src"); v.load(); choose(); return; }
      const job = todo.shift();
      v.addEventListener("seeked", () => {
        const c = document.createElement("canvas");
        c.width = 480; c.height = Math.round(480 * (v.videoHeight / v.videoWidth || 9 / 16));
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        tctx.drawImage(v, 0, 0, 32, 18);
        try { shots.push({ ...job, url: c.toDataURL("image/jpeg", 0.85), px: tctx.getImageData(0, 0, 32, 18).data }); } catch {}
        next();
      }, { once: true });
      v.currentTime = job.t;
    };
    v.addEventListener("loadeddata", next, { once: true });
  }
  function fitCastNames() {     // le nom tient dans son panneau : on réduit la taille jusqu'à ce qu'il ne soit plus rogné
    $("#st-intro").querySelectorAll(".cast b").forEach((b) => {
      if (!b.firstElementChild) b.innerHTML = `<span style="display:inline-block">${esc(b.textContent)}</span>`;
      b.style.fontSize = "";
      const cs = getComputedStyle(b), room = () => b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      let size = parseFloat(cs.fontSize);
      while (b.firstElementChild.offsetWidth > room() && size > 10) { size -= 1; b.style.fontSize = size + "px"; }
    });
    const names = [...$("#st-intro").querySelectorAll(".cast b")];   // tous les noms à la même taille, la plus petite
    const min = Math.min(...names.map((b) => parseFloat(getComputedStyle(b).fontSize)));
    names.forEach((b) => (b.style.fontSize = min + "px"));
  }
  let introDone = null;
  function intro() {            // résout true quand la présentation est finie, false si on l'a arrêtée
    const box = $("#st-intro"), logo = box.querySelector(".intro-logo"), cast = box.querySelector(".intro-cast");
    cast.querySelector("h2").textContent = proj.title.replace(/\s+\d{1,2}-\d{1,2}\s+\d{1,2}h\d{2}$/, "");
    cast.querySelector(".cast").style.setProperty("--n", proj.speakers.length);
    cast.querySelector(".cast").innerHTML = proj.speakers.map((s, i) =>
      `<div style="--c:${s.color};--i:${i}">${portraits.has(s.id) ? `<img src="${portraits.get(s.id)}" alt="">` : ""}<b>${esc(s.name)}</b></div>`).join("");
    box.classList.remove("hidden"); logo.classList.remove("hidden"); cast.classList.add("hidden");
    return new Promise((ok) => {
      const timers = [];
      const finish = (result) => { timers.forEach(clearTimeout); box.classList.add("hidden"); box.onclick = null; introDone = null; ok(result); };
      introDone = finish;
      timers.push(setTimeout(() => { logo.classList.add("hidden"); cast.classList.remove("hidden"); fitCastNames(); }, 2000));
      timers.push(setTimeout(() => finish(true), 2000 + 1500 + proj.speakers.length * 700));
      box.onclick = () => finish(true);
    });
  }
  $("#st-intro-go").onclick = async () => { stopAll(); mode = "intro"; buttons(); await intro(); if (mode === "intro") { mode = "idle"; buttons(); } };
  $("#st-orig").onclick = () => play("orig");
  $("#st-play").onclick = () => play("play");
  $("#st-stop").onclick = () => stopAll();
  function togglePause() {      // pause / reprise sans perdre ce qu'on écoute (Original ou Écouter)
    if (mode !== "play" && mode !== "orig") return;
    if (video.paused) { video.play().catch(() => {}); $("#st-pause").textContent = "⏸ Pause"; }
    else { video.pause(); $("#st-pause").textContent = "▶ Reprendre"; }
  }
  $("#st-pause").onclick = togglePause;
  document.addEventListener("keydown", (e) => {   // barre d'espace : pause / reprise (pas pendant qu'on tape un texte)
    if (e.code !== "Space" || !proj || $("#st-editor").classList.contains("hidden")) return;
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(document.activeElement.tagName)) return;
    if (mode === "play" || mode === "orig") { e.preventDefault(); togglePause(); }
  });
  video.addEventListener("ended", () => stopAll());

  // répliques de la personne choisie
  function jump(dir) {
    const t = video.currentTime;
    const mine = lines.filter((l) => l.sp === who);
    const target = dir > 0 ? mine.find((l) => l.s - 1.5 > t + 0.2) : [...mine].reverse().find((l) => l.s - 1.5 < t - 0.6);
    if (!target) return D.toast(dir > 0 ? "Plus de réplique après" : "Pas de réplique avant");
    video.currentTime = Math.max(0, target.s - 1.5);
  }
  $("#st-prev").onclick = () => jump(-1);
  $("#st-next").onclick = () => jump(1);

  // ------------------------------------------------------------ enregistrement
  function mimeType() {
    for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }
  $("#st-record").onclick = async () => {
    unlockMedia();
    stopAll();
    try {
      stream = await micStream();
    } catch {
      if (window.pywebview && confirm("Le micro n'est pas accessible dans cette fenêtre. Ouvrir Studio Rythmo dans ton navigateur pour enregistrer ?")) {
        window.pywebview.api.open_browser();
        return;
      }
      return D.toast("Micro inaccessible : autorise-le dans le navigateur.", 5000);
    }
    await swapSource("ambiance.mp4");
    if (video.duration && video.currentTime >= video.duration - 0.5) video.currentTime = 0;
    if (video.currentTime < 0.3 && $("#st-intro-auto").checked) {
      mode = "intro"; buttons();
      if (!(await intro()) || mode !== "intro") return;
    }
    recFrom = video.currentTime;
    chunks = []; playStart = 0;
    const type = mimeType();
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = saveTake;
    recStart = performance.now();
    recorder.start(250);
    // décompte de 3 secondes : la bande défile déjà jusqu'au point de départ
    mode = "countdown"; buttons();
    countdownEnd = performance.now() + 3000;
    $("#st-cd").classList.remove("hidden");
    const count = () => {
      if (mode !== "countdown") return;
      const ms = countdownEnd - performance.now();
      if (ms > 0) {
        $("#st-cd b").textContent = Math.ceil(ms / 1000);
        $("#st-cd .cd-bar i").style.width = (ms / 30) + "%";
        requestAnimationFrame(count); return;
      }
      $("#st-cd").classList.add("hidden");
      $("#st-rec").classList.remove("hidden");
      mode = "record";
      video.addEventListener("playing", () => { playStart = performance.now(); }, { once: true });
      video.play();
    };
    count();
  };

  async function saveTake() {
    const from = recFrom, to = recTo;
    if (!chunks.length || !playStart || to - from < 0.3) return;
    const type = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunks, { type });
    const at = from - (playStart - recStart) / 1000;    // instant de la vidéo qui correspond au début du fichier
    const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
    const q = new URLSearchParams({ sp: who, start: from.toFixed(3), end: to.toFixed(3), at: at.toFixed(3), ext });
    try {
      const res = await fetch(`/api/studio/${encodeURIComponent(proj.id)}/clips?${q}`, { method: "POST", body: blob });
      if (!res.ok) throw new Error((await res.json()).detail);
      proj.clips.push(await res.json());
      refresh(); renderClips(); renderPeople();
      D.toast(`Prise de ${speaker(who).name} enregistrée`);
    } catch (e) { D.toast("La prise n'a pas pu être envoyée : " + e.message, 5000); }
  }

  // ------------------------------------------------------------ personnes
  function renderPeople() {
    $("#st-people").innerHTML = proj.speakers.map((s) => {
      const n = lines.filter((l) => l.sp === s.id).length, c = proj.clips.filter((k) => k.sp === s.id).length;
      return `<div class="person" style="--c:${s.color}"><i></i><input type="text" value="${esc(s.name)}" data-sp="${s.id}" maxlength="30">
        <small>${n} réplique${n > 1 ? "s" : ""} · ${c} prise${c > 1 ? "s" : ""}</small>
        <button class="btn small icon ghost${typeof s.portrait === "number" ? " picked" : ""}" data-portrait="${s.id}"
          title="Image de présentation : prendre l'image affichée en ce moment dans la vidéo">📷</button></div>`;
    }).join("");
    $("#st-people").querySelectorAll("[data-portrait]").forEach((b) => (b.onclick = async () => {
      const s = speaker(Number(b.dataset.portrait));
      s.portrait = Math.round((video.currentTime || 0) * 100) / 100;
      await save({ speakers: proj.speakers });
      portraits = new Map(); grabPortraits(proj); renderPeople();
      D.toast(`Image de ${s.name} : celle de ${fmt(s.portrait)}`);
    }));
    $("#st-people").querySelectorAll("input").forEach((el) => el.addEventListener("change", async () => {
      speaker(Number(el.dataset.sp)).name = el.value.trim() || `Personne ${Number(el.dataset.sp) + 1}`;
      await save({ speakers: proj.speakers });
      renderWho(); renderLines(); renderClips();
    }));
  }
  $("#st-recount-go").onclick = async () => {
    if (proj.clips.length && !confirm("Recompter peut changer qui dit quoi. Les prises déjà faites sont gardées. Continuer ?")) return;
    try { await D.post(`/api/studio/${encodeURIComponent(proj.id)}/speakers`, { count: Number($("#st-recount").value) }); watchJob(); }
    catch (e) { D.toast(e.message); }
  };
  // ------------------------------------------------------------ refaire le retrait des voix
  function sepInfo() {
    $("#st-sep-info").textContent = proj.separation === "roformer" ? "Voix retirées en haute qualité (Mel-RoFormer Bleedless)"
      : "Voix retirées avec l'ancienne méthode (Demucs) : des voix restent";
    const err = proj.separation_error && proj.separation !== "roformer";
    $("#st-sep-status").classList.toggle("hidden", !err);
    if (err) $("#st-sep-status").textContent = "Le moteur haute qualité a échoué : " + proj.separation_error;
  }
  $("#st-sep-go").onclick = async () => {
    stopAll();
    try { await D.post(`/api/studio/${encodeURIComponent(proj.id)}/separate`); watchSep(); }
    catch (e) { D.toast(e.message); }
  };
  function watchSep() {
    const st = $("#st-sep-status"), id = proj.id;
    $("#st-sep-go").disabled = true;
    st.classList.remove("hidden");
    st.innerHTML = `<div class="sep-prog"><div class="sep-line"><span id="st-sep-step">Démarrage…</span><b id="st-sep-pct">0 %</b></div>
      <div class="progress"><div id="st-sep-bar"></div></div></div>`;
    const timer = setInterval(async () => {
      let p;
      try { p = await D.api(`/api/studio/${encodeURIComponent(id)}`); } catch { return; }
      if (p.job && p.job.running) {  // avancement réel envoyé par le moteur
        const pct = Math.round((p.job.progress || 0) * 100);
        if ($("#st-sep-bar")) { $("#st-sep-bar").style.width = pct + "%"; $("#st-sep-pct").textContent = pct + " %";
          $("#st-sep-step").textContent = p.job.step || "Retrait des voix…"; }
        return;
      }
      clearInterval(timer);
      st.classList.add("hidden"); $("#st-sep-go").disabled = false;
      if (!proj || proj.id !== id) return;
      if (p.job && p.job.error) return D.toast(p.job.error, 6000);
      proj.separation = p.separation; sepInfo();
      const t = video.currentTime || 0, bust = "?t=" + Date.now();
      video.src = url("ambiance.mp4") + bust; vocals.src = url("vocals.m4a") + bust;
      video.addEventListener("loadedmetadata", () => { video.currentTime = t; }, { once: true });
      D.toast("Voix retirées en haute qualité");
    }, 2000);
  }
  function watchJob() {
    clearInterval(jobPoller);
    const st = $("#st-recount-status");
    st.classList.remove("hidden");
    st.innerHTML = `<span class="dot warn"></span>Détection…`;
    jobPoller = setInterval(async () => {
      let p;
      try { p = await D.api(`/api/studio/${encodeURIComponent(proj.id)}`); } catch { return; }
      if (p.job && p.job.running) { st.innerHTML = `<span class="dot warn"></span>Détection… ${Math.round(p.job.progress * 100)} %`; return; }
      clearInterval(jobPoller);
      st.classList.add("hidden");
      if (p.job && p.job.error) D.toast(p.job.error, 6000);
      Object.assign(proj, { words: p.words, speakers: p.speakers, speakers_error: p.speakers_error });
      proj.speakers.forEach((s) => (s.color = PALETTE[s.id % PALETTE.length]));
      portraits = new Map(); grabPortraits(proj);
      if (!proj.speakers.some((s) => s.id === who)) who = proj.speakers[0].id;
      $("#st-sp-warn").classList.toggle("hidden", !proj.speakers_error);
      $("#st-sp-warn").textContent = proj.speakers_error || "";
      refresh(); renderAll();
      const n = proj.speakers.length;
      D.toast(`${n} personne${n > 1 ? "s" : ""} détectée${n > 1 ? "s" : ""}`);
    }, 1500);
  }

  // ------------------------------------------------------------ prises
  function renderClips() {
    if (!proj.clips.length) {
      $("#st-clips").innerHTML = `<p class="hint" style="margin:0">Aucune prise. Choisis qui tu doubles, place-toi avant sa réplique (⏭) et appuie sur Enregistrer.</p>`;
      return;
    }
    $("#st-clips").innerHTML = [...proj.clips].sort((a, b) => a.from - b.from).map((c) => {
      const s = speaker(c.sp);
      return `<div class="clip" style="--c:${s.color}"><i></i><span><b>${esc(s.name)}</b> · ${fmt(c.from)} → ${fmt(c.to)}</span>
        <button class="btn small ghost" data-go="${c.id}" title="Écouter">▶</button>
        <button class="btn small ghost danger" data-del="${c.id}" title="Supprimer">✕</button></div>`;
    }).join("");
    $("#st-clips").querySelectorAll("[data-go]").forEach((b) => (b.onclick = async () => {
      const c = proj.clips.find((k) => k.id === b.dataset.go);
      stopAll(); await swapSource("ambiance.mp4");
      video.currentTime = Math.max(0, c.from - 0.5);
      play("play");
    }));
    $("#st-clips").querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      await D.api(`/api/studio/${encodeURIComponent(proj.id)}/clips/${b.dataset.del}`, { method: "DELETE" });
      proj.clips = proj.clips.filter((k) => k.id !== b.dataset.del);
      refresh(); renderClips(); renderPeople();
    }));
  }

  // ------------------------------------------------------------ mixage
  function latText() { const v = Number($("#st-lat").value); $("#st-lat-val").textContent = `${v > 0 ? "+" : ""}${v} ms`; }
  $("#st-lat").addEventListener("input", latText);
  const saveMix = () => save({ latency_ms: Number($("#st-lat").value), mix: { voice: Number($("#st-vgain").value),
    ambience: Number($("#st-again").value), keep_original: $("#st-keep").checked } });
  ["#st-lat", "#st-vgain", "#st-again", "#st-keep"].forEach((s) => $(s).addEventListener("change", saveMix));

  async function save(data) {
    try {
      await D.api(`/api/studio/${encodeURIComponent(proj.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      return true;
    } catch (e) { dirty = true; saveState(); D.toast(e.message); return false; }
  }

  // ------------------------------------------------------------ bouton Enregistrer
  // Les modifications partent d'elles-mêmes après un court délai ; le bouton envoie tout tout de suite (texte en
  // cours de frappe compris) et dit clairement si c'est enregistré.
  let dirty = false;
  function saveState(state) {
    document.querySelectorAll(".st-save").forEach((b) => {
      b.disabled = state === "saving";
      b.textContent = state === "saving" ? "Enregistrement…" : dirty ? "💾 Enregistrer les modifications" : "✓ Modifications enregistrées";
      b.classList.toggle("primary", dirty);
    });
  }
  function markDirty() { dirty = true; saveState(); }
  async function saveNow(quiet) {
    if (!proj) return true;
    const typing = document.activeElement;
    if (typing && typing.matches("#st-lines textarea")) applyText(Number(typing.dataset.i), typing.value);
    clearTimeout(saveTimer);
    saveState("saving");
    dirty = false;
    const ok = await save({ words: proj.words, speakers: proj.speakers, latency_ms: Number($("#st-lat").value),
      mix: { voice: Number($("#st-vgain").value), ambience: Number($("#st-again").value), keep_original: $("#st-keep").checked } });
    saveState();
    if (ok && !quiet) D.toast("Modifications enregistrées");
    return ok;
  }
  document.querySelectorAll(".st-save").forEach((b) => (b.onclick = () => saveNow()));
  document.addEventListener("keydown", (e) => {   // Ctrl+S / Cmd+S
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && proj && !$("#st-editor").classList.contains("hidden")) {
      e.preventDefault(); saveNow();
    }
  });

  $("#st-render").onclick = async () => {
    const btn = $("#st-render");
    btn.disabled = true; btn.textContent = "Montage en cours…";
    stopAll();
    try {
      await saveMix();
      const r = await D.post(`/api/studio/${encodeURIComponent(proj.id)}/render`);
      proj.finals.unshift(r.final);
      renderFinals();
      $("#st-finals").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) { D.toast(e.message, 5000); }
    btn.disabled = false; btn.textContent = "Créer la vidéo";
  };

  function renderFinals() {
    $("#st-finals").classList.toggle("hidden", !proj.finals.length);
    if (!proj.finals.length) return;
    $("#st-final-player").src = url(proj.finals[0]);
    $("#st-final-list").innerHTML = proj.finals.map((f, i) =>
      `<a class="btn small" href="${url(f)}" download>⬇ ${i === 0 ? "Dernière version" : "Version " + (proj.finals.length - i)}</a>`).join("");
  }

  // ------------------------------------------------------------ texte des répliques
  function renderLines() {
    const options = proj.speakers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    $("#st-lines").innerHTML = lines.map((l, i) => `
      <div class="line" data-line="${i}"><div class="line-head">
        <select data-i="${i}" style="--c:${speaker(l.sp).color}">${options}</select>
        <button class="t" data-seek="${i}" title="Aller à cette réplique">${fmt(l.s)}</button></div>
        <textarea data-i="${i}" rows="1" spellcheck="true">${esc(l.words.map((k) => proj.words[k].w).join(" "))}</textarea></div>`).join("") ||
      `<p class="hint">Aucune parole détectée dans cette vidéo.</p>`;
    const grow = (el) => { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; };
    $("#st-lines").querySelectorAll("select").forEach((el) => {
      el.value = lines[el.dataset.i].sp;
      el.addEventListener("change", () => {      // le personnage change tout de suite, sur la bande aussi
        const sp = Number(el.value);
        lines[el.dataset.i].words.forEach((k) => (proj.words[k].sp = sp));
        applyWords(proj.words, true);
      });
    });
    $("#st-lines").querySelectorAll("textarea").forEach((el) => {
      requestAnimationFrame(() => grow(el));
      let timer = null;
      el.addEventListener("input", () => {        // le texte suit la frappe sur la bande
        grow(el);
        markDirty();
        clearTimeout(timer);
        timer = setTimeout(() => applyText(Number(el.dataset.i), el.value), 400);
      });
      el.addEventListener("blur", () => { clearTimeout(timer); applyText(Number(el.dataset.i), el.value, true); });
      el.addEventListener("focus", () => { if (mode === "idle") video.currentTime = Math.max(0, lines[el.dataset.i].s - 0.8); });
    });
    $("#st-lines").querySelectorAll("[data-seek]").forEach((b) => (b.onclick = () => {
      if (mode === "record" || mode === "countdown") return;
      video.currentTime = Math.max(0, lines[b.dataset.seek].s - 0.8);
    }));
    activeLine = -1;
  }
  let activeLine = -1;
  function markActiveLine(t) {  // la réplique en cours est surlignée dans le panneau Texte
    const i = lines.findIndex((l) => t >= l.s - 0.3 && t < l.e + 0.3);
    if (i === activeLine) return;
    const box = $("#st-lines");
    box.querySelector(".line.now")?.classList.remove("now");
    activeLine = i;
    const el = i >= 0 && box.querySelector(`[data-line="${i}"]`);
    if (!el) return;
    el.classList.add("now");
    if (!box.contains(document.activeElement) && mode !== "idle") box.scrollTo({ top: el.offsetTop - box.offsetTop - 60, behavior: "smooth" });
  }
  // ------------------------------------------------------------ modifications appliquées tout de suite
  let saveTimer = null;
  function applyWords(words, rerender) {
    proj.words = words;
    refresh();
    if (rerender) renderLines();
    renderPeople();
    markDirty();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => { dirty = false; await save({ words: proj.words }); saveState(); }, 600);
  }
  function applyText(i, value, done) {
    const l = lines[i];
    if (!l) return;
    const text = value.trim().split(/\s+/).filter(Boolean);
    const old = l.words.map((k) => proj.words[k]);
    if (text.length === old.length && text.every((w, k) => w === old[k].w)) { if (done) renderLines(); return; }
    let fresh;
    if (text.length === old.length) fresh = text.map((w, k) => ({ ...old[k], w }));
    else {                                 // nombre de mots changé : répartis sur la durée de la réplique
      const step = (l.e - l.s) / Math.max(1, text.length);
      fresh = text.map((w, k) => ({ w, s: l.s + k * step, e: l.s + (k + 1) * step - 0.02, sp: l.sp }));
    }
    const first = l.words[0], last = l.words[l.words.length - 1];
    const before = lines.length;
    applyWords([...proj.words.slice(0, first), ...fresh, ...proj.words.slice(last + 1)], false);
    if (done || lines.length !== before) renderLines();
  }

  // ------------------------------------------------------------ glisser un mot sur l'autre ligne de la bande
  let boxes = [], tagBoxes = [], drag = null;
  const endsSentence = (w) => /[.?!…]\s*$/.test(w.w);
  function hit(e) {
    const r = band.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const row = Math.min(ROWS() - 1, Math.max(0, Math.floor(y / laneH())));
    return { x, y, row, box: boxes.find((b) => b.row === row && x >= b.x0 - 3 && x <= b.x1 + 3),
             tag: tagBoxes.find((b) => b.row === row && x >= b.x0 - 3 && x <= b.x1 + 3) };
  }
  // Ce qui part : le mot attrapé seul ; avec Maj, lui et la fin de sa phrase (« Aller » emmène « Aller, aller. ») ;
  // l'étiquette du personnage emmène toute la réplique.
  function dragSet(h) {
    if (h.tag) return { line: h.tag.line, set: new Set(h.tag.line.words) };
    if (!h.shift) return { line: null, set: new Set([h.box.k]) };   // par défaut : ce mot seulement
    const line = lines.find((l) => l.words.includes(h.box.k)), set = new Set();
    for (const j of line.words.slice(line.words.indexOf(h.box.k))) {
      set.add(j);
      if (endsSentence(proj.words[j])) break;
    }
    return { line: null, set };
  }
  band.addEventListener("pointerdown", (e) => {
    if (!proj || client || ROWS() < 2 || mode === "record" || mode === "countdown") return;
    const h = hit(e);
    if (!h.box && !h.tag) return;
    const from = h.tag ? h.tag.row : h.box.row;
    h.shift = e.shiftKey;
    drag = { ...dragSet(h), from, y: h.y, row: from, moved: false };
    band.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  band.addEventListener("pointermove", (e) => {
    if (!drag) { const h = proj && !client && ROWS() > 1 ? hit(e) : {}; band.style.cursor = h.box || h.tag ? "grab" : ""; return; }
    const h = hit(e);
    drag.y = h.y; drag.row = h.row; drag.moved = true;
    band.style.cursor = "grabbing";
  });
  band.addEventListener("pointerup", () => {
    if (!drag) return;
    const { set, from, row } = drag;
    drag = null; band.style.cursor = "";
    if (row === from) return;
    // Les mots vont au personnage de la ligne visée (une ligne par personnage)
    const ks = [...set].sort((a, b) => a - b);
    const best = (proj.speakers[row] || {}).id;
    if (best === undefined) return;
    ks.forEach((k) => (proj.words[k] = { ...proj.words[k], sp: best }));
    applyWords(proj.words, true);
    const text = ks.map((k) => proj.words[k].w).join(" ");
    D.toast(`« ${text.length > 40 ? text.slice(0, 38) + "…" : text} » → ${speaker(best).name}`);
  });
  $("#st-delete").onclick = async () => {
    const b = $("#st-delete");
    if (!b.classList.contains("armed")) {  // pas de confirm() : la fenêtre de l'appli Mac ne l'affiche pas toujours
      b.classList.add("armed"); b.textContent = "Cliquer encore pour supprimer";
      setTimeout(() => { b.classList.remove("armed"); b.textContent = "Supprimer la vidéo"; }, 4000);
      return;
    }
    b.classList.remove("armed"); b.textContent = "Supprimer la vidéo";
    await D.api(`/api/studio/${encodeURIComponent(proj.id)}`, { method: "DELETE" });
    $("#st-back").click();
  };

  // ------------------------------------------------------------ micro et caméra
  const PREF = "studio-devices";
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF)) || {}; } catch { return {}; } })();
  const keepPrefs = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch {} };
  const devWarn = (text) => { $("#st-dev-warn").textContent = text || ""; $("#st-dev-warn").classList.toggle("hidden", !text); };
  let meterCtx = null, meterSrc = null, meterRaf = 0;

  async function listDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const all = await navigator.mediaDevices.enumerateDevices();
    const fillSel = (sel, kind, none, chosen) => {
      const items = all.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
      sel.innerHTML = `<option value="">${none}</option>` + items.map((d, i) =>
        `<option value="${esc(d.deviceId)}">${esc(d.label || (kind === "audioinput" ? "Micro " : "Caméra ") + (i + 1))}</option>`).join("");
      sel.value = items.some((d) => d.deviceId === chosen) ? chosen : "";
    };
    fillSel($("#st-mic"), "audioinput", "Micro par défaut", prefs.mic);
    fillSel($("#st-camsel"), "videoinput", "Caméra par défaut", prefs.cam);
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listDevices);

  // Le micro branché sur l'ordinateur (choisi dans la liste, sinon celui par défaut)
  async function micStream() {
    if (stream && stream.active && stream.zMic === (prefs.mic || "")) return stream;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    if (prefs.mic) audio.deviceId = { exact: prefs.mic };
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) {
      if (!prefs.mic) throw e;
      delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio });   // micro débranché : celui par défaut
    }
    stream.zMic = prefs.mic || "";
    meter(stream);
    listDevices();   // les noms des micros ne sont donnés qu'une fois l'accès autorisé
    return stream;
  }
  function meter(s) {           // niveau du micro en direct
    try {
      meterCtx = meterCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (meterCtx.state === "suspended") meterCtx.resume();
      if (meterSrc) meterSrc.disconnect();
      meterSrc = meterCtx.createMediaStreamSource(s);
      const an = meterCtx.createAnalyser(); an.fftSize = 512; meterSrc.connect(an);
      const buf = new Float32Array(an.fftSize);
      cancelAnimationFrame(meterRaf);
      const tick = () => {
        if (!s.active) { $("#st-meter").style.width = "0"; return; }
        an.getFloatTimeDomainData(buf);
        let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
        $("#st-meter").style.width = Math.min(100, Math.round(Math.sqrt(peak) * 110)) + "%";
        meterRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  }
  function noAccess(what) {
    let msg = window.isSecureContext ? `${what} inaccessible : autorise-le dans la fenêtre qui s'affiche, ou dans les réglages de confidentialité de l'ordinateur.`
      : `${what} demande une adresse sécurisée (https) : sur un autre appareil, utilise l'adresse « Accès depuis partout » (Réglages → Téléphone).`;
    if (window.pywebview) msg += " Si rien ne marche dans la fenêtre de l'appli, ouvre Studio Rythmo dans ton navigateur (Chrome, Safari…).";
    devWarn(msg);
  }
  $("#st-mic").addEventListener("change", async (e) => {
    prefs.mic = e.target.value; keepPrefs();
    try { await micStream(); devWarn(""); } catch { noAccess("Micro"); }
  });
  $("#st-mic-test").onclick = async () => {
    try { await micStream(); devWarn(""); D.toast("Parle : la barre doit bouger"); } catch { noAccess("Micro"); }
  };

  // Retour de la webcam : ton image par-dessus la scène (dans l'écran, donc aussi en plein écran télé)
  let cam = null;
  const camBox = $("#st-cam-box");
  function camLook() {
    camBox.className = "cam " + (prefs.corner || "br") + ($("#st-cam-mirror").checked ? " mirror" : "") + (cam ? "" : " hidden");
    camBox.style.setProperty("--cam-w", (prefs.size || 24) + "%");
  }
  async function camStart() {
    camStop(true);
    const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (prefs.cam) video.deviceId = { exact: prefs.cam };
    try { cam = await navigator.mediaDevices.getUserMedia({ video }); }
    catch (e) {
      if (prefs.cam) { delete video.deviceId; try { cam = await navigator.mediaDevices.getUserMedia({ video }); } catch {} }
      if (!cam) { $("#st-cam-on").checked = false; prefs.camOn = false; keepPrefs(); noAccess("La caméra"); camLook(); return; }
    }
    devWarn("");
    $("#st-cam").srcObject = cam;
    $("#st-cam").play().catch(() => {});
    camLook(); listDevices();
  }
  function camStop(keep) {
    if (cam) cam.getTracks().forEach((t) => t.stop());
    cam = null; $("#st-cam").srcObject = null;
    if (!keep) camLook();
  }
  $("#st-cam-on").addEventListener("change", (e) => { prefs.camOn = e.target.checked; keepPrefs(); e.target.checked ? camStart() : camStop(); });
  $("#st-camsel").addEventListener("change", (e) => { prefs.cam = e.target.value; keepPrefs(); if (cam) camStart(); });
  $("#st-cam-mirror").addEventListener("change", (e) => { prefs.mirror = e.target.checked; keepPrefs(); camLook(); });
  $("#st-cam-size").addEventListener("input", (e) => { prefs.size = Number(e.target.value); keepPrefs(); camLook(); });
  $("#st-cam-move").onclick = () => {
    const order = ["br", "bl", "tl", "tr"];
    prefs.corner = order[(order.indexOf(prefs.corner || "br") + 1) % 4]; keepPrefs(); camLook();
  };
  $("#st-cam-mirror").checked = prefs.mirror !== false;
  $("#st-cam-size").value = prefs.size || 24;
  function devicesOnOpen() {    // à l'ouverture d'une scène : la caméra revient si elle était allumée
    listDevices();
    $("#st-cam-on").checked = !!prefs.camOn;
    if (prefs.camOn && !cam) camStart(); else camLook();
  }

  // ------------------------------------------------------------ onglet Doubler (clients)
  async function loadScenes() {
    let list = [];
    try { list = await D.api("/api/studio"); } catch (e) { return; }
    $("#db-scenes").innerHTML = list.map((p, i) => `
      <div class="glass lib-item">
        <div class="thumb"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M7 8v8M17 6v12M2 11v2M22 10v4"/></svg></div>
        <div class="meta"><b>${esc(p.title)}</b><small>${fmt(p.duration)} · ${p.speakers} personnage${p.speakers > 1 ? "s" : ""} · ${p.clips} prise${p.clips > 1 ? "s" : ""}</small></div>
        <button class="btn small primary" style="width:auto;padding:8px 16px;font-size:14px" data-dub="${i}">Doubler</button>
      </div>`).join("");
    $("#db-scenes").querySelectorAll("[data-dub]").forEach((b) => (b.onclick = () => open(list[b.dataset.dub].id, { client: true })));
  }
  const DROP_SUB = "La scène exportée du Studio (avec sa bande rythmo) ou n'importe quelle vidéo déjà sans voix · ou glisse-la ici";
  async function importScene(f) {
    if (!f) return;
    $("#db-drop").classList.add("filled");
    $("#db-drop-title").textContent = f.name;
    $("#db-drop-sub").textContent = D.fmtSize(f.size);
    $("#db-up").classList.remove("hidden");
    const step = (text, p) => { $("#db-up-step").textContent = text; $("#db-up-pct").textContent = Math.round(p * 100) + " %"; $("#db-up-bar").style.width = p * 100 + "%"; };
    try {
      const up = await D.upload(f, (p) => step(`Envoi… ${D.fmtSize(f.size * p)} / ${D.fmtSize(f.size)}`, p * 0.9));
      step("Préparation de la scène…", 0.95);
      const r = await D.post("/api/studio/import", { source: up.path, name: f.name });
      step("Prête", 1);
      D.toast(r.rythmo ? "Scène importée avec sa bande rythmo" : "Vidéo importée, sans bande rythmo (exporte la scène depuis le Studio pour l'avoir)", 5000);
      await open(r.id, { client: true });
    } catch (e) { D.toast("Import impossible : " + e.message, 6000); }
    $("#db-up").classList.add("hidden");
    $("#db-drop").classList.remove("filled");
    $("#db-drop-title").textContent = "Choisir un MP4";
    $("#db-drop-sub").textContent = DROP_SUB;
    $("#db-file").value = "";
  }
  $("#db-file").addEventListener("change", (e) => importScene(e.target.files[0]));
  const dbDrop = $("#db-drop");
  ["dragenter", "dragover"].forEach((t) => dbDrop.addEventListener(t, (e) => { e.preventDefault(); dbDrop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => dbDrop.addEventListener(t, (e) => { e.preventDefault(); dbDrop.classList.remove("over"); }));
  dbDrop.addEventListener("drop", (e) => importScene(e.dataTransfer.files[0]));
  // Changer d'onglet pendant qu'une scène est ouverte dans l'autre : on la referme proprement
  document.querySelector('[data-view="v-dub"]').addEventListener("click", () => {
    if (proj && !client && !editor.classList.contains("hidden")) { stopAll(); camStop(); }
    if (!client || editor.classList.contains("hidden")) { $("#db-home").classList.remove("hidden"); loadScenes(); }
  });
  document.querySelector('[data-view="v-studio"]').addEventListener("click", () => {
    if (client && !editor.classList.contains("hidden")) {
      closeEditor(); client = false;
      editor.classList.remove("client", "imported");
      $("#v-studio").appendChild(editor);
    }
  });
  loadScenes();

  // ------------------------------------------------------------ démarrage
  document.querySelector('[data-view="v-studio"]').addEventListener("click", () => { loadProjects(); setTimeout(resize, 50); });
  (async () => {
    try {
      const s = await D.api("/api/status");
      if (s.total_steps === N_STEPS && ["running", "paused", "stopping"].includes(s.state)) {
        $("#st-new").classList.add("hidden"); $("#st-run").classList.remove("hidden"); watch();
      }
    } catch {}
  })();
})();
