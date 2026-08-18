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
const KNOWLEDGE = [
  { id: "new", label: "Nouvelle" },
  { id: "0", label: "Encore" },
  { id: "1", label: "Difficile" },
  { id: "2", label: "Bien" },
  { id: "3", label: "Facile" },
];
const PREF_KEY = "fc-prefs";

let cards = [];
let progress = {}; // card_id -> {ef, interval_days, reps, due_date, last_q}
let activeModes = new Set(MODES.map(m => m.id));
let activeThemes = new Set(THEMES.map(t => t.id));
let activeKnowledge = new Set(KNOWLEDGE.map(k => k.id));
let view = "cards"; // "cards" | "list"
let queue = [];
let history = []; // pile des cartes deja vues cette session, pour le bouton precedent
let idx = 0;
let flip = false;
let revealed = new Set(); // ids reveles en vue liste
let sortMode = "recent"; // "recent" | "old" | "random"
let randKeys = {}; // id -> nombre aleatoire, regenere a chaque passage en tri aleatoire
let colWidths = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem("colWidths") || "null");
    if (raw && typeof raw.q === "number") return raw;
  } catch (e) { /* ignore */ }
  return { q: 34, a: 46, n: 20 }; // pourcentages, somme = 100
})();
function saveColWidths() { localStorage.setItem("colWidths", JSON.stringify(colWidths)); }

/* ---------------- Préférences locales (filtres, vue) ---------------- */
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.modes) activeModes = new Set(p.modes);
    if (p.themes) activeThemes = new Set(p.themes);
    if (p.knowledge) activeKnowledge = new Set(p.knowledge);
    if (p.view) view = p.view;
    if (p.sortMode) sortMode = p.sortMode;
  } catch (e) { /* ignore */ }
}
function savePrefs() {
  localStorage.setItem(PREF_KEY, JSON.stringify({
    modes: [...activeModes], themes: [...activeThemes], knowledge: [...activeKnowledge], view, sortMode,
  }));
}

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
    last_q: data.last_q,
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
  return { ef, interval_days: iv, reps, due_date: addDays(iv), last_q: q };
}

/* ---------------- Utilitaires ---------------- */
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
function knowledgeOf(cardId) {
  const p = progress[cardId];
  if (!p || p.last_q == null) return "new";
  return String(p.last_q);
}
function knowledgeLabel(id) { return KNOWLEDGE.find(k => k.id === id)?.label || id; }
const SORTS = [
  { id: "recent", label: "Récentes" },
  { id: "old", label: "Anciennes" },
  { id: "random", label: "Aléatoire" },
];
function reseedRandom() { randKeys = {}; cards.forEach(c => { randKeys[c.id] = Math.random(); }); }
function addedAt(c) { return c.created_at ? Date.parse(c.created_at) || 0 : 0; }
function applySort(arr) {
  const a = arr.slice();
  if (sortMode === "random") return a.sort((x, y) => (randKeys[x.id] ?? 0) - (randKeys[y.id] ?? 0));
  if (sortMode === "old") return a.sort((x, y) => addedAt(x) - addedAt(y));
  return a.sort((x, y) => addedAt(y) - addedAt(x));
}
function passesFilters(c) {
  return activeModes.has(c.mode) && activeThemes.has(c.theme) && activeKnowledge.has(knowledgeOf(c.id));
}

/* ---------------- Panneaux (stats / réglages) ---------------- */
function togglePanel(which) {
  const stats = document.getElementById("statsPanel");
  const settings = document.getElementById("settingsPanel");
  const statsBtn = document.getElementById("statsBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  if (which === "stats") {
    const open = stats.classList.contains("hidden");
    stats.classList.toggle("hidden", !open ? true : false);
    stats.classList[open ? "remove" : "add"]("hidden");
    settings.classList.add("hidden");
    statsBtn.classList.toggle("active", open);
    settingsBtn.classList.remove("active");
  } else {
    const open = settings.classList.contains("hidden");
    settings.classList[open ? "remove" : "add"]("hidden");
    stats.classList.add("hidden");
    settingsBtn.classList.toggle("active", open);
    statsBtn.classList.remove("active");
  }
}

