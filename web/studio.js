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
      const s = Math.max(0, w.s - 0.12), e = w.e + 0.12, last = ranges[ranges.length - 1];
      if (last && s - last[1] < 0.8) last[1] = Math.max(last[1], e); else ranges.push([s, e]);
    });
    return ranges;
  }
  let wordRow = [];
  function placeLines() {       // deux lignes : chaque réplique va sur la ligne de son personnage si elle est libre, sinon sur l'autre
    const ends = [-1e9, -1e9], last = new Map();
    wordRow = new Array(proj.words.length).fill(0);
    for (const l of lines) {
      const pref = last.has(l.sp) ? last.get(l.sp) : (ends[0] <= ends[1] ? 0 : 1);
      const r = ends[pref] <= l.s - 0.15 || ends[1 - pref] > l.s - 0.15 ? pref : 1 - pref;
      l.row = r; ends[r] = Math.max(ends[r], l.e); last.set(l.sp, r);
      l.words.forEach((k) => (wordRow[k] = r));
    }
  }
  function refresh() { parts = keptParts(proj.clips); lines = buildLines(proj.words); keep = keepRanges(); placeLines(); }

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
  async function open(id) {
    let next;
    try { next = await D.api(`/api/studio/${encodeURIComponent(id)}`); } catch (e) { return D.toast(e.message); }
    if (proj) stopAll();
    proj = next;
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
    $("#st-mic-warn").textContent = secure ? "" : "Le micro du navigateur demande une adresse sécurisée (https). Sur le téléphone, ouvre Joue ta réplique avec l'adresse « Accès depuis partout » (Réglages → Téléphone).";
    $("#st-sp-warn").classList.toggle("hidden", !proj.speakers_error);
    $("#st-sp-warn").textContent = proj.speakers_error || "";
    sepInfo();
    if (proj.job && proj.job.running) (proj.job.kind === "separate" ? watchSep() : watchJob());
    window.scrollTo({ top: 0 });
    resize();
  }
  $("#st-back").onclick = () => { stopAll(); $("#st-editor").classList.add("hidden"); $("#st-home").classList.remove("hidden"); loadProjects(); };

  function renderAll() { renderWho(); renderPeople(); renderClips(); renderFinals(); renderLines(); resize(); }

  function renderWho() {
    $("#st-who").innerHTML = proj.speakers.map((s) =>
      `<button class="chip ${s.id === who ? "on" : ""}" style="--c:${s.color}" data-sp="${s.id}"><i></i>${esc(s.name)}</button>`).join("");
    $("#st-who").querySelectorAll("[data-sp]").forEach((b) => (b.onclick = () => { who = Number(b.dataset.sp); renderWho(); }));
  }

  // ------------------------------------------------------------ bande rythmo
  let W = 0, H = 0, DPR = 1;
  const tv = () => document.fullscreenElement === $("#st-tv");
  const ROWS = () => (proj && proj.speakers.length > 1 ? 2 : 1);
  function laneH() {
    const base = W && W < 600 ? 54 : 74;
    return tv() ? Math.round(base * Math.max(1.4, window.innerHeight / 640)) : base;
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
    const pps = lh * (W < 600 ? 3.6 : 4.4);    // pixels par seconde : assez vite pour que les mots tiennent sans se tasser
    const bar = Math.round(W * 0.33);
    const focus = mode === "record" || mode === "countdown";
    const fs = Math.round(lh * 0.5);
    const textY = (r) => r * lh + lh * 0.54;

    // deux lignes sombres
    for (let r = 0; r < ROWS(); r++) { ctx.fillStyle = r ? "#2c2f36" : "#32353d"; ctx.fillRect(0, r * lh, W, lh); }
    if (ROWS() > 1) { ctx.fillStyle = "#1d1f24"; ctx.fillRect(0, lh - 1, W, 2); }
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
    for (const l of lines) {
      const x = bar + (l.s - t) * pps;
      if (x > W + 200) break;
      if (bar + (l.e - t) * pps < -10) continue;
      const s = speaker(l.sp);
      ctx.font = `800 ${tagSize}px ${getComputedStyle(document.body).fontFamily}`;
      const label = (s.name.length > 16 ? s.name.slice(0, 15) + "…" : s.name).toUpperCase();
      const w = ctx.measureText(label).width + tagSize;
      const h = tagSize * 1.7, gap = tagSize * 0.6;
      ctx.globalAlpha = (focus && l.sp !== who ? 0.4 : 1) * (bar + (l.e - t) * pps < bar ? 0.45 : 1);
      ctx.fillStyle = s.color; roundRect(ctx, x - w - gap, textY(l.row) - h / 2, w, h, 3); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.fillText(label, x - w - gap + tagSize / 2, textY(l.row) + 1);
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
      const dragged = drag && drag.moved && drag.k === k;
      const y = dragged ? Math.max(fs / 2, Math.min(H - fs / 2, drag.y)) : textY(wordRow[k] || 0);
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
    if (running && mode === "play" && $("#st-keep").checked && keep.some(([a, b]) => t >= a && t < b)) vol = 1;
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
    ["#st-orig", "#st-play", "#st-record", "#st-prev", "#st-next"].forEach((s) => $(s).classList.toggle("hidden", busy));
  }
  function swapSource(name) {
    const t = video.currentTime || 0;
    if (video.src.endsWith(url(name))) return Promise.resolve();
    return new Promise((ok) => {
      video.src = url(name);
      video.addEventListener("loadedmetadata", () => { video.currentTime = t; ok(); }, { once: true });
    });
  }
  async function play(kind) {
    stopAll();
    await swapSource(kind === "orig" ? "original.mp4" : "ambiance.mp4");
    if (video.duration && video.currentTime >= video.duration - 0.1) video.currentTime = 0;
    mode = kind; buttons();
    if (video.currentTime < 0.3 && $("#st-intro-auto").checked && (!(await intro()) || mode !== kind)) return;
    try { await video.play(); } catch { stopAll(); }
  }

  // ------------------------------------------------------------ présentation : logo puis les personnages
  function grabPortraits(p) {   // pour chaque personne, une image prise au milieu de sa plus longue réplique
    const longest = new Map();
    buildLines(p.words).forEach((l) => { const b = longest.get(l.sp); if (!b || l.e - l.s > b.e - b.s) longest.set(l.sp, l); });
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.src = url("original.mp4");
    const todo = [...longest.entries()];
    const next = () => {
      if (proj !== p || !todo.length) { v.removeAttribute("src"); v.load(); return; }
      const [sp, l] = todo.shift();
      v.addEventListener("seeked", () => {
        const c = document.createElement("canvas");
        c.width = 480; c.height = Math.round(480 * (v.videoHeight / v.videoWidth || 9 / 16));
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        try { portraits.set(sp, c.toDataURL("image/jpeg", 0.85)); } catch {}
        next();
      }, { once: true });
      v.currentTime = (l.s + l.e) / 2;
    };
    v.addEventListener("loadeddata", next, { once: true });
  }
  let introDone = null;
  function intro() {            // résout true quand la présentation est finie, false si on l'a arrêtée
    const box = $("#st-intro"), logo = box.querySelector(".intro-logo"), cast = box.querySelector(".intro-cast");
    cast.querySelector("h2").textContent = proj.title.replace(/\s+\d{1,2}-\d{1,2}\s+\d{1,2}h\d{2}$/, "");
    cast.querySelector(".cast").innerHTML = proj.speakers.map((s, i) =>
      `<div style="--c:${s.color};--i:${i}">${portraits.has(s.id) ? `<img src="${portraits.get(s.id)}" alt="">` : ""}<b>${esc(s.name)}</b></div>`).join("");
    box.classList.remove("hidden"); logo.classList.remove("hidden"); cast.classList.add("hidden");
    return new Promise((ok) => {
      const timers = [];
      const finish = (result) => { timers.forEach(clearTimeout); box.classList.add("hidden"); box.onclick = null; introDone = null; ok(result); };
      introDone = finish;
      timers.push(setTimeout(() => { logo.classList.add("hidden"); cast.classList.remove("hidden"); }, 2000));
      timers.push(setTimeout(() => finish(true), 2000 + 1500 + proj.speakers.length * 700));
      box.onclick = () => finish(true);
    });
  }
  $("#st-intro-go").onclick = async () => { stopAll(); mode = "intro"; buttons(); await intro(); if (mode === "intro") { mode = "idle"; buttons(); } };
  $("#st-orig").onclick = () => play("orig");
  $("#st-play").onclick = () => play("play");
  $("#st-stop").onclick = () => stopAll();
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
    stopAll();
    try {
      stream = stream && stream.active ? stream : await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch {
      if (window.pywebview && confirm("Le micro n'est pas accessible dans cette fenêtre. Ouvrir Joue ta réplique dans ton navigateur pour enregistrer ?")) {
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
        <small>${n} réplique${n > 1 ? "s" : ""} · ${c} prise${c > 1 ? "s" : ""}</small></div>`;
    }).join("");
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
    $("#st-sep-info").textContent = proj.separation === "roformer" ? "Voix retirées en haute qualité"
      : "Voix retirées avec l'ancienne méthode : des voix peuvent rester";
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
    st.innerHTML = `<span class="dot warn"></span>Retrait des voix en cours… (une à quelques minutes)`;
    const timer = setInterval(async () => {
      let p;
      try { p = await D.api(`/api/studio/${encodeURIComponent(id)}`); } catch { return; }
      if (p.job && p.job.running) return;
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
    } catch (e) { D.toast(e.message); }
  }

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
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save({ words: proj.words }), 600);
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
  let boxes = [], drag = null;
  function hit(e) {
    const r = band.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const row = Math.min(ROWS() - 1, Math.max(0, Math.floor(y / laneH())));
    return { x, y, row, box: boxes.find((b) => b.row === row && x >= b.x0 - 3 && x <= b.x1 + 3) };
  }
  band.addEventListener("pointerdown", (e) => {
    if (!proj || ROWS() < 2 || mode === "record" || mode === "countdown") return;
    const h = hit(e);
    if (!h.box) return;
    drag = { k: h.box.k, from: h.box.row, dx: h.x - h.box.x0, y: h.y, row: h.box.row, moved: false };
    band.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  band.addEventListener("pointermove", (e) => {
    if (!drag) { band.style.cursor = proj && ROWS() > 1 && hit(e).box ? "grab" : ""; return; }
    const h = hit(e);
    drag.y = h.y; drag.row = h.row; drag.moved = true;
    band.style.cursor = "grabbing";
  });
  band.addEventListener("pointerup", () => {
    if (!drag) return;
    const { k, from, row } = drag;
    drag = null; band.style.cursor = "";
    if (row === from) return;
    // le mot va au personnage de la ligne visée : la réplique la plus proche dans le temps sur cette ligne
    const w = proj.words[k];
    let best = null, gap = 1e9;
    for (const l of lines) {
      if (l.row !== row || l.sp === w.sp) continue;
      const g = Math.max(l.s - w.e, w.s - l.e, 0);
      if (g < gap) { gap = g; best = l.sp; }
    }
    if (best === null) best = proj.speakers.find((s) => s.id !== w.sp).id;
    proj.words[k] = { ...w, sp: best };
    applyWords(proj.words, true);
    D.toast(`« ${w.w} » → ${speaker(best).name}`);
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
