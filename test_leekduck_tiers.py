#!/usr/bin/env python3
"""
Tests for classify_sections().

The fixtures below are TRANSCRIBED FROM THE LIVE PAGES, not invented: heading text and
boss lists were read off real fetches of leekduck.com on 2026-08-14. They exercise the
classification logic only. extract_sections() (HTML -> sections) is NOT covered here -
leekduck.com is unreachable from this sandbox, and a fixture written from a guess at the
markup would test my guess against itself rather than against LeekDuck.
"""
import sys

from leekduck_tiers import (
    Section,
    classify_sections,
    conflicts,
    super_mega_bosses,
    tier4_bosses,
)

# ---------------------------------------------------------------------------
# pokemon-go-fest-2026-mega-finale - the case that breaks page-level matching.
# Same page, both tiers. Raichu X/Y and Starmie appear here as ORDINARY Mega Raids
# despite having debuted in Super Mega Raid Days.
# ---------------------------------------------------------------------------
MEGA_FINALE = [
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
    # Non-raid sections that must NOT contribute bosses.
    Section(["Spawns", "Verdant Overgrowth - In the wild"],
            ["Weedle", "Bellsprout", "Chespin", "Froakie"]),
    Section(["Shiny", "Saturday", "Super Mega Raids"], ["Mega Mewtwo X"]),
]

# mega-swampert-in-mega-raids-august-2026 - the plain rotation shape.
PLAIN_ROTATION = [
    Section(["Raids"], ["Mega Swampert"]),
]

# starmie-super-mega-raid-day-2026 - title carries the marker; boss list is under it.
STARMIE_SUPER_MEGA_DAY = [
    Section(["Ultra Unlock: Starmie Super Mega Raid Day", "Raids"], ["Mega Starmie"]),
]

# raichu-super-mega-raid-day-2026
RAICHU_SUPER_MEGA_DAY = [
    Section(["Raichu Super Mega Raid Day", "Raids"], ["Mega Raichu X", "Mega Raichu Y"]),
]

failures = []


def check(label, got, want):
    if got != want:
        failures.append(f"{label}\n     got:  {sorted(got) if isinstance(got, set) else got}"
                        f"\n     want: {sorted(want) if isinstance(want, set) else want}")
        print(f"  FAIL  {label}")
    else:
        print(f"  ok    {label}")


print("Mega Finale (mixed-tier page)")
c = classify_sections(MEGA_FINALE)
check("Super Mega bucket is exactly the two Mewtwo forms",
      super_mega_bosses(c), {"Mega Mewtwo X", "Mega Mewtwo Y"})
check("Raichu X/Y classified Tier 4 here despite Super Mega debut",
      {"Mega Raichu X", "Mega Raichu Y"} <= tier4_bosses(c), True)
check("Starmie classified Tier 4 here despite Super Mega debut",
      "Mega Starmie" in tier4_bosses(c), True)
check("Mewtwo never leaks into Tier 4",
      {"Mega Mewtwo X", "Mega Mewtwo Y"} & tier4_bosses(c), set())
check("wild spawns excluded (Chespin is not a raid boss)",
      {"Chespin", "Weedle", "Froakie", "Bellsprout"} & tier4_bosses(c), set())
check("Tier 4 count is the 31 habitat Mega Raid bosses (4+4+4+3 Sat, 4+4+4+4 Sun)",
      len(tier4_bosses(c)), 31)
check("no name classified both ways", conflicts(c), {})

print("\nPlain monthly rotation")
c = classify_sections(PLAIN_ROTATION)
check("Mega Swampert is Tier 4", tier4_bosses(c), {"Mega Swampert"})
check("nothing marked Super Mega", super_mega_bosses(c), set())

print("\nSuper Mega Raid Days")
c = classify_sections(STARMIE_SUPER_MEGA_DAY)
check("Starmie excluded on its debut day", super_mega_bosses(c), {"Mega Starmie"})
check("Starmie NOT publishable on its debut day", tier4_bosses(c), set())

c = classify_sections(RAICHU_SUPER_MEGA_DAY)
check("Raichu X/Y excluded on their debut day",
      super_mega_bosses(c), {"Mega Raichu X", "Mega Raichu Y"})
check("Raichu NOT publishable on its debut day", tier4_bosses(c), set())

