#!/usr/bin/env python3
"""
Detects genuinely new raid-strategy entries added to the archive CSVs in the most recent
push, and appends them to a rolling log (new-raid-entries.json) that the landing page reads
client-side to show a "New Raid Entries!" panel.

"New" specifically means: this exact (boss, strategy) combination did not exist in the file
before this push. Editing an existing row (e.g. adding a VOD link later, fixing a typo) does
NOT count as new - only rows whose (boss, strategy) key is genuinely unseen before. A plain
git diff can't tell these apart on its own (an edited line looks like a removed-old-line +
added-new-line, same as a real new row), so this compares the full set of (boss, strategy)
keys before vs. after the push instead of diffing lines directly.

Run by .github/workflows/track-new-raid-entries.yml on every push that touches one of the
tier CSVs. Compares each CSV's current content against its content at the commit *before*
the push (git show <before_sha>:<path>), using GitHub's push-event "before" SHA passed in via
the BEFORE_SHA env var.

The rolling log keeps only the last MAX_EVENTS push-events that actually introduced new
entries - pushes that only edited existing rows produce no event and aren't logged at all.
"Recent" here means "the last few pushes with genuinely new content", not a time window.
"""
import csv
import io
import json
import os
import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
OUTPUT_FILE = REPO_ROOT / "new-raid-entries.json"
MAX_EVENTS = 2

# The two known adventure-effect icon URLs the site itself already distinguishes between
# (see tier4-raids.html etc.) - "sword" (Blade Boost, +10% damage dealt) vs "shield"
# (Adventure Effect, +10% damage reduction). Any other non-empty value in that column is
# an AE icon we don't recognize yet, so it still counts as present but falls back to "sword"
# for display purposes, matching the site's own existing fallback behavior.
AE_ICON = "https://cdn2.steamgriddb.com/icon_thumb/55e643e737da20b912037cce912305fb.png"
SHIELD_ICON = "https://static.wikia.nocookie.net/396c21d1-3e98-4c0d-8bb2-9150fda4ec41"


def classify_ae(cell):
    cell = (cell or "").strip()
    if cell == SHIELD_ICON:
        return "shield"
    if cell == AE_ICON:
        return "sword"
    return "sword" if cell else ""


# (csv filename, archive page, display label, column offsets) - boss/star/strategy/weather/AE
# column indices per file, mirroring the layout research.html's own client-side parsers
# already rely on (tier6 has a leading "Category" column, so its offsets are shifted by one;
# tier5-data.csv has no adventure-effect column at all, hence ae_col=None there).
ARCHIVES = [
    {"file": "tier4-data.csv", "page": "tier4-raids.html", "label": "Mega",
     "boss_col": 0, "star_col": 1, "strat_col": 2, "weather_col": 5, "ae_col": 6},
    {"file": "tier5-data.csv", "page": "tier5-raids.html", "label": "Legendary",
     "boss_col": 0, "star_col": 1, "strat_col": 2, "weather_col": 5, "ae_col": None},
    {"file": "tier5-ae-data.csv", "page": "tier5-ae-raids.html", "label": "Legendary AE",
     "boss_col": 0, "star_col": 1, "strat_col": 2, "weather_col": 5, "ae_col": 6},
    {"file": "tier6-data.csv", "page": "tier6-elite-raids.html", "label": "Mega Legendary & Elite",
     "boss_col": 1, "star_col": 2, "strat_col": 3, "weather_col": 6, "ae_col": 7},
]


def parse_rows(text):
    return list(csv.reader(io.StringIO(text)))


def find_vod_url(row):
    """Mirrors the site's own VOD-column detection (research.html etc.): the VOD column
    isn't at a fixed offset, since party size varies 1-6 members x 4 columns each, so scan
    for the literal "VOD"/"VOD*" header cell and take the next cell as the URL."""
    for i, cell in enumerate(row):
        if cell.strip() in ("VOD", "VOD*"):
            return row[i + 1].strip() if i + 1 < len(row) else ""
    return ""


