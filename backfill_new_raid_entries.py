#!/usr/bin/env python3
"""
One-time backfill for new-raid-entries.json.

The live workflow (.github/workflows/track-new-raid-entries.yml) only ever sees ONE push's
before/after diff at a time - it has no way to reach back into history that happened before
it was installed. This script fills that gap by walking the repo's actual git history
locally (where the full commit log already exists) and replaying the exact same detection
logic - genuinely new (boss, strategy) combos, never edits - across past commits.

Run this ONCE, locally, from the repo root (needs full git history, so a shallow clone won't
work - if `git log` only shows a handful of commits, run `git fetch --unshallow` first):

    python backfill_new_raid_entries.py

It overwrites new-raid-entries.json with the MAX_EVENTS most recent real historical events.
After running it, commit and push new-raid-entries.json once, same as any other file change -
from that point on, the live workflow takes over and keeps it updated on every future push.

Note on the very first commit that ever added one of the tracked CSVs: that commit has no
"before" state to diff against (the file didn't exist yet), so - exactly like the live
script's own handling of a brand-new branch's first push - it's treated as the starting
baseline, not as a flood of "new" entries. Only real, later additions count.
"""
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO_ROOT))

from track_new_raid_entries import (  # noqa: E402
    ARCHIVES, MAX_EVENTS, OUTPUT_FILE, extract_entries, parse_rows,
)


def run(cmd):
    return subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)


def git_show(sha, path):
    """Returns the file's content at the given commit, or None if it didn't exist there."""
    result = run(["git", "show", f"{sha}:{path}"])
    return result.stdout if result.returncode == 0 else None


def commits_touching_any(paths):
    """All commits (newest first, matching git log's default order) that touched any of the
    given paths, reachable from HEAD."""
    result = run(["git", "log", "--format=%H", "--"] + paths)
    if result.returncode != 0:
        print("git log failed - is this actually a git repo with history? " + result.stderr, file=sys.stderr)
        sys.exit(1)
    return [line for line in result.stdout.splitlines() if line.strip()]


def commit_date(sha):
    result = run(["git", "show", "-s", "--format=%cI", sha])
    return result.stdout.strip() if result.returncode == 0 else ""


def main():
    paths = [cfg["file"] for cfg in ARCHIVES]
    commits = commits_touching_any(paths)
    if not commits:
        print("No commits found touching any tracked CSV - nothing to backfill.")
        return

    events = []
    for sha in commits:
        parent_result = run(["git", "rev-parse", f"{sha}^"])
        parent_sha = parent_result.stdout.strip() if parent_result.returncode == 0 else None

        new_entries = []
        for cfg in ARCHIVES:
            path = cfg["file"]
            current_text = git_show(sha, path) or ""
            old_text = git_show(parent_sha, path) if parent_sha else None

            if old_text is None:
                # File didn't exist at the parent commit (or this is the repo's very first
                # commit) - this is the baseline for this file, not a batch of "new" entries.
                continue

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

        if new_entries:
            events.append({
                "commit": sha,
                "date": commit_date(sha),
                "entries": new_entries,
            })
            print(f"Found {len(new_entries)} new entr{'y' if len(new_entries)==1 else 'ies'} in commit {sha[:7]}.")

        if len(events) >= MAX_EVENTS:
            break

    if not events:
        print("Walked all available history - no genuinely new entries found anywhere. Nothing to write.")
        return

    import json
    OUTPUT_FILE.write_text(json.dumps(events, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {len(events)} event(s) to {OUTPUT_FILE.name}. Review it, then commit and push once.")


if __name__ == "__main__":
    main()
