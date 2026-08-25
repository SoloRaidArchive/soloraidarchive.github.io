#!/usr/bin/env node
/**
 * Regenerates every data/guides/<slug>.html from:
 *   - data/guide-template.html   (the shared template - see below for why it lives here)
 *   - csv/pokemon-stats.csv, csv/pokemon-movepool.csv, csv/moves.csv, csv/tier4-data.csv
 *   - dps-calculator.html's own BASE_FORM_MAP (Mega/Primal -> base-species lookup)
 *
 * WHY THIS EXISTS
 *
 * A guide page is build output, not a hand-authored file: `template + boss tokens + CSV-derived
 * Boss Info`. The Routes/strategies content (Overview, battle parties, VODs) is NOT baked into
 * this HTML at all - the page fetches its own data/guides/<slug>.json client-side at runtime
 * (see the `fetch('<slug>.json')` call every guide page already has), so this script never
 * touches that.
 *
 * Before this script existed, that template+data->HTML step only happened inside the Cloudflare
 * Worker, at submission time. Two problems followed from that:
 *
 *   1. A template fix (say, a layout change) only reached a boss's page the next time someone
 *      resubmitted THAT boss's guide. Pages drifted to different template versions depending on
 *      when they were last touched - which is exactly why diffing two guide HTML files against
 *      each other stopped being a meaningful way to decide what to keep. There was no "current"
 *      version to compare against; there were N versions, one per last-submission time.
 *   2. GUIDE_TEMPLATE lived as a 44KB template literal INSIDE worker3.js, with no local copy to
 *      generate from directly - the only way to see current output was to actually submit a
 *      guide through the live Worker.
 *
 * This script and the shared template file fix both: the template now lives in one place
 * (data/guide-template.html, fetched by the Worker exactly the way it already fetches
 * data/collection-template.html for collections), and running this script makes every guide page
 * simultaneously current with zero ambiguity - the same guarantee generate_collections.py already
 * gives collection pages.
 *
 * The Boss-Info-building functions below (autoBossInfoInnerHtml, computeRaidBossStats,
 * typeChipsHtml, moveChipTypesObjectLiteral) are copied verbatim from worker3.js, not
 * reimplemented - only the I/O layer differs (local fs.readFileSync here vs. the Worker's GitHub
 * Contents API). Keeping the logic byte-identical, and changing only how the bytes get read, is
 * deliberately safer than a from-scratch port: a behavioral difference could only come from the
 * I/O substitution, which is small and easy to review, rather than from re-deriving the whole
 * function.
 *
 * Usage: node generate_guides.js [--repo <path>] [--check]
 *   --check   verify only, write nothing (for CI)
 */
const fs = require("fs");
const path = require("path");

function parseArgs(argv){
  const out = { repo: ".", check: false };
  for(let i = 0; i < argv.length; i++){
    if(argv[i] === "--repo") out.repo = argv[++i];
    else if(argv[i] === "--check") out.check = true;
  }
  return out;
}

// ---- CSV reading: same shape fetchRepoCsv() in worker3.js produces, just from local disk. ----
function readCsv(repoRoot, relPath){
  const full = path.join(repoRoot, relPath);
  if(!fs.existsSync(full)) return null;
  const lines = fs.readFileSync(full, "utf8").split(/\r?\n/).filter(l => l.trim());
  if(!lines.length) return null;
  const header = lines.shift().split(",").map(h => h.trim().toLowerCase());
  return lines.map(l => {
    const c = l.split(",");
    const o = {};
    header.forEach((h, i) => { o[h] = (c[i] || "").trim(); });
    return o;
  });
}

// ============ Copied verbatim from worker3.js (I/O swapped: gh() -> local fs) ============

const RAID_BOSS_CPM = 0.79030001;
const RAID_BOSS_HP_TIER4_DISPLAY = "9,000";
const RAID_BOSS_HP_DEFAULT_DISPLAY = "15,000";

