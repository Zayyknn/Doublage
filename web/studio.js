"use strict";
// Studio : ta voix à la place de celle d'origine, avec une bande rythmo comme dans les studios de doublage.
(function () {
  const D = window.doublage;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (t) => { t = Math.max(0, t || 0); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`; };
  const STEPS = { "Prepare input": "Préparation de la vidéo", "Studio: separation": "Séparation voix / ambiance et repérage des mots", "Studio: build": "Création de la scène" };

  let file = null;
  let proj = null;            // projet ouvert
  let mode = "idle";          // idle | play | countdown | record | listen
  let countdownEnd = 0;
  let stream = null, recorder = null, chunks = [], recStart = 0, playStart = 0;
  let take = null;            // { url, trimMs }
  let poller = null;
  const video = $("#st-video");
  const band = $("#st-band");
  const takeAudio = new Audio();
  const fileUrl = (name) => `/api/studio/${encodeURIComponent(proj.id)}/file/${encodeURIComponent(name)}`;

  // ------------------------------------------------------------ accueil : nouvelle scène + liste
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
    if (!file) return D.toast("Choisis d'abord un extrait vidéo");
    $("#st-go").disabled = true;
    $("#st-new").classList.add("hidden");
    $("#st-run").classList.remove("hidden");
    $("#st-run-error").classList.add("hidden");
    try {
      const up = await D.upload(file, (p) => {
        $("#st-run-step").textContent = `Envoi… ${D.fmtSize(file.size * p)} / ${D.fmtSize(file.size)}`;
        $("#st-run-pct").textContent = Math.round(p * 100) + " %";
        $("#st-bar").style.width = p * 100 + "%";
      });
      await D.post("/api/studio", { source: up.path, source_language: $("#st-lang").value });
      watch();
    } catch (err) {
      runError(err.message);
    } finally {
      $("#st-go").disabled = false;
    }
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
      if (s.total_steps !== 3) return;
      const i = Math.max(0, s.step_index);
      const pct = s.state === "completed" ? 100 : Math.round(((i + 0.4) / 3) * 100);
      $("#st-run-step").textContent = STEPS[s.step] || "Préparation…";
      $("#st-run-pct").textContent = pct + " %";
      $("#st-bar").style.width = pct + "%";
      if (s.state === "completed") {
        clearInterval(poller);
        $("#st-run").classList.add("hidden");
        $("#st-new").classList.remove("hidden");
        file = null; $("#st-drop").classList.remove("filled");
        $("#st-drop-title").textContent = "Choisir un extrait vidéo";
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
        <div class="meta"><b>${esc(p.title)}</b><small>${fmt(p.duration)} · ${p.finals.length ? p.finals.length + " vidéo" + (p.finals.length > 1 ? "s" : "") : "pas encore doublée"}</small></div>
        <button class="btn small" data-open="${i}">Ouvrir</button>
      </div>`).join("");
    $("#st-projects").querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => open(list[b.dataset.open].id)));
    return list;
  }

  // ------------------------------------------------------------ éditeur
  async function open(id) {
    try { proj = await D.api(`/api/studio/${encodeURIComponent(id)}`); } catch (e) { return D.toast(e.message); }
    $("#st-home").classList.add("hidden");
    $("#st-editor").classList.remove("hidden");
    $("#st-title").textContent = proj.title;
    setSource("ambiance.mp4");
    take = proj.take ? { url: fileUrl(proj.take) + `?v=${Date.now()}`, trimMs: proj.take_trim || 0 } : null;
    $("#st-take").classList.toggle("hidden", !take);
    $("#st-offset").value = 0; $("#st-offset-val").textContent = "0 ms";
    renderFinals();
    renderWords();
    const secure = window.isSecureContext && navigator.mediaDevices && window.MediaRecorder;
    $("#st-mic-warn").classList.toggle("hidden", !!secure);
    $("#st-mic-warn").innerHTML = secure ? "" : "Le micro du navigateur demande une adresse sécurisée (https). Sur le téléphone, ouvre Doublage avec l'adresse « Accès depuis partout » (Réglages → Téléphone).";
    window.scrollTo({ top: 0 });
    resize();
  }

  $("#st-back").onclick = () => { stopAll(); $("#st-editor").classList.add("hidden"); $("#st-home").classList.remove("hidden"); loadProjects(); };

  function setSource(name) {
    const t = video.currentTime || 0;
    if (!video.src.endsWith(fileUrl(name))) {
      video.src = fileUrl(name);
      video.addEventListener("loadedmetadata", () => { video.currentTime = Math.min(t, video.duration || t); }, { once: true });
    }
  }

  // ------------------------------------------------------------ bande rythmo
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = window.devicePixelRatio || 1;
    W = band.clientWidth; H = band.clientHeight;
    band.width = W * DPR; band.height = H * DPR;
  }
  window.addEventListener("resize", resize);

  function clock() {
    if (mode === "countdown") return Math.min(0, (performance.now() - countdownEnd) / 1000); // de -3 s à 0
    return video.currentTime || 0;
  }

  function draw() {
    requestAnimationFrame(draw);
    if (!proj || $("#st-editor").classList.contains("hidden")) return;
    if (!W) resize();
    const ctx = band.getContext("2d");
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const t = clock();
    const pps = W < 600 ? 190 : 240;            // pixels par seconde
    const bar = Math.round(W * 0.22);
    // couloir de la bande
    ctx.fillStyle = "rgba(255,255,255,.035)";
    ctx.fillRect(0, H / 2 - 26, W, 52);
    ctx.font = `italic 600 ${W < 600 ? 26 : 30}px Georgia, 'Times New Roman', serif`;
    ctx.textBaseline = "middle";
    for (const w of proj.words) {
      const x = bar + (w.s - t) * pps;
      const width = Math.max((w.e - w.s) * pps, 4);
      if (x > W + 20 || x + Math.max(width, 200) < -20) continue;
      const natural = ctx.measureText(w.w).width;
      // comme sur une vraie bande rythmo : le mot s'étire ou se resserre pour couvrir exactement sa durée
      const scale = Math.max(0.42, Math.min(width / natural, 3));
      const drawWord = (color) => {
        ctx.save(); ctx.translate(x, H / 2); ctx.scale(scale, 1);
        ctx.fillStyle = color; ctx.fillText(w.w, 0, 1); ctx.restore();
      };
      drawWord(x + natural * scale < bar ? "rgba(255,255,255,.28)" : "rgba(255,255,255,.92)");
      if (x < bar) { // la partie déjà passée sous le trait se colore
        ctx.save(); ctx.beginPath(); ctx.rect(x - 2, 0, bar - x + 2, H); ctx.clip();
        const g = ctx.createLinearGradient(x, 0, x + natural * scale, 0);
        g.addColorStop(0, "#b4a9ff"); g.addColorStop(1, "#4fd6ff");
        drawWord(x + natural * scale < bar ? "rgba(180,169,255,.45)" : g);
        ctx.restore();
      }
    }
    // trait de synchro
    ctx.fillStyle = "#ff3b4f";
    ctx.shadowColor = "#ff3b4f"; ctx.shadowBlur = 12;
    ctx.fillRect(bar - 1.5, 6, 3, H - 12);
    ctx.shadowBlur = 0;
    // temps
    $("#st-time").textContent = fmt(t);
    $("#st-dur").textContent = fmt(video.duration);
    if (video.duration && document.activeElement !== $("#st-seek")) $("#st-seek").value = Math.round((Math.max(t, 0) / video.duration) * 1000);
  }
  requestAnimationFrame(draw);

  $("#st-seek").addEventListener("input", (e) => {
    if (mode === "record" || mode === "countdown") return;
    if (video.duration) video.currentTime = (e.target.value / 1000) * video.duration;
  });

  // ------------------------------------------------------------ lecture
  function stopAll() {
    video.pause(); takeAudio.pause();
    if (recorder && recorder.state !== "inactive") recorder.stop();
    $("#st-count").classList.add("hidden");
    $("#st-rec").classList.add("hidden");
    mode = "idle";
    buttons();
  }
  function buttons() {
    const busy = mode !== "idle";
    $("#st-stop").classList.toggle("hidden", !busy);
    ["#st-orig", "#st-play", "#st-record"].forEach((s) => $(s).classList.toggle("hidden", busy));
  }
  async function play(name) {
    stopAll();
    setSource(name);
    if (video.ended || (video.duration && video.currentTime >= video.duration - 0.1)) video.currentTime = 0;
    video.muted = false;
    mode = "play"; buttons();
    try { await video.play(); } catch { stopAll(); }
  }
  $("#st-orig").onclick = () => play("original.mp4");
  $("#st-play").onclick = () => play("ambiance.mp4");
  $("#st-stop").onclick = () => stopAll();
  video.addEventListener("ended", () => { if (mode === "record") finishRecording(); else stopAll(); });

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
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      return D.toast("Micro inaccessible : autorise-le dans le navigateur.", 5000);
    }
    setSource("ambiance.mp4");
    video.pause(); video.currentTime = 0; video.muted = false;
    chunks = [];
    const type = mimeType();
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = saveTake;
    recorder.onstart = () => { recStart = performance.now(); };
    recorder.start(250);
    // décompte de 3 secondes : la bande défile déjà, la vidéo démarre à zéro
    mode = "countdown"; buttons();
    countdownEnd = performance.now() + 3000;
    $("#st-count").classList.remove("hidden");
    const count = () => {
      if (mode !== "countdown") return;
      const left = Math.ceil((countdownEnd - performance.now()) / 1000);
      if (left > 0) { $("#st-count").textContent = left; requestAnimationFrame(count); return; }
      $("#st-count").classList.add("hidden");
      $("#st-rec").classList.remove("hidden");
      mode = "record";
      video.addEventListener("playing", () => { playStart = performance.now(); }, { once: true });
      video.play();
    };
    count();
  };

  function finishRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    video.pause();
    $("#st-rec").classList.add("hidden");
    mode = "idle"; buttons();
  }
  $("#st-stop").addEventListener("click", () => { if (recorder && recorder.state !== "inactive") recorder.stop(); });

  async function saveTake() {
    if (!chunks.length || !playStart) { playStart = 0; return; }
    const type = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunks, { type });
    const trimMs = Math.max(0, Math.round(playStart - recStart));
    playStart = 0;
    const ext = type.includes("mp4") ? "mp4" : type.includes("ogg") ? "ogg" : "webm";
    take = { url: URL.createObjectURL(blob), trimMs };
    $("#st-take").classList.remove("hidden");
    $("#st-take").scrollIntoView({ behavior: "smooth", block: "center" });
    try {
      await fetch(`/api/studio/${encodeURIComponent(proj.id)}/take?ext=${ext}&trim_ms=${trimMs}`, { method: "POST", body: blob })
        .then(async (r) => { if (!r.ok) throw new Error((await r.json()).detail); });
      D.toast("Prise enregistrée");
    } catch (e) { D.toast("La prise n'a pas pu être envoyée : " + e.message, 5000); }
  }

  // ------------------------------------------------------------ réécoute et calage
  const offset = () => Number($("#st-offset").value);
  $("#st-offset").addEventListener("input", () => {
    $("#st-offset-val").textContent = `${offset() > 0 ? "+" : ""}${offset()} ms`;
    if (mode === "listen") syncTake(true);
  });
  $("#st-vgain").addEventListener("input", () => { takeAudio.volume = Math.min(1, Number($("#st-vgain").value) / 2.5 + 0.4); });
  $("#st-again").addEventListener("input", () => { video.volume = Math.min(1, Number($("#st-again").value)); });

  function syncTake(force) {
    // l'enregistrement commence avant l'image (décompte) : on décale d'autant
    const target = video.currentTime + (take.trimMs - offset()) / 1000;
    if (force || Math.abs(takeAudio.currentTime - target) > 0.12) takeAudio.currentTime = Math.max(0, target);
  }
  $("#st-listen").onclick = async () => {
    if (!take) return;
    stopAll();
    setSource("ambiance.mp4");
    video.currentTime = 0;
    takeAudio.src = take.url;
    mode = "listen"; buttons();
    await new Promise((r) => (takeAudio.readyState >= 1 ? r() : takeAudio.addEventListener("loadedmetadata", r, { once: true })));
    syncTake(true);
    await Promise.all([video.play(), takeAudio.play()]).catch(() => stopAll());
  };
  video.addEventListener("timeupdate", () => { if (mode === "listen" && take) syncTake(false); });
  $("#st-redo").onclick = () => $("#st-record").click();

  $("#st-render").onclick = async () => {
    const btn = $("#st-render");
    btn.disabled = true; btn.textContent = "Montage en cours…";
    stopAll();
    try {
      // Côté serveur : trim positif = couper le début de la prise ; le curseur avance ou retarde la voix
      const r = await D.post(`/api/studio/${encodeURIComponent(proj.id)}/render`, {
        trim_ms: take.trimMs - offset(), voice_gain: Number($("#st-vgain").value), ambience_gain: Number($("#st-again").value),
      });
      proj.finals.unshift(r.final);
      renderFinals(r.final);
      $("#st-finals").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) { D.toast(e.message, 5000); }
    btn.disabled = false; btn.textContent = "Créer la vidéo";
  };

  function renderFinals(select) {
    $("#st-finals").classList.toggle("hidden", !proj.finals.length);
    if (!proj.finals.length) return;
    const current = select || proj.finals[0];
    $("#st-final-player").src = fileUrl(current);
    $("#st-final-list").innerHTML = proj.finals.map((f, i) =>
      `<a class="btn small" href="${fileUrl(f)}" download>⬇ ${i === 0 ? "Dernière version" : "Version " + (proj.finals.length - i)}</a>`).join("");
  }

  // ------------------------------------------------------------ texte de la bande
  function renderWords() {
    $("#st-words").innerHTML = proj.words.map((w, i) => `<input type="text" value="${esc(w.w)}" data-i="${i}">`).join("") ||
      `<p class="hint">Aucune parole détectée dans cette scène.</p>`;
  }
  $("#st-words-save").onclick = async () => {
    document.querySelectorAll("#st-words input").forEach((el) => { proj.words[el.dataset.i].w = el.value.trim(); });
    proj.words = proj.words.filter((w) => w.w);
    try {
      await D.api(`/api/studio/${encodeURIComponent(proj.id)}/words`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(proj.words) });
      renderWords(); D.toast("Texte enregistré");
    } catch (e) { D.toast(e.message); }
  };
  $("#st-delete").onclick = async () => {
    if (!confirm(`Supprimer la scène « ${proj.title} » et ses vidéos ?`)) return;
    await D.api(`/api/studio/${encodeURIComponent(proj.id)}`, { method: "DELETE" });
    $("#st-back").click();
  };

  // ------------------------------------------------------------ démarrage
  document.querySelector('[data-view="v-studio"]').addEventListener("click", () => { loadProjects(); setTimeout(resize, 50); });
  (async () => {
    try {
      const s = await D.api("/api/status");
      if (s.total_steps === 3 && ["running", "paused", "stopping"].includes(s.state)) {
        $("#st-new").classList.add("hidden"); $("#st-run").classList.remove("hidden"); watch();
      }
    } catch {}
  })();
})();
