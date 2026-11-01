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
import os
import re
import sys
from datetime import datetime, timezone, timedelta

from pathlib import Path
from zoneinfo import ZoneInfo

# The furthest-behind inhabited timezone (American Samoa / Niue, UTC-11). A dated entry is only
# retired once its day is over there, so nothing is hidden from a player whose local date still
# matches the listing.
LAST_TZ_OFFSET = timedelta(hours=11)

try:
    import requests
except ImportError:
    print("Missing dependency. Install with: pip install requests")
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent
POKEBATTLER_API_URL = "https://fight.pokebattler.com/raids"
# Pokebattler raids pages to read dates from, in order; the first that yields any dates is used.
# Pokebattler moved www.pokebattler.com to a new site built in the browser, which this script's
# plain-text read can't see into; the previous site stays up at old.pokebattler.com, so it goes
# first, with www kept as a fallback in case old.* is retired or www goes back to plain HTML.
POKEBATTLER_PAGE_USED = None   # which of these supplied the dates on this run (recorded in the output)
# NO LONGER REQUESTED (Nov 2026): old.pokebattler.com answers GitHub's servers with a Cloudflare 403
# (and its robots.txt disallows bots), and www.pokebattler.com is a JavaScript app with no data
# in its HTML. Start dates now come from the API itself (upcoming/startDate on each raid entry),
# so the bot makes one request to Pokebattler per run. Kept only for reference.
_UNUSED_POKEBATTLER_WEB_URLS = [
    "https://old.pokebattler.com/raids",
    "https://www.pokebattler.com/raids",
]
# Second schedule source: LeekDuck's event calendar as JSON, published on GitHub by the ScrapedDuck
# project (leekduck_crosscheck.py already reads it). Pokebattler's raids page is plain HTML that this
# script pattern-matches; when Pokebattler serves it as an empty JavaScript shell instead, it yields
# no dates at all - and since the API only lists bosses that are running NOW, every upcoming
# rotation silently vanished (Oct 2026: Giratina Origin / Mega Sableye, Oct 28 - Nov 3, missing).
SCRAPEDDUCK_EVENTS_URL = "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/events.json"

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
    # tier5-data.csv and tier5-ae-data.csv were merged into tier5-merged.csv and then deleted.
    # load_known_bosses() silently skips a mapped file that does not exist, so this quietly
    # dropped EVERY Tier 5 Legendary boss from known_bosses - and since a boss the API reports is
    # only published if it is in known_bosses, no Legendary raid could ever reach live-bosses.json.
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
    # September. Cross-verified against two independent sources, as this table requires:
    #   - LeekDuck, via ScrapedDuck events.json, event
    #     "mega-beedrill-in-mega-raids-september-2026": start 2026-09-08, end 2026-09-15
    #   - Pokebattler's own live-bosses.json snapshot of 2026-09-06, taken before the rotation
    #     began and so still carrying the "From" date: Sep 8 -> Sep 15
    # They agree exactly. (The old (end - 6 days) inference would have said Sep 9.)
    "mega beedrill": ("Sep 8, 2026", "Sep 15, 2026"),
    # October. First Shadow Tier 5 boss in the archive. Cross-verified: pokebattler.com/raids
    # lists "Shadow Landorus" From Oct 7, 2026 6:00 AM - Until Nov 3, 2026 10:00 PM, and the site
    # author confirmed the same window independently. Entered here because a boss added to the
    # archive after its window opens is first seen with no start date, and nothing could
    # recover it. Shadow Tier 5 runs one boss per month, so expect one entry per month.
    "shadow landorus incarnate": ("Oct 7, 2026", "Nov 3, 2026"),
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
    # Every lookup is made with normalize_name(), but these keys were only lower-cased, so an
    # archive name that normalizes differently could never be found ("Shadow Landorus" in a CSV
    # vs the "shadow landorus incarnate" a lookup asks for). Each entry is also registered under
    # its normalized key. Additive only: an existing key is never overwritten, so nothing that
    # matched before can match differently now.
    for k, v in list(known.items()):
        known.setdefault(normalize_name(v["name"]), v)
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
    # Shadow raids (Shadow Tier 5 and friends) use the same suffix convention -
    # 'LANDORUS_SHADOW_FORM', 'THUNDURUS_SHADOW_FORM' - while the archives and Pokebattler's own
    # website write 'Shadow Landorus'. Same reorder as Mega, for the same reason.
    if "Shadow" in words[1:]:
        words.remove("Shadow")
        words.insert(0, "Shadow")
    return " ".join(words)


# Species whose archive name always carries a forme, mapped to the forme Pokebattler means when
# it leaves one off (see normalize_name).
SHADOW_DEFAULT_FORMES = {
    "landorus": "incarnate", "thundurus": "incarnate", "tornadus": "incarnate",
    "enamorus": "incarnate", "giratina": "altered",
}


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
    # The website also writes X/Y forms with a bare hyphen and no spaces ("Mega Raichu-X",
    # "Mega Charizard-Y") while the archives and the API use a space ("Mega Raichu X").
    # Restricted to a trailing single X or Y on purpose: a blanket hyphen strip would
    # mangle "Ho-Oh" and "Porygon-Z", whose hyphens are part of the real name.
    cleaned = re.sub(r"-([xy])$", r" \1", cleaned)
    if re.match(r"^(burn|chill|douse|shock)\s+genesect$", cleaned):
        return "genesect"
    cleaned = re.sub(r"\s+of many battles$", "", cleaned)
    # The API's "Zacian Crowned Sword" / "Zamazenta Crowned Shield" are the archive's
    # "Zacian Crown" / "Zamazenta Crown"; without this the two never matched.
    cleaned = re.sub(r"^(zacian|zamazenta) crowned (sword|shield)$", r"\1 crown", cleaned)
    # Shadow raids name the DEFAULT forme only by omission. Pokebattler lists Shadow Landorus as
    # 'LANDORUS_SHADOW_FORM' / "Shadow Landorus", while the archive spells the forme out
    # ("Shadow Landorus Incarnate", matching its regular "Landorus Incarnate" row). Both
    # spellings are folded onto the full one so either can be used in the CSV. Only an exact
    # "shadow <species>" is touched, so "Shadow Landorus Therian" stays Therian.
    m = re.match(r"^shadow\s+(\S+)$", cleaned)
    if m and m.group(1) in SHADOW_DEFAULT_FORMES:
        cleaned = f"shadow {m.group(1)} {SHADOW_DEFAULT_FORMES[m.group(1)]}"
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


# ----------------------------------------------------------------------------
# Full record of every request to Pokebattler, for Pokebattler's owner to look into the
# Cloudflare 403s: the request as sent (URL + headers) and the response exactly as received
# (status, every header - cf-ray, server, set-cookie... - and the whole body, byte for byte).
# Written only when PB_DEBUG_DIR is set; the workflow sets it and uploads the folder as a run
# artifact, so nothing here is committed to the public repo.
# ----------------------------------------------------------------------------
PB_DEBUG_DIR = os.environ.get("PB_DEBUG_DIR") or None


