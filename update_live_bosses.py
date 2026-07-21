#!/usr/bin/env python3
"""
Fetches the current raid roster from Pokebattler's JSON API (fight.pokebattler.com/raids -
used at the request of Pokebattler's owner, replacing an earlier HTML-scraping approach
against pokebattler.com/raids) and cross-references every boss name against this repo's own
archive CSVs (tier4/5/5ae/6) to determine which currently-active bosses are documented as
soloable here.

Run by .github/workflows/update-live-bosses.yml on a schedule. Writes live-bosses.json to
the repo root; index.html fetches that file client-side (same-origin, no CORS issue).

DATE HANDLING: the JSON API does not expose scheduled start/end dates (each tier's "raids"
list is a live snapshot, with separate "_FUTURE"/"_LEGACY" pools as catalogs rather than a
calendar). To recover dates, this script ALSO fetches the human-readable page
(pokebattler.com/raids) and matches boss names between the two sources - the API remains
the sole authority on WHICH bosses are current and soloable; the website is used only as a
supplementary lookup for WHEN. If a boss from the API can't be matched to a date block on
the website (e.g. a sync gap between the two), it's grouped under "Currently active" with
no date shown, rather than guessing.

KNOWN GAP: as of this writing, the API's RAID_LEVEL_4 (Mega) tier consistently returns an
empty raids list even when the website shows an active Mega boss (confirmed against Mega
Sceptile). This looks like a real gap on Pokebattler's end, not a bug in this script -
worth flagging to them directly, or revisiting once resolved.
"""
import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("Missing dependency. Install with: pip install requests")
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent
POKEBATTLER_API_URL = "https://fight.pokebattler.com/raids"
POKEBATTLER_WEB_URL = "https://www.pokebattler.com/raids"

# Matches a date-range block header on the human-readable page, e.g.:
#   "From Jul 22, 2026 6:00 AM - Until Jul 28, 2026 10:00 PM"
#   "Until Jul 21, 2026 10:00 PM"  (already-started, no "From")
# followed immediately by the literal column-header text "BossCPDifficulty".
DATE_BLOCK_RE = re.compile(
    r"(?:From\s+([A-Za-z]+ \d+, \d+ \d+:\d+ [AP]M)\s*-\s*)?"
    r"Until\s+([A-Za-z]+ \d+, \d+ \d+:\d+ [AP]M)\s*BossCPDifficulty"
)
BOSS_NAME_WEB_RE = re.compile(
    r"([A-Z][A-Za-z]*(?:\s*-\s*[A-Z][A-Za-z]*|\s+(?:of|the|and|a|an)\s+[A-Z][A-Za-z]*|\s+[A-Z][A-Za-z]*)*)\d+CP"
)

ARCHIVE_CSVS = {
    "tier4-data.csv": "tier4-raids.html",
    "tier5-data.csv": "tier5-raids.html",
    "tier5-ae-data.csv": "tier5-ae-raids.html",
    "tier6-data.csv": "tier6-elite-raids.html",
}


def load_known_bosses():
    """Read every 'Boss Name' + 'Star' + 'Weather' from our own archive CSVs. When a boss
    has multiple documented strategies at different difficulties, keep the easiest one."""
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


def pokemon_id_to_name(pokemon_id):
    """'KYUREM_BLACK_FORM' -> 'Kyurem Black'. Matches this site's existing CSV naming.

    Special case: Pokebattler's enum puts Mega as a suffix (e.g. 'SCEPTILE_MEGA' ->
    'Sceptile Mega', or 'MEWTWO_MEGA_X' -> 'Mewtwo Mega X'), but this site's own CSVs use
    the Mega-first convention ('Mega Sceptile', 'Mega Mewtwo X'), matching how the
    community actually refers to them. Confirmed via a real Action run: 'SCEPTILE_MEGA'
    silently failed to match 'Mega Sceptile' in the archives without this reorder, which is
    why Mega bosses weren't showing up despite being correctly fetched from the API."""
    cleaned = pokemon_id.replace("_", " ")
    if cleaned.endswith(" FORM"):
        cleaned = cleaned[:-5]
    words = [w.capitalize() for w in cleaned.split()]
    if "Mega" in words[1:]:
        words.remove("Mega")
        words.insert(0, "Mega")
    return " ".join(words)


