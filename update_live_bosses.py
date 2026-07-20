#!/usr/bin/env python3
"""
Fetches the current/upcoming raid boss schedule from Pokebattler and cross-references
every boss name against this repo's own archive CSVs (tier4/5/5ae/6) to determine which
scheduled bosses are documented as soloable here.

Run by .github/workflows/update-live-bosses.yml on a schedule. Writes live-bosses.json
to the repo root; index.html fetches that file client-side (same-origin, no CORS issue).

Design note: we deliberately don't try to classify each Pokebattler boss by raid tier
(5-star/Mega/etc) ourselves - Pokebattler's page doesn't cleanly label that in a way
that's reliable to scrape. Instead we extract every boss name + its active date range,
and cross-reference ALL of them against every one of our own archive CSVs. If a name
matches, we already know its tier from *which* CSV matched - no guessing needed. This
also naturally excludes anything we haven't documented as soloable, including Legends
Z-A Megas (a different, non-standard raid format), since those simply won't be in our
own tier4-data.csv.

NOTE: Pokebattler's exact HTML structure wasn't directly inspectable when this was
written (only a text-converted view was available). The parsing below works on the
page's rendered text content directly (via regex) rather than depending on specific
CSS classes, which should be more resilient to markup changes - but if Pokebattler
substantially restructures their page, check the Action's run log, which prints how
many date-range blocks and boss names it found.
"""
import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    print("Missing dependencies. Install with: pip install requests beautifulsoup4")
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
POKEBATTLER_URL = "https://www.pokebattler.com/raids"

ARCHIVE_CSVS = {
    "tier4-data.csv": "tier4-raids.html",
    "tier5-data.csv": "tier5-raids.html",
    "tier5-ae-data.csv": "tier5-ae-raids.html",
    "tier6-data.csv": "tier6-elite-raids.html",
}

# Matches a Pokebattler date-range block header, e.g.:
#   "From Jul 22, 2026 6:00 AM - Until Jul 28, 2026 10:00 PM"
#   "Until Jul 21, 2026 10:00 PM"                              (already-started, no "From")
# followed immediately by the literal column-header text "BossCPDifficulty" (concatenated
# because the source table has no text between cells once whitespace is collapsed).
DATE_BLOCK_RE = re.compile(
    r"(?:From\s+([A-Za-z]+ \d+, \d+ \d+:\d+ [AP]M)\s*-\s*)?"
    r"Until\s+([A-Za-z]+ \d+, \d+ \d+:\d+ [AP]M)\s*BossCPDifficulty"
)

# Matches a boss name immediately followed by its first CP value, e.g. "Mega Sceptile1500CP".
# Allows single-letter suffixes (Mewtwo Y) and " - " separated formes (Dialga - Origin).
BOSS_NAME_RE = re.compile(
    r"([A-Z][A-Za-z]*(?:\s*-\s*[A-Z][A-Za-z]*|\s+[A-Z][A-Za-z]*)*)\d+CP"
)


def load_known_bosses():
    """Read every 'Boss Name' from our own archive CSVs, so we can check if a scheduled
    Pokebattler boss is something this site actually has a documented solo strategy for.
    When a boss has multiple documented strategies at different difficulties, keep the
    easiest one (lowest star rating) - that's the most useful one to surface here."""
    known = {}
    for csv_name, archive_page in ARCHIVE_CSVS.items():
        csv_path = REPO_ROOT / csv_name
        if not csv_path.exists():
            continue
        with open(csv_path, encoding="utf-8") as f:
            lines = f.read().splitlines()
        if not lines:
            continue
        header = next(csv.reader([lines[0]]))
        try:
            boss_idx = header.index("Boss Name")
            star_idx = header.index("Star")
            weather_idx = header.index("Weather")
        except ValueError:
            continue
        for line in lines[1:]:
            try:
                row = next(csv.reader([line]))
            except Exception:
                continue
            if len(row) <= boss_idx or not row[boss_idx].strip():
                continue
            name = row[boss_idx].strip().lower()
            star_raw = row[star_idx].strip() if len(row) > star_idx else ""
            weather = row[weather_idx].strip() if len(row) > weather_idx else ""
            star_num_match = re.match(r"[\d.]+", star_raw)
            star_num = float(star_num_match.group()) if star_num_match else 999
            existing = known.get(name)
            if existing is None or star_num < existing["starNum"]:
                known[name] = {
                    "archivePage": archive_page,
                    "difficulty": star_raw,
                    "starNum": star_num,
                    "weather": weather,
                }
    return known


def normalize_name(name):
    """Pokebattler formats some formes as 'Dialga - Origin'; our own CSVs use
    'Dialga Origin' (no hyphen). Normalize so these actually match."""
    return name.replace(" - ", " ").strip().lower()


def scrape_pokebattler():
    """Best-effort scrape of Pokebattler's raid schedule. Returns a list of
    {name, startDate, endDate} dicts for every boss found under every date-range block."""
    resp = requests.get(POKEBATTLER_URL, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    text = soup.get_text(separator="")

    date_matches = list(DATE_BLOCK_RE.finditer(text))
    print(f"Found {len(date_matches)} date-range block(s)")

    bosses = []
    for i, m in enumerate(date_matches):
        start_of_bosses = m.end()
        end_of_bosses = date_matches[i + 1].start() if i + 1 < len(date_matches) else len(text)
        boss_text = text[start_of_bosses:end_of_bosses]
        boss_names = BOSS_NAME_RE.findall(boss_text)
        print(f"  block {i} ({m.group(1) or 'ongoing'} -> {m.group(2)}): {boss_names}")
        for name in boss_names:
            bosses.append({
                "name": name.strip(),
                "startDate": m.group(1),
                "endDate": m.group(2),
            })

    return bosses


def parse_pokebattler_date(date_str):
    """Parses 'Jul 22, 2026 6:00 AM' into a datetime. Returns None if unparseable -
    callers should treat that as 'keep it, don't filter on a date we can't read'."""
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str, "%b %d, %Y %I:%M %p")
    except ValueError:
        return None


def main():
    known_bosses = load_known_bosses()
    print(f"Loaded {len(known_bosses)} known boss names from this site's own archives")

    scheduled_bosses = scrape_pokebattler()
    print(f"Scraped {len(scheduled_bosses)} total boss entries from Pokebattler")

    now = datetime.now()
    results = []
    seen = set()
    for boss in scheduled_bosses:
        key = normalize_name(boss["name"])
        if key not in known_bosses or key in seen:
            continue
        end_dt = parse_pokebattler_date(boss["endDate"])
        if end_dt and end_dt < now:
            print(f"  skipping {boss['name']} - end date {boss['endDate']} already passed")
            continue
        seen.add(key)
        info = known_bosses[key]
        results.append({
            "name": boss["name"],
            "startDate": boss["startDate"],
            "endDate": boss["endDate"],
            "archivePage": info["archivePage"],
            "difficulty": info["difficulty"],
            "weather": info["weather"],
        })

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "soloableBosses": results,
    }

    out_path = REPO_ROOT / "live-bosses.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {len(results)} soloable boss(es) to {out_path}")
    for r in results:
        print(f"  - {r['name']} ({r['startDate'] or 'ongoing'} -> {r['endDate']}) -> {r['archivePage']}")


if __name__ == "__main__":
    main()