def save_pokebattler_exchange(label, url, request_headers, resp=None, error=None):
    if not PB_DEBUG_DIR:
        return
    try:
        folder = Path(PB_DEBUG_DIR)
        folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        base = folder / f"{stamp}-{label}"
        record = {"label": label, "requestedAt": datetime.now(timezone.utc).isoformat(), "url": url,
                  "requestHeaders": dict(resp.request.headers) if resp is not None and resp.request is not None
                                    else dict(request_headers or {}),
                  "error": error}
        if resp is not None:
            ctype = resp.headers.get("Content-Type", "")
            ext = ".json" if "json" in ctype else ".html" if "html" in ctype else ".txt"
            body_file = base.with_name(base.name + "-body" + ext)
            body_file.write_bytes(resp.content or b"")
            record.update({
                "status": resp.status_code, "reason": resp.reason, "finalUrl": resp.url,
                "elapsedSeconds": resp.elapsed.total_seconds() if resp.elapsed else None,
                "redirects": [{"status": h.status_code, "url": h.url, "headers": dict(h.headers)} for h in resp.history],
                "responseHeaders": dict(resp.headers),
                "bodyBytes": len(resp.content or b""), "bodyFile": body_file.name,
            })
        base.with_name(base.name + "-headers.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
        print(f"Saved the full Pokebattler response for {url} ({label})")
    except Exception as e:                      # a debug record must never break a run
        print(f"Could not save the Pokebattler response for {url} (non-fatal): {e}")


# normalized boss name -> (startDate epoch ms, display name), from the API's upcoming entries
API_START_DATES = {}
API_RAW = {}   # the full API response of this run (fetch_current_bosses), for its raid schedule
# (normalized boss name, 'Nov 5, 2026') of every schedule window marked localTime: false - a fixed
# real-world time rather than "10 AM local everywhere", which is how Pokebattler lists in-person,
# location-bound events (GO Wild Area: Sendai / Mexico City, Nov 6-8 2026, shows as one Nov 5-9
# global-time window). Published as events labelled "In-person", never as monthly rotation.
API_IN_PERSON = set()

# Multi-day GLOBAL events that Pokebattler's schedule can't tell apart from a monthly rotation
# (no field marks them). Keyed by (normalized boss name, start date as published) so the same boss's
# regular rotation later is unaffected; the value is an optional label for the landing page.
EVENT_WINDOWS = {
    # Into the Wild, Nov 9-13 2026 (leekduck.com/events/into-the-wild-2026): Crowned Zacian and
    # Zamazenta take over five-star raids for the event, with Raid Hours on Nov 9 and 10.
    ("zacian crown", "Nov 9, 2026"): None,
    ("zamazenta crown", "Nov 9, 2026"): None,
}


def _find_api_schedule(data, depth=0):
    """The API's raid schedule: a list of entries with pokemon / tier / startDate / endDate
    (epoch ms), one per boss per window - e.g. GIRATINA_ALTERED_FORM, RAID_LEVEL_5, Nov 4 -> Nov 8.
    It sits beside "tiers" and "dynamaxPokemon"; found by its shape rather than its key name, so a
    renamed key doesn't silently cost us the schedule. Returns (key, list) or (None, [])."""
    if depth > 2:
        return None, []
    items = data.items() if isinstance(data, dict) else []
    for k, v in items:
        if (isinstance(v, list) and v and isinstance(v[0], dict)
                and {"pokemon", "tier", "startDate", "endDate"} <= set(v[0])):
            return k, v
    for k, v in items:
        if isinstance(v, dict):
            kk, vv = _find_api_schedule(v, depth + 1)
            if vv:
                return f"{k}.{kk}", vv
    return None, []


def fetch_boss_dates_from_api_schedule():
    """Pokebattler's own raid schedule -> (dates_by_name, occurrences), in the same shape as the
    ScrapedDuck reader. Every window has a real start AND end. Dates are read in Pacific time,
    where they land on the announced days (Giratina Altered: Nov 4 6:00 AM -> Nov 8 10:00 PM).
    Skipped: Max Battle tiers (Dynamax / Gigantamax - not raids), Super Mega tiers (handled as
    enhanced raids elsewhere) and legacy pools. A boss can have several windows (Crowned Zacian:
    a global Nov 5-9 window and a regular Nov 9-13 one) - all are kept as occurrences;
    dates_by_name holds the earliest window that hasn't ended yet."""
    API_IN_PERSON.clear()
    key, schedule = _find_api_schedule(API_RAW.get("data") or {})
    if not schedule:
        print("::warning title=Pokebattler schedule::No raid schedule found in Pokebattler's API "
              "response (a list of pokemon/tier/startDate/endDate entries). Falling back to the "
              "ScrapedDuck (LeekDuck) schedule for raid dates.")
        return {}, []
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    rows = []
    for e in schedule:
        tier = str(e.get("tier", ""))
        if "_MAX" in tier or "_MEGA_ENHANCED" in tier or "_LEGACY" in tier:
            continue
        s, en = e.get("startDate"), e.get("endDate")
        pid = e.get("pokemon") or e.get("pokemonId")
        if not (pid and isinstance(s, (int, float)) and isinstance(en, (int, float))):
            continue
        k = normalize_name(pokemon_id_to_name(pid))
        rows.append((s, en, k))
        if e.get("localTime") is False:
            API_IN_PERSON.add((k, re.match(r"^([A-Za-z]+ \d+, \d+)", _api_date(s)).group(1)))
    rows.sort()
    occurrences, chosen = [], {}
    for s, en, k in rows:
        occ = (k, _api_date(s), _api_date(en))
        if occ not in occurrences:
            occurrences.append(occ)
        # per boss: the earliest window that hasn't ended; if every window has ended, the last one
        prev = chosen.get(k)
        if prev is None or (prev[2] < now_ms and (en >= now_ms or en > prev[2])):
            chosen[k] = (occ[1], occ[2], en)
    dates_by_name = {k: (a, b) for k, (a, b, _e) in chosen.items()}
    print(f"Found {len(occurrences)} raid window(s) for {len(dates_by_name)} boss(es) in "
          f"Pokebattler's raid schedule (API key '{key}')")
    return dates_by_name, occurrences


def _api_date(ms):
    """API startDate (epoch ms, UTC) -> 'Nov 4, 2026 6:00 AM' in Pacific time, the format the
    other schedule dates use. Pokebattler's rotation starts (14:00 UTC = 6 AM Pacific) land on
    the right calendar day in Pacific time, as the site's dates are read."""
    dt = datetime.fromtimestamp(ms / 1000, timezone.utc).astimezone(ZoneInfo("America/Los_Angeles"))
    hour12 = dt.hour % 12 or 12
    return f"{dt:%b} {dt.day}, {dt.year} {hour12}:{dt:%M} {'AM' if dt.hour < 12 else 'PM'}"


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
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        resp = requests.get(POKEBATTLER_API_URL, timeout=20, headers=headers)
    except Exception as e:
        save_pokebattler_exchange("api", POKEBATTLER_API_URL, headers, error=f"{type(e).__name__}: {e}")
        raise
    save_pokebattler_exchange("api", POKEBATTLER_API_URL, headers, resp)
    resp.raise_for_status()
    data = resp.json()
    API_RAW["data"] = data

    names = []
    enhanced_names = set()
    API_START_DATES.clear()
    for tier_entry in data.get("tiers", []):
        # Max Battle tiers (RAID_LEVEL_6_MAX, RAID_LEVEL_2_MAX_FUTURE, ...) are Dynamax /
        # Gigantamax battles, not raids: Dynamax Dialga or Palkia there would otherwise match the
        # archive's raid Dialga / Palkia. Skipped entirely - no roster entries, no start dates.
        if "_MAX" in tier_entry.get("tier", ""):
            print(f"[{tier_entry.get('tier', '')}] skipped - Max Battle tier, not raids")
            continue
        # Upcoming bosses carry "upcoming": true and "startDate" (epoch ms, UTC) on their entry -
        # the only schedule data the API has (no end dates). Kept per boss: the earliest start.
        if "_LEGACY" not in tier_entry.get("tier", "") and "_MEGA_ENHANCED" not in tier_entry.get("tier", ""):
            for r in tier_entry.get("raids", []):
                pid = r.get("pokemonId") or r.get("pokemon")
                if pid and r.get("upcoming") and isinstance(r.get("startDate"), (int, float)):
                    k = normalize_name(pokemon_id_to_name(pid))
                    if k and (k not in API_START_DATES or r["startDate"] < API_START_DATES[k][0]):
                        API_START_DATES[k] = (r["startDate"], pokemon_id_to_name(pid))
        tier_key = tier_entry.get("tier", "")
        raids = tier_entry.get("raids", [])
        # Super Mega tiers, per Pokebattler's own naming:
        #   RAID_LEVEL_4_MEGA_ENHANCED  -> Super Mega
        #   RAID_LEVEL_5_MEGA_ENHANCED  -> Super Mega Legendary
        # These are a different raid class, not soloable Tier 4 Mega raids, and this
        # archive does not cover them. The tier name states it outright, so they are
        # excluded here at the source rather than being pulled in and filtered out later
        # by matching names against an external schedule.
        if "_MEGA_ENHANCED" in tier_key:
            # GATE 1 SOURCE (authoritative). These names are RECORDED, not just skipped - a
            # boss can also reach the publish list via the website-scrape pass, which carries
            # no tier data at all, and that pass needs to be able to ask "did the API call
            # this Super Mega?" Discarding the names here is what made Gate 1 unverifiable
            # for anything that did not come from this function.
            for r in raids:
                if r.get("cp", 0) != 0:
                    continue
                pid = r.get("pokemonId") or r.get("pokemon")
                if pid:
                    enhanced_names.add(pokemon_id_to_name(pid).strip().lower())
            print(f"[{tier_key}] skipping {len(enhanced_names)} boss(es) - Super Mega tier, not Tier 4 Mega")
            continue
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

    return names, enhanced_names


def fetch_boss_dates_from_website():
    """Retired Nov 2026 - Pokebattler's raids pages are no longer requested (see
    _UNUSED_POKEBATTLER_WEB_URLS). Start dates come from the API; windows from ScrapedDuck."""
    return {}, []


def _page_report(url, status=None, size=0, dates=0, note=None):
    POKEBATTLER_PAGE_REPORT.append({"url": url, "status": status, "bytes": size, "dates": dates, "note": note})
    if note:
        print(f"::warning title=Pokebattler page::{url}: {note}")


def _why_no_dates(resp):
    """A best guess at why a fetched raids page held no readable dates."""
    body = resp.text or ""
    low = body.lower()
    if resp.status_code in (403, 429, 503) or "just a moment" in low or "cf-chl" in low or "challenge-platform" in low:
        return f"blocked (HTTP {resp.status_code}, looks like a Cloudflare/bot check)"
    if len(body) < 5000 or "enable javascript" in low or ('id="root"' in low and "cp" not in low):
        return f"page has no raid content without JavaScript ({len(body)} bytes)"
    return f"no dates in the expected format ({len(body)} bytes) - the page layout may have changed"


def _dates_from_pokebattler_page(url):
    """One Pokebattler raids page -> (dates_by_name, web_occurrences); empty if it can't be read."""
    headers = {"User-Agent": "Mozilla/5.0"}
    label = re.sub(r"[^a-z0-9]+", "-", url.split("//", 1)[-1].lower()).strip("-")
    try:
        resp = requests.get(url, timeout=20, headers=headers)
    except Exception as e:
        save_pokebattler_exchange(label, url, headers, error=f"{type(e).__name__}: {e}")
        print(f"Could not fetch {url} for date info (non-fatal): {e}")
        _page_report(url, note=f"request failed: {type(e).__name__}: {str(e)[:120]}")
        return {}, []
    save_pokebattler_exchange(label, url, headers, resp)
    if resp.status_code >= 400:
        print(f"Could not fetch {url} for date info (non-fatal): HTTP {resp.status_code}")
        _page_report(url, status=resp.status_code, size=len(resp.text or ""), note=_why_no_dates(resp))
        return {}, []

    try:
        from bs4 import BeautifulSoup
        text = BeautifulSoup(resp.text, "html.parser").get_text(separator="")
    except ImportError:
        text = resp.text

    date_matches = list(DATE_BLOCK_RE.finditer(text))
    dates_by_name = {}
    web_occurrences = []
    for i, m in enumerate(date_matches):
        start = m.end()
        end = date_matches[i + 1].start() if i + 1 < len(date_matches) else len(text)
        block_text = text[start:end]
        for name in BOSS_NAME_WEB_RE.findall(block_text):
            # The page text is joined with no separator, so consecutive entries run
            # together as "...Mega Dragonite2079CP2599CPMega Malamar1279CP...". The name
            # pattern then starts matching at the previous boss's trailing "CP" and
            # captures "CPMega Malamar". Only the FIRST boss in each dated block survived
            # that; every subsequent one got a bogus key and was silently dropped, which
            # is why multi-boss event days never came through.
            clean_name = re.sub(r"^CP", "", name)
            clean_name = re.sub(r"Regional$", "", clean_name).strip()
            key = normalize_name(clean_name)
            if key not in dates_by_name:
                dates_by_name[key] = (m.group(1), m.group(2))
            # dates_by_name keeps only the FIRST window per boss, which is all the date
            # lookup needs. But a boss can legitimately appear in several dated blocks -
            # Mega Victreebel runs on Aug 31 AND again on Sep 5, Mega Starmie on Sep 3 AND
            # Sep 5 - and keying by name alone collapses those into one. Every occurrence
            # is recorded separately here so each (boss, window) can stand on its own.
            occurrence = (key, m.group(1), m.group(2))
            if occurrence not in web_occurrences:
                web_occurrences.append(occurrence)
    print(f"Found date info for {len(dates_by_name)} boss(es) on {url} "
          f"({len(web_occurrences)} boss/window occurrence(s))")
    _page_report(url, status=resp.status_code, size=len(resp.text or ""), dates=len(dates_by_name),
                 note=None if dates_by_name else _why_no_dates(resp))
    return dates_by_name, web_occurrences


def _sd_boss_name(raw, event_name):
    """ScrapedDuck boss name -> the archive's spelling. 'Giratina (Origin)' -> 'Giratina Origin'.
    Shadow raids list the plain species ('Landorus (Incarnate)'); the event name says it's a
    Shadow raid ('... in Shadow Raids'), so 'Shadow ' is put back in front."""
    name = re.sub(r"\s*\(([^)]*)\)", lambda m: " " + re.sub(r"\s*Formes?$", "", m.group(1).strip()), raw).strip()
    # The default forme carries no suffix in the archive: ScrapedDuck's "Deoxys (Normal)" is the
    # archive's "Deoxys" (its Attack/Defense/Speed formes keep theirs). Without this the normal
    # forme never matched and was dropped from Nov 25 - Dec 1 although it has strategies.
    name = re.sub(r"\s+Normal$", "", name)
    if re.search(r"\bShadow Raids?\b", event_name or "", re.I) and not name.lower().startswith("shadow "):
        name = "Shadow " + name
    return name


def _sd_date(iso):
    """'2026-10-28T06:00:00.000' -> 'Oct 28, 2026 6:00 AM', the format the website dates use."""
    if not iso:
        return None
    try:
        dt = datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    hour12 = dt.hour % 12 or 12
    return f"{dt:%b} {dt.day}, {dt.year} {hour12}:{dt:%M} {'AM' if dt.hour < 12 else 'PM'}"


def fetch_boss_dates_from_scrapedduck():
    """Raid schedule from LeekDuck via ScrapedDuck: every 'raid-battles' event, each boss with its
    own window. Same return shape as fetch_boss_dates_from_website() so the two can be merged."""
    try:
        resp = requests.get(SCRAPEDDUCK_EVENTS_URL, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        events = resp.json()
    except Exception as e:
        print(f"Could not fetch the ScrapedDuck (LeekDuck) schedule (non-fatal): {e}")
        return {}, []
    dates_by_name, occurrences = {}, []
    for ev in events if isinstance(events, list) else []:
        if ev.get("eventType") != "raid-battles":
            continue
        start, end = _sd_date(ev.get("start")), _sd_date(ev.get("end"))
        if not end:
            continue
        bosses = (((ev.get("extraData") or {}).get("raidbattles") or {}).get("bosses")) or []
        for b in bosses:
            key = normalize_name(_sd_boss_name(b.get("name", ""), ev.get("name", "")))
            if not key:
                continue
            dates_by_name.setdefault(key, (start, end))
            occ = (key, start, end)
            if occ not in occurrences:
                occurrences.append(occ)
    print(f"Found date info for {len(dates_by_name)} boss(es) in the ScrapedDuck schedule "
          f"({len(occurrences)} boss/window occurrence(s))")
    return dates_by_name, occurrences


def fetch_all_boss_dates():
    """The raid schedule. Pokebattler's API comes first: its raid schedule (full start/end windows)
    is used for every boss it lists, and ScrapedDuck only for bosses it doesn't list. Beyond that,
    for a ScrapedDuck window, an upcoming boss's start date is taken
    from its startDate (read in fetch_current_bosses, which must run first). The API has no end
    dates, so windows - and bosses the API gives no date for - come from the ScrapedDuck
    (LeekDuck) schedule. An API start replaces ScrapedDuck's start for the window it belongs to
    (the one starting within 3 days of it), so a boss with two windows keeps its other one.
    Returns how much each source supplied, so a source that comes back empty is visible."""
    api_dates, api_occ = fetch_boss_dates_from_api_schedule()
    sd_all, sd_occ_all = fetch_boss_dates_from_scrapedduck()
    # ScrapedDuck only fills in bosses Pokebattler's schedule doesn't list at all.
    sd_dates = {k: v for k, v in sd_all.items() if k not in api_dates}
    sd_occ = [o for o in sd_occ_all if o[0] not in api_dates]

    def parse(d):
        try:
            return datetime.strptime(d, "%b %d, %Y %I:%M %p")
        except (TypeError, ValueError):
            return None

    api = {k: (_api_date(ms), nm) for k, (ms, nm) in API_START_DATES.items()}
    applied, moved = set(), []

    def with_api_start(key, start, end):
        if key not in api:
            return start, end
        api_start = api[key][0]
        a_dt, s_dt = parse(api_start), parse(start)
        if a_dt and s_dt and abs((a_dt - s_dt).total_seconds()) <= 3 * 86400:
            if a_dt.date() != s_dt.date():
                moved.append(f"{api[key][1]}: {start} -> {api_start}")
            applied.add(key)
            return api_start, end
        return start, end

    occurrences = list(api_occ) + [(k,) + with_api_start(k, s_, e_) for k, s_, e_ in sd_occ]
    dates_by_name = dict(api_dates)
    dates_by_name.update({k: with_api_start(k, s_, e_) for k, (s_, e_) in sd_dates.items()})

    # Upcoming in the API but with no window anywhere: no end date to show them with yet.
    no_end = sorted(f"{nm} (from {d})" for k, (d, nm) in api.items() if k not in dates_by_name)
    print(f"Pokebattler API: start dates for {len(api)} upcoming boss(es); "
          f"{len(applied)} used for a schedule window")
    for m in moved:
        print(f"  API start date differs from ScrapedDuck's: {m}")
    if no_end:
        print("  Upcoming in the API but not yet in the ScrapedDuck schedule (no end date to publish "
              f"them with): {', '.join(no_end)}")

    health = {"pokebattlerSchedule": len(api_dates), "pokebattlerScheduleWindows": len(api_occ),
              "scrapedDuck": len(sd_dates), "pokebattlerApiStartDates": len(api),
              "pokebattlerApiStartsUsed": len(applied), "pokebattlerApiUpcomingWithoutEndDate": no_end}
    if not api_dates and not sd_all:
        print("::error title=No raid schedule::Neither Pokebattler's raid schedule nor the ScrapedDuck "
              "(LeekDuck) schedule returned any raid windows, so upcoming rotations will be missing "
              "from the landing page.")
    return dates_by_name, occurrences, health




# ============================================================================
# THE TWO GATES
# ----------------------------------------------------------------------------
# A boss is published ONLY if it passes both. Each returns (passed, reason) so a
# rejection always says which gate stopped it and why - a boss silently vanishing
# is as much a bug as a wrong boss appearing.
#
# These exist as two named functions, called from one place, specifically because
# the checks used to be scattered: the tier check lived inside the API fetch, the
# date check inside build_result, and the Super Mega backstop inside a separate
# cross-check that only inspected one category. A boss reaching the site through a
# path that skipped one of them is exactly how a Super Mega raid was published
# under Monthly Rotation.
# ============================================================================

def gate_1_not_enhanced(name, key, enhanced_names, leekduck_verdict):
    """GATE 1: the boss must be verified NOT to be an enhanced (Super Mega) raid.

    Two independent authorities, checked in order of trust:

      1. Pokebattler's own tier string (RAID_LEVEL_*_MEGA_ENHANCED). Authoritative
         when the boss came from the API - the tier names it outright.
      2. LeekDuck/ScrapedDuck Super Mega Raid Day events. The only authority for a
         boss found by the website scrape, which carries no tier data at all.

    Returns (False, reason) if either says enhanced.
    """
    if key in enhanced_names or name.strip().lower() in enhanced_names:
        return False, "Pokebattler tier is _MEGA_ENHANCED (Super Mega)"
    if leekduck_verdict == "super_mega":
        return False, "LeekDuck lists this window as a Super Mega Raid Day"
    return True, None


def gate_2_date_valid(name, start_date, end_date, now, date_only, parse_pokebattler_datetime):
    """GATE 2: the boss must have a window that places it in the current monthly
    rotation, OR be a single-day event (which is published under the event category).

    Returns (passed, category, reason).

    A MISSING START DATE IS NOT DISQUALIFYING. Pokebattler omits the "From" date for a
    rotation that is ALREADY UNDERWAY - DATE_BLOCK_RE's first group is optional - so the
    boss currently being fought is precisely the one most likely to arrive without a start.
    Rejecting those dropped Mega Beedrill's Sep 8-15 slot on the very day it went live.

    This previously returned False to stop a dateless Super Mega entry reaching Monthly
    Rotation. That job belongs to gate 1, which checks two independent authorities for
    enhanced raids and runs before this gate - so the guard here was redundant and cost a
    legitimate rotation. An end date alone still places the boss in a month, which is all
    this gate needs to decide.
    """
    if not start_date and not end_date:
        return False, None, "no start/end date"

    # Single calendar day -> event. Anything longer -> monthly rotation.
    # With no start date there is no single-day window to detect, and an already-running
    # rotation is by definition a rotation, so it is classified as one.
    category = ("event" if (start_date and date_only(start_date) == date_only(end_date))
                else "rotation")

    end_dt = parse_pokebattler_datetime(end_date) if end_date else None
    if end_dt is not None:
        if category == "rotation":
            # A rotation stays visible for the whole month its window falls in, and is
            # dropped only once the calendar month itself has passed - in the LAST timezone to
            # reach it, as for events below. Comparing against the UTC month dropped every
            # October rotation at 5 pm Pacific on Oct 31, leaving the Americas with three
            # October bosses (and no November ones yet, their month not having started).
            month_now = now - LAST_TZ_OFFSET
            if (end_dt.year, end_dt.month) < (month_now.year, month_now.month):
                return False, category, f"rotation window's month ({end_date}) has passed"
        else:
            # A one-day event stays listed until its date has passed in the LAST timezone on
            # earth to reach it.
            #
            # Source end times are UTC and `now` is UTC in CI, so comparing them directly dropped
            # the entry the moment the UTC clock passed it: an event ending "Sep 5, 2026 10:00 AM"
            # disappeared at 03:00 on the 5th for a Pacific player, and even a date-only "Sep 5"
            # died at 16:59 there. Anyone opening the site on the day of the raid saw nothing,
            # which reads as the entry being cut a day early.
            #
            # The site is global, so the entry is held until the date is over at LAST_TZ_OFFSET -
            # American Samoa, UTC-11, the furthest-behind inhabited timezone. (UTC-12 exists but
            # covers only the uninhabited Baker and Howland Islands.) A Sep 5 event therefore
            # survives until 11:00 UTC on Sep 6, by which point it is Sep 6 everywhere.
            #
            # An event is dropped only once its MONTH is over, not once its day is. The landing
            # page shows the whole month's raid information: an event on October 5th is still
            # part of October on October 22nd. Retiring it the day after left the page showing
            # only current and upcoming raids, so anything already run vanished from the record.
            # The LAST_TZ_OFFSET shift is kept so the final day of a month is not cut early for
            # players behind UTC.
            local_now = (now - LAST_TZ_OFFSET)
            if (end_dt.year, end_dt.month) < (local_now.year, local_now.month):
                return False, category, f"event's month ({end_date}) has passed"
    return True, category, None




# Shared by build_leekduck_verdicts() and the legacy apply_leekduck_crosscheck(). Module-level
# rather than defined inside one of them, so there is a single definition to keep correct.
SUPER_MEGA_RE = re.compile(r"super[-\s]?mega[-\s]?raid", re.IGNORECASE)
DATE_HEAD_RE = re.compile(r"^([A-Za-z]+ \d+, \d+)")


def parse_day(date_str):
    """'Aug 22, 2026 10:00 AM' -> datetime. The time suffix is dropped before parsing.

    LOAD-BEARING: dates arrive straight from the Pokebattler website scrape formatted WITH a
    time. A strict "%b %d, %Y" parse returns None on every one of those, every entry then
    looks undated, and any check built on it silently no-ops while reporting success.
    """
    if not date_str:
        return None
    m = DATE_HEAD_RE.match(date_str.strip())
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1), "%b %d, %Y")
    except ValueError:
        return None