def normalize_name(name):
    """Collapses Genesect's four cosmetic Drive variants into one entry, since they're
    mechanically identical for solo raiding. Also strips ' - ' (e.g. 'Dialga - Origin' /
    'Zamazenta - Hero of Many Battles') since the website keeps that hyphen in its raw
    text but the API-derived names never have one, so without this the two sources'
    keys silently never matched for any hyphenated forme.

    Also strips a trailing 'of many battles' - this is Zamazenta's real official title
    suffix, and the website apparently uses the full official name while the API's own
    enum resolves to just 'Zamazenta Hero'. Without this, the two sources' keys for this
    one boss never matched, which is exactly what caused it to fall through with no date
    info and incorrectly show as active before its July 26 window actually started."""
    cleaned = name.replace(" - ", " ").strip().lower()
    if re.match(r"^(burn|chill|douse|shock)\s+genesect$", cleaned):
        return "genesect"
    cleaned = re.sub(r"\s+of many battles$", "", cleaned)
    return cleaned


def parse_pokebattler_datetime(date_str):
    """'Jul 26, 2026 4:00 PM' -> datetime. Returns None if unparseable - callers should
    treat that as 'can't verify timing, don't filter on it' rather than assuming anything."""
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str, "%b %d, %Y %I:%M %p")
    except ValueError:
        return None