function renderStatsPanel() {
  const visible = cards.filter(passesFilters);
  const acquises = visible.filter(c => progress[c.id] && progress[c.id].interval_days >= 21).length;
  const enCours = visible.filter(c => progress[c.id] && progress[c.id].interval_days < 21 && progress[c.id].reps > 0).length;
  const nouvelles = visible.filter(c => knowledgeOf(c.id) === "new").length;
  const aRevoir = Math.max(0, queue.length - idx);
  document.getElementById("statsGrid").innerHTML = `
    <div><b>${aRevoir}</b>à revoir</div>
    <div><b>${nouvelles}</b>nouvelles</div>
    <div><b>${enCours}</b>en cours</div>
    <div><b>${acquises}</b>acquises</div>
    <div><b>${visible.length}</b>au total (filtré)</div>
  `;
}

function buildFilters() {
  const modeBox = document.getElementById("modeChips");
  const themeBox = document.getElementById("themeChips");
  const knowBox = document.getElementById("knowChips");
  const viewBox = document.getElementById("viewChips");
  const sortBox = document.getElementById("sortChips");

  sortBox.innerHTML = SORTS.map(s =>
    `<span class="chip ${sortMode === s.id ? "active" : ""}" data-sort="${s.id}">${s.label}</span>`
  ).join("");
  sortBox.querySelectorAll(".chip").forEach(el => el.onclick = () => {
    sortMode = el.getAttribute("data-sort");
    if (sortMode === "random") reseedRandom();
    onFiltersChanged();
  });

  modeBox.innerHTML = MODES.map(m =>
    `<span class="chip tag-mode m-${m.id} ${activeModes.has(m.id) ? "active" : ""}" data-mode="${m.id}">${m.label}</span>`
  ).join("");
  themeBox.innerHTML = THEMES.map(t =>
    `<span class="chip tag-theme t-${t.id} ${activeThemes.has(t.id) ? "active" : ""}" data-theme="${t.id}">${t.label}</span>`
  ).join("");
  knowBox.innerHTML = KNOWLEDGE.map(k =>
    `<span class="chip ${activeKnowledge.has(k.id) ? "active" : ""}" data-know="${k.id}">${k.label}</span>`
  ).join("");
  viewBox.querySelectorAll(".chip").forEach(el => {
    el.classList.toggle("active", el.getAttribute("data-view") === view);
  });

  modeBox.querySelectorAll(".chip").forEach(el => el.onclick = () => {
    const m = el.getAttribute("data-mode");
    if (activeModes.has(m) && activeModes.size > 1) activeModes.delete(m); else activeModes.add(m);
    onFiltersChanged();
  });
  themeBox.querySelectorAll(".chip").forEach(el => el.onclick = () => {
    const t = el.getAttribute("data-theme");
    if (activeThemes.has(t) && activeThemes.size > 1) activeThemes.delete(t); else activeThemes.add(t);
    onFiltersChanged();
  });
  knowBox.querySelectorAll(".chip").forEach(el => el.onclick = () => {
    const k = el.getAttribute("data-know");
    if (activeKnowledge.has(k) && activeKnowledge.size > 1) activeKnowledge.delete(k); else activeKnowledge.add(k);
    onFiltersChanged();
  });
  viewBox.querySelectorAll(".chip").forEach(el => el.onclick = () => {
    view = el.getAttribute("data-view");
    savePrefs();
    buildFilters();
    renderCurrentView();
  });

  document.getElementById("resetFilters").onclick = () => {
    activeModes = new Set(MODES.map(m => m.id));
    activeThemes = new Set(THEMES.map(t => t.id));
    activeKnowledge = new Set(KNOWLEDGE.map(k => k.id));
    onFiltersChanged();
  };
}

function onFiltersChanged() {
  savePrefs();
  rebuildQueue();
  buildFilters();
  renderCurrentView();
}

function syncHeaderHeight() {
  const hd = document.querySelector(".hd");
  if (hd) document.documentElement.style.setProperty("--hd-h", Math.ceil(hd.getBoundingClientRect().height) + "px");
}
window.addEventListener("resize", syncHeaderHeight);

function renderCurrentView() {
  document.getElementById("cardZone").classList.toggle("hidden", view !== "cards");
  document.getElementById("listZone").classList.toggle("hidden", view !== "list");
  document.getElementById("foot").classList.toggle("hidden", view !== "cards");
  document.body.classList.toggle("view-list", view === "list");
  document.body.classList.toggle("view-cards", view === "cards");
  document.querySelector(".bar").classList.toggle("hidden", view !== "cards");
  if (view === "cards") renderCard(); else renderList();
  syncHeaderHeight();
  renderStatsPanel();
}

