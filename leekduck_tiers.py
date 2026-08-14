#!/usr/bin/env python3
"""
Classify LeekDuck event raid bosses as Tier 4 (Mega) vs Super Mega.

WHY SECTION-SCOPED, NOT PAGE-SCOPED
-----------------------------------
The obvious implementation - "does this event page mention Super Mega?" - is wrong,
and pokemon-go-fest-2026-mega-finale is the counterexample that proves it. That page
contains BOTH:

    "Super Mega Raids"            -> Mega Mewtwo X, Mega Mewtwo Y     (exclude)
    "Saturday Habitat Mega Raids" -> Mega Raichu X, Mega Ampharos ... (Tier 4, publish)
    "Sunday Habitat Mega Raids"   -> Mega Raichu Y, Mega Sableye  ... (Tier 4, publish)

A page-level keyword test excludes the whole page and loses 15 legitimate Tier 4
bosses in order to catch 2 Super Mega ones. So the keyword must be evaluated against
the heading a boss actually sits under, not the document.

WHY TIER IS NOT A PROPERTY OF THE POKEMON
-----------------------------------------
Mega Raichu X/Y debuted in a Super Mega Raid Day (Jul 18, 2026) and Mega Starmie in
another (Aug 22, 2026) - but all three appear as ordinary Mega Raids during Mega
Finale (Sep 5-6, 2026). A permanent per-boss denylist would therefore be correct in
August and wrong in September. Classification is (boss, event window) -> tier, never
boss -> tier.

LAYERING
--------
  classify_sections()  pure, no I/O. Operates on already-extracted
                       (heading_path, [boss names]) pairs. Fully tested against text
                       captured from the real pages - see test_leekduck_tiers.py.

  extract_sections()   HTML -> those pairs. This is the layer that depends on
                       LeekDuck's live markup, and it is the layer that CANNOT be
                       verified in this sandbox (leekduck.com returns 403 through the
                       egress proxy). Treat its selectors as provisional until run
                       against a real fetch in CI. It is deliberately kept thin so a
                       markup change breaks it loudly rather than silently
                       misclassifying.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Matched against the heading path above a boss list. "Super Mega" is the discriminator;
# note that plain "Mega Raids" is a SUBSTRING-SAFE distinct case only because we test for
# the super variant first.
SUPER_MEGA_RE = re.compile(r"super\s+mega", re.IGNORECASE)

# Headings that mark a list as raid content at all. Anything else (Shiny galleries,
# Spawns, GO Pass reward tracks) is ignored: those list Pokemon that are NOT raid bosses,
# and pulling names from them is how you end up publishing Chespin as a Tier 4 boss.
RAID_HEADING_RE = re.compile(r"\braids?\b", re.IGNORECASE)

# Shiny sections repeat the same bosses under the same headings. Including them yields
# duplicates, not new information, so they are dropped wholesale.
SHINY_SECTION_RE = re.compile(r"^\s*shiny\s*$", re.IGNORECASE)

TIER_MEGA = "mega"
TIER_SUPER_MEGA = "super_mega"
# Mega evolution of a legendary species - Mega Latias, Mega Latios, Mega Rayquaza.
# The site calls these "Mega Legendary" and files them under tier6-elite-raids.html
# (csv/tier6-data.csv, Category "T6"), distinct from Elite raids in the same file.
TIER_MEGA_LEGENDARY = "mega_legendary"

TIER6_ARCHIVE_PAGE = "tier6-elite-raids.html"
TIER4_ARCHIVE_PAGE = "tier4-raids.html"

ARCHIVE_PAGE_BY_TIER = {
    TIER_MEGA: TIER4_ARCHIVE_PAGE,
    TIER_MEGA_LEGENDARY: TIER6_ARCHIVE_PAGE,
    TIER_SUPER_MEGA: None,  # not published
}


def load_legendary_species(path) -> set[str]:
    """Legendary species names, lowercased, from the repo's own csv/tier5-bosses.csv.

    Read rather than hand-listed: a second copy of this list is precisely the duplicated
    data that drifts apart and causes the worst bugs here.
    """
    import csv
    with open(path, encoding="utf-8") as f:
        return {r["Pokemon"].strip().lower()
                for r in csv.DictReader(f) if r.get("Pokemon", "").strip()}


def load_base_form_map(ct_calculator_html) -> dict[str, str]:
    """Extract BASE_FORM_MAP from ct-calculator.html's own source.

    Same approach the submission worker uses - the calculator stays the single definition.
    Name-stripping is deliberately NOT used: it is what broke on 'Mega Complete Zygarde'
    (real base 'zygarde 50%') and on 'Mega Raichu X/Y'.
    """
    import re as _re
    from pathlib import Path
    src = Path(ct_calculator_html).read_text(encoding="utf-8")
    m = _re.search(r"BASE_FORM_MAP\s*=\s*\{(.*?)\};", src, _re.S)
    if not m:
        raise RuntimeError(f"BASE_FORM_MAP not found in {ct_calculator_html}")
    pairs = _re.findall(r"['\"]([^'\"]+)['\"]\s*:\s*['\"]([^'\"]+)['\"]", m.group(1))
    if not pairs:
        raise RuntimeError("BASE_FORM_MAP matched but parsed empty")
    return {k.strip().lower(): v.strip().lower() for k, v in pairs}


@dataclass
class Section:
    """One boss list plus the chain of headings above it, outermost first."""
    heading_path: list[str]
    bosses: list[str] = field(default_factory=list)

    @property
    def context(self) -> str:
        return " > ".join(self.heading_path)


@dataclass
class BossClassification:
    name: str
    tier: str
    context: str

    @property
    def is_tier4(self) -> bool:
        return self.tier == TIER_MEGA

    @property
    def is_mega_legendary(self) -> bool:
        return self.tier == TIER_MEGA_LEGENDARY

    @property
    def is_publishable(self) -> bool:
        """Tier 4 and Mega Legendary both get published, to different archive pages.
        Super Mega does not."""
        return self.tier != TIER_SUPER_MEGA

    @property
    def archive_page(self) -> str | None:
        return ARCHIVE_PAGE_BY_TIER.get(self.tier)


def classify_sections(
    sections: list[Section],
    legendary_species: set[str] | None = None,
    base_form_map: dict[str, str] | None = None,
) -> list[BossClassification]:
    """Assign a tier to every boss from the headings above it, plus species lookup.

    PRECEDENCE, and the order matters:

      1. SUPER MEGA wins outright, from the heading. This is what LeekDuck actually ran,
         and it overrides what a boss is "supposed" to be on paper. Mega Mewtwo X/Y are
         Mega Legendary by species, but have only ever been released as Super Mega Raids,
         and LeekDuck files them under a "Super Mega Raids" heading - so Super Mega they
         are, until a page says otherwise.
      2. MEGA LEGENDARY, if the base species is legendary. Mega Latias, Mega Latios,
         Mega Rayquaza.
      3. MEGA (Tier 4) otherwise.

    Rule 1 sitting above rule 2 is the whole point: tier comes from what was published,
    not from a taxonomy we assert. If Mega Mewtwo ever runs as a genuine Mega Legendary
    raid, the heading changes and the classification follows, with no code edit.

    Without legendary_species/base_form_map this degrades to the two-tier behaviour and
    never emits MEGA_LEGENDARY - callers that care must pass both.
    """
    legendary_species = legendary_species or set()
    base_form_map = base_form_map or {}

    def is_legendary_mega(name: str) -> bool:
        key = name.strip().lower()
        base = base_form_map.get(key)
        # No mapping means it is not a known mega/primal form at all, so it cannot be a
        # Mega Legendary. Deliberately NOT falling back to stripping "Mega ".
        return bool(base) and base in legendary_species

    out: list[BossClassification] = []
    for section in sections:
        path = section.heading_path
        if any(SHINY_SECTION_RE.match(h) for h in path):
            continue
        if not any(RAID_HEADING_RE.search(h) for h in path):
            continue
        section_is_super = any(SUPER_MEGA_RE.search(h) for h in path)
        for boss in section.bosses:
            if section_is_super:
                tier = TIER_SUPER_MEGA
            elif is_legendary_mega(boss):
                tier = TIER_MEGA_LEGENDARY
            else:
                tier = TIER_MEGA
            out.append(BossClassification(name=boss, tier=tier, context=section.context))
    return out


def tier4_bosses(classifications: list[BossClassification]) -> set[str]:
    return {c.name for c in classifications if c.is_tier4}


def mega_legendary_bosses(classifications: list[BossClassification]) -> set[str]:
    return {c.name for c in classifications if c.is_mega_legendary}


def publishable_bosses(classifications: list[BossClassification]) -> set[str]:
    return {c.name for c in classifications if c.is_publishable}


def super_mega_bosses(classifications: list[BossClassification]) -> set[str]:
    return {c.name for c in classifications if c.tier == TIER_SUPER_MEGA}


def conflicts(classifications: list[BossClassification]) -> dict[str, list[BossClassification]]:
    """Bosses classified BOTH ways within one event.

    Not an error - Mega Finale legitimately runs Mega Mewtwo in Super Mega Raids while
    running other Megas in ordinary Mega Raids - but if a single NAME lands in both
    buckets on one page, the section scoping has probably gone wrong and it should be
    surfaced rather than resolved silently.
    """
    by_name: dict[str, list[BossClassification]] = {}
    for c in classifications:
        by_name.setdefault(c.name, []).append(c)
    return {n: cs for n, cs in by_name.items() if len({c.tier for c in cs}) > 1}


# A boss list item on LeekDuck carries a Pokemon icon from their CDN, e.g.
#   https://cdn.leekduck.com/assets/img/pokemon_icons/pm445.fMEGA.icon.png
# Requiring that icon is what separates a real boss entry from a nav or footer link.
POKEMON_ICON_RE = re.compile(r"/pokemon_icons?[/_]", re.IGNORECASE)

# Chrome that repeats on every page and must never contribute bosses.
CHROME_TAGS = {"nav", "header", "footer", "aside"}


def extract_sections(html: str) -> list[Section]:
    """Parse a LeekDuck event page into heading-scoped boss lists.

    STILL UNVERIFIED AGAINST LIVE MARKUP - leekduck.com is unreachable from the dev
    sandbox. Treat the first --live run as the real test.

    An earlier version took every <li> on the page. On realistic markup that returned
    'Eggs' and 'Events' as Tier 4 bosses: footer list items inherited whatever heading
    appeared earlier in the document. Two defences, both structural rather than a guess
    at one container class that could be renamed:

      1. Skip anything inside nav/header/footer/aside.
      2. Require a Pokemon icon image in the <li>. Every real boss entry has one; nav and
         footer links do not. This is the load-bearing check - it holds even if the page
         is restructured, and it fails CLOSED (a boss without a recognisable icon is
         dropped, not silently published under whatever heading came before it).

    Because it fails closed, a markup change shows up as an empty boss list - which the
    caller reports and treats as "no LeekDuck opinion" - rather than as confident
    misclassification.
    """
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:
        raise RuntimeError("extract_sections requires beautifulsoup4") from exc

    soup = BeautifulSoup(html, "html.parser")
    sections: list[Section] = []
    path: dict[int, str] = {}
    current: Section | None = None

    def in_chrome(el) -> bool:
        return any(p.name in CHROME_TAGS for p in el.parents)

    def has_pokemon_icon(el) -> bool:
        return any(POKEMON_ICON_RE.search(img.get("src") or "") for img in el.find_all("img"))

    for el in soup.find_all(["h1", "h2", "h3", "h4", "li"]):
        if in_chrome(el):
            continue

        if el.name != "li":
            level = int(el.name[1])
            path = {lvl: t for lvl, t in path.items() if lvl < level}
            path[level] = el.get_text(" ", strip=True)
            current = None
            continue

        if not has_pokemon_icon(el):
            continue
        # Drop the alt/label text of nested images so only the visible name remains.
        name = " ".join(el.get_text(" ", strip=True).split())
        if not name:
            continue
        if current is None:
            current = Section(heading_path=[path[k] for k in sorted(path)])
            sections.append(current)
        current.bosses.append(name)

    return sections
