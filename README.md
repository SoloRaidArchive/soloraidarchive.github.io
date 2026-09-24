# Solo Raid Archive

**tl;dr:** a big community-built database of Pokémon GO raids that people have soloed (beat a raid boss alone, no second trainer).

Every entry has the boss, the weather, the exact battle party used, and a video/VOD as proof. This repo is the whole site, [soloraidarchive.github.io](https://soloraidarchive.github.io), is just this repo hosted on GitHub Pages.

## What even is this repo

It's a **plain static site**. No React, no Vue, no build step, no `package.json`, nothing to `npm install`. Just HTML/CSS/JS files sitting in folders, served as-is by GitHub Pages. The "backend" is basically a pile of CSV files plus some Python/Node scripts that regenerate HTML pages from them, run automatically by GitHub Actions.

So don't go looking for a `src/` folder or a framework there isn't one.

## Running it locally

Since it's just static files, you don't need to install anything fancy. Easiest way, from the repo root:

```bash
python -m http.server
# or on some setups: python3 -m http.server
```

then open `http://localhost:8000` in your browser. That's it, that's the whole "dev server."

Any other static server works too (VS Code's Live Server extension, `npx serve`, whatever), the site doesn't care, it's just files.

## Project structure

```
soloraidarchive.github.io/
├── index.html                  # homepage
├── tier4-raids.html            # Mega raid archive (Tier 4)
├── tier5-raids.html            # Legendary raid archive (Tier 5)
├── tier6-elite-raids.html      # Mega Legendary / Elite raid archive (Tier 6)
├── guides.html                 # links into data/guides/
├── articles.html               # links into articles/
├── ct-calculator.html          # Catch Tank calculator
├── dps-calculator.html         # DPS calculator
├── ct-database.html            # community-submitted Catch Tank test logs
├── move-data.html              # move data reference table
├── pokemon-stats.html          # Pokémon base stats reference table
├── research.html               # "most used raiders" stats
├── reference.html              # star ratings / role explanations
├── solo-raid-mechanics.html    # glossary (Catch Tank, TPC, Hot Swap, etc.)
├── meta-battle-parties.html    # most common battle parties
├── editor.html                 # in-browser editor for submitting new guides
│
├── csv/                        # THE source of truth for raid data
│   ├── tier4-data.csv          # Tier 4 strategies (boss, moves, party, VOD, notes...)
│   ├── tier5-merged.csv        # Tier 5 strategies
│   ├── tier6-data.csv          # Tier 6 strategies
│   ├── moves.csv               # fast/charge move data
│   ├── pokemon-stats.csv       # Pokémon base stats
│   ├── pokemon-movepool.csv    # which Pokémon can learn which moves
│   ├── ct-database.csv         # Catch Tank test logs
│   └── csv-utils.js            # shared browser-side CSV parser, no deps
│
├── data/
│   ├── nav-partial.html        # the ONE source of truth for the site nav
│   ├── raid-mechanics.json     # glossary content for solo-raid-mechanics.html
│   ├── guides/                 # ~20 hand-written per-boss guide pages (html + json)
│   └── *-template.html         # templates used by the generator scripts
│
├── collections/                # ~130 auto-generated per-boss pages (SEO landing pages)
├── articles/                   # research write-ups (getting started, FAQ, etc.)
├── assets/
│   ├── sprites/                # ~140 animated boss sprites
│   ├── clips/                  # short clips showing mechanics (Catch Tank, Hot Swap...)
│   └── icons/                  # favicons, weather icons, tier icons
│
├── generate_collections.py     # rebuilds collections/*.html from the CSVs
├── generate_nav.py             # rebuilds the nav block on every page from nav-partial.html
├── generate_guides.js          # rebuilds data/guides/*.html from templates + CSVs
├── update_live_bosses.py       # pulls currently-active raid bosses, writes live-bosses.json
├── track_new_raid_entries.py   # detects newly-added strategies on push
├── leekduck_crosscheck.py      # cross-checks live bosses against LeekDuck data
├── submission-worker.js        # Cloudflare Worker: editor.html submissions -> GitHub PR
│
├── live-bosses.json            # auto-generated, don't hand-edit
├── new-raid-entries.json       # auto-generated, don't hand-edit
│
└── .github/workflows/          # the bots that keep everything in sync (see below)
```

## How the data actually flows

Basically: **CSVs are the real database.** Everything else gets generated from them.

1. Someone adds/edits a row in `csv/tier4-data.csv` (or tier5/tier6) : that's a new solo raid strategy.
2. GitHub Actions notices the push and runs the generator scripts, which turn those CSV rows into actual HTML pages.
3. The bots commit the generated files straight back to `main`.

Key scripts, if you wanna poke around:

- `generate_collections.py` : makes/updates the per-boss SEO pages in `collections/`.
- `generate_nav.py` : the nav menu lives in ONE file (`data/nav-partial.html`), this script stamps it into every page on the site so you never have to manually copy-paste a nav bar 50 times.
- `generate_guides.js` : same idea but for the deeper `data/guides/` pages (Node script, no deps needed).
- `update_live_bosses.py` : checks what raid bosses are currently live (via Pokebattler + LeekDuck data) and flags which ones already have a documented solo strat, runs every 3 hours.
- `track_new_raid_entries.py` : diffs the CSVs on every push to catch genuinely *new* strategies (not just edits) for the homepage's "recently added" panel.

## The bots (GitHub Actions)

Five workflows in `.github/workflows/`, all committing back to `main` as `github-actions[bot]`:

| Workflow | Does what |
|---|---|
| `update-live-bosses.yml` | refreshes `live-bosses.json` every 3 hours |
| `track-new-raid-entries.yml` | logs new strategy entries when a tier CSV gets pushed |
| `generate-collections.yml` | rebuilds `collections/*.html` when the CSVs change |
| `generate-nav.yml` | rebuilds the site nav when `nav-partial.html` changes |
| `backfill-new-raid-entries.yml` | one-off, manual-only, historical backfill |

## How people submit new strategies

`editor.html` is a whole in-browser guide editor (rich text and everything) where community members write up their solo clear. When they hit submit, it POSTs to `submission-worker.js`, a **Cloudflare Worker** deployed separately from this repo. It opens a GitHub PR with the new content for review. So new guides show up as PRs, not direct commits.

## Confused by the jargon?

If you see terms like "Catch Tank", "TPC", "Hot Swap" in the CSVs and have no clue what they mean, check out `solo-raid-mechanics.html` (backed by `data/raid-mechanics.json`), it's a glossary with short clips showing each technique.