/* ---------------- File de révision (vue cartes) ---------------- */
function rebuildQueue() {
  const t = today();
  queue = applySort(cards.filter(passesFilters).filter(c => { const p = progress[c.id]; return !p || p.due_date <= t; })).map(c => c.id);
  idx = 0; flip = false; history = [];
}

const LEVEL_BTNS = `
  <button class="b1" data-q="0">Encore<span class="lbl">aujourd'hui</span></button>
  <button class="b2" data-q="1">Difficile<span class="lbl">bientôt</span></button>
  <button class="b3" data-q="2">Bien<span class="lbl">plus tard</span></button>
  <button class="b4" data-q="3">Facile<span class="lbl">longtemps</span></button>`;

/* Pied de page fixe : selecteur de connaissance (toujours visible) + retour / action */
function renderFoot(opts) {
  const levels = document.getElementById("levelBtns");
  const row = document.getElementById("footRow");
  levels.innerHTML = LEVEL_BTNS;
  levels.classList.toggle("muted", !opts.levelsEnabled);
  levels.querySelectorAll("button").forEach(b => { b.disabled = !opts.levelsEnabled; });
  row.innerHTML = `
    <button class="foot-prev" id="prevCard" ${history.length === 0 ? "disabled" : ""} title="Précédente">‹ Précédente</button>
    ${opts.action ? `<button class="wide" id="${opts.action.id}">${opts.action.label}</button>` : ""}`;
  wirePrevButton();
}

function renderCard() {
  document.getElementById("barFill").style.width = queue.length ? (idx / queue.length * 100) + "%" : "0%";
  document.getElementById("counter").innerHTML = queue.length
    ? `<b>${Math.min(idx + 1, queue.length)}</b> / ${queue.length}`
    : "0 / 0";

  const zone = document.getElementById("cardZone");
  const card = idx < queue.length ? cards.find(c => c.id === queue[idx]) : null;

  if (!card) {
    zone.innerHTML = `<div class="done">
      <h2>Séance de révision terminée</h2>
      <p>Rien d'autre à revoir aujourd'hui avec ces filtres. Chaque carte revient à son échéance.</p>
      </div>`;
    renderFoot({ levelsEnabled: false, action: { id: "all", label: "Réviser quand même" } });
    document.getElementById("all").onclick = () => {
      queue = applySort(cards.filter(passesFilters)).map(c => c.id);
      idx = 0; flip = false; history = []; renderCard();
    };
    return;
  }

  const modeLabel = MODES.find(m => m.id === card.mode)?.label || card.mode;
  const themeLabel = THEMES.find(t => t.id === card.theme)?.label || card.theme;
  const meta = `<div class="card-meta"><span class="tag-mode m-${esc(card.mode)}">${esc(modeLabel)}</span><span class="tag-theme t-${esc(card.theme)}">${esc(themeLabel)}</span></div>`;

  if (card.mode === "writing") {
    zone.innerHTML = `
      <div class="card" style="cursor:default">
        ${meta}
        <div class="back">${esc(card.back)}</div>
        <input type="text" class="writing-input" id="wInput" placeholder="Écris la réponse en allemand" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div class="writing-feedback" id="wFeedback"></div>
        ${flip ? `<div class="sep"></div><div class="front" style="font-size:20px">${esc(card.front)}</div>${card.phonetic ? `<div class="ph">${esc(card.phonetic)}</div>` : ""}${card.note ? `<div class="note">${esc(card.note)}</div>` : ""}` : ""}
      </div>`;
    renderFoot({ levelsEnabled: flip, action: flip ? null : { id: "checkW", label: "Vérifier" } });
    const input = document.getElementById("wInput");
    input.focus();
    const normalize = s => s.trim().toLowerCase().replace(/\s+/g, " ");
    const check = () => {
      const ok = normalize(input.value) === normalize(card.front);
      const fb = document.getElementById("wFeedback");
      fb.textContent = ok ? "Correct." : "Pas tout à fait.";
      fb.className = "writing-feedback " + (ok ? "ok" : "ko");
      flip = true; renderCard();
    };
    if (!flip) {
      document.getElementById("checkW").onclick = check;
      input.addEventListener("keydown", e => { if (e.key === "Enter") check(); });
    } else {
      wireAnswerButtons(card.id);
    }
    return;
  }

  const showFrontFirst = card.mode !== "listening";
  zone.innerHTML = `
    <div class="card" id="cd">
      ${meta}
      ${showFrontFirst ? `<div class="front">${esc(card.front)}</div>${card.phonetic ? `<div class="ph">${esc(card.phonetic)}</div>` : ""}` : `<div class="front">🔊 ?</div>`}
      <button class="audio-btn" id="playAudio" title="Écouter">🔊</button>
      ${flip ? `<div class="sep"></div><div class="back">${esc(card.back)}</div>${!showFrontFirst ? `<div class="front" style="font-size:20px;margin-top:10px">${esc(card.front)}</div>${card.phonetic ? `<div class="ph">${esc(card.phonetic)}</div>` : ""}` : ""}${card.note ? `<div class="note">${esc(card.note)}</div>` : ""}` : ""}
    </div>`;
  renderFoot({ levelsEnabled: flip, action: flip ? null : { id: "show", label: "Afficher la réponse" } });
  document.getElementById("playAudio").onclick = (e) => { e.stopPropagation(); speak(card.audio_text || card.front); };
  const cd = document.getElementById("cd");
  if (!flip) cd.onclick = () => { flip = true; renderCard(); };
  const showBtn = document.getElementById("show");
  if (showBtn) showBtn.onclick = () => { flip = true; renderCard(); };
  if (flip) wireAnswerButtons(card.id);

  if (card.mode === "speaking" || card.mode === "listening") {
    setTimeout(() => speak(card.audio_text || card.front), 300);
  }
}

