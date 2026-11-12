/* Top counters on a boss's collection page (collections/<slug>.html).
 *
 * Above the battle parties: the Pokemon this boss's archived runs use, in a row per role (Main DPS,
 * Support DPS, Executor, Catch tank) - a Pokemon that played several roles is in each of those
 * rows. Tapping one opens a small pop-out table beside it: its movesets, the roles each was used in,
 * and how many runs. Where the archive has only a few attackers (fewer than 6) or catch tanks (fewer
 * than 4), hand-written suggestions from data/suggested-counters.json fill in, marked as suggested.
 *
 * The page's own script calls BossCounters.mount({ boss, slug, rows }) once its runs are loaded.
 * This file lives outside the collection template, so a change here reaches every boss page
 * without regenerating them.
 */
(function(){
  const ROLES = [
    { k: "main", re: /main dps/i,     full: "Main DPS",    short: "Main" },
    { k: "sup",  re: /support dps/i,  full: "Support DPS", short: "Support" },
    { k: "ct",   re: /catch\s*tank/i, full: "Catch Tank",  short: "CT" },   // (as the Difficulty & Roles page writes it)
    { k: "exec", re: /executor/i,     full: "Executor",    short: "Exec" },
  ];
  const MIN = { att: 6, ct: 4 };   // fewer than this from the archive: suggestions fill in
  const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const key = n => String(n || "").trim().toLowerCase();
  // the archive's typing varies ("Dragon tail", "Dynamic Punch++++"): each word capitalised, stray +s off
  const tidyMove = m => String(m || "").trim().replace(/\+{2,}$/, "").replace(/(^|[\s-])([a-z])/g, (x, a, c) => a + c.toUpperCase());
  const tidyMoves = cell => String(cell || "").split(",").map(tidyMove).filter(Boolean).join(", ");
  let suggestions = null, BOSS = "";

  async function loadSuggestions(){
    if(suggestions) return suggestions;
    try{ const res = await fetch("/data/suggested-counters.json", { cache: "no-cache" }); suggestions = res.ok ? await res.json() : {}; }
    catch(e){ suggestions = {}; }
    return suggestions;
  }

  // every Pokemon in this boss's runs: the runs it was in per role, and each moveset with the roles it was used in
  function tally(rows){
    const m = new Map();
    rows.forEach((r, i) => (r.slots || []).forEach(s => {
      if(!s.n) return;
      const roles = ROLES.filter(R => R.re.test(s.roles || "")); if(!roles.length) return;
      const k = key(s.n), e = m.get(k) || { name: s.n, runs: new Set(), byRole: {}, sets: new Map(), entries: new Map() };
      e.runs.add(i);
      const en = e.entries.get(i) || { row: r, roles: new Set(), fm: tidyMove(s.fm), cm: tidyMoves(s.cm), star: parseFloat(String(r.star || "").replace(/[^0-9.]/g, "")) || null, weather: String(r.weather || "").trim() };
      roles.forEach(R => en.roles.add(R.k)); e.entries.set(i, en);
      roles.forEach(R => { (e.byRole[R.k] = e.byRole[R.k] || new Set()).add(i); });
      const sk = [tidyMove(s.fm), tidyMoves(s.cm)].join("|");
      const st = e.sets.get(sk) || { fm: tidyMove(s.fm), cm: tidyMoves(s.cm), runs: new Set(), roles: new Set() };
      st.runs.add(i); roles.forEach(R => st.roles.add(R.k)); e.sets.set(sk, st);
      m.set(k, e);
    }));
    return [...m.values()].map(e => ({ name: e.name, runs: e.runs.size, byRole: Object.fromEntries(Object.entries(e.byRole).map(([k, v]) => [k, v.size])),
      entries: [...e.entries.values()].map(en => ({ row: en.row, roles: [...en.roles], fm: en.fm, cm: en.cm, star: en.star, weather: en.weather })),
      sets: [...e.sets.values()].map(st => ({ fm: st.fm, cm: st.cm, n: st.runs.size, roles: [...st.roles] })).sort((a, b) => b.n - a.n) }));
  }

  // suggestions fill in where the archive has too few attackers / catch tanks
  function addSuggestions(list, mine){
    const have = new Set(list.map(e => key(e.name)));
    const attN = list.filter(e => e.byRole.main || e.byRole.sup || e.byRole.exec).length, ctN = list.filter(e => e.byRole.ct).length;
    const roleOf = r => ({ support: "sup", sup: "sup", "support dps": "sup", exec: "exec", executor: "exec" })[key(r)] || "main";
    const take = (arr, need, ct) => (Array.isArray(arr) ? arr : []).filter(s => s && s.name && !have.has(key(s.name)))
      .slice(0, mine.always ? undefined : Math.max(0, need))
      .map(s => { have.add(key(s.name)); const rk = ct ? "ct" : roleOf(s.role);
        return { name: s.name, runs: 0, suggested: true, note: s.note || "", weather: s.weather || "", byRole: { [rk]: 0 },
                 sets: (s.fm || s.cm) ? [{ fm: tidyMove(s.fm), cm: tidyMoves(s.cm), n: 0, roles: [rk] }] : [] }; });
    return list.concat(take(mine.counters, MIN.att - attN, false), take(mine.catchTanks, MIN.ct - ctN, true));
  }

  // In a role: its lowest star rating (a lower-rated run is an easier raid - a stronger counter), and the
  // weather it needs - when every run in that role had one weather, and it boosts one of its moves
  const BOOSTS = { sunny: ["fire", "grass", "ground"], clear: ["fire", "grass", "ground"], rainy: ["water", "electric", "bug"], "partly cloudy": ["normal", "rock"],
    cloudy: ["fairy", "fighting", "poison"], windy: ["dragon", "flying", "psychic"], snow: ["ice", "steel"], fog: ["dark", "ghost"] };
  const inRole = (e, k) => (e.entries || []).filter(en => en.roles.includes(k));
  const lowestStar = (e, k) => { const st = inRole(e, k).map(en => en.star).filter(x => x != null); return st.length ? Math.min(...st) : null; };
  const typesOf = en => new Set([en.fm].concat(String(en.cm || "").split(",")).map(m => typeof MOVE_TYPES !== "undefined" ? MOVE_TYPES[String(m).trim().toLowerCase()] : null).filter(Boolean).map(t => t.toLowerCase()));
  const boosted = en => { const b = BOOSTS[en.weather.toLowerCase()]; if(!b) return false; const t = typesOf(en); return b.some(x => t.has(x)); };
  // Attackers: Extreme when any run was in Extreme weather or a weather boosting none of its moves (it
  // can fight without a boost); otherwise the boosting weather its runs used (the most used, if several).
  // Catch tanks: an icon only when every run had one weather, and it boosts one of its moves.
  const neededWeather = (e, k) => {
    const ens = inRole(e, k).filter(en => en.weather); if(!ens.length) return "";
    if(k !== "ct"){
      if(ens.some(en => !boosted(en))) return "Extreme";
      const n = new Map(); ens.forEach(en => n.set(en.weather, (n.get(en.weather) || 0) + 1));
      return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    const w = [...new Set(ens.map(en => en.weather.toLowerCase()))];
    return w.length === 1 && ens.every(boosted) ? ens[0].weather : "";
  };
  const moveIcon = n => {
    const t = typeof MOVE_TYPES !== "undefined" ? MOVE_TYPES[String(n || "").trim().toLowerCase()] : null; if(!t) return '<span class="bc-mi"></span>';
    const bg = typeof TYPE_COLORS !== "undefined" ? (TYPE_COLORS[t.toLowerCase()] || "#9199A1") : "#9199A1";
    const src = typeof TYPE_ICON_BASE !== "undefined" ? TYPE_ICON_BASE + t.toLowerCase() + ".svg" : "";
    return `<span class="bc-mi" style="background:${bg}" title="${esc(t)}">${src ? `<img src="${esc(src)}" alt="" onerror="this.remove()">` : ""}</span>`; };
  const chip = n => /^any$/i.test(String(n || "").trim()) || !n ? "" : `<span class="bc-mvt">${moveIcon(n)}${esc(n)}</span>`;
  const movesHtml = (fm, cm) => { const cms = typeof splitMoves === "function" ? splitMoves(cm) : String(cm || "").split(",").map(x => x.trim()).filter(Boolean);
    return (fm ? [fm] : []).concat(cms).map(chip).join(""); };
  const sprite = n => typeof spriteUrl === "function" ? spriteUrl(n) : "";
  const mist = n => typeof needsShadowMist === "function" && needsShadowMist(n) ? " shadow-mist" : "";
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  function monHtml(e, i, rk){
    const n = e.byRole[rk] || 0, wx = e.suggested ? (e.weather || "") : neededWeather(e, rk);
    const wIcon = wx && typeof WEATHER_ICON_URLS !== "undefined" ? WEATHER_ICON_URLS[wx.toLowerCase()] : "";
    const tip = `${e.name}${e.suggested ? " (suggested)" : ` - ${plural(n, "run")} as ${ROLES.find(R => R.k === rk).full}`}${wx ? (/^extreme$/i.test(wx) ? " - fights in Extreme weather" : ` - needs ${wx}`) : ""}`;
    return `<button type="button" class="bc-mon${e.suggested ? " is-sug" : ""}" data-i="${i}" title="${esc(tip)}">
      <span class="bc-spw"><img class="bc-sp${mist(e.name)}" src="${esc(sprite(e.name))}" alt="${esc(e.name)}" loading="lazy" onerror="this.style.visibility='hidden'">${wIcon ? `<img class="bc-wx" src="${esc(wIcon)}" alt="${esc(wx)}" title="Needs ${esc(wx)}" onerror="this.remove()">` : ""}</span>
</button>`;
  }

  // Its entries, in a window over the page - the same look as the Top Catch Tanks page's tables: a
  // row per run it was in against this boss (role, its moveset, the boss's, difficulty, weather, VOD)
  function closeModal(){ document.querySelectorAll(".bc-overlay").forEach(x => x.remove()); document.body.style.overflow = ""; document.querySelectorAll(".bc-mon.on").forEach(b => b.classList.remove("on")); }
  function openModal(btn, e){
    closeModal(); btn.classList.add("on");
    const roleTag = k => { const R = ROLES.find(x => x.k === k); return `<i class="bc-r bc-r-${k}">${R ? R.full : k}</i>`; };
    const weather = w => !w ? '<span class="bc-dim">&mdash;</span>' : (typeof weatherHtml === "function" ? weatherHtml(w) : esc(w));
    // the run's video: its Link, as the battle party cards use it
    const vod = r => r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">&#9654; Watch</a>` : '<span class="bc-dim">&mdash;</span>';
    const stars = v => !v ? "&mdash;" : /\u2b50|\u2605/.test(v) ? esc(v) : esc(v) + " &#11088;";   // the archive's value may carry its star already
    const bossSet = r => [tidyMove(r.fm), tidyMoves(r.cm)].filter(Boolean).join(" / ") || "&mdash;";
    // the run's Adventure Effect, as its battle party card shows it (Blade Boost / Behemoth Bash / Dynamic Punch+)
    const effect = r => (r.ae && typeof aeIconHtml === "function" ? aeIconHtml(r.ae).trim() : "") || '<span class="bc-dim">&mdash;</span>';
    const sub = e.suggested ? "Suggested &middot; not in this boss's runs yet"
      : `${plural(e.runs, "run")} vs ${esc(BOSS)} &middot; ${ROLES.filter(R => e.byRole[R.k]).map(R => `${R.full} &times;${e.byRole[R.k]}`).join(" &middot; ")}`;
    const body = e.suggested
      ? `<thead><tr><th>Role</th><th>Moveset</th><th>Note</th></tr></thead><tbody><tr><td>${Object.keys(e.byRole).map(roleTag).join(" ")}</td><td><span class="bc-t-mv">${e.sets[0] ? movesHtml(e.sets[0].fm, e.sets[0].cm) : "&mdash;"}</span></td><td>${esc(e.note) || '<span class="bc-dim">&mdash;</span>'}</td></tr></tbody>`
      : `<thead><tr><th>Role</th><th>Moveset</th><th>Boss moveset</th><th class="c">Difficulty</th><th class="c">Weather</th><th class="c">Effect</th><th>VOD</th></tr></thead><tbody>${e.entries.map(en =>
          `<tr><td>${en.roles.map(roleTag).join(" ")}</td><td><span class="bc-t-mv">${movesHtml(en.fm, en.cm) || "&mdash;"}</span></td><td>${bossSet(en.row)}</td><td class="c">${stars(en.row.star)}</td><td class="c">${weather(en.row.weather)}</td><td class="c">${effect(en.row)}</td><td>${vod(en.row)}</td></tr>`).join("")}</tbody>`;
    const ov = document.createElement("div"); ov.className = "bc-overlay";
    ov.innerHTML = `<div class="bc-modal" role="dialog" aria-modal="true" aria-label="${esc(e.name)}">
      <div class="bc-m-head"><div class="bc-m-title"><span class="bc-m-icon"><img class="${mist(e.name).trim()}" src="${esc(sprite(e.name))}" alt="" onerror="this.style.visibility='hidden'"></span>
        <div><h3>${esc(e.name)}</h3><div class="bc-m-sub">${sub}</div></div></div><button type="button" class="bc-m-close" aria-label="Close">&times;</button></div>
      <div class="bc-m-scroll"><table class="bc-m-table">${body}</table></div></div>`;
    ov.addEventListener("click", ev => { if(ev.target === ov || ev.target.closest(".bc-m-close")) closeModal(); });
    document.body.appendChild(ov); document.body.style.overflow = "hidden";
    ov.querySelector(".bc-m-close").focus();
  }
  document.addEventListener("keydown", ev => { if(ev.key === "Escape") closeModal(); });

  async function mount(o){
    const host = document.getElementById("bossCounters"); if(!host) return;
    BOSS = o.boss || "";
    const s = await loadSuggestions();
    const mine = (s.bosses || {})[o.slug] || {};
    const list = addSuggestions(tally(o.rows || []), mine);
    const rows = ROLES.map(R => {
      // the order: any you set for this boss and role (data file "order") first, as written; then Main DPS
      // by its lowest star rating (easier-rated runs first) and the other roles by runs; suggestions after
      const pinned = ((mine.order || {})[{ main: "main", sup: "support", exec: "exec", ct: "ct" }[R.k]] || []).map(key);
      const pin = e => { const p = pinned.indexOf(key(e.name)); return p < 0 ? Infinity : p; };
      const starOf = e => { const v = lowestStar(e, R.k); return v == null ? Infinity : v; };
      const mons = list.map((e, i) => [e, i]).filter(([e]) => R.k in e.byRole)
        .sort(([a], [b]) => (pin(a) - pin(b)) || (a.suggested - b.suggested)
          || (R.k === "main" ? starOf(a) - starOf(b) : 0) || (b.byRole[R.k] - a.byRole[R.k]) || (a.suggested ? 0 : a.name.localeCompare(b.name)));
      return mons.length ? `<div class="bc-row"><div class="bc-lbl"><i class="bc-r bc-r-${R.k}">${R.full}</i></div><div class="bc-mons">${mons.map(([e, i]) => monHtml(e, i, R.k)).join("")}</div></div>` : "";
    }).join("");
    if(!rows){ host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = `<div class="bc-head">Top counters</div>${rows}`;
    host.querySelectorAll(".bc-mon").forEach(b => b.addEventListener("click", ev => {
      ev.stopPropagation(); openModal(b, list[+b.dataset.i]); }));
  }

  const css = `
  #bossCounters{ margin:14px 0 8px; }
  .bc-head{ font:800 11.5px 'Manrope',system-ui,sans-serif; letter-spacing:.07em; text-transform:uppercase; color:var(--text-dim); margin-bottom:2px; }
  .bc-row{ display:flex; align-items:center; gap:12px; padding:4px 0; }
  .bc-lbl{ flex:none; width:104px; }
  .bc-mons{ display:flex; flex-wrap:wrap; gap:2px 6px; min-width:0; }
  .bc-mon{ display:flex; align-items:center; justify-content:center; width:50px; height:50px; padding:0; border:0; background:transparent; color:inherit; cursor:pointer; border-radius:12px; }
  /* tappable: the sprite pops out a little on hover (and keyboard focus) */
  .bc-mon{ outline:none; }
  /* tappable: on hover (and keyboard focus) an outline traces the sprite itself */
  .bc-sp{ transition:filter .12s ease; }
  .bc-mon:hover .bc-sp, .bc-mon:focus-visible .bc-sp, .bc-mon.on .bc-sp{
    filter:drop-shadow(0 0 1px rgba(90,169,255,.85)) drop-shadow(0 0 4px rgba(90,169,255,.45)); }   /* a soft glow along its edge */
  .bc-spw{ position:relative; display:block; }
  .bc-sp{ width:44px; height:44px; object-fit:contain; display:block; }
  .bc-wx{ position:absolute; right:-3px; bottom:-2px; width:17px; height:17px; padding:1px; border-radius:50%; background:var(--card); box-shadow:0 0 0 1px var(--border); }
  .bc-mon.is-sug .bc-sp{ outline:1.5px dashed #e8a33a; outline-offset:1px; border-radius:50%; }
  /* role pills: the Difficulty & Roles page's colours */
  .bc-r{ font-style:normal; display:inline-block; font:800 11px/1 'Manrope',system-ui,sans-serif; border-radius:999px; padding:5px 10px; white-space:nowrap; }
  .bc-r-main{ background:#ffe1e1; color:#c62828; } .bc-r-sup{ background:#dff5f3; color:#00897b; }
  .bc-r-ct{ background:#f2ebff; color:#7d4fd6; } .bc-r-exec{ background:#e9e9eb; color:#292929; }
  [data-theme="dark"] .bc-r-main{ background:rgba(220,53,69,0.22); color:#ff9494; } [data-theme="dark"] .bc-r-sup{ background:rgba(0,150,136,0.22); color:#5eded4; }
  [data-theme="dark"] .bc-r-ct{ background:rgba(155,123,240,0.2); color:#c1a8ff; } [data-theme="dark"] .bc-r-exec{ background:rgba(255,255,255,0.14); color:#e4e4e6; }
  .bc-overlay{ position:fixed; inset:0; background:rgba(20,24,38,0.45); z-index:80; display:flex; align-items:center; justify-content:center; padding:20px; }
  .bc-modal{ background:var(--card); border:2px solid var(--border); border-radius:16px; width:min(860px, 100%); max-height:88vh; display:flex; flex-direction:column;
    box-shadow:0 12px 40px rgba(20,24,38,0.25); overflow:hidden; }
  .bc-m-head{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; border-bottom:1.5px solid var(--border); flex-shrink:0; }
  .bc-m-title{ display:flex; align-items:center; gap:10px; min-width:0; }
  .bc-m-title h3{ font-family:'Manrope', sans-serif; font-size:16px; margin:0; color:var(--text); }
  .bc-m-sub{ font-size:11.5px; color:var(--text-dim); font-weight:600; margin-top:1px; }
  .bc-m-icon{ width:38px; height:38px; border-radius:50%; background:rgba(61,157,255,.12); flex-shrink:0; display:flex; align-items:center; justify-content:center; overflow:hidden; }
  .bc-m-icon img{ width:100%; height:100%; object-fit:contain; }
  .bc-m-close{ background:none; border:none; font-size:26px; line-height:1; cursor:pointer; color:var(--text-dim); padding:0 4px; }
  .bc-m-scroll{ overflow:auto; flex:1; }
  .bc-m-table{ width:100%; border-collapse:separate; border-spacing:0; font-size:11.5px; color:var(--text); }
  .bc-m-table th{ position:sticky; top:0; background:var(--card); text-align:left; font-family:'Manrope', sans-serif; font-weight:800; font-size:10px; text-transform:uppercase;
    letter-spacing:0.04em; color:var(--text-dim); padding:8px 12px; white-space:nowrap; z-index:3; box-shadow:inset 0 -1px 0 var(--border); }
  .bc-m-table td{ padding:7px 12px; border-bottom:1px solid var(--border); vertical-align:middle; }
  .bc-m-table tr:hover td{ background:rgba(61,157,255,.08); }
  .bc-m-table .c{ text-align:center; white-space:nowrap; }
  .bc-m-table a{ color:var(--blue); font-weight:700; text-decoration:none; white-space:nowrap; }
  .bc-t-mv{ display:flex; flex-direction:column; gap:3px; }
  .bc-mvt{ display:inline-flex; align-items:center; gap:5px; font-weight:700; white-space:nowrap; }
  .bc-mi{ width:15px; height:15px; border-radius:50%; flex:none; display:inline-flex; align-items:center; justify-content:center; }
  .bc-mi img{ width:9px; height:9px; filter:brightness(0) invert(1); }
  .bc-m-table .bc-r{ font-size:10px; padding:3px 8px; margin:1px 0; }
  .bc-dim{ color:var(--text-muted); opacity:.6; }
  .bc-m-table .ae-icon{ width:20px; height:20px; margin:0; vertical-align:middle; }
  @media (max-width:600px){
    .bc-overlay{ padding:0; }
    .bc-modal{ max-height:100vh; height:100vh; border-radius:0; border:none; width:100%; } .bc-modal{ max-height:100dvh; height:100dvh; }
    .bc-m-head{ position:sticky; top:0; z-index:2; background:var(--card); }
    .bc-m-close{ min-width:44px; min-height:44px; }
  }
  .bc-mv{ border:1px solid var(--border); border-radius:999px; padding:1px 7px; font:700 11px 'Manrope',sans-serif; }
  @media (max-width:560px){ .bc-row{ flex-direction:column; align-items:flex-start; gap:2px; } .bc-lbl{ width:auto; } .bc-mon{ width:46px; height:46px; } .bc-sp{ width:40px; height:40px; } }
  `;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  window.BossCounters = { mount };
})();