def build_leekduck_verdicts(candidates):
    """Pre-computes a Super Mega verdict for each (boss key, start day) candidate window.

    This replaces the old after-the-fact apply_leekduck_crosscheck() filter. Same data and
    same 1-to-1 (boss, window) matching rule, but the answer is now available DURING the
    publish decision, so Gate 1 can consult it for every source path rather than a filter
    running afterwards over only one category.

    Returns {(key, start_day): "super_mega"} - keys absent mean "not Super Mega, or not
    determinable". Removal still requires positive evidence: a Super Mega Raid Day event
    that covers the window and does not list the boss as an ordinary Mega Raid boss. A
    fetch failure yields an empty dict, which means Gate 1 falls back to the Pokebattler
    tier string alone.
    """
    verdicts = {}
    try:
        import leekduck_crosscheck as lc
    except ImportError as exc:
        print(f"  LeekDuck cross-check unavailable ({exc}) - Gate 1 will rely on tier data alone")
        return verdicts
    try:
        events = lc.discover_events()
    except Exception as exc:
        print(f"  LeekDuck cross-check FAILED ({type(exc).__name__}: {exc}) - Gate 1 will rely on tier data alone")
        return verdicts

    index = []
    for e in events:
        start = lc.parse_iso(e.get("start"))
        end = lc.parse_iso(e.get("end"))
        if not start or not end:
            continue
        bosses = {b.get("name") for b in
                  (e.get("extraData") or {}).get("raidbattles", {}).get("bosses", [])
                  if b.get("name")}
        eid = e.get("eventID") or ""
        index.append({
            "eventID": eid, "start": start, "end": end, "bosses": bosses,
            "isSuperMega": bool(SUPER_MEGA_RE.search(eid) or SUPER_MEGA_RE.search(e.get("name") or "")),
        })

    smd = [c["eventID"] for c in index if c["isSuperMega"]]
    print(f"  LeekDuck: {len(index)} dated event(s) from ScrapedDuck, "
          f"{len(smd)} Super Mega Raid Day(s): {', '.join(smd) or 'none'}")
    if not index:
        return verdicts

    def contains(event, start, end):
        return event["start"].date() <= start.date() and event["end"].date() >= end.date()

    for key, name, start_day, start_date, end_date in candidates:
        start = parse_day(start_date)
        end = parse_day(end_date)
        if not start or not end:
            continue
        matches = [c for c in index if contains(c, start, end)]
        if not matches:
            continue
        # Tightest covering event is the one this entry actually belongs to.
        event = min(matches, key=lambda c: (c["end"] - c["start"]).total_seconds())
        if event["isSuperMega"] and name not in event["bosses"]:
            verdicts[(key, start_day)] = "super_mega"
            print(f"  LeekDuck: {name} [{start_day}] -> Super Mega "
                  f"({event['eventID']} covers it and does not list it as a Mega Raid boss)")
    return verdicts