function wirePrevButton() {
  const btn = document.getElementById("prevCard");
  if (!btn) return;
  btn.onclick = () => {
    if (history.length === 0) return;
    idx = history.pop();
    flip = false;
    renderCard();
  };
}

function wireAnswerButtons(cardId) {
  document.querySelectorAll("[data-q]").forEach(b => {
    b.onclick = async () => {
      const q = parseInt(b.getAttribute("data-q"), 10);
      const p = schedule(progress[cardId] || {}, q);
      progress[cardId] = p;
      await saveProgress(cardId, p);
      history.push(idx);
      if (q === 0) { queue.splice(idx, 1); queue.push(cardId); }
      else idx++;
      flip = false;
      renderCard();
      renderStatsPanel();
    };
  });
}

/* ---------------- Vue liste ---------------- */
function renderList() {
  const rows = applySort(cards.filter(passesFilters));
  const zone = document.getElementById("listZone");
  if (!rows.length) {
    zone.innerHTML = `<div class="done"><h2>Aucune carte</h2><p>Aucune carte ne correspond aux filtres actifs.</p></div>`;
    return;
  }
  zone.innerHTML = `
    <table class="list-table">
      <colgroup>
        <col id="colQ" style="width:${colWidths.q}%">
        <col id="colA" style="width:${colWidths.a}%">
        <col id="colN" style="width:${colWidths.n}%">
      </colgroup>
      <thead><tr>
        <th>Question<span class="col-resizer" data-pair="qa"></span></th>
        <th>Réponse<span class="col-resizer" data-pair="an"></span></th>
        <th>Niveau</th>
      </tr></thead>
      <tbody>
        ${rows.map(c => {
          const isOpen = revealed.has(c.id);
          const k = knowledgeOf(c.id);
          return `<tr class="list-row" data-id="${esc(c.id)}">
            <td class="list-q">
              ${esc(c.front)}
              ${c.phonetic ? `<span class="ph-inline">${esc(c.phonetic)}</span>` : ""}
              <button class="list-audio" data-audio="${esc(c.id)}" title="Écouter">🔊</button>
            </td>
            <td class="list-a" data-reveal="${esc(c.id)}">
              ${isOpen
                ? `${esc(c.back)}${c.note ? `<span class="note-inline">${esc(c.note)}</span>` : ""}`
                : `<span class="reveal-hint" title="Toucher pour révéler"></span>`}
            </td>
            <td class="list-level"><span class="badge k-${k}">${esc(knowledgeLabel(k))}</span></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
  zone.querySelectorAll("[data-reveal]").forEach(el => el.onclick = () => {
    const id = el.getAttribute("data-reveal");
    if (revealed.has(id)) revealed.delete(id); else revealed.add(id);
    renderList();
  });
  zone.querySelectorAll("[data-audio]").forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    const id = el.getAttribute("data-audio");
    const c = cards.find(x => x.id === id);
    if (c) speak(c.audio_text || c.front);
  });
  zone.querySelectorAll(".col-resizer").forEach(handle => {
    const start = (clientX) => {
      const pair = handle.getAttribute("data-pair"); // "qa" ou "an"
      const table = zone.querySelector("table");
      const tableW = table.offsetWidth;
      const [kL, kR] = pair === "qa" ? ["q", "a"] : ["a", "n"];
      const startL = colWidths[kL];
      const startR = colWidths[kR];
  const min = 12; // % minimum par colonne
      handle.classList.add("dragging");
      const move = (x) => {
        const deltaPct = (x - clientX) / tableW * 100;
        const d = Math.max(min - startL, Math.min(startR - min, deltaPct));
        colWidths[kL] = Math.round((startL + d) * 10) / 10;
        colWidths[kR] = Math.round((startR - d) * 10) / 10;
        document.getElementById("colQ").style.width = colWidths.q + "%";
        document.getElementById("colA").style.width = colWidths.a + "%";
        document.getElementById("colN").style.width = colWidths.n + "%";
        saveColWidths();
      };
      const onMove = (ev) => move(ev.touches ? ev.touches[0].clientX : ev.clientX);
      const onUp = () => {
        handle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: true });
      document.addEventListener("touchend", onUp);
    };
    handle.onmousedown = (e) => { e.preventDefault(); start(e.clientX); };
    handle.ontouchstart = (e) => start(e.touches[0].clientX);
  });
}

