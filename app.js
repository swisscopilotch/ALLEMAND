/* ==========================================================================
   Flashcards allemand — logique principale
   Stockage : Supabase (tables `cards` et `progress`), via API REST directe
   (PostgREST), sans dependance a la librairie supabase-js.
   ========================================================================== */

const REST = SUPABASE_URL + "/rest/v1";
const HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: "Bearer " + SUPABASE_ANON_KEY,
  "Content-Type": "application/json",
};

const MODES = [
  { id: "reading", label: "Lecture" },
  { id: "listening", label: "Écoute" },
  { id: "speaking", label: "Shadowing" },
  { id: "writing", label: "Écriture" },
];
const THEMES = [
  { id: "vocabulaire", label: "Vocabulaire" },
  { id: "grammaire", label: "Grammaire" },
  { id: "conjugaison", label: "Conjugaison" },
  { id: "decomposition", label: "Décomposition" },
];

let cards = [];
let progress = {}; // card_id -> {ef, interval_days, reps, due_date}
let activeModes = new Set(MODES.map(m => m.id));
let activeThemes = new Set(THEMES.map(t => t.id));
let queue = [];
let idx = 0;
let flip = false;

/* ---------------- Accès ---------------- */
function checkAccess() {
  const saved = sessionStorage.getItem("fc-access");
  if (saved === "ok") { showApp(); return; }
  document.getElementById("enter").onclick = tryEnter;
  document.getElementById("pwd").addEventListener("keydown", e => { if (e.key === "Enter") tryEnter(); });
}
function tryEnter() {
  const val = document.getElementById("pwd").value;
  if (val === ACCESS_PASSWORD) {
    sessionStorage.setItem("fc-access", "ok");
    showApp();
  } else {
    document.getElementById("gateMsg").textContent = "Mot de passe incorrect.";
  }
}
function showApp() {
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("main").classList.remove("hidden");
  init();
}