def extract_entries(rows, cfg):
    """Returns {key: {boss, star, strategy, weather, ae, fast, charge, vod}} for every row
    that looks like a real data row (has a non-empty boss name and a star-rating cell).

    The identity key is built from fields that are always present on every row - boss,
    strategy, weather, star/tier, and the boss's own fast/charge move - rather than the VOD
    link. VOD is the most reliable single field when it exists (a real video is inherently
    unique), but not every real publication has one yet, so it can't be the only thing this
    relies on. The strategy label alone isn't enough either - it's just a category (Catch
    Tank, Hot Swap, Recycle, etc.), not a unique name, so two genuinely different real
    submissions for the same boss can share it - that's what the rest of the row's core
    columns disambiguate. VOD is still stored on each entry and used as a bonus exact-match
    signal for deep-linking when it's available, just not required for detection.

    This does mean an edit that changes weather or moveset on an existing row could register
    as "new" (its key changes), rather than only pure additions - an acceptable tradeoff to
    get reliable detection for entries that don't have a VOD at all yet."""
    entries = {}
    for row in rows:
        if len(row) <= max(cfg["boss_col"], cfg["star_col"], cfg["strat_col"]):
            continue
        boss = row[cfg["boss_col"]].strip()
        star = row[cfg["star_col"]].strip()
        strat = row[cfg["strat_col"]].strip()
        if not boss or "\u2b50" not in star:
            continue
        weather = row[cfg["weather_col"]].strip() if cfg["weather_col"] is not None and len(row) > cfg["weather_col"] else ""
        ae_cell = row[cfg["ae_col"]].strip() if cfg["ae_col"] is not None and len(row) > cfg["ae_col"] else ""
        # FM/CM sit immediately after the strategy column on every archive file
        fast = row[cfg["strat_col"] + 1].strip() if len(row) > cfg["strat_col"] + 1 else ""
        charge = row[cfg["strat_col"] + 2].strip() if len(row) > cfg["strat_col"] + 2 else ""
        vod = find_vod_url(row)
        tier_match = re.search(r"[\d.]+", star)
        tier = tier_match.group(0) if tier_match else star
        key = (boss.lower(), strat.lower(), weather.lower(), tier, fast.lower(), charge.lower())
        entries[key] = {
            "boss": boss, "star": star, "strategy": strat, "weather": weather,
            "ae": classify_ae(ae_cell), "fast": fast, "charge": charge, "vod": vod,
        }
    return entries


def git_show(sha, path):
    """Returns the file's content at the given commit, or None if it didn't exist there."""
    try:
        result = subprocess.run(
            ["git", "show", f"{sha}:{path}"],
            cwd=REPO_ROOT, capture_output=True, text=True, check=True,
        )
        return result.stdout
    except subprocess.CalledProcessError:
        return None


def main():
    before_sha = os.environ.get("BEFORE_SHA", "").strip()
    commit_sha = os.environ.get("COMMIT_SHA", "").strip()
    commit_date = os.environ.get("COMMIT_DATE", "").strip()

    if not before_sha or set(before_sha) == {"0"}:
        # First-ever push to the repo, a manual workflow_dispatch run (no push event at all),
        # or before_sha is all-zeros (GitHub's signal for "new branch, no prior commit") -
        # nothing real to diff against, so skip rather than flooding the log with every
        # existing row as "new".
        print("No usable before-SHA, skipping (nothing to diff against).")
        return

    new_entries = []
    for cfg in ARCHIVES:
        path = cfg["file"]
        file_path = REPO_ROOT / path
        current_text = file_path.read_text(encoding="utf-8") if file_path.exists() else ""
        old_text = git_show(before_sha, path) or ""

        current_entries = extract_entries(parse_rows(current_text), cfg)
        old_entries = extract_entries(parse_rows(old_text), cfg)

        for key, data in current_entries.items():
            if key not in old_entries:
                new_entries.append({
                    "boss": data["boss"],
                    "star": data["star"],
                    "strategy": data["strategy"],
                    "weather": data["weather"],
                    "ae": data["ae"],
                    "fast": data["fast"],
                    "charge": data["charge"],
                    "vod": data["vod"],
                    "archivePage": cfg["page"],
                    "archiveLabel": cfg["label"],
                })

    if not new_entries:
        print("No genuinely new (boss, strategy) entries in this push - nothing to log.")
        return

    event = {
        "commit": commit_sha,
        "date": commit_date,
        "entries": new_entries,
    }

    existing_events = []
    if OUTPUT_FILE.exists():
        try:
            existing_events = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing_events = []

    updated_events = [event] + existing_events
    updated_events = updated_events[:MAX_EVENTS]

    OUTPUT_FILE.write_text(json.dumps(updated_events, indent=2) + "\n", encoding="utf-8")
    plural = "y" if len(new_entries) == 1 else "ies"
    print(f"Logged {len(new_entries)} new entr{plural} from commit {commit_sha[:7]}.")


if __name__ == "__main__":
    main()