/* ---------------- Import de nouvelles cartes ---------------- */
function wireImportPanel() {
  document.getElementById("tImp").onclick = () => document.getElementById("impBox").classList.toggle("hidden");
  document.getElementById("tReset").onclick = async () => {
    if (!confirm("Effacer toute ta progression et repartir de zéro ?")) return;
    const ids = cards.map(c => c.id);
    for (const id of ids) {
      const p = { ef: 2.5, interval_days: 0, reps: 0, due_date: today(), last_q: null };
      progress[id] = p;
      await saveProgress(id, p);
    }
    onFiltersChanged();
  };
  document.getElementById("doImp").onclick = async () => {
    const msg = document.getElementById("impMsg");
    try {
      const add = JSON.parse(document.getElementById("ta").value);
      if (!Array.isArray(add)) throw new Error("un tableau JSON est attendu");
      const inserted = await insertCards(add);
      inserted.forEach(c => { cards.push(c); progress[c.id] = { ef: 2.5, interval_days: 0, reps: 0, due_date: today(), last_q: null }; });
      msg.style.color = "var(--green)";
      msg.textContent = inserted.length + " carte(s) ajoutée(s).";
      document.getElementById("ta").value = "";
      onFiltersChanged();
    } catch (e) {
      msg.style.color = "var(--red)";
      msg.textContent = "Erreur : " + e.message;
    }
  };
}

/* ---------------- Initialisation ---------------- */
function wireHeader() {
  const btn = document.getElementById("menuBtn");
  const menu = document.getElementById("menu");
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle("hidden");
    btn.classList.toggle("active", !open);
    if (!open) renderStatsPanel();
  };
  document.addEventListener("mousedown", (e) => {
    if (menu.classList.contains("hidden")) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    menu.classList.add("hidden");
    btn.classList.remove("active");
  });
  const more = document.getElementById("moreBtn");  more.onclick = () => {
    const body = document.getElementById("settingsBody");
    const hidden = body.classList.toggle("hidden");
    more.textContent = hidden ? "Voir plus" : "Masquer";
  };
}

async function init() {
  loadPrefs();
  document.getElementById("cardZone").innerHTML = `<div class="done"><p>Chargement…</p></div>`;
  try {
    [cards, progress] = await Promise.all([fetchCards(), fetchProgress()]);
  } catch (e) {
    document.getElementById("cardZone").innerHTML =
      `<div class="done"><h2>Connexion impossible</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  wireHeader();
  buildFilters();
  wireImportPanel();
  rebuildQueue();
  renderCurrentView();
}

if ("speechSynthesis" in window) { speechSynthesis.onvoiceschanged = () => {}; }
checkAccess();
