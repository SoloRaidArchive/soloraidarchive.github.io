/*
  Cloudflare Worker: relay for boss-guide strategy submissions.

  What this does, end to end, for one submission:
    1. Receives a submission from the editor. Every field except `boss` (routing only) and the
       optional `imageBase64`/`imageFilename` pair is passed straight through into the strategy
       entry - new editor fields never require changes here, see the pass-through note below.
    2. If an image was attached, commits it as its own file under assets/presets/ and points the
       strategy's `imageUrl` at it - this is the one thing that DOES need explicit Worker support,
       since committing a binary file is a different operation than appending a JSON field.
    3. Reads the CURRENT data/guides/{boss}.json file from the repo (creates a fresh skeleton if the
       boss has no file yet - this is the only "new page" case, and even then it's one file per boss,
       never one file per strategy).
    4. Appends the new strategy to that file's `strategies` array. Every strategy for a boss always
       lives in the SAME file - there is no code path that creates a second file for a boss that
       already has one, which is what structurally guarantees "one page per boss" rather than relying
       on convention.
    5. If this is a brand-new boss, ALSO generates and commits data/guides/{slug}.html from
       GUIDE_TEMPLATE below, and registers the boss in data/guides/index.json - all in the same
       branch/PR. This is what makes a new boss's guide viewable the moment the PR merges, with no
       manual "build the HTML file" step ever needed again.
    6. Creates a new branch, commits the image (if any), the updated JSON, and (for a new boss) the
       new HTML page and index update, then opens a pull request into main.
    7. Returns the PR URL to the editor so the volunteer gets a confirmation link.

  Deploy: `wrangler deploy` after setting the GITHUB_TOKEN secret (a fine-grained PAT scoped to
  Contents: Read/Write and Pull requests: Read/Write on this one repo only - not a full-account token).
  Set secrets with `wrangler secret put GITHUB_TOKEN`, never commit the token itself.
*/

const OWNER = "soloraidarchive";
const REPO = "soloraidarchive.github.io";
const BASE_BRANCH = "main";
const GITHUB_API = "https://api.github.com";

// The raid-boss CPM is the same 0.7903 across every tier this site deals with (confirmed against
// tier4-raids.html, tier5-raids.html, and tier6-elite-raids.html - all three
// define the identical constant). Only the fixed HP pool changes per tier:
//   Tier 4 (ordinary Mega Raids - not Mega Legendary, not a Legends Z-A Mega)  -> 9,000
//   Tier 5 / 5-star legendary or mythical (Lunala, Azelf, Nihilego, etc.)      -> 15,000 (default)
//   Tier 6 "Mega Legendary & Elite"                                            -> 22,500 (not yet
//     auto-detected here - this repo doesn't cleanly separate "Mega Legendary" from "Elite/Shadow"
//     raids in tier6-elite-raids.html's own data, so a boss that's actually a Mega Legendary will
//     currently fall through to the 15,000 default and be wrong. Flagging this rather than guessing.)
//
// Which bosses count as Tier 4 is read live from csv/tier4-data.csv
// (the site's actual Mega Raid archive) rather than a hardcoded name list here, so it never goes
// stale as that page's roster changes.
//
// ATK/DEF formula and rounding were reverse-checked against the three guides that already had
// real, hand-entered Boss Info (Lunala, Azelf, Nihilego): floor((base + 15) * RAID_BOSS_CPM * 10)
// / 10 reproduces 5 of those 6 known ATK/DEF values exactly and is within 0.1 on the sixth
// (Lunala's DEF) - almost certainly just a tiny discrepancy in whatever source those three
// original numbers were manually copied from, not a bug in this formula.
const RAID_BOSS_CPM = 0.79030001;
const RAID_BOSS_HP_TIER4_DISPLAY = "9,000";
const RAID_BOSS_HP_DEFAULT_DISPLAY = "15,000";

