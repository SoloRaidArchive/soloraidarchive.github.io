#!/usr/bin/env python3
"""
Double-check EVENT mega raids against LeekDuck. Dry run - never writes.

SCOPE (deliberately narrow)
---------------------------
Pokebattler stays the source of truth for what is running and when; it is right ~99% of
the time. LeekDuck is consulted for exactly one question: for a mega raid attached to an
EVENT, is that a Tier 4 Mega Raid or a Super Mega Raid? Nothing else here overrides
Pokebattler.

Three rules, in order:

  1. NULL DATES -> DROP. A mega entry with no start/end is excluded outright, no LeekDuck
     lookup. update_live_bosses.py skips every expiry check when end_dt is None, which is
     why Mega Raichu X/Y have sat on the site since July. Rotation data is only trustworthy
     when the window is defined, so undated entries are simply not included.

  2. ROTATIONS -> UNTOUCHED. Including ones whose window has already closed inside the
     current month. Those are still wanted under "Monthly raid rotations" and this script
     has no opinion on them.

  3. EVENTS -> ASK LEEKDUCK. If LeekDuck lists the boss as a Tier 4 Mega Raid in an
     overlapping window, keep it. If the overlapping LeekDuck event is a Super Mega Raid
     Day and the boss is not listed as Tier 4 anywhere in it, drop it. If LeekDuck has
     nothing to say, keep it - silence defers to Pokebattler rather than deleting.

WHY TIER IS PER-EVENT, NOT PER-POKEMON
--------------------------------------
Mega Starmie is Super Mega on Aug 22 and Tier 4 on Sep 3 (Mega Ascension). Mega Raichu
X/Y are Super Mega on Jul 18 and Tier 4 on Sep 4. A permanent per-boss denylist would be
right in August and wrong in September, so classification is always (boss, window).

SANDBOX LIMITATION
------------------
leekduck.com returns 403 through this sandbox's egress proxy, so --live cannot run here.
--offline replays hand-transcribed fixtures; those rows are marked FIXTURE.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

from leekduck_tiers import (
    Section, classify_sections, extract_sections,
    load_base_form_map, load_legendary_species,
    mega_legendary_bosses, publishable_bosses, super_mega_bosses, tier4_bosses,
)

SCRAPEDDUCK_EVENTS = "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/events.json"
TIER4_ARCHIVE_PAGE = "tier4-raids.html"
CANDIDATE_EVENT_TYPES = {"raid-battles", "raid-day", "pokemon-go-fest", "event"}

# A dedicated monthly rotation page. These must never be merged with their neighbours -
# Garchomp (Aug 12-18) and Swampert (Aug 19-25) are contiguous but separate rotations.
ROTATION_SLUG_RE = re.compile(r"-in-mega-raids-", re.IGNORECASE)
SUPER_MEGA_DAY_RE = re.compile(r"super[-\s]mega[-\s]raid[-\s]day", re.IGNORECASE)


def http_json(url):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "solo-raid-archive-crosscheck"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def http_text(url):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "solo-raid-archive-crosscheck"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_iso(s):
    try:
        return datetime.fromisoformat(s) if s else None
    except ValueError:
        return None


def parse_site_date(s):
    try:
        return datetime.strptime(s.strip(), "%b %d, %Y") if s else None
    except ValueError:
        return None


def fmt(dt):
    return f"{dt:%b} {dt.day}, {dt.year}" if dt else "None"


def overlaps(a_start, a_end, b_start, b_end) -> bool:
    if a_start and b_end and a_start.date() > b_end.date():
        return False
    if b_start and a_end and b_start.date() > a_end.date():
        return False
    return True


def discover_events():
    return [e for e in http_json(SCRAPEDDUCK_EVENTS)
            if e.get("eventType") in CANDIDATE_EVENT_TYPES]


def build_leekduck_index(events, sections_for, legendary, base_form_map, verbose=True):
    """One record per event: window, Tier 4 bosses, and whether it's a Super Mega day."""
    index = []
    for e in events:
        eid = e.get("eventID")
        sections = sections_for(e)
        if sections is None:
            continue
        classified = classify_sections(sections, legendary, base_form_map)
        t4 = tier4_bosses(classified)
        megaleg = mega_legendary_bosses(classified)
        supers = super_mega_bosses(classified)
        is_smd = bool(SUPER_MEGA_DAY_RE.search(eid or "")
                      or SUPER_MEGA_DAY_RE.search(e.get("name") or ""))
        if verbose:
            tag = "  [SUPER MEGA RAID DAY]" if is_smd else ""
            print(f"  {eid}: tier4={len(t4)} megaLegendary={len(megaleg)} superMega={len(supers)}{tag}")
            if megaleg:
                print(f"      Mega Legendary (T6): {', '.join(sorted(megaleg))}")
            if supers:
                print(f"      Super Mega: {', '.join(sorted(supers))}")
        index.append({
            "eventID": eid,
            "start": parse_iso(e.get("start")),
            "end": parse_iso(e.get("end")),
            "tier4": t4,
            "megaLegendary": megaleg,
            "publishable": publishable_bosses(classified),
            "superMega": supers,
            "isSuperMegaDay": is_smd,
            "isRotation": bool(ROTATION_SLUG_RE.search(eid or "")),
        })
    return index