/* ---------------- Chargement des données ---------------- */
async function fetchCards() {
  const r = await fetch(REST + "/cards?select=*&order=created_at.asc", { headers: HEADERS });
  if (!r.ok) throw new Error("Impossible de charger les cartes (" + r.status + ")");
  return r.json();
}
async function fetchProgress() {
  const r = await fetch(REST + "/progress?select=*", { headers: HEADERS });
  if (!r.ok) throw new Error("Impossible de charger la progression (" + r.status + ")");
  const rows = await r.json();
  const map = {};
  rows.forEach(row => { map[row.card_id] = row; });
  return map;
}
async function saveProgress(cardId, data) {
  const body = {
    card_id: cardId,
    ef: data.ef,
    interval_days: data.interval_days,
    reps: data.reps,
    due_date: data.due_date,
    updated_at: new Date().toISOString(),
  };
  await fetch(REST + "/progress?card_id=eq." + encodeURIComponent(cardId), {
    method: "PATCH",
    headers: { ...HEADERS, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  }).catch(err => console.error("Sauvegarde progression impossible", err));
}
async function insertCards(newCards) {
  const r = await fetch(REST + "/cards", {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(newCards),
  });
  if (!r.ok) throw new Error("Échec de l'import (" + r.status + ")");
  const inserted = await r.json();
  const progRows = inserted.map(c => ({ card_id: c.id }));
  if (progRows.length) {
    await fetch(REST + "/progress", {
      method: "POST",
      headers: { ...HEADERS, Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(progRows),
    });
  }
  return inserted;
}

/* ---------------- Répétition espacée (SM-2 simplifié) ---------------- */
function today() { return new Date().toISOString().slice(0, 10); }
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function schedule(p, q) {
  let ef = p.ef == null ? 2.5 : p.ef;
  let iv = p.interval_days || 0;
  let reps = p.reps || 0;
  if (q === 0) {
    reps = 0; iv = 1; ef = Math.max(1.3, ef - 0.2);
  } else {
    reps += 1;
    if (reps === 1) iv = (q === 3) ? 4 : 1;
    else if (reps === 2) iv = (q === 1) ? 3 : (q === 2) ? 6 : 10;
    else iv = Math.round(iv * (q === 1 ? 1.2 : q === 2 ? ef : ef * 1.3));
    ef = Math.max(1.3, ef + (q === 1 ? -0.15 : q === 3 ? 0.15 : 0));
    iv = Math.min(iv, 365);
  }
  return { ef, interval_days: iv, reps, due_date: addDays(iv) };
}

/* ---------------- Rendu ---------------- */
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : s;
  return d.innerHTML;
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const voices = speechSynthesis.getVoices();
  const de = voices.find(v => v.lang === "de-CH") || voices.find(v => v.lang && v.lang.startsWith("de"));
  if (de) u.voice = de;
  u.lang = "de-DE";
  u.rate = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function buildFilters() {
  const modeBox = document.getElementById("modeChips");
  const themeBox = document.getElementById("themeChips");
  modeBox.innerHTML = MODES.map(m =>
    `<span class="chip ${activeModes.has(m.id) ? "active" : ""}" data-mode="${m.id}">${m.label}</span>`
  ).join("");
  themeBox.innerHTML = THEMES.map(t =>
    `<span class="chip ${activeThemes.has(t.id) ? "active" : ""}" data-theme="${t.id}">${t.label}</span>`
  ).join("");
  modeBox.querySelectorAll(".chip").forEach(el => el.onclick = () => {
    const m = el.getAttribute("data-mode");
    if (activeModes.has(m) && activeModes.size > 1) activeModes.delete(m); else activeModes.add(m);
    rebuildQueue(); buildFilters(); render();
  });
  themeBox.querySelectorAll(".chip").forEach(el => el.onclick = () => {
    const t = el.getAttribute("data-theme");
    if (activeThemes.has(t) && activeThemes.size > 1) activeThemes.delete(t); else activeThemes.add(t);
    rebuildQueue(); buildFilters(); render();
  });
}

function rebuildQueue() {
  const t = today();
  queue = cards
    .filter(c => activeModes.has(c.mode) && activeThemes.has(c.theme))
    .filter(c => { const p = progress[c.id]; return !p || p.due_date <= t; })
    .map(c => c.id);
  idx = 0; flip = false;
}

function currentStats() {
  const visible = cards.filter(c => activeModes.has(c.mode) && activeThemes.has(c.theme));
  const acquises = visible.filter(c => progress[c.id] && progress[c.id].interval_days >= 21).length;
  const enCours = visible.filter(c => progress[c.id] && progress[c.id].interval_days < 21).length;
  return { total: visible.length, acquises, enCours, restant: Math.max(0, queue.length - idx) };
}

function render() {
  const s = currentStats();
  document.getElementById("stats").innerHTML =
    `<b>${s.restant}</b> à revoir · <b>${s.enCours}</b> en cours · <b>${s.acquises}</b> acquises · <b>${s.total}</b> filtrées`;
  document.getElementById("barFill").style.width = queue.length ? (idx / queue.length * 100) + "%" : "0%";

  const zone = document.getElementById("cardZone");
  const card = idx < queue.length ? cards.find(c => c.id === queue[idx]) : null;

  if (!card) {
    zone.innerHTML = `<div class="done">
      <h2>Séance de révision terminée</h2>
      <p>Rien d'autre à revoir aujourd'hui avec ces filtres. Chaque carte revient à son échéance.</p>
      <div class="btns" style="max-width:260px;margin:0 auto">
        <button class="wide" id="all">Réviser quand même</button>
      </div></div>`;
    document.getElementById("all").onclick = () => {
      queue = cards.filter(c => activeModes.has(c.mode) && activeThemes.has(c.theme)).map(c => c.id);
      idx = 0; flip = false; render();
    };
    return;
  }

  const modeLabel = MODES.find(m => m.id === card.mode)?.label || card.mode;
  const themeLabel = THEMES.find(t => t.id === card.theme)?.label || card.theme;
  const meta = `<div class="card-meta"><span>${esc(modeLabel)}</span><span>${esc(themeLabel)}</span></div>`;

  if (card.mode === "writing") {
    zone.innerHTML = `
      <div class="card" style="cursor:default">
        ${meta}
        <div class="back">${esc(card.back)}</div>
        <input type="text" class="writing-input" id="wInput" placeholder="Écris la réponse en allemand" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="writing-feedback" id="wFeedback"></div>
        ${flip ? `<div class="sep"></div><div class="front" style="font-size:20px">${esc(card.front)}</div>${card.phonetic ? `<div class="ph">${esc(card.phonetic)}</div>` : ""}${card.note ? `<div class="note">${esc(card.note)}</div>` : ""}` : ""}
      </div>
      <div class="btns">
        ${!flip
          ? `<button class="wide" id="checkW">Vérifier</button>`
          : `<button class="b1" data-q="0">Encore<span class="lbl">aujourd'hui</span></button>
             <button class="b2" data-q="1">Difficile<span class="lbl">bientôt</span></button>
             <button class="b3" data-q="2">Bien<span class="lbl">plus tard</span></button>
             <button class="b4" data-q="3">Facile<span class="lbl">longtemps</span></button>`}
      </div>`;
    const input = document.getElementById("wInput");
    input.focus();
    const normalize = s => s.trim().toLowerCase().replace(/\s+/g, " ");
    const check = () => {
      const ok = normalize(input.value) === normalize(card.front);
      const fb = document.getElementById("wFeedback");
      fb.textContent = ok ? "Correct." : "Pas tout à fait.";
      fb.className = "writing-feedback " + (ok ? "ok" : "ko");
      flip = true; render();
    };
    if (!flip) {
      document.getElementById("checkW").onclick = check;
      input.addEventListener("keydown", e => { if (e.key === "Enter") check(); });
    } else {
      wireAnswerButtons(card.id);
    }
    return;
  }

  // reading, listening, speaking partagent le meme gabarit visuel
  const showFrontFirst = card.mode !== "listening";
  zone.innerHTML = `
    <div class="card" id="cd">
      ${meta}
      ${showFrontFirst ? `<div class="front">${esc(card.front)}</div>${card.phonetic ? `<div class="ph">${esc(card.phonetic)}</div>` : ""}` : `<div class="front">🔊 ?</div>`}
      <button class="audio-btn" id="playAudio" title="Écouter">🔊</button>
      ${flip ? `<div class="sep"></div><div class="back">${esc(card.back)}</div>${!showFrontFirst ? `<div class="front" style="font-size:20px;margin-top:10px">${esc(card.front)}</div>${card.phonetic ? `<div class="ph">${esc(card.phonetic)}</div>` : ""}` : ""}${card.note ? `<div class="note">${esc(card.note)}</div>` : ""}` : ""}
    </div>
    ${flip
      ? `<div class="btns">
           <button class="b1" data-q="0">Encore<span class="lbl">aujourd'hui</span></button>
           <button class="b2" data-q="1">Difficile<span class="lbl">bientôt</span></button>
           <button class="b3" data-q="2">Bien<span class="lbl">plus tard</span></button>
           <button class="b4" data-q="3">Facile<span class="lbl">longtemps</span></button>
         </div>`
      : `<div class="btns"><button class="wide" id="show">Afficher la réponse</button></div>`}
  `;
  document.getElementById("playAudio").onclick = (e) => { e.stopPropagation(); speak(card.audio_text || card.front); };
  const cd = document.getElementById("cd");
  if (!flip) cd.onclick = () => { flip = true; render(); };
  const showBtn = document.getElementById("show");
  if (showBtn) showBtn.onclick = () => { flip = true; render(); };
  if (flip) wireAnswerButtons(card.id);

  if (card.mode === "speaking" || card.mode === "listening") {
    setTimeout(() => speak(card.audio_text || card.front), 300);
  }
}

function wireAnswerButtons(cardId) {
  document.querySelectorAll("[data-q]").forEach(b => {
    b.onclick = async () => {
      const q = parseInt(b.getAttribute("data-q"), 10);
      const p = schedule(progress[cardId] || {}, q);
      progress[cardId] = p;
      await saveProgress(cardId, p);
      if (q === 0) { queue.splice(idx, 1); queue.push(cardId); }
      else idx++;
      flip = false;
      render();
    };
  });
}

/* ---------------- Import de nouvelles cartes ---------------- */
function wireImportPanel() {
  document.getElementById("tImp").onclick = () => document.getElementById("impBox").classList.toggle("hidden");
  document.getElementById("tReset").onclick = async () => {
    if (!confirm("Effacer toute ta progression et repartir de zéro ?")) return;
    const ids = cards.map(c => c.id);
    for (const id of ids) {
      const p = { ef: 2.5, interval_days: 0, reps: 0, due_date: today() };
      progress[id] = p;
      await saveProgress(id, p);
    }
    rebuildQueue(); render();
  };
  document.getElementById("doImp").onclick = async () => {
    const msg = document.getElementById("impMsg");
    try {
      const add = JSON.parse(document.getElementById("ta").value);
      if (!Array.isArray(add)) throw new Error("un tableau JSON est attendu");
      const inserted = await insertCards(add);
      inserted.forEach(c => { cards.push(c); progress[c.id] = { ef: 2.5, interval_days: 0, reps: 0, due_date: today() }; });
      msg.style.color = "var(--green)";
      msg.textContent = inserted.length + " carte(s) ajoutée(s).";
      document.getElementById("ta").value = "";
      rebuildQueue(); buildFilters(); render();
    } catch (e) {
      msg.style.color = "var(--red)";
      msg.textContent = "Erreur : " + e.message;
    }
  };
}

/* ---------------- Initialisation ---------------- */
async function init() {
  document.getElementById("cardZone").innerHTML = `<div class="done"><p>Chargement…</p></div>`;
  try {
    [cards, progress] = await Promise.all([fetchCards(), fetchProgress()]);
  } catch (e) {
    document.getElementById("cardZone").innerHTML =
      `<div class="done"><h2>Connexion impossible</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  buildFilters();
  rebuildQueue();
  wireImportPanel();
  render();
}

if ("speechSynthesis" in window) { speechSynthesis.onvoiceschanged = () => {}; }
checkAccess();