def apply_leekduck_crosscheck(results):
    """Drop event mega raids that LeekDuck identifies as Super Mega raids.

    SOURCE: ScrapedDuck JSON, NOT leekduck.com HTML.
    ------------------------------------------------
    leekduck.com returns 403 to non-browser requests, so every page fetch fails from a
    CI runner. The previous version skipped any event whose HTML could not be read, which
    meant the index came back EMPTY, the whole check failed open, and nothing was ever
    dropped - Mega Starmie (Aug 22) and Mega Staraptor (Sep 19) survived every run while
    the logs looked healthy. That was a dependency on an unreachable source, not a parsing
    bug.

    ScrapedDuck mirrors LeekDuck as JSON on raw.githubusercontent.com, which IS reachable,
    and it already carries everything this decision needs:

        eventID / name   "starmie-super-mega-raid-day-2026", "Super Mega Raid Day"
        start / end      real ISO timestamps
        bosses[]         named for raid-battles events

    Super Mega Raid Days are identified from the event's slug and title. No HTML, no
    parsing of page structure, nothing that can silently return nothing.

    MATCHING IS 1-TO-1 ON (BOSS, WINDOW)
    ------------------------------------
    An entry is matched to the single event whose window CONTAINS it, never to "any event
    whose dates overlap". Tier is a property of a boss within a specific event: Mega
    Starmie on Aug 22 (Super Mega Raid Day) and Mega Starmie on Sep 3 (Mega Ascension,
    an ordinary Mega Raid) are separate questions with separate answers.

    REMOVAL REQUIRES POSITIVE EVIDENCE
    ----------------------------------
    An entry is dropped ONLY when its matching event is a Super Mega Raid Day and does not
    list that boss as an ordinary Mega Raid boss. Anything else is kept: no matching event,
    a plain event, a rotation, or a fetch failure all mean KEEP and Pokebattler stands.
    Mega Ascension and Mega Finale are plain events running ordinary Mega Raids and can
    never trigger a removal.
    """
    import re as _re

    SUPER_MEGA_RE = _re.compile(r"super[-\s]?mega[-\s]?raid", _re.IGNORECASE)
    DATE_HEAD_RE = _re.compile(r"^([A-Za-z]+ \d+, \d+)")

    def parse_day(date_str):
        """'Aug 22, 2026 10:00 AM' -> date. Time suffix is dropped before parsing.

        THIS IS LOAD-BEARING. build_result passes dates straight from the Pokebattler
        website scrape, which formats them WITH a time ("Aug 22, 2026 10:00 AM").
        date_only() strips the time, but only later, when groups are assembled - by which
        point this function has already run. A strict "%b %d, %Y" parse returns None on
        every one of those, every entry then looks undated, and the whole check silently
        no-ops while reporting success. That is exactly what happened: Mega Starmie and
        Mega Staraptor survived run after run because their dates carried a time and
        nothing here could read it.
        """
        if not date_str:
            return None
        m = DATE_HEAD_RE.match(date_str.strip())
        if not m:
            return None
        try:
            return datetime.strptime(m.group(1), "%b %d, %Y")
        except ValueError:
            return None

    try:
        import leekduck_crosscheck as lc
    except ImportError as exc:
        print(f"  LeekDuck cross-check unavailable ({exc}) - keeping all entries")
        return results

    try:
        events = lc.discover_events()
    except Exception as exc:
        print(f"  LeekDuck cross-check FAILED ({type(exc).__name__}: {exc}) - keeping all entries")
        return results

    index = []
    for e in events:
        start = lc.parse_iso(e.get("start"))
        end = lc.parse_iso(e.get("end"))
        if not start or not end:
            continue
        bosses = {b.get("name") for b in
                  (e.get("extraData") or {}).get("raidbattles", {}).get("bosses", [])
                  if b.get("name")}
        eid = e.get("eventID") or ""
        index.append({
            "eventID": eid,
            "start": start,
            "end": end,
            "bosses": bosses,
            "isSuperMega": bool(SUPER_MEGA_RE.search(eid) or SUPER_MEGA_RE.search(e.get("name") or "")),
        })

    smd = [c["eventID"] for c in index if c["isSuperMega"]]
    print(f"  LeekDuck: {len(index)} dated event(s) from ScrapedDuck, "
          f"{len(smd)} Super Mega Raid Day(s): {', '.join(smd) or 'none'}")
    if not index:
        print("  LeekDuck cross-check got no usable events - keeping all entries")
        return results

    def contains(event, start, end):
        return event["start"].date() <= start.date() and event["end"].date() >= end.date()

    kept = []
    for r in results:
        # Gate on the ARCHIVE PAGE only, not on category. Gating on category == "event" meant
        # any mega raid that reached here labelled "rotation" was exempt from the Super Mega
        # test entirely - which is precisely how a misclassified Super Mega boss got published
        # under Monthly Rotation. Tier is a property of the boss in its window; it has nothing
        # to do with whether that window happens to be one day or several, so a category was
        # never the right thing to branch on here. Removal still requires positive evidence
        # (see the docstring): a Super Mega Raid Day event that covers the window and does not
        # list the boss as an ordinary Mega Raid boss.
        if r.get("archivePage") != lc.TIER4_ARCHIVE_PAGE:
            kept.append(r)
            continue

        start = parse_day(r.get("startDate"))
        end = parse_day(r.get("endDate"))
        window = f"{r.get('startDate')} -> {r.get('endDate')}"
        if not start or not end:
            print(f"  keep {r['name']} [{window}]: undated, nothing to match against")
            kept.append(r)
            continue

        matches = [c for c in index if contains(c, start, end)]
        if not matches:
            print(f"  keep {r['name']} [{window}]: no event covers this window")
            kept.append(r)
            continue

        # Tightest covering event is the one this entry actually belongs to.
        event = min(matches, key=lambda c: (c["end"] - c["start"]).total_seconds())
        if event["isSuperMega"] and r["name"] not in event["bosses"]:
            print(f"  DROP {r['name']} [{window}]: {event['eventID']} is a Super Mega Raid "
                  f"Day and does not list it as a Mega Raid boss")
            continue
        print(f"  keep {r['name']} [{window}]: {event['eventID']} is not a Super Mega Raid Day")
        kept.append(r)

    dropped = len(results) - len(kept)
    print(f"  LeekDuck cross-check: {dropped} mega raid(s) dropped as Super Mega")
    return kept