def merge_event_windows(index):
    """Merge contiguous NON-rotation Tier 4 event windows into one span.

    Mega Ascension (Aug 31 - Sep 4) runs straight into Mega Finale (Sep 5 - 6), and
    LeekDuck says so explicitly: the replacement raid schedule runs Aug 31 through Sep 6.
    Monthly rotations are excluded from merging - Garchomp and Swampert are back to back
    but are separate windows and must not be fused.
    """
    spans = sorted(
        [c for c in index if c["publishable"] and not c["isRotation"]
         and c["start"] and c["end"]],
        key=lambda c: c["start"],
    )
    merged = []
    for c in spans:
        if merged and c["start"] - merged[-1]["end"] <= timedelta(days=1):
            merged[-1]["end"] = max(merged[-1]["end"], c["end"])
            merged[-1]["tier4"] |= set(c["tier4"])
            merged[-1]["megaLegendary"] |= set(c["megaLegendary"])
            merged[-1]["events"].append(c["eventID"])
        else:
            merged.append({"start": c["start"], "end": c["end"],
                           "tier4": set(c["tier4"]),
                           "megaLegendary": set(c["megaLegendary"]),
                           "events": [c["eventID"]]})
    return merged


def crosscheck(live, index):
    keep, dropped, untouched = [], [], []
    for group in live.get("dateGroups", []):
        g_start = parse_site_date(group.get("startDate"))
        g_end = parse_site_date(group.get("endDate"))
        for boss in group.get("bosses", []):
            if boss.get("archivePage") != TIER4_ARCHIVE_PAGE:
                continue
            row = {"name": boss["name"], "startDate": group.get("startDate"),
                   "endDate": group.get("endDate"), "category": group.get("category")}

            # Rule 1 - undated entries are never included.
            if not g_start and not g_end:
                row["reason"] = "null start/end date - only dated rotations are trusted"
                dropped.append(row)
                continue

            # Rule 2 - rotations belong to Pokebattler, including closed windows this month.
            if group.get("category") != "event":
                row["reason"] = "rotation - Pokebattler authoritative"
                untouched.append(row)
                continue

            # Rule 3 - events get the LeekDuck tier question.
            overlapping = [c for c in index if overlaps(g_start, g_end, c["start"], c["end"])]
            confirms = [c for c in overlapping if boss["name"] in c["publishable"]]
            if confirms:
                row["confirmedBy"] = confirms[0]["eventID"]
                row["tier"] = ("Mega Legendary (T6)"
                               if boss["name"] in confirms[0]["megaLegendary"]
                               else "Mega (T4)")
                keep.append(row)
                continue
            smd = [c for c in overlapping if c["isSuperMegaDay"]]
            if smd:
                row["reason"] = f"Super Mega Raid Day ({smd[0]['eventID']}) - not Tier 4"
                dropped.append(row)
                continue
            row["reason"] = "event - no LeekDuck tier info, deferring to Pokebattler"
            untouched.append(row)
    return keep, dropped, untouched