print("\nTime-boxing: same boss, opposite verdicts in different events")
aug = classify_sections(RAICHU_SUPER_MEGA_DAY)
sep = classify_sections(MEGA_FINALE)
check("Raichu X is Super Mega in its debut event",
      "Mega Raichu X" in super_mega_bosses(aug), True)
check("Raichu X is Tier 4 in Mega Finale",
      "Mega Raichu X" in tier4_bosses(sep), True)

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("All checks passed.")


# ===========================================================================
# Mega Legendary (Tier 6). Loaded from the repo's own data, not a second list.
# ===========================================================================
from pathlib import Path
from leekduck_tiers import (
    load_legendary_species, load_base_form_map,
    mega_legendary_bosses, publishable_bosses,
    TIER_MEGA_LEGENDARY, TIER_SUPER_MEGA, TIER_MEGA,
)

REPO = Path("../soloraidarchive.github.io")
LEG = load_legendary_species(REPO / "csv/tier5-bosses.csv")
BFM = load_base_form_map(REPO / "ct-calculator.html")

print("\nMega Legendary tier")
check("legendary list loaded from tier5-bosses.csv", len(LEG) > 70, True)
check("BASE_FORM_MAP loaded from ct-calculator.html", len(BFM) > 90, True)

asc = classify_sections([
    Section(["Raids", "Throughout Mega Ascension"], ["Mega Latias", "Mega Latios"]),
    Section(["Raids", "Friday, September 4"], ["Mega Raichu X", "Mega Raichu Y"]),
    Section(["Raids", "Monday, August 31"], ["Mega Victreebel", "Mega Dragonite"]),
], LEG, BFM)
check("Latias/Latios are Mega Legendary",
      mega_legendary_bosses(asc), {"Mega Latias", "Mega Latios"})
check("Latias/Latios are NOT Tier 4",
      {"Mega Latias", "Mega Latios"} & tier4_bosses(asc), set())
check("Raichu X/Y stay Tier 4 (Raichu is not legendary)",
      {"Mega Raichu X", "Mega Raichu Y"} <= tier4_bosses(asc), True)
check("Victreebel/Dragonite stay Tier 4",
      {"Mega Victreebel", "Mega Dragonite"} <= tier4_bosses(asc), True)
check("Mega Legendary routes to tier6-elite-raids.html",
      {c.archive_page for c in asc if c.is_mega_legendary}, {"tier6-elite-raids.html"})
check("Tier 4 routes to tier4-raids.html",
      {c.archive_page for c in asc if c.is_tier4}, {"tier4-raids.html"})

print("\nSuper Mega outranks Mega Legendary (the Mewtwo case)")
mew = classify_sections([
    Section(["Raids", "Saturday", "Super Mega Raids"], ["Mega Mewtwo X"]),
    Section(["Raids", "Sunday", "Super Mega Raids"], ["Mega Mewtwo Y"]),
], LEG, BFM)
check("Mewtwo is legendary by species", "mewtwo" in LEG, True)
check("Mega Mewtwo X/Y map to mewtwo",
      {BFM.get("mega mewtwo x"), BFM.get("mega mewtwo y")}, {"mewtwo"})
check("but they classify as Super Mega, not Mega Legendary",
      super_mega_bosses(mew), {"Mega Mewtwo X", "Mega Mewtwo Y"})
check("Mewtwo not emitted as Mega Legendary", mega_legendary_bosses(mew), set())
check("Super Mega is not publishable", publishable_bosses(mew), set())
check("Super Mega has no archive page",
      {c.archive_page for c in mew}, {None})

print("\nRayquaza sanity (already a T6 boss in csv/tier6-data.csv)")
ray = classify_sections([Section(["Raids"], ["Mega Rayquaza"])], LEG, BFM)
check("Mega Rayquaza is Mega Legendary", mega_legendary_bosses(ray), {"Mega Rayquaza"})

print("\nNo-stripping guarantee")
zyg = classify_sections([Section(["Raids"], ["Mega Complete Zygarde"])], LEG, BFM)
check("Mega Complete Zygarde maps via BASE_FORM_MAP, not stripping",
      BFM.get("mega complete zygarde"), "zygarde 50%")
check("unmapped names never guess a base",
      classify_sections([Section(["Raids"], ["Mega Notarealmon"])], LEG, BFM)[0].tier,
      TIER_MEGA)

print()
if failures:
    print(f"{len(failures)} FAILURE(S):")
    for f in failures:
        print("  - " + f)
    sys.exit(1)
print("All checks passed.")
