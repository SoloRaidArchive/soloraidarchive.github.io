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
    "csv/tier4-data.csv": "tier4-raids.html",
    "csv/tier5-merged.csv": "tier5-raids.html",
    "csv/tier6-data.csv": "tier6-elite-raids.html",
}

# Confirmed monthly rotation dates, keyed by normalized boss name -> (startDate, endDate)
# in the same "Mon D, YYYY" string format used elsewhere. Cross-verified against two
# independent sources (leekduck.com's official schedule post + pokemongohub.net's July
# 2026 events roundup, which agree exactly), rather than inferred or scraped live.
#
# WHY THIS EXISTS: Pokebattler's website only gives an end date for a raid that's already
# underway (no start date), which this script previously handled by guessing the start was
# always exactly 7 days earlier. That guess is wrong in general - July had a genuine 2-day
# "bonus" rotation slot (Jul 13-14) breaking the clean 7-day cadence - so for the *current*
# confirmed rotation, prefer this static table over any inference.
#
# HOW TO UPDATE: when a new month's schedule is confirmed (check leekduck.com/events and/or
# pokemongohub.net's monthly events post - they should be cross-checked against each other,
# not trusted individually), add entries here for that month's Tier 5 and Mega rotation
# bosses. Once added, treat these as locked/static for that historical period - they should
# NOT change even if something else about the live site changes later, since the rotation
# itself is a fixed historical fact once it's happened. This table only needs to cover
# monthly ROTATION bosses (Tier 4/5 rotation, ~1-2 week windows) - one-off Event raids
# (GO Fest days, Community Day raids, etc.) are intentionally left out of this table and
# continue to be picked up dynamically from the live scrape, since those genuinely do
# change and aren't worth hand-maintaining here.
CONFIRMED_ROTATION_DATES = {
    "kyogre": ("Jul 15, 2026", "Jul 21, 2026"),
    "mega sceptile": ("Jul 15, 2026", "Jul 21, 2026"),
    "solgaleo": ("Jul 22, 2026", "Jul 28, 2026"),
    "mega salamence": ("Jul 22, 2026", "Jul 28, 2026"),
    "kyurem": ("Jul 29, 2026", "Aug 4, 2026"),
    "mega aggron": ("Jul 29, 2026", "Aug 4, 2026"),
    # August 2026 rotation. These are NOT inferred - they were recovered from the repo's own
    # git history of live-bosses.json (commit 5cafe24e, generated 2026-08-05), which is the
    # authoritative record of what the live scrape actually saw at the time. Azelf and Mega
    # Blaziken share the Aug 5-11 window.
    "azelf": ("Aug 5, 2026", "Aug 11, 2026"),
    "mega blaziken": ("Aug 5, 2026", "Aug 11, 2026"),
    "mega garchomp": ("Aug 12, 2026", "Aug 18, 2026"),
    "lunala": ("Aug 19, 2026", "Aug 25, 2026"),
    "mega swampert": ("Aug 19, 2026", "Aug 25, 2026"),
    "mega gyarados": ("Aug 26, 2026", "Sep 8, 2026"),
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
            display_name = row[boss_idx].strip()
            name = display_name.lower()
            star_raw = row[star_idx].strip() if len(row) > star_idx else ""
            weather = row[weather_idx].strip() if len(row) > weather_idx else ""
            star_num_match = re.match(r"[\d.]+", star_raw)
            star_num = float(star_num_match.group()) if star_num_match else 999
            existing = known.get(name)
            if existing is None or star_num < existing["starNum"]:
                known[name] = {
                    "name": display_name,
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
    """'Jul 26, 2026 4:00 PM' -> datetime. Also handles a date-only string like
    'Jul 26, 2026' (as used in CONFIRMED_ROTATION_DATES, which has no time component) by
    treating it as the end of that day, so the "already ended" check below still works
    correctly for statically-sourced dates instead of silently never firing. Returns None
    if unparseable - callers should treat that as 'can't verify timing, don't filter on
    it' rather than assuming anything."""
    if not date_str:
        return None
    try:
        return datetime.strptime(date_str, "%b %d, %Y %I:%M %p")
    except ValueError:
        pass
    try:
        return datetime.strptime(date_str, "%b %d, %Y").replace(hour=23, minute=59)
    except ValueError:
        return None


def same_month(dt, ref):
    """True if dt falls in the same calendar month+year as ref. Used for the 'keep this
    month's rotation bosses visible until the month actually flips' rule."""
    return dt is not None and dt.year == ref.year and dt.month == ref.month


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



def apply_leekduck_crosscheck(results):
    """Drop event mega raids that LeekDuck explicitly identifies as Super Mega raids.

    Returns a filtered copy of `results`. Anything that is not a Tier 4 EVENT entry is
    passed through untouched: rotations (including ones whose window already closed this
    month, which are still wanted under "Monthly raid rotations"), Tier 5, Elite and
    Shadow bosses are all out of scope.

    MATCHING IS 1-TO-1 ON (BOSS, WINDOW)
    ------------------------------------
    An entry is matched to the single LeekDuck event whose window CONTAINS it, not to
    "any event whose dates happen to overlap". Tier is a property of a boss in a specific
    event, so Mega Starmie on Aug 22 (Super Mega Raid Day) and Mega Starmie on Sep 3
    (Mega Ascension, an ordinary Mega Raid) are two separate questions with two separate
    answers. Overlap matching blurred them together: a boss could be cleared by an event
    weeks away that merely shared a date range, or condemned by one it had nothing to do
    with. Containment ties each entry to the event it actually belongs to.

    REMOVAL REQUIRES POSITIVE EVIDENCE
    ----------------------------------
    An entry is dropped ONLY when the matching event says, in so many words, that this
    boss is a Super Mega raid - either:

      * the boss sits under a "Super Mega Raids" heading on that event's page, or
      * the event is a Super Mega Raid Day (by slug or title) and does not list the boss
        as an ordinary Mega Raid boss elsewhere on the page.

    Absence of evidence is never removal. If no event matches, if the page could not be
    parsed, or if the event simply does not mention the boss, the entry is KEPT and
    Pokebattler stands. Mega Ascension is the case this protects: it is a plain event that
    runs ordinary Mega Raids, it is not a Super Mega Raid Day, and nothing about it should
    cause a removal.
    """
    try:
        import leekduck_crosscheck as lc
        from leekduck_tiers import load_base_form_map, load_legendary_species
    except ImportError as exc:
        print(f"  LeekDuck cross-check unavailable ({exc}) - keeping all entries")
        return results

    try:
        events = lc.discover_events()
        legendary = load_legendary_species(REPO_ROOT / "csv/tier5-bosses.csv")
        base_form_map = load_base_form_map(REPO_ROOT / "ct-calculator.html")

        def sections_for(e):
            try:
                return lc.extract_sections(lc.http_text(e["link"]))
            except Exception as exc:
                print(f"    !! fetch/parse failed for {e.get('eventID')}: {exc}")
                return None

        index = lc.build_leekduck_index(events, sections_for, legendary, base_form_map,
                                        verbose=False)
    except Exception as exc:
        print(f"  LeekDuck cross-check FAILED ({type(exc).__name__}: {exc}) "
              f"- keeping all entries")
        return results

    parsed = [c for c in index if c["publishable"] or c["superMega"]]
    print(f"  LeekDuck: {len(index)} event(s) discovered, {len(parsed)} with a readable "
          f"boss list")
    if not parsed:
        print("  LeekDuck cross-check found no readable boss lists - markup may have "
              "changed. Keeping all entries.")
        return results

    def contains(event, start, end):
        """True when the event's window covers the entry's window, at day granularity."""
        if not event["start"] or not event["end"] or not start or not end:
            return False
        return event["start"].date() <= start.date() and event["end"].date() >= end.date()

    kept = []
    for r in results:
        if r.get("category") != "event" or r.get("archivePage") != lc.TIER4_ARCHIVE_PAGE:
            kept.append(r)
            continue

        start = lc.parse_site_date(r.get("startDate"))
        end = lc.parse_site_date(r.get("endDate"))
        window = f"{r.get('startDate')} -> {r.get('endDate')}"

        matches = [c for c in index if contains(c, start, end)]
        if not matches:
            print(f"  keep {r['name']} [{window}]: no LeekDuck event covers this window")
            kept.append(r)
            continue

        # Prefer the tightest covering event - the one this entry actually belongs to.
        event = min(matches, key=lambda c: (c["end"] - c["start"]).total_seconds())
        eid = event["eventID"]

        if r["name"] in event["superMega"]:
            print(f"  DROP {r['name']} [{window}]: listed under a Super Mega Raids "
                  f"heading in {eid}")
            continue

        if event["isSuperMegaDay"] and r["name"] not in event["publishable"]:
            print(f"  DROP {r['name']} [{window}]: {eid} is a Super Mega Raid Day and "
                  f"does not list it as a Mega Raid boss")
            continue

        why = ("listed as a Mega Raid boss" if r["name"] in event["publishable"]
               else "not identified as Super Mega")
        print(f"  keep {r['name']} [{window}]: {eid} - {why}")
        kept.append(r)

    dropped = len(results) - len(kept)
    print(f"  LeekDuck cross-check: {dropped} event mega raid(s) dropped as Super Mega")
    return kept


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

    def build_result(name, key):
        """Assembles one result dict for a known boss, applying the expiry rule. Returns the
        dict to append, or None if the boss should be filtered out. Shared by the live-API
        pass and the this-month-rotation retention pass below so both use identical logic."""
        info = known_bosses[key]
        # Prefer the static, hand-verified CONFIRMED_ROTATION_DATES table over whatever
        # the live website scrape found - it's cross-checked against two independent
        # sources and, once entered, doesn't drift if Pokebattler's page changes wording.
        # Only fall back to the live scrape for bosses not yet in that table (e.g. a new
        # month's rotation before it's been manually confirmed and added).
        start_date, end_date = CONFIRMED_ROTATION_DATES.get(key) or dates_by_name.get(key, (None, None))

        # NULL-DATE RULE: an entry with neither a start nor an end date is never published.
        # Every expiry check below is skipped when end_dt is None, so an undated boss used
        # to persist forever - which is how Mega Raichu X/Y stayed on the site from July
        # onward. Rotation data is only trustworthy when the window is defined, so drop it
        # rather than show it under "Currently active".
        # This rule is local and needs no network, so it still applies when the LeekDuck
        # cross-check below is unavailable.
        if not start_date and not end_date:
            print(f"  skipping {name}: no start/end date - undated entries are not published")
            return None

        end_dt = parse_pokebattler_datetime(end_date)

        # Classify BEFORE filtering: a single calendar day (start == end) is an Event -
        # GO Fest makeup days, Community Day raids, etc, always short one-day windows.
        # Anything spanning multiple days, or with no matched date, is the standard
        # Monthly Rotation (usually 1-2 weeks).
        category = "event" if (start_date and date_only(start_date) == date_only(end_date)) else "rotation"

        # Expiry rule differs by category:
        #  - ROTATION bosses stay visible for the WHOLE month their window falls in, even
        #    after the ~1-2 week window itself has passed, and only drop once the calendar
        #    month actually flips. People still want retroactive monthly boss guides (e.g.
        #    Azelf mid-to-late August after its early-August window ended). A rotation boss
        #    is dropped only when its end date is in an EARLIER month than today.
        #  - EVENTS (one-day windows) keep the old behavior: dropped the moment they're over,
        #    since a finished one-day event isn't a "this month's rotation" people revisit.
        # No "hasn't started yet" exclusion (future-dated bosses show with a dated header);
        # that was removed earlier after it silently emptied the Event row for a distant event.
        if end_dt:
            if category == "event":
                if now > end_dt:
                    print(f"  skipping {name}: event window ended {end_date}, already over")
                    return None
            else:  # rotation
                # dropped only once we're past the month the window ended in
                month_over = (now.year, now.month) > (end_dt.year, end_dt.month)
                if month_over:
                    print(f"  skipping {name}: rotation window's month ({end_date}) has passed")
                    return None

        return {
            "name": name,
            "startDate": start_date,
            "endDate": end_date,
            "category": category,
            "archivePage": info["archivePage"],
            "difficulty": info["difficulty"],
            "weather": info["weather"],
        }

    # Pass 1: everything the live API currently reports as active.
    for name in current_names:
        key = normalize_name(name)
        if key not in known_bosses or key in seen:
            continue
        r = build_result(name, key)
        if r is None:
            continue
        seen.add(key)
        results.append(r)

    # Pass 2: retain THIS MONTH's confirmed rotation bosses even after the live API stops
    # reporting them. Once a rotation window ends, Pokebattler drops the boss from its API
    # entirely, so it never reaches Pass 1 - which is why a boss like Azelf vanished from the
    # landing page the moment its early-August window closed, mid-August. Anything in the
    # hand-verified CONFIRMED_ROTATION_DATES table whose window ended in the current month is
    # re-added here (build_result still applies the month-flip drop, so next month it falls off
    # on its own). Bosses whose window is a future month are left to Pass 1 / the live scrape.
    for key, (start_date, end_date) in CONFIRMED_ROTATION_DATES.items():
        if key in seen or key not in known_bosses:
            continue
        end_dt = parse_pokebattler_datetime(end_date)
        if not same_month(end_dt, now):
            continue
        # reconstruct the display name from the CSV's known record (title-cased key is close,
        # but known_bosses stores the canonical name via load_known_bosses)
        display_name = known_bosses[key].get("name") or key.title()
        r = build_result(display_name, key)
        if r is None:
            continue
        seen.add(key)
        results.append(r)

    # ---- LEEKDUCK CROSS-CHECK (event mega raids only) ----------------------------------
    # Pokebattler stays authoritative for what is running and when. LeekDuck answers one
    # question: for a mega raid attached to an EVENT, is it a Tier 4 Mega Raid or a Super
    # Mega Raid? Pokebattler lists Super Mega Raid Days as ordinary megas, which is how
    # Mega Starmie (Aug 22) and Mega Staraptor (Sep 19) reached the site.
    #
    # FAILS OPEN, DELIBERATELY. If ScrapedDuck or leekduck.com is unreachable, or the
    # parser returns nothing because their markup changed, this drops NOTHING and logs
    # loudly. Silence from a cross-check must never be read as "delete everything" - that
    # would empty the page on any upstream outage. Rotations are never touched here at
    # all; neither are non-mega entries.
    results = apply_leekduck_crosscheck(results)

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