# ---------------------------------------------------------------------------
# Fixtures transcribed from live pages on 2026-08-14.
# ---------------------------------------------------------------------------
FIXTURES = {
    "mega-garchomp-in-mega-raids-august-2026": [Section(["Raids"], ["Mega Garchomp"])],
    "mega-swampert-in-mega-raids-august-2026": [Section(["Raids"], ["Mega Swampert"])],
    "mega-gyarados-in-mega-raids-august-2026": [Section(["Raids"], ["Mega Gyarados"])],
    "starmie-super-mega-raid-day-2026": [
        Section(["Ultra Unlock: Starmie Super Mega Raid Day", "Raids"], ["Mega Starmie"])],
    "super-mega-raid-day-september-2026": [Section(["Super Mega Raid Day", "Raids"], [])],
    "super-mega-raid-day-october-2026": [Section(["Super Mega Raid Day", "Raids"], [])],
    "super-mega-raid-day-november-2026": [Section(["Super Mega Raid Day", "Raids"], [])],
    "mega-ascension": [
        Section(["Raids", "Monday, August 31"],
                ["Mega Victreebel", "Mega Dragonite", "Mega Malamar"]),
        Section(["Raids", "Tuesday, September 1"], ["Mega Falinks"]),
        Section(["Raids", "Wednesday, September 2"], ["Mega Skarmory"]),
        Section(["Raids", "Thursday, September 3"], ["Mega Starmie"]),
        Section(["Raids", "Friday, September 4"], ["Mega Raichu X", "Mega Raichu Y"]),
        Section(["Raids", "Throughout Mega Ascension"], ["Mega Latias", "Mega Latios"]),
    ],
    "pokemon-go-fest-2026-mega-finale": [
        Section(["Raids", "Saturday", "Super Mega Raids"], ["Mega Mewtwo X"]),
        Section(["Raids", "Sunday", "Super Mega Raids"], ["Mega Mewtwo Y"]),
        Section(["Saturday Habitat Mega Raids", "Verdant Overgrowth"],
                ["Mega Beedrill", "Mega Victreebel", "Mega Pinsir", "Mega Abomasnow"]),
        Section(["Saturday Habitat Mega Raids", "Mindworks Canal"],
                ["Mega Alakazam", "Mega Slowbro", "Mega Starmie", "Mega Medicham"]),
        Section(["Saturday Habitat Mega Raids", "Eerie Alley"],
                ["Mega Gengar", "Mega Houndoom", "Mega Banette", "Mega Malamar"]),
        Section(["Saturday Habitat Mega Raids", "Circuit Plaza"],
                ["Mega Raichu X", "Mega Ampharos", "Mega Manectric"]),
        Section(["Sunday Habitat Mega Raids", "Iron Frostworks"],
                ["Mega Steelix", "Mega Skarmory", "Mega Aggron", "Mega Glalie"]),
        Section(["Sunday Habitat Mega Raids", "Battle District"],
                ["Mega Sharpedo", "Mega Camerupt", "Mega Lopunny", "Mega Falinks"]),
        Section(["Sunday Habitat Mega Raids", "Skyline Roosts"],
                ["Mega Gyarados", "Mega Aerodactyl", "Mega Dragonite", "Mega Altaria"]),
        Section(["Sunday Habitat Mega Raids", "Prism Promenade"],
                ["Mega Raichu Y", "Mega Sableye", "Mega Mawile", "Mega Audino"]),
    ],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live-bosses", default="live-bosses.json", type=Path)
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--repo", default=Path("."), type=Path,
                    help="repo root, for tier5-bosses.csv and ct-calculator.html")
    args = ap.parse_args()

    live = json.loads(args.live_bosses.read_text(encoding="utf-8"))

    print("Discovering events via ScrapedDuck...")
    events = discover_events()
    print(f"  {len(events)} candidate events\n")

    print("Classifying LeekDuck event pages...")
    if args.offline:
        print("  (FIXTURE replay - leekduck.com unreachable from sandbox)")
        def sections_for(e):
            return FIXTURES.get(e.get("eventID"))
    else:
        def sections_for(e):
            try:
                return extract_sections(http_text(e["link"]))
            except Exception as exc:
                print(f"  !! FETCH FAILED {e.get('eventID')}: "
                      f"{type(exc).__name__}: {exc}", file=sys.stderr)
                return None
    legendary = load_legendary_species(args.repo / "csv/tier5-bosses.csv")
    base_form_map = load_base_form_map(args.repo / "ct-calculator.html")
    print(f"  {len(legendary)} legendary species, {len(base_form_map)} BASE_FORM_MAP entries")
    index = build_leekduck_index(events, sections_for, legendary, base_form_map)

    keep, dropped, untouched = crosscheck(live, index)

    print(f"\n{'='*72}\nDRY RUN - no files written\n{'='*72}")

    print("\nLEEKDUCK TIER 4 EVENT WINDOWS (merged)")
    for m in merge_event_windows(index):
        print(f"  {fmt(m['start'])} -> {fmt(m['end'])}   ({', '.join(m['events'])})")
        print(f"    Tier 4 ({len(m['tier4'])}): {', '.join(sorted(m['tier4']))}")
        if m['megaLegendary']:
            print(f"    Mega Legendary T6 ({len(m['megaLegendary'])}): "
                  f"{', '.join(sorted(m['megaLegendary']))}")

    print(f"\nDROP ({len(dropped)})")
    for r in sorted(dropped, key=lambda r: r["name"]):
        print(f"  - {r['name']:20} {r['startDate']} -> {r['endDate']}")
        print(f"      {r['reason']}")

    print(f"\nKEEP - event mega raids confirmed Tier 4 ({len(keep)})")
    for r in sorted(keep, key=lambda r: r["name"]):
        print(f"  + {r['name']:20} {r['startDate']} -> {r['endDate']}  "
              f"{r['tier']:20} [{r['confirmedBy']}]")

    print(f"\nNOT CROSS-CHECKED ({len(untouched)})")
    for r in sorted(untouched, key=lambda r: (r["startDate"] or "", r["name"])):
        print(f"  . {r['name']:20} {r['startDate']} -> {r['endDate']}  ({r['reason']})")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
