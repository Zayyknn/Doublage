"use strict";
// Assistant de premier lancement + réglages qui remplacent les commandes (Ollama, voix locales, téléphone).
(function () {
  const D = window.doublage;
  const $ = (s, root = document) => root.querySelector(s);
  let setup = null;
  let timer = null;
  const mounts = new Map(); // élément -> fonction qui le dessine
  let waitingOllama = false;

  async function refresh() {
    try { setup = await D.api("/api/setup"); } catch { return; }
    [...mounts].forEach(([el, fn]) => { if (document.body.contains(el)) fn(el); else mounts.delete(el); });
    const j = setup.jobs;
    const busy = j.ollama.running || j.voices.running || (j.tunnel.running && !j.tunnel.url) || waitingOllama;
    if (busy && !timer) timer = setInterval(refresh, 1500);
    if (!busy && timer) { clearInterval(timer); timer = null; }
    if (j.voices.done && !j.voices.running) {
      try { D.system = await D.api("/api/system"); D.renderEngines(); D.renderSystem(); } catch {}
    }
  }
  function mount(el, fn) { mounts.set(el, fn); if (setup) fn(el); }

  // ------------------------------------------------------------ QR code (chargé à la demande)
  let qrLib = null;
  function qr(el, text) {
    const draw = () => { el.innerHTML = ""; new window.QRCode(el, { text, width: 148, height: 148, correctLevel: window.QRCode.CorrectLevel.M }); };
    if (window.QRCode) return draw();
    qrLib = qrLib || new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = "/qrcode.min.js";
      s.onload = ok; s.onerror = ko; document.head.appendChild(s);
    });
    qrLib.then(draw).catch(() => { el.remove(); });
  }

  // ------------------------------------------------------------ Ollama
  function renderOllama(el) {
    mounts.set(el, renderOllama);
    if (!setup) return;
    const o = setup.ollama, job = setup.jobs.ollama;
    if (o.ready) {
      el.innerHTML = `<div class="sub"><div class="status"><span class="dot ok"></span>Ollama est prêt, la traduction se fera sur ton ordi.</div></div>`;
      return;
    }
    if (!o.running) {
      el.innerHTML = `<div class="sub">
        <p style="margin:0 0 10px">1. Installe Ollama comme n'importe quelle appli, puis ouvre-le.</p>
        <div class="btns"><a class="btn small" href="https://ollama.com/download" target="_blank" rel="noopener">Télécharger Ollama</a>
        <button class="btn small ghost" data-act="check">J'ai installé, vérifier</button></div>
        <div class="status">${waitingOllama ? "<span class='dot warn'></span>En attente d'Ollama…" : "Ollama n'est pas encore détecté."}</div></div>`;
      $("[data-act=check]", el).onclick = () => { waitingOllama = true; refresh(); setTimeout(() => { waitingOllama = false; }, 120000); };
      return;
    }
    waitingOllama = false;
    el.innerHTML = `<div class="sub">
      <p style="margin:0 0 10px">2. Télécharge l'IA de traduction (${setup.ollama_model}, environ 5 Go, une seule fois).</p>
      ${job.running ? `<div class="progress"><div style="width:${job.percent}%"></div></div><div class="status">${job.percent} % · ${job.status || ""}</div>`
        : `<button class="btn small" data-act="pull">Télécharger le modèle</button>`}
      ${job.error ? `<div class="notice bad" style="margin-top:10px">${job.error}</div>` : ""}</div>`;
    const pull = $("[data-act=pull]", el);
    if (pull) pull.onclick = async () => { try { await D.post("/api/ollama/pull"); refresh(); } catch (e) { D.toast(e.message); } };
  }
  window.renderOllama = renderOllama;

  // ------------------------------------------------------------ voix locales
  function renderVoices(el) {
    const job = setup.jobs.voices;
    const installed = D.system.engines && D.system.engines.kokoro_tts;
    if (installed && !job.running) {
      el.innerHTML = `<div class="status"><span class="dot ok"></span>Installées${D.system.engines.chatterbox_tts ? " (Kokoro et Chatterbox)" : " (Kokoro)"}.</div>`;
      return;
    }
    if (job.running) {
      el.innerHTML = `<div class="sub"><div class="status"><span class="dot warn"></span>Installation en cours, tu peux continuer pendant ce temps.</div>
        <div class="log">${job.log.slice(-6).map(esc).join("\n")}</div></div>`;
      return;
    }
    el.innerHTML = `${job.done && !job.ok ? `<div class="notice bad">L'installation a échoué. Edge reste disponible.<div class="log">${job.log.slice(-4).map(esc).join("\n")}</div></div>` : ""}
      <button class="btn small" data-act="voices">Installer les voix locales</button>`;
    $("[data-act=voices]", el).onclick = async () => { try { await D.post("/api/install/voices"); refresh(); } catch (e) { D.toast(e.message); } };
  }

  // ------------------------------------------------------------ téléphone
  function renderPhone(el) {
    const t = setup.jobs.tunnel;
    const lan = setup.lan[0];
    el.innerHTML = `
      ${lan ? `<p style="margin:0;color:var(--muted)">Sur le même Wi-Fi, ouvre cette adresse sur le téléphone :</p>
        <div class="qr" data-qr="lan"></div><div class="url">${lan}</div>` : ""}
      <label class="toggle" style="margin-top:8px"><span>Accès depuis partout<small>4G, travail… via un tunnel Cloudflare gratuit et sécurisé</small></span>
        <span class="switch"><input type="checkbox" data-act="remote" ${setup.remote_access ? "checked" : ""}><i></i></span></label>
      ${setup.remote_access ? (t.url ? `<div class="qr" data-qr="remote"></div><div class="url">${t.url}</div>
          <p class="hint" style="text-align:center;margin-top:4px">L'adresse change à chaque démarrage de Joue ta réplique.</p>`
        : `<div class="status"><span class="dot warn"></span>${t.error ? esc(t.error) : (t.status || "Ouverture…")}</div>`) : ""}
      ${setup.password ? `<div class="sub" style="text-align:center"><small style="color:var(--muted)">Mot de passe à entrer sur le téléphone</small><div class="url" style="font-size:17px">${esc(setup.password)}</div></div>` : ""}
      <p class="hint" style="margin-top:10px">Astuce : sur le téléphone, « Partager → Sur l'écran d'accueil » pour l'avoir comme une appli.</p>`;
    const lq = $("[data-qr=lan]", el); if (lq) qr(lq, lan);
    const rq = $("[data-qr=remote]", el); if (rq) qr(rq, t.url);
    $("[data-act=remote]", el).onchange = async (e) => {
      try { await D.post("/api/tunnel", { enable: e.target.checked }); setup.remote_access = e.target.checked; refresh(); }
      catch (err) { D.toast(err.message); }
    };
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------ assistant
  let step = 0;
  let translation = "google";
  const STEPS = [
    (b) => {
      b.innerHTML = `<h1>Bienvenue 👋</h1>
        <p class="lede">Joue ta réplique traduit et double tes vidéos, depuis ce PC ou ton téléphone. Trois réglages rapides et c'est prêt.</p>
        <div class="choices">
          <div class="choice"><span class="ic">🎬</span><span><b>Une vidéo ou un lien YouTube</b><small>Tu choisis la langue, l'appli fait le reste.</small></span></div>
          <div class="choice"><span class="ic">🎙️</span><span><b>Nouvelle voix + sous-titres</b><small>La musique d'origine est gardée.</small></span></div>
          <div class="choice"><span class="ic">📱</span><span><b>Aussi sur le téléphone</b><small>Lance un doublage depuis ton canapé.</small></span></div>
        </div>`;
    },
    (b) => {
      b.innerHTML = `<h1>La traduction</h1>
        <p class="lede">Pour faire parler la vidéo dans une autre langue, il faut d'abord traduire ce qui est dit.</p>
        <div class="choices">
          <button class="choice" data-tr="google"><span class="ic">⚡</span><span><b>Gratuit, tout de suite</b><small>Google Traduction. Rien à installer. Recommandé pour commencer.</small></span></button>
          <button class="choice" data-tr="ollama"><span class="ic">🧠</span><span><b>Gratuit, plus naturel</b><small>Une IA sur ton ordi (Ollama). Une installation, puis hors ligne.</small></span></button>
          <button class="choice" data-tr="api"><span class="ic">🔑</span><span><b>J'ai une clé API</b><small>DeepSeek, Mistral, OpenAI… à régler ensuite dans Réglages.</small></span></button>
        </div><div id="wiz-ollama"></div>`;
      const sync = () => {
        b.querySelectorAll("[data-tr]").forEach((c) => c.classList.toggle("on", c.dataset.tr === translation));
        const box = $("#wiz-ollama", b);
        box.innerHTML = "";
        if (translation === "ollama") renderOllama(box);
      };
      b.querySelectorAll("[data-tr]").forEach((c) => (c.onclick = () => { translation = c.dataset.tr; sync(); }));
      sync();
    },
    (b) => {
      b.innerHTML = `<h1>Les voix</h1>
        <p class="lede">Les voix <b>Edge</b> sont prêtes : naturelles, rapides, gratuites.</p>
        <div class="choices"><div class="choice"><span class="ic">✨</span><span><b>Option : voix locales</b>
          <small>Kokoro, hors ligne, et Chatterbox, qui garde la voix d'origine de la personne. Environ 4 Go, ça s'installe en arrière-plan.</small></span></div></div>
        <div id="wiz-voices" style="margin-top:12px"></div>`;
      mount($("#wiz-voices", b), renderVoices);
    },
    (b) => {
      b.innerHTML = `<h1>Sur ton téléphone</h1><p class="lede">Optionnel : tu peux aussi le faire plus tard dans Réglages.</p><div id="wiz-phone"></div>`;
      mount($("#wiz-phone", b), renderPhone);
    },
    (b) => {
      b.innerHTML = `<div class="big-check">✅</div><h1 style="text-align:center">C'est prêt</h1>
        <p class="lede" style="text-align:center">Choisis une vidéo, une langue, et lance le doublage.<br>Tout se retrouve dans Réglages si tu veux changer.</p>`;
    },
  ];

  async function leave(from) {
    if (from === 1 && translation !== "api") {
      try { D.settings = await D.post("/api/setup/translation", { engine: translation }); } catch (e) { D.toast(e.message); }
    }
    if (from === 1 && translation === "api") {
      try { D.settings = await D.post("/api/setup/translation", { engine: "api" }); } catch {}
    }
  }

  function draw() {
    $("#wiz-dots").innerHTML = STEPS.map((_, i) => `<i class="${i <= step ? "on" : ""}"></i>`).join("");
    STEPS[step]($("#wiz-body"));
    $("#wiz-back").classList.toggle("hidden", step === 0 || step === STEPS.length - 1);
    $("#wiz-next").textContent = step === 0 ? "C'est parti" : step === STEPS.length - 1 ? "Commencer" : "Continuer";
  }

  $("#wiz-next").onclick = async () => {
    await leave(step);
    if (step < STEPS.length - 1) { step++; draw(); return; }
    await D.post("/api/setup/finish");
    $("#wizard").classList.add("hidden");
    D.system = await D.api("/api/system");
    D.renderSettings(); D.renderSystem(); D.renderEngines();
    if (translation === "api") document.querySelector('[data-view="v-settings"]').click();
  };
  $("#wiz-back").onclick = () => { if (step > 0) { step--; draw(); } };

  window.openWizard = () => {
    step = 0;
    translation = (D.settings.translation_engine === "google") ? "google" : (setup && setup.ollama.ready ? "ollama" : "google");
    $("#wizard").classList.remove("hidden");
    draw();
  };

  window.initSetup = async () => {
    await refresh();
    mount($("#phone-box"), renderPhone);
    mount($("#voices-box"), renderVoices);
    if (setup && !setup.done) window.openWizard();
  };
})();