const TYPE_COLORS = {
  Normal: "#9199A1", Fire: "#E2661C", Water: "#3E8DE0", Electric: "#E0B316",
  Grass: "#4E9A3A", Ice: "#5AC9C9", Fighting: "#A2402A", Poison: "#8A3F94",
  Ground: "#6B4423", Flying: "#8B93E0", Psychic: "#E0426E", Bug: "#7B9A1E",
  Rock: "#B5651D", Ghost: "#5B4B8A", Dragon: "#5B3FE0", Dark: "#4A4238",
  Steel: "#7A8A9A", Fairy: "#E091C9",
};

function escapeHtmlForTemplate(str){
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeJsStringForTemplate(str){
  return String(str == null ? "" : str).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function computeRaidBossStats(baseStats, isTier4Mega){
  if(!baseStats) return null;
  const atk = Math.floor((baseStats.atk + 15) * RAID_BOSS_CPM * 10) / 10;
  const def = Math.floor((baseStats.def + 15) * RAID_BOSS_CPM * 10) / 10;
  const hp = isTier4Mega ? RAID_BOSS_HP_TIER4_DISPLAY : RAID_BOSS_HP_DEFAULT_DISPLAY;
  return { atk: atk.toFixed(1), def: def.toFixed(1), hp };
}

function typeChipsHtml(types){
  return types.map(t => `<span class="type-icon-wrap" style="background:${TYPE_COLORS[t] || "#9199A1"};">${escapeHtmlForTemplate(t)}</span>`).join("");
}

// Both movepool rows are empty in the HTML and filled by script once the page runs, so without a
// reserved height they grow from 0 and shove everything below them down - measured at 0.48 CLS on
// a phone before this. A flat CSS constant cannot work: Mega Raichu X needs 90px and Mega Starmie
// 282px (its movepool lists all 16 Hidden Power variants separately) while most bosses need 26px,
// so any single value is dead space for some pages and a shift for others. The generator knows the
// exact move count, so it emits the exact height instead of guessing.
//
// Chips are a fixed 26px tall with a 6px gap, wrapping at CHIPS_PER_ROW on a 390px screen. Wider
// screens fit more per row, so this over-reserves slightly there - harmless, since reserved space
// costs nothing while a shift costs ranking.
const CHIP_H = 26, CHIP_GAP = 6;
// Row width and chip metrics fitted against the 13 rendered guides at a 390px viewport, then
// checked back: 12 of 13 rows matched exactly. A plain chips-per-row constant does not work
// because chip width tracks the label - Mega Starmie's "Hidden Power Fighting" chips are roughly
// twice the width of "Water Gun", so counting chips under-reserved that page by 64px.
const ROW_W = 330, CHIP_FIXED = 34, CHIP_PER_CHAR = 5.5;
function reserveRowPx(moveNames){
  if(!moveNames || !moveNames.length) return 0;
  let rows = 1, x = 0;
  for(const n of moveNames){
    const w = CHIP_FIXED + String(n).length * CHIP_PER_CHAR;
    if(x > 0 && x + CHIP_GAP + w > ROW_W){ rows++; x = w; }
    else x += (x ? CHIP_GAP : 0) + w;
  }
  return rows * CHIP_H + (rows - 1) * CHIP_GAP;
}

function moveChipTypesObjectLiteral(moveNames, moveTypeMap){
  const lines = [];
  for(const name of moveNames){
    const elem = moveTypeMap.get(name);
    if(!elem) continue;
    lines.push(`  ${JSON.stringify(name)}: {type:${JSON.stringify(elem)}, color:${JSON.stringify(TYPE_COLORS[elem] || "#9199A1")}},`);
  }
  return `const MOVE_TYPES = {\n${lines.join("\n")}\n};`;
}

function autoBossInfoInnerHtml(bossNameEscaped, bossName, raidDb){
  const rawStats = raidDb.statsMap.get(bossName.trim().toLowerCase()) || null;
  const isTier4Mega = raidDb.tier4MegaSet.has(bossName.trim().toLowerCase());
  const stats = computeRaidBossStats(rawStats, isTier4Mega);
  if(!stats) return null;

  let types = raidDb.typesMap.get(bossName.trim().toLowerCase()) || null;
  if(!types){
    const fallbackKey = raidDb.baseFormMap.get(bossName.trim().toLowerCase());
    if(fallbackKey) types = raidDb.typesMap.get(fallbackKey) || null;
  }
  const movepool = raidDb.movepoolMap.get(bossName.trim().toLowerCase())
    || raidDb.movepoolMap.get(raidDb.baseFormMap.get(bossName.trim().toLowerCase()))
    || null;

  const typeRow = types ? `\n        <div class="type-icon-row-sm">${typeChipsHtml(types)}</div>` : "";
  const statsBlock = `<div class="boss-info-top">
      <img class="boss-sprite-sm" id="boss-sprite-img" alt="${bossNameEscaped}" onerror="this.style.display='none'">
      <div class="boss-info-top-right">${typeRow}
        <dl class="stat-row-sm">
          <div class="stat-cell-sm"><dt class="stat-label-sm">ATK</dt><dd class="stat-value-sm">${stats.atk}</dd></div>
          <div class="stat-cell-sm"><dt class="stat-label-sm">DEF</dt><dd class="stat-value-sm">${stats.def}</dd></div>
          <div class="stat-cell-sm"><dt class="stat-label-sm">HP</dt><dd class="stat-value-sm">${stats.hp}</dd></div>
        </dl>
      </div>
    </div>`;

  if(movepool && (movepool.fast.length || movepool.charged.length)){
    return {
      html: `${statsBlock}
    <div class="movepool-label">Fast Moves</div>
    <div class="movepool-row" id="fast-move-row" style="min-height:${reserveRowPx(movepool.fast)}px"></div>
    <div class="movepool-label">Charge Moves</div>
    <div class="movepool-row" id="charge-move-row" style="min-height:${reserveRowPx(movepool.charged)}px"></div>`,
      moveScript: `${moveChipTypesObjectLiteral([...movepool.fast, ...movepool.charged], raidDb.moveTypeMap)}
const TYPE_ICON_BASE = "https://duiker101.github.io/pokemon-type-svg-icons/icons/";
function moveChipHtml(name, isCharge){
  const info = MOVE_TYPES[name];
  const bg = info ? info.color : "#9199A1";
  const icon = info ? \`<img class="move-type-icon" src="\${TYPE_ICON_BASE}\${info.type.toLowerCase()}.svg" alt="\${info.type}" onerror="this.remove();">\` : "";
  return \`<span class="move-chip" style="background:\${bg};" title="\${info ? info.type : ""}">\${icon}\${name}</span>\`;
}
document.getElementById('fast-move-row').innerHTML = ${JSON.stringify(movepool.fast)}.map(m => moveChipHtml(m, false)).join('');
document.getElementById('charge-move-row').innerHTML = ${JSON.stringify(movepool.charged)}.map(m => moveChipHtml(m, true)).join('');`,
    };
  }

  const missingLabel = types ? "movepool hasn't" : "type and movepool haven't";
  return {
    html: `${statsBlock}
    <p class="boss-info-placeholder">The ${missingLabel} been added for this boss yet - edit this page to fill it in with THIS boss's own type, stats, and moves (do not paste in another boss's MOVE_TYPES or moveset - copying another guide's data is exactly what causes wrong move-type icons to show up here). Stats above were calculated automatically from base stats using standard 5-star/Mega raid boss values.</p>`,
    moveScript: null,
  };
}

// ============ Local-disk raidDb builder (same shape as worker3.js's getPokemonRaidDb) ============

const BASE_URL = "https://soloraidarchive.github.io/";

// Nothing was keeping guide URLs in the sitemap: 5 of 13 guides were listed, the rest were not,
// and neither the Worker nor this script touched sitemap.xml. The 5 were added by hand once and
// then drifted. generate_collections.py already does exactly this for collections/, so guides now
// follow the same rule - the generator that creates the page also registers it.
function syncSitemap(repoRoot, bosses, check){
  const sitemapPath = path.join(repoRoot, "sitemap.xml");
  if(!fs.existsSync(sitemapPath)){ console.log("  no sitemap.xml, skipping"); return false; }
  let xml = fs.readFileSync(sitemapPath, "utf8");

  const wanted = new Set(bosses.map(b => `${BASE_URL}data/guides/${b.slug}.html`));
  const present = new Set((xml.match(/<loc>([^<]+)<\/loc>/g) || []).map(m => m.replace(/<\/?loc>/g, "")));
  const presentGuides = new Set([...present].filter(u => u.includes("/data/guides/")));

  const stale = [...presentGuides].filter(u => !wanted.has(u)).sort();
  for(const url of stale){
    xml = xml.replace(new RegExp(`\\s*<url>\\s*<loc>${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>[\\s\\S]*?</url>`), "");
  }
  const additions = [...wanted].filter(u => !presentGuides.has(u)).sort()
    .map(u => `  <url>\n    <loc>${u}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`);
  if(additions.length) xml = xml.replace("</urlset>", additions.join("\n") + "\n</urlset>");

  if(!additions.length && !stale.length){ console.log("  sitemap: already in step"); return false; }
  console.log(`  sitemap: +${additions.length} / -${stale.length} guide URL(s)`);
  if(!check) fs.writeFileSync(sitemapPath, xml, "utf8");
  return true;
}

function buildRaidDb(repoRoot){
  const statsMap = new Map();
  const typesMap = new Map();
  const statRows = readCsv(repoRoot, "csv/pokemon-stats.csv");
  if(statRows){
    for(const r of statRows){
      const key = (r.name || "").trim().toLowerCase();
      if(!key) continue;
      const atk = parseFloat(r.atk), def = parseFloat(r.def);
      if(isFinite(atk) && isFinite(def)) statsMap.set(key, { atk, def });
      const types = [r.type1, r.type2].filter(Boolean);
      if(types.length) typesMap.set(key, types);
    }
  }

  const baseFormMap = new Map();
  const calcPath = path.join(repoRoot, "dps-calculator.html");
  if(fs.existsSync(calcPath)){
    const html = fs.readFileSync(calcPath, "utf8");
    const m = html.match(/const BASE_FORM_MAP = \{([\s\S]*?)\n\};/);
    if(m){
      const re = /"([^"]+)":\s*"([^"]+)"/g;
      let mm;
      while((mm = re.exec(m[1])) !== null) baseFormMap.set(mm[1], mm[2]);
    }
  }

  const movepoolMap = new Map();
  const mpRows = readCsv(repoRoot, "csv/pokemon-movepool.csv");
  if(mpRows){
    for(const r of mpRows){
      const key = (r.pokemon || "").trim().toLowerCase();
      const move = (r.move || "").trim();
      if(!key || !move) continue;
      if(/^(y|yes|true|1)$/i.test(r.elite || "")) continue;
      if(!movepoolMap.has(key)) movepoolMap.set(key, { fast: [], charged: [] });
      const e = movepoolMap.get(key);
      const bucket = (r.category || "").trim().toLowerCase() === "fast" ? e.fast : e.charged;
      // The movepool CSV lists Hidden Power once per element - 16 rows for Starmie alone, which
      // rendered as 16 chips and 314px of movepool. In game it is a single move whose type is
      // fixed per Pokemon, so one chip is the accurate representation. csv/moves.csv already
      // carries a plain "Hidden Power" row (Normal, Fast, 15.0/15.0/3.0, identical to every
      // variant), so the collapsed name still resolves for typing and stats.
      const collapsed = /^hidden power\b/i.test(move) ? "Hidden Power" : move;
      if(!bucket.includes(collapsed)) bucket.push(collapsed);
    }
  }

  const moveTypeMap = new Map();
  const moveRows = readCsv(repoRoot, "csv/moves.csv");
  if(moveRows){
    for(const r of moveRows){
      const n = (r.name || "").trim(), t = (r.type || "").trim();
      if(n && t) moveTypeMap.set(n, t);
    }
  }

  const tier4MegaSet = new Set();
  const tier4Rows = readCsv(repoRoot, "csv/tier4-data.csv");
  if(tier4Rows){
    for(const r of tier4Rows){
      const n = (r["boss name"] || "").trim().toLowerCase();
      if(n) tier4MegaSet.add(n);
    }
  }

  return { statsMap, typesMap, movepoolMap, moveTypeMap, tier4MegaSet, baseFormMap };
}

// ============ Page assembly ============

function buildGuidePage(template, boss, raidDb){
  const bossSlug = boss.slug;
  let pageHtml = template
    .replace(/%%BOSS_NAME_JS%%/g, escapeJsStringForTemplate(boss.name))
    .replace(/%%BOSS_NAME%%/g, escapeHtmlForTemplate(boss.name))
    .replace(/%%BOSS_SLUG%%/g, bossSlug);

  const bossNameEscaped = escapeHtmlForTemplate(boss.name);
  const auto = autoBossInfoInnerHtml(bossNameEscaped, boss.name, raidDb);

  const infoStart = pageHtml.indexOf('<div class="info-box">');
  const infoEnd = pageHtml.indexOf('<h2 class="section-title">Routes</h2>');
  if(auto && infoStart !== -1 && infoEnd !== -1){
    pageHtml = pageHtml.slice(0, infoStart) + auto.html + "\n    " + pageHtml.slice(infoEnd);
  }

  if(auto && auto.moveScript){
    // Not a regex splice against a "const MOVE_TYPES = {...}" block - the template's placeholder
    // for an unpopulated movepool is a single COMMENT line (see worker3.js's own
    // placeholderComment), because a boss with no documented stats has no fast/charge-move-row
    // elements at all yet, so there is nothing resembling a real move-script block to pattern-match
    // against on first generation. Matching on `const MOVE_TYPES` (what an ALREADY-populated page
    // would contain) only ever matches on the second-or-later regeneration of a given boss, and
    // silently does nothing on the first - which is exactly the bug this comment is warning about.
    const placeholderComment = "// Boss Info movepool not populated - no fast/charge-move-row elements exist for a boss without documented stats yet (see the placeholder note above)";
    if(pageHtml.includes(placeholderComment)){
      pageHtml = pageHtml.replace(placeholderComment, auto.moveScript);
    }else{
      // Second-or-later generation: an already-populated move-script block from a previous run
      // needs replacing, not appending alongside.
      const blockRe = /const MOVE_TYPES = \{[\s\S]*?document\.getElementById\('charge-move-row'\)\.innerHTML = .*?;/;
      if(blockRe.test(pageHtml)) pageHtml = pageHtml.replace(blockRe, auto.moveScript);
    }
  }

  return pageHtml;
}

// ============ Main ============

function main(){
  const { repo, check } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(repo);

  const templatePath = path.join(repoRoot, "data", "guide-template.html");
  if(!fs.existsSync(templatePath)){
    console.error(`  ABORT: ${templatePath} not found`);
    process.exit(2);
  }
  const template = fs.readFileSync(templatePath, "utf8");
  for(const token of ["%%BOSS_NAME%%", "%%BOSS_SLUG%%", "%%BOSS_NAME_JS%%"]){
    if(!template.includes(token)){
      console.error(`  ABORT: guide-template.html has no ${token} - wrong template?`);
      process.exit(2);
    }
  }

  const indexPath = path.join(repoRoot, "data", "guides", "index.json");
  if(!fs.existsSync(indexPath)){
    console.error(`  ABORT: ${indexPath} not found`);
    process.exit(2);
  }
  const guideIndex = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const bosses = guideIndex.bosses || [];

  const raidDb = buildRaidDb(repoRoot);

  let written = 0, unchanged = 0;
  for(const boss of bosses){
    const html = buildGuidePage(template, boss, raidDb);
    const outPath = path.join(repoRoot, "data", "guides", `${boss.slug}.html`);
    const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null;
    if(existing === html){ unchanged++; continue; }
    written++;
    if(!check){
      fs.writeFileSync(outPath, html, "utf8");
    }
  }

  console.log(`  ${bosses.length} guide(s); ${written} page(s) ${check ? "would change" : "written"}, ${unchanged} already current`);
  const sitemapChanged = syncSitemap(repoRoot, bosses, check);
  if(check && (written > 0 || sitemapChanged)) process.exit(1);
}

main();