// The full guide page template, generated once from a real working guide page (Lunala's) and
// parameterized with %%BOSS_NAME%%/%%BOSS_SLUG%% tokens. Kept as a plain string with token
// replacement rather than a real JS template literal, since the guide page's OWN inline script
// uses ${...} template literals extensively - wrapping the whole thing in a literal here would
// make those get evaluated in THIS scope instead of staying literal text. All backticks and
// ${ sequences in the template below are pre-escaped for exactly that reason - do not hand-edit
// this string without re-escaping if the source guide page template changes. Boss Info
// (type/stats/movepool) is left as an honest placeholder in the template, since this Worker has
// no access to a full Pokemon database - Routes and the strategy breakdown work immediately regardless, since
// those are entirely driven by the JSON data committed in the same PR.
const GUIDE_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>How to Solo %%BOSS_NAME%% (Pokémon GO) — Solo Raid Archive</title>
<link rel="icon" href="../../assets/icons/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../../assets/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../../assets/icons/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../../assets/icons/favicon-180.png">
<meta name="description" content="How to solo %%BOSS_NAME%% in Pokémon GO: exact battle parties, weather conditions, and difficulty routes from real recorded solo clears, with video proof for every strategy.">
<link rel="canonical" href="https://soloraidarchive.github.io/data/guides/%%BOSS_SLUG%%.html">
<meta property="og:type" content="article">
<meta property="og:title" content="How to Solo %%BOSS_NAME%% (Pokémon GO)">
<meta property="og:description" content="Exact battle parties, weather conditions, and difficulty routes from real recorded solo clears of %%BOSS_NAME%%, with video proof for every strategy.">
<meta property="og:url" content="https://soloraidarchive.github.io/data/guides/%%BOSS_SLUG%%.html">
<meta property="og:site_name" content="Solo Raid Archive">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="How to Solo %%BOSS_NAME%% (Pokémon GO)">
<meta name="twitter:description" content="Exact battle parties, weather conditions, and difficulty routes from real recorded solo clears of %%BOSS_NAME%%, with video proof for every strategy.">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to Solo %%BOSS_NAME%% in Pokémon GO",
  "description": "Step-by-step routes for soloing %%BOSS_NAME%%, based on real recorded clears: check the boss's type and moves, pick a route by difficulty/weather/adventure effect, then follow the matching battle party.",
  "step": [
    { "@type": "HowToStep", "name": "Check Boss Info", "text": "Review %%BOSS_NAME%%'s typing, effective stats, and possible fast/charge moves so you know what you're up against." },
    { "@type": "HowToStep", "name": "Choose a Route", "text": "Pick the recorded route that matches your difficulty, current weather, and any active Adventure Effect." },
    { "@type": "HowToStep", "name": "Follow the Battle Party", "text": "Use the matching battle party - exact Pokémon, levels, and movesets - and the linked VOD as proof the strategy works." }
  ]
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --bg1: #ffffff; --bg2: #ffe4c9; --bg3: #f6c9ce;
    --card: #ffffff; --border: #e7edf5;
    --text: #2d3142; --text-muted: #6b7280; --text-dim: #5f6675;
    --blue: #3d9dff; --blue-dark: #2b7fd6; --accent-soft: #eef2ff;
  }
  [data-theme="dark"]{
    --bg1: #0c0e1c; --bg2: #2a1830; --bg3: #6b3324; --bg4: #9c5024;
    --card: #1c2030; --border: #323850;
    --text: #eef1f7; --text-muted: #a7afc0; --text-dim: #767f96;
    --blue: #5aa9ff; --blue-dark: #8cc7ff; --accent-soft: #232840;
  }
  [data-theme="dark"] body{
    background: linear-gradient(180deg, #0c0e1c 0%, #2a1830 45%, #6b3324 80%, #9c5024 100%);
  }
  *{ box-sizing: border-box; }
  body{
    font-family:'Inter', sans-serif; margin:0; padding:0;
    background: linear-gradient(160deg, var(--bg1) 0%, var(--bg2) 55%, var(--bg3) 100%);
    color: var(--text); min-height:100vh;
  }
  .page{ max-width:720px; margin:0 auto; padding:20px 20px 60px; }

  .sticky-header{
    position:sticky; top:0; z-index:15; background: var(--bg1);
    padding: 10px 16px; border-bottom: 1px solid var(--border);
  }
  .sticky-header-row{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; position:relative; }
  .sticky-header-row .hamburger-btn{ position:absolute; right:0; }
  .page-title-sm{ font-family:'Manrope', sans-serif; font-weight:800; font-size:18px; margin:0; color: var(--text); text-align:center; }

  .hamburger-btn{
    flex-shrink:0; z-index:20; -webkit-tap-highlight-color:transparent;
    width:38px; height:38px; border-radius:50%;
    background: var(--card); border:2px solid var(--border);
    cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:4px; box-shadow: 0 3px 0 rgba(0,0,0,0.06); transition: transform .15s;
  }
  .hamburger-btn:hover{ transform: translateY(-2px); }
  .hamburger-btn span{ display:block; width:19px; height:2.5px; border-radius:2px; background: var(--text); transition: transform .2s ease, opacity .2s ease; }
  .hamburger-btn[aria-expanded="true"] span:nth-child(1){ transform: translateY(6.5px) rotate(45deg); }
  .hamburger-btn[aria-expanded="true"] span:nth-child(2){ opacity:0; }
  .hamburger-btn[aria-expanded="true"] span:nth-child(3){ transform: translateY(-6.5px) rotate(-45deg); }
  .hamburger-panel{
    position:fixed; top:66px; right:16px; z-index:19; width:min(240px, calc(100vw - 32px));
    background: var(--card); border:2px solid var(--border); border-radius:16px;
    padding:10px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    display:none; flex-direction:column; gap:14px; max-height:calc(100vh - 96px); overflow-y:auto;
  }
  .hamburger-panel.open{ display:flex; }
  .hamburger-theme-toggle{
    display:flex; align-items:center; justify-content:center; gap:6px;
    width:100%; padding:12px 10px; font-family:'Manrope', sans-serif; font-weight:700;
    font-size:14px; color: var(--text); background: var(--card); border:2px solid var(--border);
    border-radius:10px; cursor:pointer; min-height:44px; box-sizing:border-box;
  }
  .hamburger-theme-toggle:hover{ border-color: var(--blue); color: var(--blue-dark); }
  .hamburger-section-label{
    font-family:'Manrope', sans-serif; font-weight:800; font-size:11px; text-transform:uppercase;
    letter-spacing:0.05em; color: var(--text-dim); padding:6px 10px 4px;
  }
  .hamburger-section a{
    display:flex; align-items:center; padding:10px; font-family:'Manrope', sans-serif; font-weight:700;
    font-size:13.5px; color: var(--text); text-decoration:none; border-radius:10px;
    min-height:40px; box-sizing:border-box; word-break:break-word; line-height:1.3;
  }
  .hamburger-section a:hover{ background: var(--bg1); color: var(--blue-dark); }
  .hamburger-section a.current{ background: var(--blue); color:#fff; }
  .hamburger-section a.hamburger-featured{
    border: 2px solid transparent !important;
    background-image:
      linear-gradient(var(--card), var(--card)),
      linear-gradient(90deg, #3d9dff, #b5d4f4, #ffd77a, #3d9dff, #b5d4f4, #ffd77a);
    background-origin: padding-box, border-box;
    background-clip: padding-box, border-box;
    background-size: 100% 100%, 300% 100%;
    animation: hamburgerShine 4s linear infinite;
  }
  @keyframes hamburgerShine{
    0%{ background-position: 0 0, 0% 0; }
    100%{ background-position: 0 0, 100% 0; }
  }

  .guide-eyebrow{
    font-family:'Manrope', sans-serif; font-weight:800; font-size:11.5px; color: var(--blue-dark);
    text-transform:uppercase; letter-spacing:0.06em; margin:20px 0 4px; text-align:center;
  }
  .guide-title{ font-family:'Manrope', sans-serif; font-weight:800; font-size:28px; margin:0 0 8px; text-align:center; }
  .boss-info-placeholder{ font-size:13px; color: var(--text-dim); text-align:center; line-height:1.6; padding:10px 0; }
  .edit-guide-row{ display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:18px; flex-wrap:wrap; }
  .edit-guide-btn{
    display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700;
    color: var(--blue-dark); background: var(--accent-soft); padding:6px 14px; border-radius:999px;
    text-decoration:none; border:none; font-family:'Inter', sans-serif; cursor:pointer;
  }
  .edit-guide-btn:hover{ background:#dcecff; }
  [data-theme="dark"] .edit-guide-btn:hover{ background:#2a3555; }
  .share-guide-btn.copied{ background:#d4f5dd; color:#1f7a45; }
  [data-theme="dark"] .share-guide-btn.copied{ background:#12301f; color:#7dd9a5; }

  .section-title{
    font-family:'Manrope', sans-serif; font-weight:800; font-size:19px; margin:32px 0 4px;
  }

  .info-box{
    background: var(--card); border:2px solid var(--border); border-radius:18px;
    padding:18px 20px; margin-top:12px;
  }
  .boss-sprite-row{ display:flex; justify-content:center; margin-bottom:12px; }
  .boss-sprite{ width:90px; height:90px; object-fit:contain; }
  .type-icon-row{ display:flex; gap:8px; margin-bottom:16px; justify-content:center; }
  .type-icon-wrap{
    display:flex; align-items:center; gap:6px; padding:6px 12px; border-radius:999px; color:#fff;
    font-family:'Manrope', sans-serif; font-weight:700; font-size:12.5px;
  }
  .stat-row{ display:flex; gap:10px; margin-bottom:16px; }
  .stat-cell{ flex:1; background: var(--accent-soft); border-radius:10px; padding:10px 8px; text-align:center; }
  .stat-label{ font-family:'Manrope', sans-serif; font-weight:700; font-size:10px; color: var(--text-dim); text-transform:uppercase; letter-spacing:0.03em; }
  .stat-value{ font-family:'Manrope', sans-serif; font-weight:800; font-size:16px; color: var(--blue-dark); margin-top:2px; }
  .movepool-label{ font-family:'Manrope', sans-serif; font-weight:700; font-size:10.5px; color: var(--text-dim); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px; }
  .movepool-row{ display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
  .move-chip{
    display:inline-flex; align-items:center; gap:6px; padding:6px 12px; border-radius:999px; color:#fff;
    font-family:'Manrope', sans-serif; font-weight:700; font-size:12.5px;
  }
  .move-type-icon{ width:13px; height:13px; flex-shrink:0; object-fit:contain; filter:brightness(0) invert(1); }

  .route-row{ display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .route-btn{
    font-family:'Manrope', sans-serif; font-weight:700; font-size:12px;
    background: var(--card); color: var(--text-dim); border:1.5px solid var(--border);
    padding:9px 14px; border-radius:999px; cursor:pointer;
  }
  .route-btn.active{ background: var(--blue); color:#fff; border-color: var(--blue); }
  .route-dropdown{ position:relative; }
  .route-dropdown-toggle{ display:inline-flex; align-items:center; gap:6px; }
  .route-dropdown-caret{ width:9px; height:9px; flex-shrink:0; transition:transform .15s; }
  .route-dropdown.open .route-dropdown-caret{ transform:rotate(180deg); }
  .route-dropdown-menu{
    position:absolute; top:calc(100% + 6px); left:0; z-index:20; min-width:220px;
    background: var(--card); border:1.5px solid var(--border); border-radius:12px;
    padding:6px; box-shadow:0 10px 28px rgba(0,0,0,0.14); display:none;
  }
  .route-dropdown.open .route-dropdown-menu{ display:block; }
  .route-dropdown-item{
    display:block; width:100%; text-align:left; background:none; border:none; border-radius:8px;
    padding:9px 10px; font-family:'Inter', sans-serif; font-size:12.5px; color: var(--text); cursor:pointer;
  }
  .route-dropdown-item:hover{ background: var(--accent-soft); }
  .route-dropdown-item.active{ background: var(--accent-soft); font-weight:700; color: var(--blue-dark); }

  .strategy-block{ margin:14px 0; }
  .strategy-name{ font-family:'Manrope', sans-serif; font-weight:800; font-size:16px; margin-bottom:4px; }
  .battle-party{ background: var(--accent-soft); border-radius:12px; padding:12px 14px; margin-top:10px; }
  @media (min-width:601px){
    .battle-party{ display:grid; grid-template-columns: 1fr 1fr; gap:2px 20px; align-items:start; }
    .battle-party-label{ grid-column: 1 / -1; }
    .battle-party-label-secondary{ grid-column: 1 / -1; }
  }
  .battle-party-label{ font-family:'Manrope', sans-serif; font-weight:800; font-size:12.5px; color: var(--blue-dark); margin-bottom:8px; }
  .battle-party-label-secondary{
    font-family:'Manrope', sans-serif; font-weight:700; font-size:11.5px; color:#b8791a; margin:-4px 0 8px;
  }
  [data-theme="dark"] .battle-party-label-secondary{ color:#e0b060; }
  .battle-mon{ display:flex; align-items:center; gap:8px; padding:3px 0; font-size:12.5px; }
  .battle-mon-icon{ width:28px; height:28px; border-radius:50%; background: var(--card); flex-shrink:0; overflow:hidden; display:flex; align-items:center; justify-content:center; position:relative; }
  .battle-mon-icon.shadow-mist{
    background: radial-gradient(circle, rgba(58,12,92,0.85) 0%, rgba(30,6,54,0.7) 55%, rgba(12,4,24,0.55) 100%);
    box-shadow: 0 0 8px rgba(88,28,135,0.7), inset 0 0 8px rgba(0,0,0,0.45);
  }
  .battle-mon-icon.shadow-mist::after{
    content:""; position:absolute; z-index:1; pointer-events:none;
    top:-60%; left:-30%; width:160%; height:220%;
    background: radial-gradient(ellipse 40% 28% at 50% 75%, rgba(168,85,247,0.7) 0%, rgba(147,51,234,0) 65%);
    animation: shadowMistRise 4.5s cubic-bezier(0.33, 0, 0.4, 1) infinite;
  }
  @keyframes shadowMistRise{
    0%{ transform: translateY(28%) scale(0.75); opacity:0; }
    15%{ opacity:0.7; }
    55%{ opacity:0.55; }
    100%{ transform: translateY(-52%) scale(1.15); opacity:0; }
  }
  .battle-mon-icon img{ width:100%; height:100%; object-fit:contain; position:relative; z-index:2; }
  .battle-mon-meta{ color: var(--text-dim); font-size:11px; }
  .battle-mon-level{ font-weight:700; font-size:11px; color: var(--text); }
  .role-badge{
    display:inline-block; font-size:10px; font-weight:800; text-transform:uppercase;
    letter-spacing:0.03em; padding:1px 7px; border-radius:999px; margin:1px 4px 1px 0; vertical-align:1px;
  }
  .role-badge.role-main-dps{ background:#ffe1e1; color:#c62828; }
  .role-badge.role-support-dps{ background:#dff5f3; color:#00897b; }
  .role-badge.role-catch-tank{ background:#f2ebff; color:#7d4fd6; }
  .role-badge.role-executor{ background:#e9e9eb; color:#292929; }
  [data-theme="dark"] .role-badge.role-main-dps{ background:rgba(220,53,69,0.22); color:#ff9494; }
  [data-theme="dark"] .role-badge.role-support-dps{ background:rgba(0,150,136,0.22); color:#5eded4; }
  [data-theme="dark"] .role-badge.role-catch-tank{ background:rgba(155,123,240,0.2); color:#c1a8ff; }
  [data-theme="dark"] .role-badge.role-executor{ background:rgba(255,255,255,0.14); color:#e4e4e6; }
  .battle-mon.optional{
    border:1.5px dashed #d9a441; background: rgba(224,160,32,0.08); border-radius:8px;
    padding:5px 7px; margin:2px 0 2px -7px; width:calc(100% + 14px);
  }
  .optional-note{ font-weight:600; color:#b8791a; font-size:10px; }
  [data-theme="dark"] .optional-note{ color:#e0b060; }
  // Level+role and the moveset are always stacked as two rows (level/role on top, moves
  // underneath) - this used to force them onto one flex row with a middle-dot separator at
  // >=601px, cramming everything onto one crowded line on desktop. Removed so the layout is the
  // same clean two-row block at every width, matching what mobile already did by default.
  @media (min-width: 601px){
    .battle-mon{ padding:4px 0; }
  }
  .strategy-tags{ display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap; }
  .strategy-tag{
    font-family:'Inter',sans-serif; font-weight:700; font-size:10px; color: var(--blue-dark);
    background: var(--accent-soft); padding:2px 9px; border-radius:999px;
  }
  .strategy-text{ font-size:14px; color: var(--text); line-height:1.4; margin:0 0 6px; }
  .strategy-text p{ margin:0 0 6px; }
  .strategy-text h2{ font-family:'Manrope', sans-serif; font-weight:800; font-size:17px; margin:14px 0 6px; }
  .strategy-text h3{ font-family:'Manrope', sans-serif; font-weight:700; font-size:15px; margin:12px 0 5px; }
  .strategy-text h4{ font-family:'Manrope', sans-serif; font-weight:700; font-size:14px; margin:10px 0 4px; }
  .strategy-text blockquote{ margin:8px 0; padding:6px 12px; border-left:3px solid var(--blue); color: var(--text-dim); }
  .strategy-text ol, .strategy-text ul{ margin:4px 0 6px; padding-left:22px; list-style:none; counter-reset:list-0; }
  .strategy-text li{ position:relative; }
  .strategy-text li[data-list="bullet"]::before{ content:"\\2022"; display:inline-block; margin-left:-1.2em; margin-right:.3em; width:1em; }
  .strategy-text li[data-list="ordered"]{ counter-increment:list-0; }
  .strategy-text li[data-list="ordered"]::before{ content:counter(list-0) ". "; display:inline-block; margin-left:-1.4em; margin-right:.3em; width:1.2em; }
  .strategy-text img{ max-width:100%; border-radius:8px; margin:6px 0; }
  .strategy-text strong{ font-weight:800; }
  .strategy-text a{ color:#0e8f82; font-weight:700; text-decoration:underline; text-underline-offset:2px; }
  [data-theme="dark"] .strategy-text a{ color:#5eead4; }
  .mechanic-preview{
    position:fixed; z-index:60; width:240px; background: var(--card); border:2px solid var(--border);
    border-radius:12px; padding:8px; box-shadow:0 10px 28px rgba(0,0,0,0.22);
    display:none; pointer-events:none;
  }
  .mechanic-preview.visible{ display:block; }
  .mechanic-preview video{ width:100%; border-radius:7px; display:block; background:#000; }
  .mechanic-preview-label{
    font-family:'Manrope', sans-serif; font-weight:800; font-size:11.5px; color: var(--text);
    margin-top:6px; text-align:center;
  }
  .strategy-vod-row{ display:flex; flex-direction:column; align-items:flex-start; gap:8px; margin-top:4px; }
  .strategy-vod-item{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .strategy-vod{
    display:inline-flex; align-items:center; gap:6px; font-size:13px; font-weight:700;
    color:#fff; text-decoration:none; background: var(--blue); padding:8px 16px; border-radius:999px;
    margin-top:0;
  }
  .strategy-vod:hover{ filter: brightness(0.9); }
  .strategy-vod-credit{ font-size:11.5px; color: var(--text-dim); }
  .strategy-vod-credit a{ color: var(--blue-dark); text-decoration:none; font-weight:600; }
  .strategy-vod-credit a:hover{ text-decoration:underline; }
  .strategy-credit{ font-size:11px; color: var(--text-dim); margin-top:4px; }

  .load-state{ text-align:center; color: var(--text-dim); font-size:13px; padding:30px 0; }
  .load-error{ text-align:center; color:#c62828; font-size:13px; padding:20px; background:#fff0f0; border-radius:10px; }

  footer{
    text-align:center; padding: 24px; font-size:12px; color: var(--text-dim);
    font-family:'Inter', sans-serif; border-top: 1px solid var(--border); margin-top:20px;
  }
  [data-theme="dark"] footer{ color: rgba(238,241,247,0.62); }
  [data-theme="dark"] .strategy-credit{ color: rgba(238,241,247,0.58); }
  @media (max-width: 600px){
    .guide-title{ font-size:26px; }
    .strategy-text{ font-size:16px; line-height:1.4; }
    .strategy-name{ font-size:18px; }
    .strategy-tag{ font-size:11.5px; padding:4px 11px; }
    .stat-label{ font-size:11px; }
    .stat-value{ font-size:17px; }
    .move-chip{ font-size:12.5px; }
    .battle-mon-level{ font-size:13px; }
    .battle-mon-meta{ font-size:12.5px; }
    .battle-party-label{ font-size:13.5px; }
    .route-btn{ font-size:13.5px; padding:11px 16px; }
    .strategy-credit{ font-size:12px; }
    .section-title{ font-size:21px; }
  }

  .boss-info-top{ display:flex; align-items:center; gap:16px; margin-bottom:14px; }
  .boss-sprite-sm{ width:64px; height:64px; object-fit:contain; flex-shrink:0; }
  .boss-info-top-right{ flex:1; min-width:0; }
  .type-icon-row-sm{ display:flex; gap:6px; margin-bottom:8px; }
  .stat-row-sm{ display:flex; gap:14px; flex-wrap:wrap; margin:0; }
  .stat-cell-sm{ display:flex; align-items:baseline; gap:5px; }
  .stat-label-sm{ font-family:'Manrope', sans-serif; font-weight:700; font-size:10px; color: var(--text-dim); text-transform:uppercase; }
  .stat-value-sm{ font-family:'Manrope', sans-serif; font-weight:800; font-size:14px; color: var(--blue-dark); margin:0; }
</style>
</head>
<body>

<div class="hamburger-panel" id="hamburgerPanel">
  <button type="button" class="hamburger-theme-toggle" id="themeToggle">🌙 Dark Mode</button>
  <div class="hamburger-section">
    <a href="../../index.html"><img src="../../assets/icons/favicon-32.png" alt="" style="width:18px;height:18px;border-radius:4px;margin-right:8px;flex-shrink:0;">Home</a>
  </div>
  <div class="hamburger-section">
    <div class="hamburger-section-label">Research</div>
    <a href="../../research.html" class="hamburger-featured">Most Used Raiders</a>
    <a href="../../ct-database.html" class="hamburger-featured">Viable Catch Tanks</a>
    <a href="../../solo-raid-mechanics.html" class="hamburger-featured">Solo Raid Mechanics</a>
    <a href="../../guides.html" class="hamburger-featured">Boss Guides</a>
    <a href="../../articles.html" class="hamburger-featured">Research Articles</a>
    <a href="../../meta-battle-parties.html">Meta Battle Parties</a>
    <a href="../../dps-calculator.html">DPS Calculator</a>
    <a href="../../move-data.html">Move Data</a>
    <a href="../../pokemon-stats.html">Pokémon Stats</a>
    <a href="../../reference.html">Difficulty &amp; Role Reference</a>
  </div>
  <div class="hamburger-section">
    <div class="hamburger-section-label">Raid Archives</div>
    <a href="../../tier4-raids.html">Mega</a>
    <a href="../../tier5-raids.html">Legendary</a>
    <a href="../../tier6-elite-raids.html">Mega Legendary &amp; Elite</a>
  </div>
  <div class="hamburger-section">
    <div class="hamburger-section-label">Resources</div>
    <a href="https://pokechespin.net/" target="_blank" rel="noopener noreferrer">Pokéchespin</a>
    <a href="https://docs.google.com/spreadsheets/d/1iT8T894SOM72vlWIC-43oQw3wUYfdtpgCUT2zvHkj0Y/edit?gid=1654946465#gid=1654946465" target="_blank" rel="noopener noreferrer">Solo Raid Spreadsheet</a>
    <a href="https://docs.google.com/spreadsheets/d/1LwHHk97yMIz2UC4VurEoZxdtXYrN_LdEiGI9JdmQSC0/edit?gid=1018733201#gid=1018733201" target="_blank" rel="noopener noreferrer">Raid Rotation Calculator</a>
    <a href="https://www.pokebattler.com/" target="_blank" rel="noopener noreferrer">Pokébattler</a>
  </div>
</div>

<div class="sticky-header">
  <div class="sticky-header-row">
    <div class="page-title-sm">Guide</div>
    <button class="hamburger-btn" id="hamburgerBtn" aria-label="Open navigation menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </div>
</div>

<article class="page">
  <div class="guide-eyebrow">Boss Guide</div>
  <h1 class="guide-title">How to Solo %%BOSS_NAME%%</h1>
  <div class="edit-guide-row">
    <a class="edit-guide-btn" href="../../guides.html">&#8592; All Guides</a>
    <a class="edit-guide-btn" href="../../editor.html?boss=%%BOSS_SLUG%%">&#9998; Edit this guide</a>
    <a class="edit-guide-btn collection-link" href="../../collections/%%BOSS_SLUG%%.html">&#9776; All strategies for this boss</a>\n    <button type="button" class="edit-guide-btn share-guide-btn" id="shareGuideBtn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg> Share</button>
  </div>

  <h2 class="section-title">Boss Info</h2>
  <div class="info-box">
    <div class="boss-sprite-row">
      <img class="boss-sprite" id="boss-sprite-img" alt="%%BOSS_NAME%%" onerror="this.style.display='none'">
    </div>
    <p class="boss-info-placeholder">Type, stats, and movepool haven't been added for this boss yet - edit this page to fill them in with THIS boss's own data (do not paste in another boss's Boss Info or moveset - see the site's other guide pages only for the HTML structure to match, never for the actual values).</p>
  </div>

  <h2 class="section-title">Routes</h2>
  <div class="route-row" id="route-row">
    <div class="load-state">Loading...</div>
  </div>

  <div id="strategy-display">
    <div class="load-state">Loading strategies...</div>
  </div>
</article>

<div class="mechanic-preview" id="mechanicPreview">
  <video id="mechanicPreviewVideo" autoplay loop muted playsinline preload="none"></video>
  <div class="mechanic-preview-label" id="mechanicPreviewLabel"></div>
</div>

<footer>Terms are defined as used within this archive; abbreviations match those shown on raid cards.</footer>

<script>
// Boss Info movepool not populated - no fast/charge-move-row elements exist for a boss without documented stats yet (see the placeholder note above)

// ============ SPRITE RESOLUTION (full system - was regressed to a naive version during
// an earlier rebuild of this page; restored here to match editor.html and the rest of the site) ============
const DB_OVERRIDES = {
  "mega lucario":"lucario-mega", "mega rayquaza":"rayquaza-mega", "mega mewtwo y":"mewtwo-mega-y", "mega mewtwo x":"mewtwo-mega-x", "mega charizard x":"charizard-mega-x", "mega charizard y":"charizard-mega-y",
  "mega beedrill":"beedrill-mega", "mega blaziken":"blaziken-mega", "mega gengar":"gengar-mega",
  "mega diancie":"diancie-mega", "mega alakazam":"alakazam-mega",
  "primal groudon":"groudon-primal", "primal kyogre":"kyogre-primal",
  "zacian crown":"zacian-crowned", "zacian hero":"zacian-hero", "zamazenta hero":"zamazenta-hero", "zamazenta crown":"zamazenta-crowned",
  "necrozma dawn wings":"necrozma-dawn-wings", "necrozma dusk mane":"necrozma-dusk-mane", "ndm":"necrozma-dusk-mane",
  "giratina altered":"giratina-altered", "giratina origin":"giratina-origin",
  "tornadus therian":"tornadus-therian", "tornadus incarnate":"tornadus-incarnate",
  "thundurus incarnate":"thundurus-incarnate", "enamorus therian":"enamorus-therian",
  "enamorus incarnate":"enamorus-incarnate", "kyurem white":"kyurem-white", "kyurem black":"kyurem-black",
  "mega heracross":"heracross-mega", "palkia origin":"palkia-origin",
  "mega raichu x":"raichu-mega-x", "mega raichu y":"raichu-mega-y", "mega complete zygarde":"zygarde-complete-mega",
};
const DEX_MAP = {
  "regigigas":486, "rampardos":409, "reshiram":643, "garchomp":445,
  "palkia":484, "dialga":483, "groudon":383, "mamoswine":473,
  "salamence":373, "gengar":94, "tyrantrum":697, "rhyperior":464,
  "kyogre":382, "mewtwo":150, "excadrill":530, "blaziken":257,
};
function toDbSlug(name){
  let n = name.trim().toLowerCase();
  if (DB_OVERRIDES[n]) return DB_OVERRIDES[n];
  n = n.replace(/^shadow\\s+/, "");
  if (DB_OVERRIDES[n]) return DB_OVERRIDES[n];
  const megaMatch = n.match(/^mega\\s+(.+)$/);
  if (megaMatch) return \`\${megaMatch[1].replace(/\\s+/g, "-")}-mega\`;
  const regionalMatch = n.match(/^(alolan|galarian|hisuian|paldean)\\s+(.+)$/);
  if (regionalMatch) return \`\${regionalMatch[2].replace(/\\s+/g, "-")}-\${regionalMatch[1]}\`;
  return n.replace(/\\s+/g, "-");
}
const GOHUB_OVERRIDES = {
  "mega raichu x": "https://db.pokemongohub.net/images/official/full/026_mega_x_with_bg.webp",
  "mega raichu y": "https://db.pokemongohub.net/images/official/full/026_mega_y_with_bg.webp",
  "mega complete zygarde": "https://db.pokemongohub.net/images/official/full/718_mega_with_bg.webp",
};
const ANI_OVERRIDES = {
  // Regional forms whose CDN filename does not follow the "<name>-<region>" rule the generic
  // regional branch produces. Each of these 404s without an entry here; the names were confirmed
  // against the sprite CDN rather than guessed.
  "galarian farfetch'd": "farfetchd-galarian",
  "galarian mr. mime": "mrmime-galarian",
  "hisuian basculin": "basculin-whitestriped",
  "hisuian zoroark": "zoroark-hisuian",
  "paldean wooper": "wooper-paldea",
  "galarian darmanitan": "darmanitan-galarianstandard",
  "galarian darmanitan zen": "darmanitan-galarianzen",
  "zacian crown": "zacian-crownedsword",
  "zamazenta crown": "zamazenta-crownedshield",
  "tapu koko": "tapukoko", "tapu lele": "tapulele", "tapu bulu": "tapubulu", "tapu fini": "tapufini",
  "necrozma dusk mane": "necrozma-duskmane", "ndm": "necrozma-duskmane",
  "necrozma dawn wings": "necrozma-dawnwings",
  "mega charizard x": "charizard-megax", "mega charizard y": "charizard-megay",
  "mega mewtwo x": "mewtwo-megax", "mega mewtwo y": "mewtwo-megay",
  "ho-oh": "hooh",
  "landorus i": "landorus-incarnate", "landorus-t": "landorus-therian",
  "thundurus i": "thundurus-incarnate", "thundurus t": "thundurus-therian",
  "tornadus i": "tornadus-incarnate", "tornadus t": "tornadus-therian",
};
const ANI_URL_OVERRIDES = {
  "palkia origin": "https://raw.githubusercontent.com/mgrann03/pokemon-resources/main/graphics/pogo-256/palkia-origin.png",
  "dialga origin": "https://raw.githubusercontent.com/mgrann03/pokemon-resources/main/graphics/pogo-256/dialga-origin.png",
};
// NOTE: no %%BOSS_SLUG%% placeholder in here. It used to sit between "audino-mega" and
// "banette-mega" - azelf's slot - and because the token replace is global it substituted
// there too, injecting the PAGE slug ("mega-garchomp") where a SPRITE slug
// ("garchomp-mega") belongs. Every regenerated guide then claimed a local sprite that does
// not exist, and lost the real "azelf" entry. A new boss's sprite is not local until
// someone adds the file, so no per-boss entry belongs here.
const LOCAL_SPRITES = new Set(["abomasnow-mega", "absol-mega", "aerodactyl-mega", "aggron-mega", "alakazam-mega", "altaria-mega", "ampharos-mega", "articuno", "audino-mega", "azelf", "banette-mega", "baxcalibur", "beedrill-mega", "blacephalon", "blastoise-mega", "blaziken", "blaziken-mega", "buzzwole", "camerupt-mega", "celesteela", "charizard-megax", "charizard-megay", "darkrai", "deoxys", "deoxys-attack", "dialga", "diancie-mega", "dragonite-mega", "enamorus-incarnate", "enamorus-therian", "entei", "eternatus", "excadrill", "gallade-mega", "garchomp", "garchomp-mega", "gardevoir-mega", "genesect", "gengar", "gengar-mega", "giratina-altered", "giratina-origin", "glalie-mega", "groudon", "groudon-primal", "guzzlord", "gyarados-mega", "heatran", "heracross-mega", "hooh", "houndoom-mega", "kangaskhan-mega", "kartana", "keldeo", "keldeo-resolute", "kyogre", "kyogre-primal", "kyurem", "kyurem-black", "kyurem-white", "landorus-incarnate", "landorus-therian", "latios", "lopunny-mega", "lucario-mega", "mamoswine", "manectric-mega", "mawile-mega", "medicham-mega", "metagross-mega", "mewtwo", "mewtwo-megay", "necrozma", "necrozma-dawnwings", "necrozma-duskmane", "nihilego", "palkia", "pheromosa", "pidgeot-mega", "pinsir-mega", "rampardos", "rayquaza-mega", "regidrago", "regieleki", "regigigas", "reshiram", "rhyperior", "sableye-mega", "salamence", "salamence-mega", "sceptile-mega", "scizor-mega", "sharpedo-mega", "skarmory-mega", "slowbro-mega", "solgaleo", "stakataka", "starmie-mega", "steelix-mega", "swampert-mega", "tapubulu", "tapukoko", "tapulele", "terrakion", "thundurus-incarnate", "thundurus-therian", "tornadus-incarnate", "tornadus-therian", "tyranitar-mega", "tyrantrum", "venusaur-mega", "virizion", "xerneas", "xurkitree", "yveltal", "zacian-crownedsword", "zamazenta-crownedshield", "zamazenta-hero", "zapdos", "zekrom"]);
function monSpriteUrl(name){
  const key = name.trim().toLowerCase();
  if (GOHUB_OVERRIDES[key]) return GOHUB_OVERRIDES[key];
  if (ANI_URL_OVERRIDES[key]) return ANI_URL_OVERRIDES[key];
  const slug = (ANI_OVERRIDES[key] || ANI_OVERRIDES[key.replace(/^shadow\\s+/, "")] || toDbSlug(name)).replace(/-alolan$/, "-alola");
  if (LOCAL_SPRITES.has(slug)) return \`../../assets/sprites/\${slug}.gif\`;
  return \`https://raw.githubusercontent.com/mgrann03/pokemon-resources/main/graphics/ani/\${slug}.gif\`;
}

function battleMonIconHtml(name){
  const isShadow = /^shadow\\s+/i.test(name.trim());
  const src = monSpriteUrl(name);
  if(isShadow){
    return \`<div class="battle-mon-icon shadow-mist"><img src="\${src}" alt="\${escapeAttr(name)}" title="\${escapeAttr(name)}" onerror="this.parentElement.style.background=\\'var(--accent-soft)\\'; this.remove();"></div>\`;
  }
  return \`<div class="battle-mon-icon"><img src="\${src}" alt="\${escapeAttr(name)}" title="\${escapeAttr(name)}" onerror="this.parentElement.style.background=\\'var(--accent-soft)\\'; this.remove();"></div>\`;
}
function roleBadgeClass(role){
  return \`role-badge role-\${role.toLowerCase().replace(/\\s+/g, '-')}\`;
}
function roleBadgesHtml(roles, escape){
  return (roles || []).map(r => \`<span class="\${roleBadgeClass(r)}">\${escape(r)}</span>\`).join('');
}
document.getElementById('boss-sprite-img').src = monSpriteUrl('%%BOSS_NAME_JS%%');

function routeLabel(s){
  const parts = [s.difficulty, s.weather];
  if(s.adventureEffect && s.adventureEffect !== "None") parts.push(s.adventureEffect);
  return parts.join(" \\u00b7 ");
}

function strategyBlockHtml(s){
  return \`
    <div class="strategy-block">
      \${s.strategyName ? \`<div class="strategy-name">\${escapeHtml(s.strategyName)}</div>\` : ""}
      <div class="strategy-tags">
        <span class="strategy-tag">\${escapeHtml(s.difficulty)}</span>
        <span class="strategy-tag">\${escapeHtml(s.weather)}</span>
        \${s.adventureEffect && s.adventureEffect !== "None" ? \`<span class="strategy-tag">\${escapeHtml(s.adventureEffect)}</span>\` : ""}
      </div>
      \${(s.battleParties && s.battleParties.length > 0) ? s.battleParties.map(p => \`
        <div class="battle-party">
          <div class="battle-party-label">\${escapeHtml(p.label)}</div>
          \${p.secondaryLabel ? \`<div class="battle-party-label-secondary">\${escapeHtml(p.secondaryLabel)}</div>\` : ""}
          \${p.mons.map(m => \`
            <div class="battle-mon\${m.optional ? " optional" : ""}">
              \${battleMonIconHtml(m.name)}
              <div>
                \${m.level || (m.roles && m.roles.length) || m.optional ? \`<div class="battle-mon-level">\${m.level ? \`Lv \${escapeHtml(m.level)}\` : ''}\${roleBadgesHtml(m.roles, escapeHtml)}\${m.optional ? ' <span class="optional-note">(Optional)</span>' : ""}</div>\` : ""}
                \${(m.fm || m.cm || m.cm2) ? \`<div class="battle-mon-meta">\${[m.fm, m.cm, m.cm2].filter(Boolean).map(escapeHtml).join(' / ')}</div>\` : ""}
              </div>
            </div>
          \`).join('')}
        </div>
      \`).join('') : ""}
      <div class="strategy-text">\${s.text}</div>
      \${(() => {
        const raw = (s.vods && s.vods.length) ? s.vods : (s.vod ? [s.vod] : []);
        if(raw.length === 0) return "";
        const vodList = raw.map(v => typeof v === "string" ? {url: v, label: ""} : v);
        return \`<div class="strategy-vod-row">\${vodList.map((v, i) => {
          const creditHtml = v.creditName ? \`<span class="strategy-vod-credit">by \${v.creditUrl ? \`<a href="\${escapeAttr(v.creditUrl)}" target="_blank" rel="noopener noreferrer">\${escapeHtml(v.creditName)}</a>\` : escapeHtml(v.creditName)}</span>\` : "";
          return \`<div class="strategy-vod-item"><a class="strategy-vod" href="\${escapeAttr(v.url)}" target="_blank" rel="noopener noreferrer">&#9654; \${v.label ? escapeHtml(v.label) : \`Watch VOD\${vodList.length > 1 ? \` \${i + 1}\` : ""}\`}</a>\${creditHtml}</div>\`;
        }).join("")}</div>\`;
      })()}
      \${s.submittedBy ? \`<div class="strategy-credit">Submitted by \${escapeHtml(s.submittedBy)}</div>\` : ""}
    </div>
  \`;
}

let loadedStrategies = [];

function strategyDropdownLabel(s, fallbackNum){
  return s.strategyName ? s.strategyName : \`Route \${fallbackNum}\`;
}

function selectRoute(index){
  document.querySelectorAll('.route-btn[data-index]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.index) === index);
  });
  document.querySelectorAll('.route-dropdown').forEach(dd => {
    const indices = (dd.dataset.indices || '').split(',').map(Number);
    dd.querySelector('.route-dropdown-toggle').classList.toggle('active', indices.includes(index));
    dd.querySelectorAll('.route-dropdown-item').forEach(item => {
      item.classList.toggle('active', Number(item.dataset.index) === index);
    });
    dd.classList.remove('open');
  });
  document.getElementById('strategy-display').innerHTML = strategyBlockHtml(loadedStrategies[index]);
}

function toggleRouteDropdown(btn){
  const dd = btn.closest('.route-dropdown');
  const wasOpen = dd.classList.contains('open');
  document.querySelectorAll('.route-dropdown.open').forEach(d => d.classList.remove('open'));
  if(!wasOpen) dd.classList.add('open');
}

document.addEventListener('click', (e) => {
  if(!e.target.closest('.route-dropdown')){
    document.querySelectorAll('.route-dropdown.open').forEach(d => d.classList.remove('open'));
  }
});

async function loadGuide(){
  const routeRow = document.getElementById('route-row');
  const strategyDisplay = document.getElementById('strategy-display');

  try{
    const res = await fetch('%%BOSS_SLUG%%.json', { cache: "no-store" });
    if(!res.ok) throw new Error(\`HTTP \${res.status}\`);
    const data = await res.json();

    if(!data.strategies || data.strategies.length === 0){
      strategyDisplay.innerHTML = '<div class="load-state">No strategies documented yet.</div>';
      routeRow.innerHTML = '<span class="load-state">No routes yet.</span>';
      return;
    }
    loadedStrategies = data.strategies;

    const groups = [];
    const groupIndexByLabel = new Map();
    data.strategies.forEach((s, i) => {
      const label = routeLabel(s);
      if(!groupIndexByLabel.has(label)){
        groupIndexByLabel.set(label, groups.length);
        groups.push({ label, indices: [] });
      }
      groups[groupIndexByLabel.get(label)].indices.push(i);
    });

    routeRow.innerHTML = groups.map(g => {
      if(g.indices.length === 1){
        const i = g.indices[0];
        return \`<button type="button" class="route-btn" data-index="\${i}" onclick="selectRoute(\${i})">\${escapeHtml(g.label)}</button>\`;
      }
      const items = g.indices.map((i, n) =>
        \`<button type="button" class="route-dropdown-item" data-index="\${i}" onclick="selectRoute(\${i})">\${escapeHtml(strategyDropdownLabel(data.strategies[i], n + 1))}</button>\`
      ).join('');
      return \`
        <div class="route-dropdown" data-indices="\${g.indices.join(',')}">
          <button type="button" class="route-btn route-dropdown-toggle" onclick="toggleRouteDropdown(this)">
            \${escapeHtml(g.label)}
            <svg class="route-dropdown-caret" viewBox="0 0 10 6" fill="none"><path d="M1 1L5 5L9 1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="route-dropdown-menu">\${items}</div>
        </div>
      \`;
    }).join('');

    selectRoute(0);
  }catch(e){
    strategyDisplay.innerHTML = \`<div class="load-error">Couldn't load strategy data: \${escapeHtml(e.message)}</div>\`;
    routeRow.innerHTML = '';
  }
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}
function escapeAttr(str){
  return escapeHtml(str).replace(/"/g, "&quot;");
}

loadGuide();

document.addEventListener('click', (e) => {
  const link = e.target.closest('.strategy-text a');
  if(!link) return;
  e.preventDefault();
  window.open(link.href, '_blank', 'noopener,noreferrer');
});

// ============ MECHANIC HOVER VIDEO PREVIEW ============
// Hovering a mechanic link for a moment shows a small bubble playing its reference clip, without
// having to click through to the mechanics page. Built on the same clip data solo-raid-mechanics.html
// already uses - matches a link's slug (from its #strategy-{slug} anchor) against each mechanic's
// own slug to find the right clip.
function mechanicSlug(name){
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
let mechanicClipMap = null;
async function loadMechanicClips(){
  try{
    const res = await fetch('../../data/raid-mechanics.json', { cache: "no-store" });
    if(!res.ok) return;
    const data = await res.json();
    mechanicClipMap = {};
    (data.sections || []).forEach(sec => {
      (sec.entries || []).forEach(e => {
        if(e.clip) mechanicClipMap[mechanicSlug(e.name)] = { clip: e.clip, name: e.name };
      });
    });
  }catch(err){
    mechanicClipMap = {};
  }
}
loadMechanicClips();

const mechanicPreview = document.getElementById('mechanicPreview');
const mechanicPreviewVideo = document.getElementById('mechanicPreviewVideo');
const mechanicPreviewLabel = document.getElementById('mechanicPreviewLabel');
let mechanicHoverTimer = null;

function showMechanicPreview(link){
  const match = link.href.match(/#strategy-([a-z0-9-]+)/i);
  if(!match || !mechanicClipMap) return;
  const entry = mechanicClipMap[match[1]];
  if(!entry) return;

  const rect = link.getBoundingClientRect();
  mechanicPreview.style.left = \`\${Math.max(8, Math.min(rect.left, window.innerWidth - 256))}px\`;
  const previewHeight = 170;
  const showAbove = rect.top > previewHeight + 12;
  mechanicPreview.style.top = showAbove ? \`\${rect.top - previewHeight - 8}px\` : \`\${rect.bottom + 8}px\`;

  mechanicPreviewVideo.querySelectorAll('source').forEach(s => s.remove());
  const mp4Source = document.createElement('source');
  mp4Source.src = \`../../\${entry.clip}\`;
  mp4Source.type = 'video/mp4';
  const webmSource = document.createElement('source');
  webmSource.src = \`../../\${entry.clip.replace(/\\.mp4($|\\?)/i, '.webm$1')}\`;
  webmSource.type = 'video/webm';
  mechanicPreviewVideo.appendChild(mp4Source);
  mechanicPreviewVideo.appendChild(webmSource);
  mechanicPreviewVideo.load();
  mechanicPreviewLabel.textContent = entry.name;
  mechanicPreview.classList.add('visible');
}
function hideMechanicPreview(){
  clearTimeout(mechanicHoverTimer);
  mechanicPreview.classList.remove('visible');
  mechanicPreviewVideo.pause();
}
document.addEventListener('mouseover', (e) => {
  const link = e.target.closest('.strategy-text a');
  if(!link) return;
  clearTimeout(mechanicHoverTimer);
  mechanicHoverTimer = setTimeout(() => showMechanicPreview(link), 500);
});
document.addEventListener('mouseout', (e) => {
  const link = e.target.closest('.strategy-text a');
  if(!link) return;
  if(link.contains(e.relatedTarget)) return;
  hideMechanicPreview();
});

const themeToggle = document.getElementById("themeToggle");
function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode";
  try{ localStorage.setItem("raidArchiveTheme", theme); }catch(e){}
}
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
});
let initialTheme = "light";
try{
  const saved = localStorage.getItem("raidArchiveTheme");
  if(saved){ initialTheme = saved; }
  else if(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches){ initialTheme = "dark"; }
}catch(e){}
applyTheme(initialTheme);

const hamburgerBtn = document.getElementById("hamburgerBtn");
const hamburgerPanel = document.getElementById("hamburgerPanel");
const shareGuideBtn = document.getElementById('shareGuideBtn');
shareGuideBtn.addEventListener('click', async () => {
  const shareData = { title: document.title, url: window.location.href };
  if(navigator.share){
    try{ await navigator.share(shareData); }
    catch(e){ /* user cancelled the share sheet - no action needed */ }
    return;
  }
  try{
    await navigator.clipboard.writeText(window.location.href);
    showShareCopiedState();
  }catch(e){
    prompt('Copy this link:', window.location.href);
  }
});
function showShareCopiedState(){
  shareGuideBtn.classList.add('copied');
  shareGuideBtn.innerHTML = '&#9989; Copied!';
  setTimeout(() => {
    shareGuideBtn.classList.remove('copied');
    shareGuideBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;"><line x1="7" y1="17" x2="17" y2="7"></line><polyline points="7 7 17 7 17 17"></polyline></svg> Share';
  }, 2000);
}

hamburgerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = hamburgerPanel.classList.contains("open");
  hamburgerPanel.classList.toggle("open", !isOpen);
  hamburgerBtn.setAttribute("aria-expanded", String(!isOpen));
});
document.addEventListener("click", (e) => {
  if(!hamburgerPanel.contains(e.target) && e.target !== hamburgerBtn){
    hamburgerPanel.classList.remove("open");
    hamburgerBtn.setAttribute("aria-expanded", "false");
  }
});
</script>
</body>
</html>
`;

const ARTICLE_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>%%ARTICLE_TITLE%% — Solo Raid Archive</title>
<link rel="icon" href="../assets/icons/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="../assets/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="../assets/icons/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="../assets/icons/favicon-180.png">
<link rel="canonical" href="https://soloraidarchive.github.io/articles/%%ARTICLE_SLUG%%.html">
<meta property="og:type" content="article">
<meta property="og:title" content="%%ARTICLE_TITLE%%">
<meta name="twitter:card" content="summary">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{
    --bg1: #ffffff; --bg2: #ffe4c9; --bg3: #f6c9ce; --bg: #ffffff; --card: #ffffff; --border: #e7edf5;
    --text: #2d3142; --text-muted: #6b7280; --text-dim: #9aa3b2;
    --accent: #3d9dff; --accent-soft: #eaf4ff; --accent-dark: #2b7fd6;
    --blue: #3d9dff; --blue-dark: #2b7fd6;
  }
  [data-theme="dark"]{
    --bg1: #0c0e1c; --bg2: #2a1830; --bg3: #6b3324; --bg4: #9c5024; --bg: #10131d; --card: #1c2030; --border: #323850;
    --text: #eef1f7; --text-muted: #a7afc0; --text-dim: #767f96;
    --accent: #5aa9ff; --accent-soft: #232840; --accent-dark: #8cc7ff;
    --blue: #5aa9ff; --blue-dark: #8cc7ff;
  }
  [data-theme="dark"] body{
    background: linear-gradient(180deg, #0c0e1c 0%, #2a1830 45%, #6b3324 80%, #9c5024 100%);
  }
  *{ box-sizing:border-box; }
  html{ max-width:100vw; }
  body{
    margin:0; overflow-x:hidden; background: linear-gradient(160deg, var(--bg1) 0%, var(--bg2) 55%, var(--bg3) 100%); color: var(--text);
    font-family: 'Inter', sans-serif; min-height:100vh;
  }
  .page{ max-width:680px; margin:0 auto; padding:20px 20px 60px; }
  .article-eyebrow{ font-family:'Manrope', sans-serif; font-weight:800; font-size:11.5px; text-transform:uppercase; letter-spacing:0.06em; color: var(--blue-dark); text-align:center; margin-bottom:8px; }
  .article-title{ font-family:'Manrope', sans-serif; font-weight:800; font-size:26px; margin:0 0 8px; text-align:center; line-height:1.3; }
  .edit-guide-row{ text-align:center; margin-bottom:14px; }
  .edit-guide-btn{
    display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700;
    color: var(--blue-dark); background: var(--accent-soft); padding:6px 14px; border-radius:999px;
    text-decoration:none;
  }
  .edit-guide-btn:hover{ background:#dcecff; }
  [data-theme="dark"] .edit-guide-btn:hover{ background:#2a3555; }
  .article-meta-row{ display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:28px; flex-wrap:wrap; }
  .article-category{
    display:inline-block; font-family:'Manrope', sans-serif; font-weight:800; font-size:11px;
    text-transform:uppercase; letter-spacing:0.03em; color: var(--blue-dark); background: var(--accent-soft);
    padding:5px 12px; border-radius:999px;
  }
  .article-byline{ font-size:12.5px; color: var(--text-dim); }
  .article-body{
    background: var(--card); border-radius:16px; padding:24px 26px; font-size:15px; line-height:1.4;
  }
  .article-body p{ margin:0 0 14px; }
  .article-body p:last-child{ margin-bottom:0; }
  .article-body strong{ font-weight:800; }
  .article-body a{ color:#0e8f82; font-weight:700; text-decoration:underline; text-underline-offset:2px; }
  [data-theme="dark"] .article-body a{ color:#5eead4; }
  .mechanic-preview{
    position:fixed; z-index:60; width:240px; background: var(--card); border:2px solid var(--border);
    border-radius:12px; padding:8px; box-shadow:0 10px 28px rgba(0,0,0,0.22);
    display:none; pointer-events:none;
  }
  .mechanic-preview.visible{ display:block; }
  .mechanic-preview video{ width:100%; border-radius:7px; display:block; background:#000; }
  .mechanic-preview-label{
    font-family:'Manrope', sans-serif; font-weight:800; font-size:11.5px; color: var(--text);
    margin-top:6px; text-align:center;
  }
  .article-body h2, .article-body h3, .article-body h4{ font-family:'Manrope', sans-serif; font-weight:800; margin:20px 0 10px; }
  .article-body ul, .article-body ol{ margin:0 0 14px; padding-left:22px; list-style:none; counter-reset:list-0; }
  .article-body li{ margin-bottom:4px; }
  .article-body li[data-list="bullet"]::before{ content:"\\2022"; display:inline-block; margin-left:-1.2em; margin-right:.3em; width:1em; }
  .article-body li[data-list="ordered"]{ counter-increment:list-0; }
  .article-body li[data-list="ordered"]::before{ content:counter(list-0) ". "; display:inline-block; margin-left:-1.4em; margin-right:.3em; width:1.2em; }
  .article-body img{ max-width:100%; height:auto; border-radius:8px; cursor:zoom-in; }
  @media (max-width: 600px){
    .article-body img[style*="float"]{ float:none !important; width:100% !important; margin:10px 0 !important; display:block; }
  }
  .img-lightbox-overlay{
    display:none; position:fixed; inset:0; background:rgba(10,12,20,0.9); z-index:9999;
    align-items:center; justify-content:center; padding:24px; cursor:zoom-out;
  }
  .img-lightbox-overlay.visible{ display:flex; }
  .img-lightbox-img{ max-width:100%; max-height:100%; border-radius:8px; box-shadow:0 12px 40px rgba(0,0,0,0.5); cursor:default; }
  .img-lightbox-close{
    position:absolute; top:16px; right:16px; width:40px; height:40px; border-radius:50%;
    background:rgba(255,255,255,0.12); color:#fff; border:none; font-size:22px; line-height:1;
    cursor:pointer; display:flex; align-items:center; justify-content:center;
  }
  .img-lightbox-close:hover{ background:rgba(255,255,255,0.25); }
  .article-body blockquote{
    border-left:3px solid var(--accent); margin:14px 0; padding:4px 0 4px 14px; color: var(--text-muted); font-style:italic;
  }
  .article-table{ width:100%; border-collapse:collapse; margin:14px 0; font-size:13px; }
  .article-table th, .article-table td{ border:1.5px solid var(--text-dim); padding:8px 10px; text-align:left; }
  .article-table th{ background: var(--accent-soft); font-family:'Manrope', sans-serif; font-weight:800; }
  .article-table tr:nth-child(even) td{ background: var(--bg1); }

  .battle-party{ background: var(--accent-soft); border-radius:12px; padding:12px 14px; margin:14px 0; }
  @media (min-width:601px){
    .battle-party{ display:grid; grid-template-columns: 1fr 1fr; gap:2px 20px; align-items:start; }
    .battle-party-label{ grid-column: 1 / -1; }
  }
  .battle-party-label{ font-family:'Manrope', sans-serif; font-weight:800; font-size:12.5px; color: var(--blue-dark); margin-bottom:8px; }
  .battle-mon{ display:flex; align-items:center; gap:8px; padding:3px 0; font-size:12.5px; }
  .battle-mon-icon{ width:28px; height:28px; border-radius:50%; background: var(--card); flex-shrink:0; overflow:hidden; display:flex; align-items:center; justify-content:center; position:relative; }
  .battle-mon-icon.shadow-mist{
    background: radial-gradient(circle, rgba(58,12,92,0.85) 0%, rgba(30,6,54,0.7) 55%, rgba(12,4,24,0.55) 100%);
    box-shadow: 0 0 8px rgba(88,28,135,0.7), inset 0 0 8px rgba(0,0,0,0.45);
  }
  .battle-mon-icon.shadow-mist::after{
    content:""; position:absolute; z-index:1; pointer-events:none;
    top:-60%; left:-30%; width:160%; height:220%;
    background: radial-gradient(ellipse 40% 28% at 50% 75%, rgba(168,85,247,0.7) 0%, rgba(147,51,234,0) 65%);
    animation: shadowMistRise 4.5s cubic-bezier(0.33, 0, 0.4, 1) infinite;
  }
  @keyframes shadowMistRise{
    0%{ transform: translateY(28%) scale(0.75); opacity:0; }
    15%{ opacity:0.7; }
    55%{ opacity:0.55; }
    100%{ transform: translateY(-52%) scale(1.15); opacity:0; }
  }
  .battle-mon-icon img{ width:100%; height:100%; object-fit:contain; position:relative; z-index:2; }
  .battle-mon-meta{ color: var(--text-dim); font-size:11px; }
  .battle-mon-level{ font-weight:700; font-size:11px; color: var(--text); }
  .role-badge{
    display:inline-block; font-size:10px; font-weight:800; text-transform:uppercase;
    letter-spacing:0.03em; padding:1px 7px; border-radius:999px; margin:1px 4px 1px 0; vertical-align:1px;
  }
  .role-badge.role-main-dps{ background:#ffe1e1; color:#c62828; }
  .role-badge.role-support-dps{ background:#dff5f3; color:#00897b; }
  .role-badge.role-catch-tank{ background:#f2ebff; color:#7d4fd6; }
  .role-badge.role-executor{ background:#e9e9eb; color:#292929; }
  [data-theme="dark"] .role-badge.role-main-dps{ background:rgba(220,53,69,0.22); color:#ff9494; }
  [data-theme="dark"] .role-badge.role-support-dps{ background:rgba(0,150,136,0.22); color:#5eded4; }
  [data-theme="dark"] .role-badge.role-catch-tank{ background:rgba(155,123,240,0.2); color:#c1a8ff; }
  [data-theme="dark"] .role-badge.role-executor{ background:rgba(255,255,255,0.14); color:#e4e4e6; }
  // Level+role and the moveset are always stacked as two rows (level/role on top, moves
  // underneath) - this used to force them onto one flex row with a middle-dot separator at
  // >=601px, cramming everything onto one crowded line on desktop. Removed so the layout is the
  // same clean two-row block at every width, matching what mobile already did by default.
  @media (min-width: 601px){
    .battle-mon{ padding:4px 0; }
  }
  .battle-mon.optional{
    border:1.5px dashed #d9a441; background: rgba(224,160,32,0.08); border-radius:8px;
    padding:5px 7px; margin:2px 0;
  }
  .optional-note{ font-weight:600; color:#b8791a; font-size:10px; }
  [data-theme="dark"] .optional-note{ color:#e0b060; }

  footer{
    text-align:center; padding: 24px; font-size:12px; color: var(--text-dim);
    font-family:'Inter', sans-serif; border-top: 1px solid var(--border); margin-top:20px;
  }

  .sticky-header{
    position:sticky; top:0; z-index:15; background: var(--bg1);
    padding: 10px 16px; border-bottom: 1px solid var(--border);
  }
  .sticky-header-row{ display:flex; align-items:center; justify-content:center; gap:8px; width:100%; position:relative; }
  .sticky-header-row .hamburger-btn{ position:absolute; right:0; }
  .page-title-sm{ font-family:'Manrope', sans-serif; font-weight:800; font-size:18px; margin:0; color: var(--text); text-align:center; }

  .hamburger-btn{
    flex-shrink:0; z-index:20; -webkit-tap-highlight-color:transparent;
    width:38px; height:38px; border-radius:50%;
    background: var(--card); border:2px solid var(--border);
    cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:4px; box-shadow: 0 3px 0 rgba(0,0,0,0.06); transition: transform .15s;
  }
  .hamburger-btn:hover{ transform: translateY(-2px); }
  .hamburger-btn span{ display:block; width:19px; height:2.5px; border-radius:2px; background: var(--text); transition: transform .2s ease, opacity .2s ease; }
  .hamburger-btn[aria-expanded="true"] span:nth-child(1){ transform: translateY(6.5px) rotate(45deg); }
  .hamburger-btn[aria-expanded="true"] span:nth-child(2){ opacity:0; }
  .hamburger-btn[aria-expanded="true"] span:nth-child(3){ transform: translateY(-6.5px) rotate(-45deg); }
  .hamburger-panel{
    position:fixed; top:66px; right:16px; z-index:19; width:min(240px, calc(100vw - 32px));
    background: var(--card); border:2px solid var(--border); border-radius:16px;
    padding:10px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
    display:none; flex-direction:column; gap:14px; max-height:calc(100vh - 96px); overflow-y:auto;
  }
  .hamburger-panel.open{ display:flex; }
  .hamburger-theme-toggle{
    display:flex; align-items:center; justify-content:center; gap:6px;
    width:100%; padding:12px 10px; font-family:'Manrope', sans-serif; font-weight:700;
    font-size:14px; color: var(--text); background: var(--card); border:2px solid var(--border);
    border-radius:10px; cursor:pointer; min-height:44px; box-sizing:border-box;
  }
  .hamburger-theme-toggle:hover{ border-color: var(--accent); color: var(--accent-dark); }
  .hamburger-section-label{
    font-family:'Manrope', sans-serif; font-weight:800; font-size:11px; text-transform:uppercase;
    letter-spacing:0.05em; color: var(--text-dim); padding:6px 10px 4px;
  }
  .hamburger-section a{
    display:flex; align-items:center; padding:10px; font-family:'Manrope', sans-serif; font-weight:700;
    font-size:13.5px; color: var(--text); text-decoration:none; border-radius:10px;
    min-height:40px; box-sizing:border-box; word-break:break-word; line-height:1.3;
  }
  .hamburger-section a:hover{ background: var(--bg1); color: var(--accent-dark); }
  .hamburger-section a.current{ background: var(--accent); color:#fff; }
  .hamburger-section a.hamburger-featured{
    border: 2px solid transparent !important;
    background-image:
      linear-gradient(var(--card), var(--card)),
      linear-gradient(90deg, #3d9dff, #b5d4f4, #ffd77a, #3d9dff, #b5d4f4, #ffd77a);
    background-origin: padding-box, border-box;
    background-clip: padding-box, border-box;
    background-size: 100% 100%, 300% 100%;
    animation: hamburgerShine 4s linear infinite;
  }
  @keyframes hamburgerShine{
    0%{ background-position: 0 0, 0% 0; }
    100%{ background-position: 0 0, 100% 0; }
  }
</style>
</head>
<body>

<div class="hamburger-panel" id="hamburgerPanel">
  <button type="button" class="hamburger-theme-toggle" id="themeToggle">🌙 Dark Mode</button>
  <div class="hamburger-section">
    <a href="../index.html"><img src="../assets/icons/favicon-32.png" alt="" style="width:18px;height:18px;border-radius:4px;margin-right:8px;flex-shrink:0;">Home</a>
  </div>
  <div class="hamburger-section">
    <div class="hamburger-section-label">Research</div>
    <a href="../research.html">Most Used Raiders</a>
    <a href="../ct-database.html">Viable Catch Tanks</a>
    <a href="../solo-raid-mechanics.html">Solo Raid Mechanics</a>
    <a href="../guides.html" class="hamburger-featured">Boss Guides</a>
    <a href="../articles.html" class="hamburger-featured">Research Articles</a>
    <a href="../meta-battle-parties.html">Meta Battle Parties</a>
    <a href="../dps-calculator.html">DPS Calculator</a>
    <a href="../move-data.html">Move Data</a>
    <a href="../pokemon-stats.html">Pokémon Stats</a>
    <a href="../reference.html">Difficulty &amp; Role Reference</a>
  </div>
  <div class="hamburger-section">
    <div class="hamburger-section-label">Raid Archives</div>
    <a href="../tier4-raids.html">Mega</a>
    <a href="../tier5-raids.html">Legendary</a>
    <a href="../tier6-elite-raids.html">Mega Legendary &amp; Elite</a>
  </div>
</div>

<div class="sticky-header">
  <div class="sticky-header-row">
    <h1 class="page-title-sm">Article</h1>
    <button class="hamburger-btn" id="hamburgerBtn" aria-label="Open navigation menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
  </div>
</div>

<div class="page">
  <div class="article-eyebrow">Research Article</div>
  <h1 class="article-title">%%ARTICLE_TITLE%%</h1>
  <div class="edit-guide-row">
    <a class="edit-guide-btn" href="../articles.html">&#8592; All Articles</a>
    <a class="edit-guide-btn" href="../editor.html?mode=article&article=%%ARTICLE_SLUG%%">&#9998; Edit this article</a>
  </div>
  <div class="article-meta-row">
    <span class="article-category">%%ARTICLE_CATEGORY%%</span>
    <span class="article-byline">By %%ARTICLE_AUTHOR%%</span>
  </div>
  <div class="article-body">%%ARTICLE_BODY%%</div>
</div>

<div class="img-lightbox-overlay" id="imgLightboxOverlay">
  <button type="button" class="img-lightbox-close" id="imgLightboxCloseBtn" aria-label="Close">&times;</button>
  <img class="img-lightbox-img" id="imgLightboxImg" src="" alt="">
</div>

<div class="mechanic-preview" id="mechanicPreview">
  <video id="mechanicPreviewVideo" autoplay loop muted playsinline preload="none"></video>
  <div class="mechanic-preview-label" id="mechanicPreviewLabel"></div>
</div>

<footer>Terms are defined as used within this archive; abbreviations match those shown on raid cards.</footer>

<script>
const imgLightboxOverlay = document.getElementById('imgLightboxOverlay');
const imgLightboxImg = document.getElementById('imgLightboxImg');
function openImgLightbox(src, alt){
  imgLightboxImg.src = src;
  imgLightboxImg.alt = alt || '';
  imgLightboxOverlay.classList.add('visible');
}
function closeImgLightbox(){
  imgLightboxOverlay.classList.remove('visible');
  imgLightboxImg.src = '';
}
document.addEventListener('click', (e) => {
  const img = e.target.closest('.article-body img');
  if(img){ openImgLightbox(img.currentSrc || img.src, img.alt); return; }
  if(e.target === imgLightboxOverlay) closeImgLightbox();
});
document.getElementById('imgLightboxCloseBtn').addEventListener('click', closeImgLightbox);
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeImgLightbox(); });

const themeToggle = document.getElementById("themeToggle");
function applyTheme(theme){
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "☀️ Light Mode" : "🌙 Dark Mode";
  try{ localStorage.setItem("raidArchiveTheme", theme); }catch(e){}
}
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  applyTheme(current === "dark" ? "light" : "dark");
});
let initialTheme = "light";
try{
  const saved = localStorage.getItem("raidArchiveTheme");
  if(saved){ initialTheme = saved; }
  else if(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches){ initialTheme = "dark"; }
}catch(e){}
applyTheme(initialTheme);

const hamburgerBtn = document.getElementById("hamburgerBtn");
const hamburgerPanel = document.getElementById("hamburgerPanel");
hamburgerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = hamburgerPanel.classList.contains("open");
  hamburgerPanel.classList.toggle("open", !isOpen);
  hamburgerBtn.setAttribute("aria-expanded", String(!isOpen));
});
document.addEventListener("click", (e) => {
  if(!hamburgerPanel.contains(e.target) && e.target !== hamburgerBtn){
    hamburgerPanel.classList.remove("open");
    hamburgerBtn.setAttribute("aria-expanded", "false");
  }
});

// mechanic links open in a new tab, matching guide pages
document.addEventListener('click', e => {
  const link = e.target.closest('.article-body a');
  if(link && link.href){
    e.preventDefault();
    window.open(link.href, '_blank', 'noopener,noreferrer');
  }
});

// ============ MECHANIC HOVER VIDEO PREVIEW ============
// Same as the guide-page version, but this template lives one folder deep (articles/{slug}.html),
// not two, so paths use a single ../ instead of ../../.
function mechanicSlug(name){
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
let mechanicClipMap = null;
async function loadMechanicClips(){
  try{
    const res = await fetch('../data/raid-mechanics.json', { cache: "no-store" });
    if(!res.ok) return;
    const data = await res.json();
    mechanicClipMap = {};
    (data.sections || []).forEach(sec => {
      (sec.entries || []).forEach(e => {
        if(e.clip) mechanicClipMap[mechanicSlug(e.name)] = { clip: e.clip, name: e.name };
      });
    });
  }catch(err){
    mechanicClipMap = {};
  }
}
loadMechanicClips();

const mechanicPreview = document.getElementById('mechanicPreview');
const mechanicPreviewVideo = document.getElementById('mechanicPreviewVideo');
const mechanicPreviewLabel = document.getElementById('mechanicPreviewLabel');
let mechanicHoverTimer = null;

function showMechanicPreview(link){
  const match = link.href.match(/#strategy-([a-z0-9-]+)/i);
  if(!match || !mechanicClipMap) return;
  const entry = mechanicClipMap[match[1]];
  if(!entry) return;

  const rect = link.getBoundingClientRect();
  mechanicPreview.style.left = \`\${Math.max(8, Math.min(rect.left, window.innerWidth - 256))}px\`;
  const previewHeight = 170;
  const showAbove = rect.top > previewHeight + 12;
  mechanicPreview.style.top = showAbove ? \`\${rect.top - previewHeight - 8}px\` : \`\${rect.bottom + 8}px\`;

  mechanicPreviewVideo.querySelectorAll('source').forEach(s => s.remove());
  const mp4Source = document.createElement('source');
  mp4Source.src = \`../\${entry.clip}\`;
  mp4Source.type = 'video/mp4';
  const webmSource = document.createElement('source');
  webmSource.src = \`../\${entry.clip.replace(/\\.mp4($|\\?)/i, '.webm$1')}\`;
  webmSource.type = 'video/webm';
  mechanicPreviewVideo.appendChild(mp4Source);
  mechanicPreviewVideo.appendChild(webmSource);
  mechanicPreviewVideo.load();
  mechanicPreviewLabel.textContent = entry.name;
  mechanicPreview.classList.add('visible');
}
function hideMechanicPreview(){
  clearTimeout(mechanicHoverTimer);
  mechanicPreview.classList.remove('visible');
  mechanicPreviewVideo.pause();
}
document.addEventListener('mouseover', (e) => {
  const link = e.target.closest('.article-body a');
  if(!link) return;
  clearTimeout(mechanicHoverTimer);
  mechanicHoverTimer = setTimeout(() => showMechanicPreview(link), 500);
});
document.addEventListener('mouseout', (e) => {
  const link = e.target.closest('.article-body a');
  if(!link) return;
  if(link.contains(e.relatedTarget)) return;
  hideMechanicPreview();
});
</script>

</body>
</html>
`;

export default {
  async fetch(request, env){
    if(request.method === "OPTIONS") return corsResponse(new Response(null, { status: 204 }));
    if(request.method !== "POST") return corsResponse(jsonError("Method not allowed", 405));

    let submission;
    try{
      submission = await request.json();
    }catch(e){
      return corsResponse(jsonError("Invalid JSON body", 400));
    }

    const type = submission && submission.type;

    try{
      // Deletions never merge anything themselves - like every other submission, they only open
      // a PR (via the same branch/commit/PR flow below) for a soloraidarchive owner to review.
      // The GITHUB_TOKEN this Worker uses only needs Contents/Pull-requests write on this repo,
      // never merge rights on main - the open, unmerged PR sitting there IS the "requires owner
      // confirmation" mechanism.
      if(type === "delete_guide"){
        const validationError = validateDeleteGuideSubmission(submission);
        if(validationError) return corsResponse(jsonError(validationError, 400));
        const prUrl = await deleteGuide(submission, env.GITHUB_TOKEN);
        return corsResponse(new Response(JSON.stringify({ ok: true, prUrl }), {
          headers: { "Content-Type": "application/json" },
        }));
      }
      if(type === "delete_route"){
        const validationError = validateDeleteRouteSubmission(submission);
        if(validationError) return corsResponse(jsonError(validationError, 400));
        const prUrl = await deleteRoute(submission, env.GITHUB_TOKEN);
        return corsResponse(new Response(JSON.stringify({ ok: true, prUrl }), {
          headers: { "Content-Type": "application/json" },
        }));
      }

      const isArticle = type === "article";
      const validationError = isArticle ? validateArticleSubmission(submission) : validateSubmission(submission);
      if(validationError) return corsResponse(jsonError(validationError, 400));

      const prUrl = isArticle
        ? await submitArticle(submission, env.GITHUB_TOKEN)
        : await submitStrategy(submission, env.GITHUB_TOKEN);
      return corsResponse(new Response(JSON.stringify({ ok: true, prUrl }), {
        headers: { "Content-Type": "application/json" },
      }));
    }catch(e){
      return corsResponse(jsonError(`Submission failed: ${e.message}`, 500));
    }
  },
};

function validateSubmission(s){
  if(!s || typeof s !== "object") return "Missing submission body";
  const required = ["boss", "weather", "difficulty", "text"];
  for(const field of required){
    if(!s[field] || typeof s[field] !== "string" || !s[field].trim()){
      return `Missing required field: ${field}`;
    }
  }
  if(!/[a-z0-9]/i.test(s.boss)) return "Boss name must contain at least one letter or number";
  if(s.text.length > 10000) return "Strategy text too long (max 10,000 characters)";
  if(s.vods){
    if(!Array.isArray(s.vods)) return "VOD links must be an array";
    for(const v of s.vods){
      const url = typeof v === "string" ? v : v.url;
      if(!url || !/^https?:\/\//.test(url)) return "Each VOD link must be a valid URL";
      if(typeof v === "object" && v.label && v.label.length > 80) return "VOD label too long (max 80 characters)";
    }
  }
  if(s.vod && !/^https?:\/\//.test(s.vod)) return "VOD link must be a valid URL";
  if(s.imageBase64 && s.imageBase64.length > 7_000_000) return "Image too large (max ~5MB)";
  return null;
}

function validateArticleSubmission(s){
  if(!s || typeof s !== "object") return "Missing submission body";
  const required = ["title", "category", "body"];
  for(const field of required){
    if(!s[field] || typeof s[field] !== "string" || !s[field].trim()){
      return `Missing required field: ${field}`;
    }
  }
  if(s.body.length > 10000) return "Article body too long (max 10,000 characters)";
  if(s.title.length > 200) return "Article title too long (max 200 characters)";
  if(s.images){
    if(!Array.isArray(s.images)) return "Images must be an array";
    if(s.images.length > 10) return "Too many images (max 10 per article)";
    for(const img of s.images){
      if(img.base64 && img.base64.length > 7_000_000) return "One of the uploaded images is too large (max ~5MB)";
    }
  }
  return null;
}

function validateDeleteGuideSubmission(s){
  if(!s || typeof s !== "object") return "Missing submission body";
  if(!s.boss || typeof s.boss !== "string" || !s.boss.trim()) return "Missing boss name";
  if(!/[a-z0-9]/i.test(s.boss)) return "Boss name must contain at least one letter or number";
  if(s.reason && s.reason.length > 500) return "Reason too long (max 500 characters)";
  return null;
}

function validateDeleteRouteSubmission(s){
  if(!s || typeof s !== "object") return "Missing submission body";
  if(!s.boss || typeof s.boss !== "string" || !s.boss.trim()) return "Missing boss name";
  if(typeof s.deleteIndex !== "number" || !Number.isInteger(s.deleteIndex) || s.deleteIndex < 0){
    return "Missing or invalid deleteIndex";
  }
  if(s.reason && s.reason.length > 500) return "Reason too long (max 500 characters)";
  return null;
}

// Type-color palette used consistently across the site (move-data.html, dps-calculator.html) for
// type badges and move-chip icons - stable/small enough to hardcode rather than fetch.
const TYPE_COLORS = {
  Normal: "#9199A1", Fire: "#E2661C", Water: "#3E8DE0", Electric: "#E0B316",
  Grass: "#4E9A3A", Ice: "#5AC9C9", Fighting: "#A2402A", Poison: "#8A3F94",
  Ground: "#6B4423", Flying: "#8B93E0", Psychic: "#E0426E", Bug: "#7B9A1E",
  Rock: "#B5651D", Ghost: "#5B4B8A", Dragon: "#5B3FE0", Dark: "#4A4238",
  Steel: "#7A8A9A", Fairy: "#E091C9",
};

// dps-calculator.html already has everything needed to fill in a boss's ATK/DEF/HP, type(s), and
// full fast/charge movepool - it's the same data every hand-filled Boss Info box (Lunala, Azelf,
// Nihilego) was manually copied from, confirmed by checking that this file's POKEMON_MOVEPOOL
// entries match those three pages' committed move lists exactly. One fetch here builds all three
// lookups so submitStrategy/deleteRoute only need to hit the network once per submission.
// Parsed with regexes rather than eval'd - the file content is trusted (it's this same repo), but
// there's no reason to execute it as code when the values needed can be pulled out directly.
// Reads a CSV from the repo and returns rows as objects keyed by the header.
async function fetchRepoCsv(gh, path){
  const res = await gh(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${BASE_BRANCH}`);
  if(!res.ok) return null;
  const body = await res.json();
  const lines = decodeBase64(body.content).split(/\r?\n/).filter(l => l.trim());
  if(!lines.length) return null;
  const header = lines.shift().split(",").map(h => h.trim().toLowerCase());
  return lines.map(l => {
    const c = l.split(",");
    const o = {};
    header.forEach((h, i) => { o[h] = (c[i] || "").trim(); });
    return o;
  });
}

async function getPokemonRaidDb(gh){
  const res = await gh(`/repos/${OWNER}/${REPO}/contents/dps-calculator.html?ref=${BASE_BRANCH}`);
  if(!res.ok) return null;
  const body = await res.json();
  const html = decodeBase64(body.content);

  // Stats and types come from csv/pokemon-stats.csv, not from an inline POKEMON_DB array in
  // dps-calculator.html. That array was removed when the data moved to CSV; this function kept
  // scraping for it, silently got zero rows, and every new guide therefore fell through to the
  // "stats haven't been added" placeholder. That is why Mega Starmie, Mega Raichu Y and Mega
  // Dragonite came out blank while older guides - written before the move - did not.
  const statsMap = new Map();
  const typesMap = new Map();
  const statRows = await fetchRepoCsv(gh, "csv/pokemon-stats.csv");
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

  // Kept as a fallback: if the CSV read fails the old inline arrays are still honoured, so a
  // network hiccup degrades to the previous behaviour rather than to nothing.
  const typesMatch = statsMap.size ? null : html.match(/const POKEMON_TYPES = \[([\s\S]*?)\n\];/);
  if(typesMatch){
    const re = /\{n:"([^"]+)",t1:"([^"]*)",t2:"([^"]*)"\}/g;
    let m;
    while((m = re.exec(typesMatch[1])) !== null){
      typesMap.set(m[1].trim().toLowerCase(), [m[2], m[3]].filter(Boolean));
    }
  }

  // Same explicit Mega/Primal -> base-species map dps-calculator.html itself uses (rather than
  // guessing a base name by stripping "Mega "/"Primal " off the string, which gets Mega Complete
  // Zygarde or Mega Raichu X/Y wrong). Read directly from that page's own source instead of
  // keeping a second hand-copied version in the worker, so there's exactly one place this
  // mapping is ever defined or edited.
  const baseFormMap = new Map();
  const baseFormMatch = html.match(/const BASE_FORM_MAP = \{([\s\S]*?)\n\};/);
  if(baseFormMatch){
    const re = /"([^"]+)":\s*"([^"]+)"/g;
    let m;
    while((m = re.exec(baseFormMatch[1])) !== null){
      baseFormMap.set(m[1], m[2]);
    }
  }

  // Elite-TM-exclusive moves must be stripped from a boss's displayed movepool: a real raid boss
  // can never have one (they're only obtainable by a player spending an Elite TM). Same list the
  // dps-calculator.html uses to filter its boss dropdown - fetched here so a generated guide page's
  // Boss Info shows only moves a boss can actually appear with. Failure to load just means no
  // filtering (movepool shown as-is), rather than blocking the whole submission.
  const eliteMap = new Map();
  // data/elite-moves.csv was deleted; the elite flag now lives as a column on
  // csv/pokemon-movepool.csv and is already applied when movepoolMap is built above, so there is
  // nothing to load here.

  // Same story as the stats: POKEMON_MOVEPOOL moved to csv/pokemon-movepool.csv, which also
  // carries an `elite` column, so elite moves are excluded at the source rather than subtracted
  // from a separate list afterwards.
  const movepoolMap = new Map();
  const mpRows = await fetchRepoCsv(gh, "csv/pokemon-movepool.csv");
  if(mpRows){
    for(const r of mpRows){
      const key = (r.pokemon || "").trim().toLowerCase();
      const move = (r.move || "").trim();
      if(!key || !move) continue;
      if(/^(y|yes|true|1)$/i.test(r.elite || "")) continue;
      if(!movepoolMap.has(key)) movepoolMap.set(key, { fast: [], charged: [] });
      const e = movepoolMap.get(key);
      ((r.category || "").trim().toLowerCase() === "fast" ? e.fast : e.charged).push(move);
    }
  }

  const movepoolMatch = movepoolMap.size ? null : html.match(/const POKEMON_MOVEPOOL = \{([\s\S]*?)\n\};/);
  if(movepoolMatch){
    const re = /"([^"]+)":\{fast:\[([^\]]*)\],charged:\[([^\]]*)\]\}/g;
    let m;
    const parseList = s => s.split(",").map(x => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
    while((m = re.exec(movepoolMatch[1])) !== null){
      const key = m[1].trim().toLowerCase();
      // Elite moves are keyed by base species (e.g. "salamence"), while a boss may be "mega
      // salamence" - resolve through baseFormMap (extracted above from dps-calculator.html's own
      // BASE_FORM_MAP) rather than guessing the base name by stripping "mega "/"primal "/
      // "shadow " off the string, which silently fails for anything not literally shaped like
      // "<prefix> <base name>" - e.g. Mega Complete Zygarde's real base is "zygarde 50%".
      const baseKey = baseFormMap.get(key);
      const elite = eliteMap.get(key) || (baseKey && eliteMap.get(baseKey)) || null;
      let fast = parseList(m[2]);
      let charged = parseList(m[3]);
      if(elite){
        fast = fast.filter(mv => !elite.has(mv));
        charged = charged.filter(mv => !elite.has(mv));
      }
      movepoolMap.set(key, { fast, charged });
    }
  }

  // csv/moves.csv rather than the removed inline MOVE_DB - without this every auto-filled move
  // chip renders in the fallback grey with no type icon.
  const moveTypeMap = new Map();
  const moveRows = await fetchRepoCsv(gh, "csv/moves.csv");
  if(moveRows){
    for(const r of moveRows){
      const n = (r.name || "").trim(), t = (r.type || "").trim();
      if(n && t) moveTypeMap.set(n, t);
    }
  }
  const moveDbMatch = moveTypeMap.size ? null : html.match(/const MOVE_DB = \[([\s\S]*?)\n\];/);
  if(moveDbMatch){
    const re = /\{n:"([^"]+)",dmg:[\d.]+,energy:-?[\d.]+,ad:[\d.]+,type:"(?:Fast|Charge)",elem:"([^"]+)"\}/g;
    let m;
    while((m = re.exec(moveDbMatch[1])) !== null) moveTypeMap.set(m[1].trim(), m[2]);
  }

  // tier4-raids.html ("Mega Raids" on the site) is the live roster of every current, ordinary
  // (non-Legendary, non-Legends-Z-A) Mega Raid boss - those raids run at a 9,000 HP pool rather
  // than the 15,000 used by 5-star legendary/mythical raids. Pulling this list live rather than
  // hardcoding it means it never goes stale as Niantic rotates Mega Raids in and out.
  const tier4MegaSet = new Set();
  // Tier 4 Megas come from csv/tier4-data.csv. This used to scrape BOSS_BASE_STATS out of
  // tier4-raids.html, but that array went away when the page became a boss index reading the CSV
  // live - so the set was silently empty and computeRaidBossStats() gave every Mega the Tier 5
  // HP figure instead of 9000.
  const tier4Rows = await fetchRepoCsv(gh, "csv/tier4-data.csv");
  if(tier4Rows){
    for(const r of tier4Rows){
      const n = (r["boss name"] || "").trim().toLowerCase();
      if(n) tier4MegaSet.add(n);
    }
  }

  return { statsMap, typesMap, movepoolMap, moveTypeMap, tier4MegaSet, baseFormMap };
}

// Megas/Primals/X-Y variants aren't listed separately in POKEMON_TYPES when they don't change
// type from their base species (which is true for every boss on this site so far) - this only
// affects the TYPE lookup; POKEMON_MOVEPOOL and POKEMON_DB already key Megas by their full name
// directly (e.g. "mega blaziken"), no fallback needed for those.
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

function moveChipTypesObjectLiteral(moveNames, moveTypeMap){
  const lines = [];
  for(const name of moveNames){
    const elem = moveTypeMap.get(name);
    if(!elem) continue; // no icon for this one - moveChipHtml already degrades gracefully, matches existing behavior
    lines.push(`  ${JSON.stringify(name)}: {type:${JSON.stringify(elem)}, color:${JSON.stringify(TYPE_COLORS[elem] || "#9199A1")}},`);
  }
  return `const MOVE_TYPES = {\n${lines.join("\n")}\n};`;
}

// Builds the full auto-filled Boss Info: stats always attempted; type and movepool layered on
// top independently since they come from separate lookups and either can legitimately miss (a
// boss not yet in POKEMON_TYPES, or one with no recorded movepool). Returns null only when NOT
// EVEN stats were found, in which case the caller leaves the template's original placeholder
// completely untouched - the safest fallback for a boss this repo has no data on at all.
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
    <div class="movepool-row" id="fast-move-row"></div>
    <div class="movepool-label">Charge Moves</div>
    <div class="movepool-row" id="charge-move-row"></div>`,
      moveScript: `${moveChipTypesObjectLiteral([...movepool.fast, ...movepool.charged], raidDb.moveTypeMap)}
const TYPE_ICON_BASE = "https://duiker101.github.io/pokemon-type-svg-icons/icons/";
function moveChipHtml(name, isCharge){
  // Same solid-color pill already used for the Boss Info type badges (typeChipsHtml) - a move's
  // chip IS its type color, full stop, rather than a separate accent-border layered on top of a
  // generic chip. The small type icon rides on top of that same colored pill (forced to solid
  // white via CSS filter so it reads clearly against any type's color, rather than needing a
  // separate icon variant per type).
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

// Rebuilds a guide page's HTML from GUIDE_TEMPLATE, preserving whatever hand-filled Boss Info
// and move data already exists on that boss's page (or auto-filling it for a brand-new boss).
// Shared by submitStrategy (add/refresh a route) and deleteRoute (remove a route) - both need to
// regenerate the full page, and previously each had its own copy-pasted version of this logic.
// That duplication is exactly how a bug in one silently kept living in the other: the move-data
// preservation regex here used to capture ONLY the two `fast-move-row`/`charge-move-row`
// assignment lines, not the `const MOVE_TYPES = {...}` block those lines depend on for their
// type icons. The template's OWN placeholder MOVE_TYPES (5 generic example entries, left over
// from whatever boss the template was first authored from) sat just above the placeholder
// comment being replaced, so it was never removed - the regenerated page ended up with the
// correct boss-specific moveset but the WRONG (template-default) icon lookup table, so every
// icon silently failed to resolve. Real-world case: Mega Blaziken and Mega Garchomp's guide
// pages both picked up Azelf's MOVE_TYPES after a route was added/edited on each, because that's
// what the template's leftover placeholder happened to contain. Fixed by capturing and splicing
// the WHOLE move-script block (MOVE_TYPES through the final assignment line) as one unit, via the
// same blockStart/blockEnd slice already correctly used for the auto-filled case below - having
// only one code path do this splice, used by both the preserved and auto-filled branches, is
// what actually prevents this class of "half updated" bug rather than just patching the symptom.

async function regenerateGuidePageHtml({ boss, bossSlug, pagePath, gh, isNewBoss }){
  // A genuinely new boss (caller already confirmed no .json exists) can't have a .html page
  // either - they're always created together - so skip the fetch entirely rather than making a
  // network call guaranteed to 404. Matches the original behavior exactly (deleteRoute never
  // passes isNewBoss since a route can't be deleted from a boss that doesn't exist yet).
  let existingPageRes = { status: 404 };
  if(!isNewBoss){
    existingPageRes = await gh(`/repos/${OWNER}/${REPO}/contents/${pagePath}?ref=${BASE_BRANCH}`);
  }
  let pageSha = null;
  let preservedBossInfo = null;
  let preservedMoveScript = null;
  if(existingPageRes.status === 200){
    const body = await existingPageRes.json();
    pageSha = body.sha;
    const existingHtml = decodeBase64(body.content);
    const infoStart = existingHtml.indexOf('<div class="info-box">');
    const infoEnd = existingHtml.indexOf('<h2 class="section-title">Routes</h2>');
    if(infoStart !== -1 && infoEnd !== -1 && infoEnd > infoStart){
      const section = existingHtml.slice(infoStart, infoEnd);
      if(!section.includes("boss-info-placeholder")) preservedBossInfo = section;
    }
    // Captures the FULL move-script block - MOVE_TYPES, TYPE_ICON_BASE, moveChipHtml, and both
    // innerHTML assignment lines - as one unit, not just the two assignment lines. This is the
    // fix: without the leading const MOVE_TYPES = {...}, the template's own placeholder
    // MOVE_TYPES stays behind, orphaned, and every move-type-icon lookup silently resolves to
    // nothing.
    const moveMatch = existingHtml.match(/const MOVE_TYPES = \{[\s\S]*?document\.getElementById\('charge-move-row'\)\.innerHTML = .*?;/);
    if(moveMatch) preservedMoveScript = moveMatch[0];
  }else if(existingPageRes.status !== 404){
    throw new Error(`Failed to read ${pagePath} (${existingPageRes.status})`);
  }

  let pageHtml = GUIDE_TEMPLATE
    .replace(/%%BOSS_NAME_JS%%/g, escapeJsStringForTemplate(boss))
    .replace(/%%BOSS_NAME%%/g, escapeHtmlForTemplate(boss))
    .replace(/%%BOSS_SLUG%%/g, bossSlug);

  let autoMoveScript = null;
  if(preservedBossInfo){
    const freshStart = pageHtml.indexOf('<div class="info-box">');
    const freshEnd = pageHtml.indexOf('<h2 class="section-title">Routes</h2>');
    if(freshStart !== -1 && freshEnd !== -1 && freshEnd > freshStart){
      pageHtml = pageHtml.slice(0, freshStart) + preservedBossInfo + pageHtml.slice(freshEnd);
    }
  }else{
    const raidDb = await getPokemonRaidDb(gh);
    const auto = raidDb ? autoBossInfoInnerHtml(escapeHtmlForTemplate(boss), boss, raidDb) : null;
    if(auto){
      const freshStart = pageHtml.indexOf('<div class="info-box">');
      const freshEnd = pageHtml.indexOf('<h2 class="section-title">Routes</h2>');
      if(freshStart !== -1 && freshEnd !== -1 && freshEnd > freshStart){
        const autoInfo = `<div class="info-box">\n    ${auto.html}\n  </div>\n\n  `;
        pageHtml = pageHtml.slice(0, freshStart) + autoInfo + pageHtml.slice(freshEnd);
      }
      autoMoveScript = auto.moveScript;
    }
  }

  // The template itself carries NO move data of any kind by default - not even inert-looking
  // boilerplate - only this placeholder comment. That's deliberate: a template that bundles a
  // real boss's actual data (even as an unused "example") is exactly how one boss's MOVE_TYPES
  // silently became every other boss's fallback. Real move data only ever enters a page from
  // one of two places: this boss's own preserved existing content, or this boss's own auto-filled
  // movepool lookup - both already come bundled as one complete, self-contained unit (MOVE_TYPES +
  // TYPE_ICON_BASE + moveChipHtml + both innerHTML lines), so replacing the comment outright with
  // whichever one applies is sufficient - there's no separate leftover block to worry about.
  const placeholderComment = "// Boss Info movepool not populated - no fast/charge-move-row elements exist for a boss without documented stats yet (see the placeholder note above)";
  const moveScriptToInsert = preservedMoveScript || autoMoveScript;
  if(moveScriptToInsert && pageHtml.includes(placeholderComment)){
    pageHtml = pageHtml.replace(placeholderComment, moveScriptToInsert);
  }

  return { pageHtml, pageSha };
}

async function submitStrategy(submission, token){
  const bossSlug = submission.boss.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filePath = `data/guides/${bossSlug}.json`;

  const gh = (path, opts = {}) => fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "soloraidarchive-guide-submissions",
      ...(opts.headers || {}),
    },
  });

  // 1. read the current file, if it exists, so we append rather than overwrite
  let currentData = { boss: submission.boss.trim(), types: [], strategies: [] };
  let currentSha = null;
  let isNewBoss = false;
  const existing = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${BASE_BRANCH}`);
  if(existing.status === 200){
    const body = await existing.json();
    currentSha = body.sha;
    currentData = JSON.parse(decodeBase64(body.content));
  }else if(existing.status === 404){
    isNewBoss = true;
  }else{
    throw new Error(`Failed to read existing file (${existing.status})`);
  }

  // 2. branch off main - created early so both the image commit (if any) and the JSON commit
  //    below land on the same branch/PR
  const mainRef = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  if(!mainRef.ok) throw new Error(`Failed to read ${BASE_BRANCH} ref (${mainRef.status})`);
  const mainSha = (await mainRef.json()).object.sha;

  const branchName = `guide-submission/${bossSlug}-${Date.now()}`;
  const createBranch = await gh(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
  });
  if(!createBranch.ok) throw new Error(`Failed to create branch (${createBranch.status})`);

  // 3. commit the attached image (if any) as its own file - this is the one part of a submission
  //    that genuinely needs explicit Worker support, since it's a binary file commit rather than
  //    a JSON field. imageBase64/imageFilename are transport-only and never get stored raw in the
  //    JSON - only the resulting imageUrl path does.
  const { boss, imageBase64, imageFilename, editIndex, ...strategyFields } = submission;
  if(imageBase64){
    const ext = (imageFilename || "").split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const imagePath = `assets/presets/${bossSlug}-${Date.now()}.${ext}`;
    const rawBase64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64; // strip "data:image/png;base64," prefix if present
    const putImage = await gh(`/repos/${OWNER}/${REPO}/contents/${imagePath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Add preset image for ${submission.boss} (${submission.difficulty})`,
        content: rawBase64, // binary content - passed through as-is, not re-encoded
        branch: branchName,
      }),
    });
    if(!putImage.ok) throw new Error(`Failed to commit image (${putImage.status})`);
    strategyFields.imageUrl = imagePath;
  }

  // 4. append the new strategy, or replace an existing one if editIndex points at a real entry -
  //    this is the only mutation to the JSON file itself; the file (and therefore the page) a
  //    boss renders from never changes identity across submissions, whether adding or editing.
  //
  //    Every field here is passed through as the editor sent it, rather than named explicitly.
  //    That means adding a new field to the editor form (strategy name, battle parties, anything
  //    future) never requires touching or redeploying this Worker - the editor is the only thing
  //    that needs to change. This is safe specifically because every submission already goes
  //    through manual PR review before merging; that review is the real safety net here, not a
  //    field whitelist in this file.
  const isEdit = typeof editIndex === "number" && editIndex >= 0 && editIndex < currentData.strategies.length;
  const newEntry = {
    ...strategyFields,
    submittedAt: new Date().toISOString(),
  };
  if(isEdit){
    currentData.strategies[editIndex] = newEntry;
  }else{
    currentData.strategies.push(newEntry);
  }

  // 5. commit the updated JSON to the same branch
  const commitMessage = isEdit
    ? `Edit ${submission.weather} strategy for ${submission.boss} (${submission.difficulty})`
    : `Add ${submission.weather} strategy for ${submission.boss} (${submission.difficulty})`;
  const putFile = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: commitMessage,
      content: encodeBase64(JSON.stringify(currentData, null, 2)),
      branch: branchName,
      ...(currentSha ? { sha: currentSha } : {}),
    }),
  });
  if(!putFile.ok) throw new Error(`Failed to commit file (${putFile.status})`);

  // 5b. if this is a brand-new boss, also register it in the index so it shows up in the
  //     editor's boss dropdown going forward - same branch, same PR
  if(isNewBoss){
    const indexPath = "data/guides/index.json";
    let indexData = { bosses: [] };
    let indexSha = null;
    const indexRes = await gh(`/repos/${OWNER}/${REPO}/contents/${indexPath}?ref=${BASE_BRANCH}`);
    if(indexRes.status === 200){
      const body = await indexRes.json();
      indexSha = body.sha;
      indexData = JSON.parse(decodeBase64(body.content));
    }
    indexData.bosses.push({ name: submission.boss.trim(), slug: bossSlug });
    const putIndex = await gh(`/repos/${OWNER}/${REPO}/contents/${indexPath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Register ${submission.boss} in the guide index`,
        content: encodeBase64(JSON.stringify(indexData, null, 2)),
        branch: branchName,
        ...(indexSha ? { sha: indexSha } : {}),
      }),
    });
    if(!putIndex.ok) throw new Error(`Failed to update guide index (${putIndex.status})`);
  }

  // 5c. (re)generate and commit the guide page itself from the current template - this now runs
  //     on EVERY submission, not just brand-new bosses, so a boss's page always reflects whatever
  //     the template looks like today rather than freezing at whatever it looked like the moment
  //     that boss was first submitted. Without this, every future fix to GUIDE_TEMPLATE would only
  //     ever reach new bosses going forward and never the ones that already exist.
  //
  //     The one thing that must survive a regeneration: Boss Info (type/stats/movepool), since that
  //     gets added by hand directly into a page's HTML - it isn't stored in the JSON data at all,
  //     and the Worker has no Pokemon database to regenerate it from. So for an existing boss, the
  //     current page's Boss Info section is read first and spliced into the freshly-generated page,
  //     as long as it's a real, filled-in section and not still the placeholder.
  const pagePath = `data/guides/${bossSlug}.html`;
  const { pageHtml, pageSha } = await regenerateGuidePageHtml({
    boss: submission.boss.trim(), bossSlug, pagePath, gh, isNewBoss,
  });

  const putPage = await gh(`/repos/${OWNER}/${REPO}/contents/${pagePath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: isNewBoss ? `Create guide page for ${submission.boss}` : `Refresh guide page for ${submission.boss}`,
      content: encodeBase64(pageHtml),
      branch: branchName,
      ...(pageSha ? { sha: pageSha } : {}),
    }),
  });
  if(!putPage.ok) throw new Error(`Failed to write guide page (${putPage.status})`);

  // 5d. The collection page is NOT written here. generate_collections.py owns it, and runs from
  //     .github/workflows/generate-collections.yml on any push to main - which includes the merge
  //     of this submission's PR. Writing it here as well meant the same three-token substitution
  //     existed in two languages, which is precisely how the sprite tables drifted: two copies
  //     that agree today and silently disagree after the next edit to one of them. One
  //     implementation, one place to change it.

  // 6. open the PR
  const pr = await gh(`/repos/${OWNER}/${REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: commitMessage,
      head: branchName,
      base: BASE_BRANCH,
      body: `Volunteer submission via the guide editor.\n\n**Boss:** ${submission.boss}\n**Weather:** ${submission.weather}\n**Difficulty:** ${submission.difficulty}\n**Submitted by:** ${submission.submittedBy || "Anonymous"}\n\nThis appends to the existing \`${filePath}\` - it does not create a new page.`,
    }),
  });
  if(!pr.ok) throw new Error(`Failed to open PR (${pr.status})`);
  const prBody = await pr.json();
  return prBody.html_url;
}

async function submitArticle(submission, token){
  const baseSlug = submission.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const isEdit = !!submission.editSlug;

  const gh = (path, opts = {}) => fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "soloraidarchive-guide-submissions",
      ...(opts.headers || {}),
    },
  });

  // 1. Resolve the slug and, for a new article, make sure it doesn't collide with an existing
  //    one (every article submission creates its own file, so two articles with the same title
  //    need distinct filenames). Editing an existing article skips all of that and just confirms
  //    the target file is actually there - editSlug is expected to be real, and quietly falling
  //    through to "create a new article instead" if it isn't would silently lose the edit.
  let slug;
  let existingJsonSha = null;
  let existingHtmlSha = null;
  let originalSubmittedAt = null;

  if(isEdit){
    slug = submission.editSlug;
    const existing = await gh(`/repos/${OWNER}/${REPO}/contents/articles/${slug}.json?ref=${BASE_BRANCH}`);
    if(existing.status === 404) throw new Error(`Article "${slug}" not found - it may have been renamed or removed.`);
    if(existing.status !== 200) throw new Error(`Failed to read existing article (${existing.status})`);
    const existingBody = await existing.json();
    existingJsonSha = existingBody.sha;
    try{ originalSubmittedAt = JSON.parse(decodeBase64(existingBody.content)).submittedAt || null; }catch(e){ /* fall through with null */ }

    const existingPage = await gh(`/repos/${OWNER}/${REPO}/contents/articles/${slug}.html?ref=${BASE_BRANCH}`);
    if(existingPage.status === 200) existingHtmlSha = (await existingPage.json()).sha;
  }else{
    slug = baseSlug;
    let suffix = 2;
    while(true){
      const check = await gh(`/repos/${OWNER}/${REPO}/contents/articles/${slug}.json?ref=${BASE_BRANCH}`);
      if(check.status === 404) break;
      if(check.status !== 200) throw new Error(`Failed to check existing article slug (${check.status})`);
      slug = `${baseSlug}-${suffix}`;
      suffix++;
    }
  }

  // 2. branch off main
  const mainRef = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  if(!mainRef.ok) throw new Error(`Failed to read ${BASE_BRANCH} ref (${mainRef.status})`);
  const mainSha = (await mainRef.json()).object.sha;

  const branchName = `article-${isEdit ? "edit" : "submission"}/${slug}-${Date.now()}`;
  const createBranch = await gh(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
  });
  if(!createBranch.ok) throw new Error(`Failed to create branch (${createBranch.status})`);

  // 3. commit each newly uploaded image as its own file, then swap its {{UPLOAD:tempId}}
  //    placeholder in the body for the real committed path - the placeholder is what keeps the
  //    body's length reasonable up through validation; this is the point where it becomes a real
  //    URL. On an edit, images already referenced in the body (from before this edit) are just
  //    plain "/assets/articles/..." text at this point - nothing here touches them, only images
  //    freshly attached during this editing session go through this loop at all.
  let articleBody = submission.body;
  const images = Array.isArray(submission.images) ? submission.images : [];
  for(let i = 0; i < images.length; i++){
    const img = images[i];
    if(!img.base64 || !img.tempId) continue;
    const ext = (img.filename || "").split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "png";
    const imagePath = `assets/articles/${slug}-${Date.now()}-${i + 1}.${ext}`;
    // Root-relative (leading slash), not "../assets/..." - this body text gets embedded into
    // both the published page (articles/{slug}.html, one folder deep) and an editor preview at
    // the repo root - a relative path correct for one depth breaks at the other. This is a
    // <user>.github.io repo, served at the domain root, so a leading-slash path resolves
    // correctly from any page depth without needing to track which depth is rendering it.
    const rootRelativeImagePath = `/${imagePath}`;
    const rawBase64 = img.base64.includes(",") ? img.base64.split(",")[1] : img.base64;
    const putImage = await gh(`/repos/${OWNER}/${REPO}/contents/${imagePath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `Add image for article: ${submission.title.trim()}`,
        content: rawBase64,
        branch: branchName,
      }),
    });
    if(!putImage.ok) throw new Error(`Failed to commit article image (${putImage.status})`);
    articleBody = articleBody.split(`{{UPLOAD:${img.tempId}}}`).join(rootRelativeImagePath);
  }

  // Normalize any article-image path that isn't already root-relative. Article pages live one
  // folder deep (articles/{slug}.html), so a path like "assets/articles/x.png" resolves to the
  // non-existent "articles/assets/articles/x.png" and the image breaks. This defensively rewrites
  // any such path (from an older saved body, a pasted URL, a merge that reverted an earlier fix,
  // etc.) to a leading-slash path that resolves from the domain root regardless of page depth -
  // so a broken path can never be re-committed, closing the loop where editing an article with a
  // stale body kept stamping broken paths back into the generated HTML.
  articleBody = articleBody.replace(/(<img\b[^>]*?\bsrc=")(?!https?:\/\/|\/|data:)(assets\/articles\/)/gi, "$1/$2");

  // 4. commit the article's raw data
  const articleData = {
    title: submission.title.trim(),
    category: submission.category,
    body: articleBody,
    submittedBy: submission.submittedBy || "Anonymous",
    submittedAt: originalSubmittedAt || new Date().toISOString(),
    ...(isEdit ? { updatedAt: new Date().toISOString() } : {}),
  };
  const dataPath = `articles/${slug}.json`;
  const putData = await gh(`/repos/${OWNER}/${REPO}/contents/${dataPath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: isEdit ? `Update article: ${submission.title.trim()}` : `Add article: ${submission.title.trim()}`,
      content: encodeBase64(JSON.stringify(articleData, null, 2)),
      branch: branchName,
      ...(existingJsonSha ? { sha: existingJsonSha } : {}),
    }),
  });
  if(!putData.ok) throw new Error(`Failed to commit article data (${putData.status})`);

  // 5. commit the static article page, generated from the same template every article uses
  const pageHtml = ARTICLE_TEMPLATE
    .replace(/%%ARTICLE_TITLE%%/g, escapeHtmlForTemplate(submission.title.trim()))
    .replace(/%%ARTICLE_SLUG%%/g, slug)
    .replace(/%%ARTICLE_CATEGORY%%/g, escapeHtmlForTemplate(submission.category))
    .replace(/%%ARTICLE_AUTHOR%%/g, escapeHtmlForTemplate(submission.submittedBy || "Anonymous"))
    .replace(/%%ARTICLE_BODY%%/g, articleBody);
  const pagePath = `articles/${slug}.html`;
  const putPage = await gh(`/repos/${OWNER}/${REPO}/contents/${pagePath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: isEdit ? `Update article page: ${submission.title.trim()}` : `Create article page: ${submission.title.trim()}`,
      content: encodeBase64(pageHtml),
      branch: branchName,
      ...(existingHtmlSha ? { sha: existingHtmlSha } : {}),
    }),
  });
  if(!putPage.ok) throw new Error(`Failed to ${isEdit ? "update" : "create"} article page (${putPage.status})`);

  // 6. register (or update the existing entry) in the article index so articles.html reflects it
  const indexPath = "articles/index.json";
  let indexData = { articles: [] };
  let indexSha = null;
  const indexRes = await gh(`/repos/${OWNER}/${REPO}/contents/${indexPath}?ref=${BASE_BRANCH}`);
  if(indexRes.status === 200){
    const body = await indexRes.json();
    indexSha = body.sha;
    indexData = JSON.parse(decodeBase64(body.content));
  }else if(indexRes.status !== 404){
    throw new Error(`Failed to read article index (${indexRes.status})`);
  }
  const entry = { title: submission.title.trim(), slug, category: submission.category };
  const existingEntryIndex = indexData.articles.findIndex(a => a.slug === slug);
  if(existingEntryIndex !== -1) indexData.articles[existingEntryIndex] = entry;
  else indexData.articles.push(entry);
  const putIndex = await gh(`/repos/${OWNER}/${REPO}/contents/${indexPath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: isEdit ? `Update article index entry: ${submission.title.trim()}` : `Register article: ${submission.title.trim()}`,
      content: encodeBase64(JSON.stringify(indexData, null, 2)),
      branch: branchName,
      ...(indexSha ? { sha: indexSha } : {}),
    }),
  });
  if(!putIndex.ok) throw new Error(`Failed to update article index (${putIndex.status})`);

  // 7. open the PR
  const pr = await gh(`/repos/${OWNER}/${REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `${isEdit ? "Update" : "Add"} article: ${submission.title.trim()}`,
      head: branchName,
      base: BASE_BRANCH,
      body: `Volunteer article ${isEdit ? "edit" : "submission"} via the editor.\n\n**Title:** ${submission.title.trim()}\n**Category:** ${submission.category}\n**Submitted by:** ${submission.submittedBy || "Anonymous"}`,
    }),
  });
  if(!pr.ok) throw new Error(`Failed to open PR (${pr.status})`);
  const prBody = await pr.json();
  return prBody.html_url;
}

// Same slug/label logic the guide page's own client-side routeLabel() uses, plus the strategy-name
// prefix the editor's delete-route confirmation already shows the volunteer - used server-side only
// as a best-effort "does this still look like the route I was asked to delete" sanity check.
function routeSummaryLabel(s){
  if(!s) return "";
  const parts = [s.difficulty, s.weather];
  if(s.adventureEffect && s.adventureEffect !== "None") parts.push(s.adventureEffect);
  const base = parts.join(" \u00b7 ");
  return s.strategyName ? `${s.strategyName} (${base})` : base;
}

async function deleteGuide(submission, token){
  const boss = submission.boss.trim();
  const bossSlug = boss.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filePath = `data/guides/${bossSlug}.json`;
  const pagePath = `data/guides/${bossSlug}.html`;
  const indexPath = "data/guides/index.json";

  const gh = (path, opts = {}) => fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "soloraidarchive-guide-submissions",
      ...(opts.headers || {}),
    },
  });

  // 1. branch off main
  const mainRef = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  if(!mainRef.ok) throw new Error(`Failed to read ${BASE_BRANCH} ref (${mainRef.status})`);
  const mainSha = (await mainRef.json()).object.sha;

  const branchName = `guide-deletion/${bossSlug}-${Date.now()}`;
  const createBranch = await gh(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
  });
  if(!createBranch.ok) throw new Error(`Failed to create branch (${createBranch.status})`);

  // 2. delete the JSON and HTML files that make up the guide. Missing files (e.g. someone already
  //    half-deleted this guide by hand) shouldn't hard-fail the whole PR - skip and note instead.
  const skipped = [];
  for(const path of [filePath, pagePath]){
    const existing = await gh(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${BASE_BRANCH}`);
    if(existing.status === 200){
      const body = await existing.json();
      const del = await gh(`/repos/${OWNER}/${REPO}/contents/${path}`, {
        method: "DELETE",
        body: JSON.stringify({
          message: `Delete ${path} (guide removal: ${boss})`,
          sha: body.sha,
          branch: branchName,
        }),
      });
      if(!del.ok) throw new Error(`Failed to delete ${path} (${del.status})`);
    }else if(existing.status === 404){
      skipped.push(path);
    }else{
      throw new Error(`Failed to read ${path} (${existing.status})`);
    }
  }

  // 3. drop the boss from the guide index so it stops showing up on guides.html and in the
  //    editor's boss dropdown
  let indexRemoved = false;
  const indexRes = await gh(`/repos/${OWNER}/${REPO}/contents/${indexPath}?ref=${BASE_BRANCH}`);
  if(indexRes.status === 200){
    const body = await indexRes.json();
    const indexData = JSON.parse(decodeBase64(body.content));
    const before = indexData.bosses.length;
    indexData.bosses = indexData.bosses.filter(b => b.slug !== bossSlug);
    indexRemoved = indexData.bosses.length !== before;
    if(indexRemoved){
      const putIndex = await gh(`/repos/${OWNER}/${REPO}/contents/${indexPath}`, {
        method: "PUT",
        body: JSON.stringify({
          message: `Remove ${boss} from the guide index`,
          content: encodeBase64(JSON.stringify(indexData, null, 2)),
          branch: branchName,
          sha: body.sha,
        }),
      });
      if(!putIndex.ok) throw new Error(`Failed to update guide index (${putIndex.status})`);
    }
  }else if(indexRes.status !== 404){
    throw new Error(`Failed to read ${indexPath} (${indexRes.status})`);
  }
  if(!indexRemoved) skipped.push(`${indexPath} (no matching entry for slug "${bossSlug}")`);

  // Note: this doesn't clean up any assets/presets/ images attached to the boss's strategies -
  // same as how submitStrategy never removes an old image when a strategy is edited to swap it
  // out. Orphaned preset images are a pre-existing, separate cleanup concern, not introduced here.
  const reason = (submission.reason || "").trim();
  const prBodyLines = [
    `Guide deletion requested via the editor's "Delete this guide" flow.`,
    ``,
    `**Boss:** ${boss}`,
    `**Slug:** \`${bossSlug}\``,
    reason ? `**Reason given:** ${reason}` : `**Reason given:** _(none provided)_`,
    ``,
    `This deletes \`${filePath}\`, \`${pagePath}\`, and the boss's entry in \`${indexPath}\`.`,
  ];
  if(skipped.length){
    prBodyLines.push(``, `⚠️ Not found / not modified:`, ...skipped.map(s => `- \`${s}\``));
  }
  prBodyLines.push(``, `Nothing changes on the live site until this PR is reviewed and merged by a soloraidarchive owner.`);

  const pr = await gh(`/repos/${OWNER}/${REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `Delete guide: ${boss}`,
      head: branchName,
      base: BASE_BRANCH,
      body: prBodyLines.join("\n"),
    }),
  });
  if(!pr.ok) throw new Error(`Failed to open PR (${pr.status})`);
  const prBody = await pr.json();
  return prBody.html_url;
}

async function deleteRoute(submission, token){
  const boss = submission.boss.trim();
  const bossSlug = boss.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filePath = `data/guides/${bossSlug}.json`;
  const pagePath = `data/guides/${bossSlug}.html`;

  const gh = (path, opts = {}) => fetch(`${GITHUB_API}${path}`, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "soloraidarchive-guide-submissions",
      ...(opts.headers || {}),
    },
  });

  // 1. read the current file - this also doubles as the existence check
  const existing = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${BASE_BRANCH}`);
  if(existing.status === 404) throw new Error(`No data file found for "${boss}"`);
  if(existing.status !== 200) throw new Error(`Failed to read ${filePath} (${existing.status})`);
  const existingBody = await existing.json();
  const currentSha = existingBody.sha;
  const currentData = JSON.parse(decodeBase64(existingBody.content));
  const strategies = currentData.strategies || [];

  if(submission.deleteIndex >= strategies.length){
    // The strategies array can shift between when the editor loaded it and when this request
    // arrives (someone else's add/edit/delete merged first) - the same class of race the
    // one-file-per-boss design has always been exposed to. Fail loudly rather than delete the
    // wrong route.
    throw new Error("This route's position has changed since the editor loaded it - reload the guide and try again.");
  }
  const target = strategies[submission.deleteIndex];
  if(submission.routeSummary && target && routeSummaryLabel(target) !== submission.routeSummary){
    throw new Error("This route no longer matches what was selected - the guide changed since the editor loaded it. Reload and try again.");
  }

  // 2. branch off main
  const mainRef = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`);
  if(!mainRef.ok) throw new Error(`Failed to read ${BASE_BRANCH} ref (${mainRef.status})`);
  const mainSha = (await mainRef.json()).object.sha;

  const branchName = `route-deletion/${bossSlug}-${Date.now()}`;
  const createBranch = await gh(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha }),
  });
  if(!createBranch.ok) throw new Error(`Failed to create branch (${createBranch.status})`);

  // 3. remove the one strategy and commit the updated JSON
  strategies.splice(submission.deleteIndex, 1);
  currentData.strategies = strategies;
  const putFile = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Delete route from ${boss}'s guide`,
      content: encodeBase64(JSON.stringify(currentData, null, 2)),
      branch: branchName,
      sha: currentSha,
    }),
  });
  if(!putFile.ok) throw new Error(`Failed to commit file (${putFile.status})`);

  // 4. regenerate the guide page - via the same shared regenerateGuidePageHtml() submitStrategy
  //    uses, so the deleted route's card actually disappears from the rendered page and not just
  //    the JSON. Boss Info (type/stats/movepool) is preserved the same way, since it isn't stored
  //    in the JSON at all and this Worker has no Pokemon database to regenerate it from.
  const { pageHtml, pageSha } = await regenerateGuidePageHtml({ boss, bossSlug, pagePath, gh });

  const putPage = await gh(`/repos/${OWNER}/${REPO}/contents/${pagePath}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `Refresh guide page for ${boss}`,
      content: encodeBase64(pageHtml),
      branch: branchName,
      ...(pageSha ? { sha: pageSha } : {}),
    }),
  });
  if(!putPage.ok) throw new Error(`Failed to write guide page (${putPage.status})`);

  // 5. open the PR
  const reason = (submission.reason || "").trim();
  const label = submission.routeSummary || routeSummaryLabel(target) || `route at index ${submission.deleteIndex}`;
  const pr = await gh(`/repos/${OWNER}/${REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `Delete route: ${boss} — ${label}`,
      head: branchName,
      base: BASE_BRANCH,
      body: [
        `Route deletion requested via the editor's "Delete this route" flow.`,
        ``,
        `**Boss:** ${boss}`,
        `**Route:** ${label}`,
        reason ? `**Reason given:** ${reason}` : `**Reason given:** _(none provided)_`,
        ``,
        `This removes one entry from \`${filePath}\` and regenerates \`${pagePath}\`.`,
        ``,
        `Nothing changes on the live site until this PR is reviewed and merged by a soloraidarchive owner.`,
      ].join("\n"),
    }),
  });
  if(!pr.ok) throw new Error(`Failed to open PR (${pr.status})`);
  const prBody = await pr.json();
  return prBody.html_url;
}

function encodeBase64(str){
  return btoa(unescape(encodeURIComponent(str)));
}
function decodeBase64(str){
  return decodeURIComponent(escape(atob(str.replace(/\n/g, ""))));
}
// Used when substituting a community-submitted value (like a boss name) into the generated page
// template. A boss name can contain anything a submitter typed - quotes, angle brackets, even a
// completely ordinary apostrophe (e.g. the real Pokemon "Farfetch'd") - and without escaping, that
// breaks straight through whatever HTML attribute or JS string literal it lands inside, corrupting
// the whole generated page. Two versions exist because the same value lands in two different
// contexts within the template: plain HTML text/attributes, and inside a single-quoted JS string.
function escapeHtmlForTemplate(str){
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeJsStringForTemplate(str){
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/</g, "\\x3C"); // guards against a literal "</script>" breaking out of the tag
}
function jsonError(message, status){
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status, headers: { "Content-Type": "application/json" },
  });
}
function corsResponse(response){
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "https://soloraidarchive.github.io");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { status: response.status, headers });
}