def _status_for(start_date, end_date, now):
    """active | future | passed, from the window alone.

    Nothing is deleted on a status change - the group stays in live-bosses.json and this field
    is recomputed on every run. An already-running rotation is published without a start date,
    so a group with only an end date that has not passed is treated as active.
    """
    start = parse_pokebattler_datetime(start_date or "")
    end = parse_pokebattler_datetime(end_date or "")
    # Compared in the furthest-behind inhabited timezone so a window is not retired while it is
    # still that date somewhere.
    local = (now - LAST_TZ_OFFSET).date()
    if end and end.date() < local:
        return "passed"
    if start and start.date() > local:
        return "future"
    return "active"


def _carry_forward_month(date_groups, out_path, now):
    """Accumulate EVERYTHING that belongs to the current month.

    live-bosses.json is the record for the month, not a snapshot of what the source happens to
    list right now. Pokebattler drops a rotation or event as soon as its window closes, so a
    boss shown on the 5th disappears by the 22nd unless the file remembers it.

    Both rotations AND events are carried: a raid that happened on October 5th is still part of
    October's raid information on October 22nd. Anything whose window ended in a PREVIOUS month
    is let go at passover, so each month starts clean without anyone maintaining a table.
    """
    try:
        previous = json.loads(out_path.read_text(encoding="utf-8")).get("dateGroups", [])
    except (OSError, ValueError):
        return date_groups                      # no previous file, or it is unreadable

    # Keyed on the WHOLE window. This used to be (end date, category) alone, because a rotation is
    # published WITH a start date while upcoming and WITHOUT one once live, and keying on the start
    # stored it twice. main() now restores each boss's start date from this file before grouping,
    # so the start is stable across that transition and can be part of the key again. It has to
    # be: Shadow Tier 5 windows routinely share an end date with a weekly rotation (Oct 7 - Nov 3
    # and Oct 28 - Nov 3), and an end-date key let one of them overwrite the other.
    def key(g):
        return (g.get("startDate"), g.get("endDate"), g.get("category"))

    present = {key(g) for g in date_groups}

    carried = []
    for g in previous:
        if g.get("openEnded"):
            continue                          # rebuilt from the API every run; never carried
        if key(g) in present:
            continue                          # the source still reports it; nothing to restore
        # An entry belongs to a month by the window it ended in. A start date is used only when
        # there is no end date, since an already-running rotation is published without a start.
        stamp = (parse_pokebattler_datetime(g.get("endDate") or "")
                 or parse_pokebattler_datetime(g.get("startDate") or ""))
        if not stamp:
            continue
        # The month in the last timezone to reach it (see gate_2_date_valid): carrying by the UTC
        # month let go of the whole of October at 5 pm Pacific on Oct 31.
        month_now = now - LAST_TZ_OFFSET
        if (stamp.year, stamp.month) == (month_now.year, month_now.month):
            carried.append(g)

    if carried:
        rot = sum(1 for g in carried if g.get("category") == "rotation")
        names = [b.get("name") for g in carried for b in g.get("bosses", [])]
        print(f"Carried forward {len(carried)} group(s) the source no longer lists "
              f"({rot} rotation, {len(carried) - rot} event): {names}")
    return date_groups + carried


