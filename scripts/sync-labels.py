#!/usr/bin/env python3
"""Create or update the labels in labels.yml on BanksiaFoundation repositories.

Usage: scripts/sync-labels.py [REPO ...]. With no repository, it syncs every
repository of the organization. It deletes no label. It needs the GitHub CLI,
logged in with write access to the repositories.
"""
import json
import pathlib
import re
import subprocess
import sys

ORG = "BanksiaFoundation"
LABELS = pathlib.Path(__file__).resolve().parent.parent / "labels.yml"
ENTRY = re.compile(r"^- \{name: (?P<name>.+?), color: \"?(?P<color>[0-9a-fA-F]{6})\"?, description: (?P<desc>.+)\}$")


def labels():
    found = []
    for line in LABELS.read_text().splitlines():
        if not line.startswith("- "):
            continue
        match = ENTRY.match(line)
        if not match:
            sys.exit(f"cannot read this line of {LABELS.name}: {line}")
        found.append({key: value.strip().strip('"') for key, value in match.groupdict().items()})
    return found


def repos(args):
    if args:
        return args
    out = subprocess.run(
        ["gh", "repo", "list", ORG, "--limit", "1000", "--json", "name", "--no-archived"],
        check=True, capture_output=True, text=True,
    ).stdout
    return [f"{ORG}/{repo['name']}" for repo in json.loads(out)]


def main():
    failed = 0
    for repo in repos(sys.argv[1:]):
        for label in labels():
            result = subprocess.run(
                ["gh", "label", "create", label["name"], "--repo", repo, "--force",
                 "--color", label["color"], "--description", label["desc"]],
                capture_output=True, text=True,
            )
            if result.returncode != 0:
                failed += 1
                print(f"{repo}: {label['name']}: {result.stderr.strip()}", file=sys.stderr)
        print(f"{repo}: synced")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
