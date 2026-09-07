#!/usr/bin/env python3
"""
Write collections/<slug>.html for every boss in the raid archives.

WHAT CHANGED, AND WHY IT MATTERS

Collection pages used to be byte-identical copies of the template - the page worked out which boss
it was from its own filename at runtime. That was a genuinely good property: a template fix reached
every boss with a plain copy, and "all 109 files have one md5" was a one-command correctness check.

It cost the site its search visibility, though. A crawler that does not execute JavaScript sees
only the initial HTML, and that was 109 documents sharing the title "Boss Collection - Solo Raid
Archive" with no description and no canonical. The runtime title is correct but arrives too late
for anything that does not render.

So the HEAD is now templated and the BODY is not:

  head   %%BOSS_NAME%%, %%BOSS_SLUG%%, %%TIER_LABEL%% are substituted here, at write time.
  body   still reads the boss from location.pathname, so strategy data is never baked in and a
         CSV edit appears without regenerating anything.

Only those three tokens are substituted, and that is deliberate. They change when a boss is renamed
or moves tier - rare. Strategy counts change constantly, so putting one in the head would mean
rewriting all 109 pages on every CSV edit and a commit storm for no reader benefit.

The old invariant is gone; this is the replacement:

  every page differs from every other ONLY inside <head>

which check_collections() asserts below. The worker performs the identical substitution when it
creates a page for a newly submitted boss, so hand-generated and worker-generated pages agree.
"""
import argparse
import csv
import json
import pathlib
import re
import sys

ARCHIVES = [
    ("csv/tier4-data.csv", "Tier 4 Mega"),
    ("csv/tier5-merged.csv", "Tier 5 Legendary"),
    ("csv/tier6-data.csv", "Tier 6 & Elite"),
]
TEMPLATE = "data/collection-template.html"
OUT_DIR = "collections"


def slugify(name: str) -> str:
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", name.strip().lower()))


