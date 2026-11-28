#!/usr/bin/env python3
"""Every VOD'd run in the raid archives, with the player who ran it - for the Raider Leaderboard.

Writes:
  csv/vod-authors.csv   Link, Player, Name   - who posted each VOD. A YouTube link is looked up once
                        (YouTube's public oEmbed: the channel's @handle and name, no API key);
                        an X / fixupx link names its poster in the URL. Rows already here are kept,
                        so each link is only ever looked up once, and a name fixed by hand stays.
  csv/vod-runs.csv      Star, Run, Player, Link, Archive - one row per VOD:
                        Run = "Boss | Weather | Adventure effect | Moveset" (NAE = no adventure effect).

The leaderboard page (leaderboard.html) reads vod-runs.csv, vod-authors.csv and
csv/player-aliases.csv (one player's other accounts) and does the scoring itself.

    python generate_vod_runs.py            # look up new links, rewrite both CSVs
    python generate_vod_runs.py --offline  # no lookups (new YouTube links are left without a player)
"""
import csv, json, re, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ARCHIVES = [("csv/tier4-data.csv", "Mega"), ("csv/tier5-merged.csv", "Legendary"), ("csv/tier6-data.csv", "Mega Legendary & Elite")]
AUTHORS, RUNS = ROOT / "csv/vod-authors.csv", ROOT / "csv/vod-runs.csv"
AE = {"55e643e737": "Blade Boost", "396c21d1": "Shield Boost", "12ZtA4r_57": "Dynamic Punch+"}   # the archives store the effect's icon


def ae_of(v):
    for k, n in AE.items():
        if k in v:
            return n
    return v.strip() or "NAE"


def star_of(v):
    m = re.search(r"\d+(\.\d+)?", v or "")
    return m.group(0) if m else ""


def youtube_id(u):
    m = re.search(r"(?:youtu\.be/|[?&]v=|/shorts/|/live/|/embed/)([A-Za-z0-9_-]{11})", u)
    return m.group(1) if m else None


def x_handle(u):
    m = re.match(r"https?://(?:www\.)?(?:x|twitter|fixupx|fxtwitter|vxtwitter)\.com/([^/?#]+)/status", u, re.I)
    return "@" + m.group(1) if m and m.group(1).lower() != "i" else None   # x.com/i/status/... names nobody


def lookup_youtube(vid):
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote("https://www.youtube.com/watch?v=" + vid, safe="")
    req = urllib.request.Request(url, headers={"User-Agent": "soloraidarchive-leaderboard"})
    with urllib.request.urlopen(req, timeout=15) as r:
        j = json.load(r)
    m = re.search(r"/(@[^/?#]+)", j.get("author_url", ""))
    handle = urllib.parse.unquote(m.group(1)) if m else j.get("author_url", "")
    return handle, j.get("author_name", "") or handle.lstrip("@")


def main():
    offline = "--offline" in sys.argv
    known = {}
    if AUTHORS.exists():
        for r in csv.DictReader(open(AUTHORS, encoding="utf-8")):
            known[r["Link"]] = (r["Player"], r["Name"])
    by_video = {youtube_id(l): v for l, v in known.items() if youtube_id(l)}

    runs, looked, failed = [], 0, 0
    for f, arch in ARCHIVES:
        rows = list(csv.reader(open(ROOT / f, encoding="utf-8-sig")))
        h = rows[0]
        i = {k: h.index(k) for k in ["Boss Name", "Star", "Weather", "FM", "CM", "Link"]}   # FM / CM: the first pair is the boss's
        iae = next(j for j, k in enumerate(h) if "dventure" in k)
        for r in rows[1:]:
            if len(r) <= i["Link"] or not r[i["Link"]].strip():
                continue
            link = r[i["Link"]].strip()
            if link not in known:
                vid, xh = youtube_id(link), x_handle(link)
                if xh:
                    known[link] = (xh, xh.lstrip("@"))
                elif vid and vid in by_video:
                    known[link] = by_video[vid]
                elif vid and not offline:
                    try:
                        known[link] = by_video[vid] = lookup_youtube(vid); looked += 1
                        time.sleep(0.2)
                    except Exception as e:   # tried again on the next run
                        failed += 1; print(f"  lookup failed for {link}: {e}")
            mv = " / ".join(x for x in [r[i["FM"]].strip(), r[i["CM"]].strip()] if x) or "Any"
            run = " | ".join([r[i["Boss Name"]].strip(), r[i["Weather"]].strip() or "Extreme", ae_of(r[iae]), mv])
            runs.append({"Star": star_of(r[i["Star"]]), "Run": run, "Player": known.get(link, ("", ""))[0], "Link": link, "Archive": arch})

    with open(AUTHORS, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh); w.writerow(["Link", "Player", "Name"])
        for l, (p, n) in sorted(known.items(), key=lambda x: (x[1][0].lower(), x[0])):
            w.writerow([l, p, n])
    with open(RUNS, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["Star", "Run", "Player", "Link", "Archive"]); w.writeheader(); w.writerows(runs)
    print(f"{len(runs)} VOD runs, {sum(1 for r in runs if r['Player'])} with a player; {looked} new YouTube lookups, {failed} failed.")


if __name__ == "__main__":
    main()