def main():
    known_bosses = load_known_bosses()
    print(f"Loaded {len(known_bosses)} known boss names from this site's own archives")

    current_names, enhanced_names = fetch_current_bosses()
    print(f"Fetched {len(current_names)} total current boss entries from Pokebattler's API")

    dates_by_name, web_occurrences, source_health = fetch_all_boss_dates()
    source_health["pokebattlerApi"] = len(current_names)   # bosses the API reports running right now
    now = datetime.now()

    def date_only(date_str):
        """'Jul 26, 2026 10:00 AM' -> 'Jul 26, 2026' - drops the time so blocks that only
        differ by hour merge into one."""
        if not date_str:
            return None
        m = re.match(r"^([A-Za-z]+ \d+, \d+)", date_str)
        return m.group(1) if m else date_str

    # Every (boss, window) that could possibly be published, gathered before any publish
    # decision so Gate 1's LeekDuck authority is available to all of them. Covers all three
    # source paths: the live API roster, the website scrape, and the confirmed-rotation table.
    candidates = []
    for key in set(list(dates_by_name.keys()) + list(CONFIRMED_ROTATION_DATES.keys())
                   + [k for k, _s, _e in web_occurrences]):
        if key not in known_bosses:
            continue
        nm = known_bosses[key].get("name") or key.title()
        sd, ed = CONFIRMED_ROTATION_DATES.get(key) or dates_by_name.get(key, (None, None))
        if sd:
            candidates.append((key, nm, date_only(sd), sd, ed))
    for k, sd, ed in web_occurrences:
        if k in known_bosses and sd:
            nm = known_bosses[k].get("name") or k.title()
            candidates.append((k, nm, date_only(sd), sd, ed))
    leekduck_verdicts = build_leekduck_verdicts(candidates)

    results = []
    seen = set()

    def build_result(name, key, override_dates=None):
        """Assembles one result dict for a known boss, applying the expiry rule. Returns the
        dict to append, or None if the boss should be filtered out. Shared by the live-API
        pass and the this-month-rotation retention pass below so both use identical logic.

        override_dates supplies an explicit (start, end) for the website pass, where the
        same boss can appear on several days and the name-keyed dates_by_name lookup would
        return whichever window happened to come first."""
        info = known_bosses[key]
        # Prefer the static, hand-verified CONFIRMED_ROTATION_DATES table over whatever
        # the live website scrape found - it's cross-checked against two independent
        # sources and, once entered, doesn't drift if Pokebattler's page changes wording.
        # Only fall back to the live scrape for bosses not yet in that table (e.g. a new
        # month's rotation before it's been manually confirmed and added).
        start_date, end_date = override_dates or CONFIRMED_ROTATION_DATES.get(key) or dates_by_name.get(key, (None, None))

        # ---- GATE 2: date/window validity and category ----
        passed, category, reason = gate_2_date_valid(
            name, start_date, end_date, now, date_only, parse_pokebattler_datetime)
        if not passed:
            print(f"  GATE 2 REJECT {name}: {reason}")
            return None

        # ---- GATE 1: must be verified NOT an enhanced (Super Mega) raid ----
        # Checked here, at the single point where a boss becomes publishable, so it applies
        # identically to every source path - the API pass, the website-scrape pass, and the
        # this-month retention pass. Previously the tier check only ran inside the API fetch,
        # leaving the website path (which has no tier data) unguarded.
        leekduck_verdict = leekduck_verdicts.get((key, date_only(start_date)))
        passed, reason = gate_1_not_enhanced(name, key, enhanced_names, leekduck_verdict)
        if not passed:
            print(f"  GATE 1 REJECT {name}: {reason}")
            return None

        return {
            # The ARCHIVE's spelling, not the source's. The landing page builds each boss's link
            # from this name (collections/<slug>.html), and those pages are generated from the
            # archive CSVs - so a source spelling like Pokebattler's "Shadow Landorus" linked to
            # a page that does not exist while the archive's "Shadow Landorus Incarnate" has one.
            "name": info.get("name") or name,
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

    # Pass 3: bosses Pokebattler's WEBSITE lists that its API leaves out.
    #
    # fetch_boss_dates_from_website() already parses every boss name out of each dated
    # block on pokebattler.com/raids - it just discarded the names and kept only the
    # dates, because the API was treated as the sole authority on WHICH bosses exist.
    # That is fine for ordinary rotations, but the API omits the per-day Mega line-up for
    # multi-day event weeks: Mega Ascension's Aug 31 - Sep 4 blocks (Mega Dragonite, Mega
    # Malamar, Mega Victreebel, Mega Falinks, Mega Skarmory, Mega Starmie, Mega Raichu
    # X/Y) are all plainly listed on the website with their own date headers, and none of
    # them ever reached this script.
    #
    # These are Pokebattler's own numbers from Pokebattler's own page - the same source,
    # read more completely. Everything downstream still applies: known_bosses filters to
    # documented solos, build_result applies the expiry and category rules, and the
    # LeekDuck cross-check still gets to drop any of them that turn out to be Super Mega.
    # Deduped by (boss, day), NOT by boss. `seen` above is name-keyed, which is right for
    # the rotation passes but wrong here: a boss can run on several separate event days.
    # Mega Victreebel is on Aug 31 and again on Sep 5; Mega Starmie on Sep 3 and Sep 5;
    # Mega Raichu X on Sep 4 and Sep 5. Keying by name alone kept only the first and
    # silently dropped the Sep 5/Sep 6 appearances.
    seen_windows = {(normalize_name(r["name"]), date_only(r.get("startDate"))) for r in results}
    seen_names = {normalize_name(r["name"]) for r in results}
    for key, start_date, end_date in web_occurrences:
        if key not in known_bosses:
            continue
        # A block for an already-running rotation has no "From" date - DATE_BLOCK_RE's
        # first group is optional - so the occurrence carries start=None. That cannot be
        # matched against a dated entry, and treating (name, None) as a distinct window
        # added a SECOND copy of a boss already present: Mega Garchomp appeared twice in
        # the monthly rotation, once with its real Aug 12-18 window and once undated.
        # With no start date there is no window to distinguish, so fall back to matching
        # on the name alone.
        if not start_date:
            if key in seen_names:
                print(f"  website: ignoring a second, undated listing for "
                      f"{known_bosses[key].get('name') or key} - already included with dates")
                continue
        elif (key, date_only(start_date)) in seen_windows:
            continue
        info = known_bosses[key]
        r = build_result(info.get("name") or key.title(), key,
                         override_dates=(start_date, end_date))
        if r is None:
            continue
        seen_windows.add((key, date_only(start_date)))
        seen_names.add(key)
        results.append(r)
        print(f"  website: added {r['name']} ({date_only(start_date)} -> {date_only(end_date)}) - "
              f"listed on pokebattler.com/raids but absent from its API")

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
    # apply_leekduck_crosscheck() is no longer called here. Its job moved into Gate 1, which
    # runs at the single publish decision point and therefore covers every source path and
    # every category - the old filter only inspected category == "event", which is exactly how
    # a misclassified Super Mega boss slipped past it.

    # Restore start dates per BOSS, before grouping. Pokebattler drops the "From" date once a
    # window is running, and grouping is by (start, end, category) - so two different windows
    # that end on the same day collapse into one group as soon as both are underway. That is
    # the normal case for Shadow Tier 5: its month-long window (Shadow Landorus, Oct 7 - Nov 3)
    # ends on the same Tuesday as the last weekly rotation (Giratina Origin, Oct 28 - Nov 3), and
    # from Oct 28 every one of them was published as "Oct 28 - Nov 3". Each boss is matched to
    # the window it was last stored with (same boss, same end date, same category), so it gets
    # back its own start rather than whichever start its group happened to inherit.
    # Upcoming bosses the API gives a start date for, that no schedule lists yet: published with
    # their start date and no end ("From Nov 5" on the landing page) rather than left off until
    # LeekDuck announces the window. The API never has end dates, so this is the only way to show
    # them early. Once ScrapedDuck lists the boss, its window replaces this (dates_by_name check),
    # and an open-ended group is never carried forward (see _carry_forward_month).
    month_now = now - LAST_TZ_OFFSET
    for key, (ms, api_name) in sorted(API_START_DATES.items(), key=lambda kv: kv[1][0]):
        if key not in known_bosses or key in seen_names or key in dates_by_name:
            continue
        start_date = _api_date(ms)
        start_dt = parse_pokebattler_datetime(start_date)
        if not start_dt or (start_dt.year, start_dt.month) < (month_now.year, month_now.month):
            continue
        info = known_bosses[key]
        name = info.get("name") or api_name
        passed, reason = gate_1_not_enhanced(name, key, enhanced_names, None)
        if not passed:
            print(f"  GATE 1 REJECT {name}: {reason}")
            continue
        results.append({"name": name, "startDate": start_date, "endDate": None, "category": "rotation",
                        "archivePage": info["archivePage"], "difficulty": info["difficulty"],
                        "weather": info["weather"]})
        seen_names.add(key)
        print(f"  API: added {name} from {date_only(start_date)} - no end date announced yet")

    # Event windows that would otherwise read as monthly rotation (multi-day): in-person ones
    # (localTime: false in Pokebattler's schedule) and the listed global ones (EVENT_WINDOWS).
    for r in results:
        w = (normalize_name(r["name"]), date_only(r.get("startDate")))
        if w in API_IN_PERSON:
            r["category"], r["label"] = "event", "In-person"
        elif w in EVENT_WINDOWS:
            r["category"] = "event"
            if EVENT_WINDOWS[w]:
                r["label"] = EVENT_WINDOWS[w]

    out_path = REPO_ROOT / "live-bosses.json"
    try:
        _previous = json.loads(out_path.read_text(encoding="utf-8")).get("dateGroups", [])
    except (OSError, ValueError):
        _previous = []
    stored_start = {}
    for g in _previous:
        if g.get("startDate"):
            for b in g.get("bosses", []):
                stored_start[(normalize_name(b.get("name", "")), g.get("endDate"), g.get("category"))] = g["startDate"]
    for r in results:
        if not r.get("startDate"):
            s = stored_start.get((normalize_name(r["name"]), date_only(r.get("endDate")), r["category"]))
            if s:
                r["startDate"] = s

    grouped = {}
    order = []
    labels = {}
    for r in results:
        if r.get("label"):
            labels[(date_only(r["startDate"]), date_only(r["endDate"]), r["category"])] = r["label"]
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
        if start and not end:
            date_groups[-1]["openEnded"] = True   # start known (from the API), end not yet
        if key in labels:
            date_groups[-1]["label"] = labels[key]   # e.g. "In-person", shown on the landing page

    # Carry forward this month's rotations that the SOURCE has already forgotten.
    #
    # Pokebattler lists only current and upcoming rotations. The moment a rotation's window
    # closes it disappears from the feed, so a boss that was on the landing page yesterday
    # vanishes today - which is how Zamazenta Hero (window ended Sep 22) disappeared while
    # Mega Gyarados and Mega Beedrill survived: those two happen to be hardcoded in
    # CONFIRMED_ROTATION_DATES, and Zamazenta was not.
    #
    # Hardcoding every rotation by hand is what made this recur. Instead the previous
    # live-bosses.json is read back and any rotation group from the CURRENT month that the
    # source no longer reports is preserved. The file becomes the memory, so a rotation that
    # has been seen once stays for the rest of its month without anyone maintaining a table.
    # One run time, shared by the carry-forward and the status stamp. Taking it as an argument
    # rather than reading the clock inside keeps the two consistent and makes the behaviour
    # testable against any date.
    _now = datetime.now(timezone.utc)
    date_groups = _carry_forward_month(date_groups, out_path, _now)

    # Status is refreshed on EVERY run for every group, carried or freshly pulled, so a boss
    # moves future -> active -> passed in place instead of disappearing from the file.
    for g in date_groups:
        g["status"] = _status_for(g.get("startDate"), g.get("endDate"), _now)

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        # How many bosses each schedule source supplied on this run: the first place to look when
        # upcoming rotations go missing. (The landing page reads only dateGroups.)
        "sources": source_health,
        "dateGroups": date_groups,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {len(results)} soloable boss(es) across {len(date_groups)} date group(s) to {out_path}")
    for g in date_groups:
        names = ", ".join(b["name"] for b in g["bosses"])
        print(f"  [{g['category']}] [{g['startDate'] or 'no date match'} -> {g['endDate']}]: {names}")

    # No schedule windows at all (ScrapedDuck empty - the API alone has start dates only): the
    # file is still written (it keeps today's running bosses and this month's history), but the
    # run ends as FAILED so GitHub flags it, instead of passing quietly with every upcoming
    # rotation missing. The workflow commits the file regardless.
    if not source_health["scrapedDuck"] and not source_health["pokebattlerSchedule"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