def read_bosses(repo: pathlib.Path):
    """boss slug -> (display name, tier label).

    First archive wins on a tie: Regidrago is in both tier 5 and tier 6, and its collection is
    reached from the Tier 5 index, so that is the label its head should carry.
    """
    bosses = {}

    # Guides first, so a boss that has a guide but no archive rows still gets a page. The Worker
    # used to create that page itself; it no longer does (see below), and without this a guide's
    # "All strategies for this boss" link would 404 until someone added a CSV row.
    guide_index = repo / "data/guides/index.json"
    if guide_index.exists():
        try:
            for g in json.loads(guide_index.read_text(encoding="utf-8")).get("bosses", []):
                name = (g.get("name") or "").strip()
                if name:
                    bosses.setdefault(slugify(name), (name, "Raid"))
        except (ValueError, OSError) as e:
            print(f"  could not read {guide_index}: {e}", file=sys.stderr)

    for rel, tier in ARCHIVES:
        path = repo / rel
        if not path.exists():
            print(f"  skipping missing {rel}", file=sys.stderr)
            continue
        with open(path, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                name = (row.get("Boss Name") or "").strip()
                if not name:
                    continue
                slug = slugify(name)
                # An archive row beats the guide placeholder: it carries the real tier label. But
                # the FIRST archive still wins over later ones - Regidrago is in both tier 5 and
                # tier 6, and its collection is reached from the Tier 5 index.
                if slug not in bosses or bosses[slug][1] == "Raid":
                    bosses[slug] = (name, tier)
    return bosses


def render(template: str, name: str, slug: str, tier: str) -> str:
    # Escaped for an HTML attribute: a boss name is site-controlled, but the substitution should
    # not be the one place a stray quote could break every meta tag on the page.
    safe = name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    return (template
            .replace("%%BOSS_NAME%%", safe)
            .replace("%%BOSS_SLUG%%", slug)
            .replace("%%TIER_LABEL%%", tier))



BASE_URL = "https://soloraidarchive.github.io/"


def sync_sitemap(repo: pathlib.Path, bosses) -> bool:
    """Keep collections/ entries in sitemap.xml in step with the archives.

    Done here rather than as a separate step because the two go together: a collection page that
    is not in the sitemap is a page search engines have to stumble across, and a sitemap entry for
    a page that no longer exists is a soft 404. Returns True if the file changed.
    """
    path = repo / "sitemap.xml"
    if not path.exists():
        print("  no sitemap.xml, skipping")
        return False
    xml = path.read_text(encoding="utf-8")

    wanted = {f"{BASE_URL}collections/{slug}.html" for slug in bosses}
    present = set(re.findall(r"<loc>([^<]+)</loc>", xml))
    present_collections = {u for u in present if "/collections/" in u}

    for url in sorted(present_collections - wanted):        # boss removed from the archives
        xml = re.sub(r"\s*<url>\s*<loc>" + re.escape(url) + r"</loc>.*?</url>", "", xml, flags=re.S)

    additions = [f"  <url>\n    <loc>{u}</loc>\n    <changefreq>weekly</changefreq>\n"
                 f"    <priority>0.7</priority>\n  </url>"
                 for u in sorted(wanted - present_collections)]
    if additions:
        xml = xml.replace("</urlset>", "\n".join(additions) + "\n</urlset>")

    added, removed = len(wanted - present_collections), len(present_collections - wanted)
    if added or removed:
        path.write_text(xml, encoding="utf-8")
        print(f"  sitemap: +{added} / -{removed} collection URL(s)")
        return True
    print("  sitemap: already in step")
    return False


def check_collections(repo: pathlib.Path) -> int:
    """Assert the new invariant: pages differ only in <head>."""
    bodies = {}
    for f in sorted((repo / OUT_DIR).glob("*.html")):
        html = f.read_text(encoding="utf-8")
        i = html.find("</head>")
        if i == -1:
            print(f"  {f.name}: no </head>", file=sys.stderr)
            return 1
        bodies.setdefault(html[i:], []).append(f.name)
    if len(bodies) == 1:
        print(f"  OK: {sum(len(v) for v in bodies.values())} pages share one identical body")
        return 0
    print(f"  MISMATCH: {len(bodies)} distinct bodies", file=sys.stderr)
    for body, names in bodies.items():
        print(f"    {len(names)} page(s): {names[:4]}", file=sys.stderr)
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", type=pathlib.Path, default=pathlib.Path("."))
    ap.add_argument("--check", action="store_true", help="verify only, write nothing")
    args = ap.parse_args()
    repo = args.repo

    if args.check:
        return check_collections(repo)

    template = (repo / TEMPLATE).read_text(encoding="utf-8")
    for token in ("%%BOSS_NAME%%", "%%BOSS_SLUG%%", "%%TIER_LABEL%%"):
        if token not in template:
            print(f"  ABORT: {TEMPLATE} has no {token} - wrong template?", file=sys.stderr)
            return 2

    bosses = read_bosses(repo)
    out = repo / OUT_DIR
    out.mkdir(exist_ok=True)

    written = 0
    for slug, (name, tier) in sorted(bosses.items()):
        html = render(template, name, slug, tier)
        path = out / f"{slug}.html"
        if path.exists() and path.read_text(encoding="utf-8") == html:
            continue          # unchanged; leave it alone so git stays quiet
        path.write_text(html, encoding="utf-8")
        written += 1

    sync_sitemap(repo, bosses)

    stale = {p.name for p in out.glob("*.html")} - {f"{s}.html" for s in bosses}
    print(f"  {len(bosses)} boss(es); {written} page(s) written, {len(bosses) - written} already current")
    if stale:
        print(f"  {len(stale)} page(s) no longer backed by any archive row: {sorted(stale)[:6]}")
    return check_collections(repo)


if __name__ == "__main__":
    sys.exit(main())