def fetch_current_bosses():
    """Fetches the live roster from Pokebattler's API. Returns a list of boss names
    currently active.

    Per guidance from Pokebattler's owner: currently-active bosses aren't limited to the
    plain-named tiers (RAID_LEVEL_5, etc) - they can also show up inside the "_FUTURE" or
    "_LEGACY" tier pools, which otherwise contain a much broader catalog of bosses that
    have appeared or could appear. The actual signal for "this specific entry is live right
    now" is cp == 0 on the individual raid entry (verified against the real site: every
    cp:0 entry in RAID_LEVEL_5_FUTURE matched a boss the website listed as live during the
    July 26 GO Fest event, while every nonzero-cp entry in the same tier did not). So this
    now searches every tier's raids list and filters on cp==0 per-entry, rather than
    excluding entire tiers by name."""
    resp = requests.get(POKEBATTLER_API_URL, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
    resp.raise_for_status()
    data = resp.json()

    names = []
    for tier_entry in data.get("tiers", []):
        tier_key = tier_entry.get("tier", "")
        raids = tier_entry.get("raids", [])
        current_in_tier = 0
        for raid in raids:
            if raid.get("cp", 0) != 0:
                continue
            pokemon_id = raid.get("pokemonId") or raid.get("pokemon")
            if not pokemon_id:
                continue
            names.append(pokemon_id_to_name(pokemon_id))
            current_in_tier += 1
        print(f"[{tier_key}] {current_in_tier} currently-active boss(es) (of {len(raids)} total entries)")

    return names


def fetch_boss_dates_from_website():
    """Fetches the human-readable raids page (used only to recover scheduled dates, since
    the JSON API doesn't expose them) and returns a dict mapping normalized boss name ->
    (startDate, endDate). The API remains the authority on WHICH bosses are current and
    soloable; this is purely a supplementary lookup for WHEN, matched by name."""
    try:
        resp = requests.get(POKEBATTLER_WEB_URL, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
    except Exception as e:
        print(f"Could not fetch website for date info (non-fatal, dates will show as 'Currently active'): {e}")
        return {}

    try:
        from bs4 import BeautifulSoup
        text = BeautifulSoup(resp.text, "html.parser").get_text(separator="")
    except ImportError:
        text = resp.text

    date_matches = list(DATE_BLOCK_RE.finditer(text))
    dates_by_name = {}
    for i, m in enumerate(date_matches):
        start = m.end()
        end = date_matches[i + 1].start() if i + 1 < len(date_matches) else len(text)
        block_text = text[start:end]
        for name in BOSS_NAME_WEB_RE.findall(block_text):
            clean_name = re.sub(r"Regional$", "", name).strip()
            key = normalize_name(clean_name)
            if key not in dates_by_name:
                dates_by_name[key] = (m.group(1), m.group(2))
    print(f"Found date info for {len(dates_by_name)} boss(es) on the website")
    return dates_by_name



def main():
    known_bosses = load_known_bosses()
    print(f"Loaded {len(known_bosses)} known boss names from this site's own archives")

    current_names = fetch_current_bosses()
    print(f"Fetched {len(current_names)} total current boss entries from Pokebattler's API")

    dates_by_name = fetch_boss_dates_from_website()
    now = datetime.now()

    def date_only(date_str):
        """'Jul 26, 2026 10:00 AM' -> 'Jul 26, 2026' - drops the time so blocks that only
        differ by hour merge into one."""
        if not date_str:
            return None
        m = re.match(r"^([A-Za-z]+ \d+, \d+)", date_str)
        return m.group(1) if m else date_str

    results = []
    seen = set()
    for name in current_names:
        key = normalize_name(name)
        if key not in known_bosses or key in seen:
            continue
        info = known_bosses[key]
        start_date, end_date = dates_by_name.get(key, (None, None))
        end_dt = parse_pokebattler_datetime(end_date)

        # Classify BEFORE filtering: a single calendar day (start == end) is an Event -
        # GO Fest makeup days, Community Day raids, etc, always short one-day windows.
        # Anything spanning multiple days, or with no matched date, is the standard
        # Monthly Rotation (usually 1-2 weeks).
        category = "event" if (start_date and date_only(start_date) == date_only(end_date)) else "rotation"

        # NOTE: there is deliberately no "hasn't started yet" exclusion here anymore. An
        # earlier version of this script excluded future-dated Events specifically,
        # reasoning that a boss like Zamazenta Hero shouldn't show before its July 26 slot
        # began. That was solving the wrong problem: the actual Zamazenta bug was that
        # date-matching FAILED for it (a hyphen mismatch, since fixed), so it fell into the
        # undated "currently active" bucket with no context at all. Now that date-matching
        # works correctly, a boss with a real future date is accurately labeled as such
        # (e.g. a group header reading "Jul 26") - excluding it just hides real, correctly
        # -dated upcoming info, which is exactly what happened here: it silently emptied
        # the entire "Event raids" row the one time an event was more than a few days out.
        if end_dt and now > end_dt:
            print(f"  skipping {name}: window ended {end_date}, already over")
            continue

        seen.add(key)
        results.append({
            "name": name,
            "startDate": start_date,
            "endDate": end_date,
            "category": category,
            "archivePage": info["archivePage"],
            "difficulty": info["difficulty"],
            "weather": info["weather"],
        })

    grouped = {}
    order = []
    for r in results:
        key = (date_only(r["startDate"]), date_only(r["endDate"]), r["category"])
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append({
            "name": r["name"],
            "archivePage": r["archivePage"],
            "difficulty": r["difficulty"],
            "weather": r["weather"],
        })

    date_groups = []
    for key in order:
        start, end, category = key
        date_groups.append({
            "startDate": start,
            "endDate": end,
            "category": category,
            "bosses": grouped[key],
        })

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dateGroups": date_groups,
    }

    out_path = REPO_ROOT / "live-bosses.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {len(results)} soloable boss(es) across {len(date_groups)} date group(s) to {out_path}")
    for g in date_groups:
        names = ", ".join(b["name"] for b in g["bosses"])
        print(f"  [{g['category']}] [{g['startDate'] or 'no date match'} -> {g['endDate']}]: {names}")


if __name__ == "__main__":
    main()
