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
  function refresh() { parts = keptParts(proj.clips); lines = buildLines(proj.words); keep = keepRanges(); }

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
      </div>`).join("");
    $("#st-projects").querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => open(list[b.dataset.open].id)));
    return list;
  }

  // ------------------------------------------------------------ ouvrir une vidéo
  async function open(id) {
    let next;
    try { next = await D.api(`/api/studio/${encodeURIComponent(id)}`); } catch (e) { return D.toast(e.message); }
    if (proj) stopAll();
    proj = next;
    pool.forEach((a) => a.pause()); pool.clear();
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
    if (proj.job && proj.job.running) watchJob();
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
  function laneH() { const n = proj ? proj.speakers.length : 1; return n <= 2 ? 50 : n <= 4 ? 40 : 30; }
  function resize() {
    if (!proj) return;
    DPR = window.devicePixelRatio || 1;
    band.style.height = (proj.speakers.length * laneH() + 12) + "px";
    W = band.clientWidth; H = band.clientHeight;
    band.width = W * DPR; band.height = H * DPR;
  }
  window.addEventListener("resize", resize);

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
    const pps = W < 600 ? 170 : 220;            // pixels par seconde
    const bar = Math.round(W * 0.24);
    const lh = laneH();
    const focus = mode === "record" || mode === "countdown";
    const row = new Map(proj.speakers.map((s, i) => [s.id, i]));

    // couloirs, un par personne
    proj.speakers.forEach((s, i) => {
      ctx.globalAlpha = s.id === who ? 0.16 : 0.06;
      ctx.fillStyle = s.color;
      ctx.fillRect(0, 6 + i * lh + 2, W, lh - 4);
      ctx.globalAlpha = 1;
    });
    // ce qui est déjà enregistré : un trait sous la bande
    for (const p of parts) {
      const x0 = Math.max(0, bar + (p.a - t) * pps), x1 = Math.min(W, bar + (p.b - t) * pps);
      if (x1 <= x0) continue;
      ctx.fillStyle = speaker(p.clip.sp).color;
      ctx.globalAlpha = 0.9; ctx.fillRect(x0, 6 + (row.get(p.clip.sp) ?? 0) * lh + lh - 5, x1 - x0, 3); ctx.globalAlpha = 1;
    }
    // les mots
    ctx.font = `italic 600 ${Math.round(lh * 0.56)}px Georgia, 'Times New Roman', serif`;
    ctx.textBaseline = "middle";
    for (const w of proj.words) {
      const x = bar + (w.s - t) * pps;
      if (x > W + 10) break;
      const width = Math.max((w.e - w.s) * pps, 4);
      if (x + width * 3 < -10) continue;
      const s = speaker(w.sp);
      const y = 6 + (row.get(w.sp) ?? 0) * lh + lh / 2;
      const natural = ctx.measureText(w.w).width || 1;
      const scale = Math.max(0.42, Math.min(width / natural, 3));  // le mot couvre exactement sa durée
      const end = x + natural * scale;
      const dim = focus && w.sp !== who ? 0.35 : 1;
      const drawWord = (fill, alpha) => {
        ctx.save(); ctx.globalAlpha = alpha * dim; ctx.translate(x, y); ctx.scale(scale, 1);
        ctx.fillStyle = fill; ctx.fillText(w.w, 0, 1); ctx.restore();
      };
      drawWord(end < bar ? s.color : "#fff", end < bar ? 0.4 : 0.92);
      if (x < bar && end >= bar) {     // le mot en train d'être dit se colore
        ctx.save(); ctx.beginPath(); ctx.rect(x - 2, 0, bar - x + 2, H); ctx.clip();
        drawWord(s.color, 1); ctx.restore();
      }
    }
    // noms au bord gauche
    ctx.font = "600 11px " + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = "middle";
    proj.speakers.forEach((s, i) => {
      const y = 6 + i * lh + 4;
      const label = s.name.length > 14 ? s.name.slice(0, 13) + "…" : s.name;
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = "rgba(11,12,18,.85)"; roundRect(ctx, 6, y, w, 16, 8); ctx.fill();
      ctx.fillStyle = s.color; ctx.fillText(label, 12, y + 8.5);
    });
    // trait de synchro
    ctx.fillStyle = "#ff3b4f"; ctx.shadowColor = "#ff3b4f"; ctx.shadowBlur = 12;
    ctx.fillRect(bar - 1.5, 3, 3, H - 6); ctx.shadowBlur = 0;

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
    try { await video.play(); } catch { stopAll(); }
  }
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
      const left = Math.ceil((countdownEnd - performance.now()) / 1000);
      if (left > 0) { $("#st-cd").textContent = left; requestAnimationFrame(count); return; }
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
      <div class="line"><span class="t">${fmt(l.s)}</span>
        <select data-i="${i}" style="--c:${speaker(l.sp).color}">${options}</select>
        <input type="text" data-i="${i}" value="${esc(l.words.map((k) => proj.words[k].w).join(" "))}"></div>`).join("") ||
      `<p class="hint">Aucune parole détectée dans cette vidéo.</p>`;
    $("#st-lines").querySelectorAll("select").forEach((el) => {
      el.value = lines[el.dataset.i].sp;
      el.addEventListener("change", () => el.style.setProperty("--c", speaker(Number(el.value)).color));
    });
  }
  $("#st-lines-save").onclick = async () => {
    const words = [];
    lines.forEach((l, i) => {
      const sp = Number($(`#st-lines select[data-i="${i}"]`).value);
      const text = $(`#st-lines input[data-i="${i}"]`).value.trim().split(/\s+/).filter(Boolean);
      const old = l.words.map((k) => proj.words[k]);
      if (text.length === old.length) text.forEach((w, k) => words.push({ ...old[k], w, sp }));
      else {                               // nombre de mots changé : répartis sur la durée de la réplique
        const step = (l.e - l.s) / Math.max(1, text.length);
        text.forEach((w, k) => words.push({ w, s: l.s + k * step, e: l.s + (k + 1) * step - 0.02, sp }));
      }
    });
    proj.words = words;
    await save({ words });
    refresh(); renderLines(); renderPeople();
    D.toast("Texte enregistré");
  };
  $("#st-delete").onclick = async () => {
    if (!confirm(`Supprimer « ${proj.title} », ses prises et ses vidéos ?`)) return;
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
