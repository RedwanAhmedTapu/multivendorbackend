#!/usr/bin/env bash
#
# purge-daraz-session.sh
#
# WHY: `daraz-session/` is a Puppeteer/Chrome user-data profile that got
# committed into this repo's git history (239 files, ~54MB). It contains a
# live `Network/Cookies` SQLite DB and a saved-password `Login Data` SQLite
# DB. Deleting the folder in a new commit is NOT enough — anyone who clones
# this repo can still check out an old commit and read those files. This
# script rewrites history to remove them completely.
#
# ⚠️ THIS REWRITES GIT HISTORY. Every commit hash changes. Anyone with an
# existing clone (including your own other machines) must re-clone or hard
# reset — `git pull` will NOT work cleanly for them afterwards. Do this
# BEFORE anyone else pulls, ideally right now.
#
# ── Step 0: rotate the credential first, not last ──────────────────────
# Scrubbing history does not un-leak anything that's already been cloned,
# forked, or cached by GitHub/search engines. Before (or immediately after)
# running this:
#   1. Log out of / change the password for whatever account was used for
#      the Daraz scraping session (the one behind daraz-session/).
#   2. Assume that session's cookies are permanently compromised.
#
# ── Step 1: back up first ───────────────────────────────────────────────
#   cp -r /path/to/multivendorbackend /path/to/multivendorbackend-backup
#
# ── Step 2: install git-filter-repo (one-time) ─────────────────────────
#   pip install git-filter-repo
#   # or: brew install git-filter-repo   (macOS)
#   # or: apt install git-filter-repo    (Debian/Ubuntu, if packaged)
#
# ── Step 3: run this script from the repo root ─────────────────────────
#   chmod +x scripts/purge-daraz-session.sh
#   ./scripts/purge-daraz-session.sh
#
# ── Step 4: force-push the rewritten history ───────────────────────────
#   git push origin --force --all
#   git push origin --force --tags
#
# ── Step 5: tell any collaborators ─────────────────────────────────────
#   Anyone else with a clone must run:
#     git fetch origin
#     git reset --hard origin/main
#   (a plain `git pull` will create a tangled mess of duplicate history)
#
# ── Step 6 (optional but recommended): ask GitHub to purge cached views ──
#   GitHub caches old commits/blobs for a while even after a force-push.
#   If this repo is/was public, consider it fully compromised regardless —
#   rotating the credential (Step 0) is the real fix, not just the git
#   history cleanup.

set -euo pipefail

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "git-filter-repo not found. Install it first: pip install git-filter-repo"
  exit 1
fi

if [ ! -d ".git" ]; then
  echo "Run this from the repository root (where .git/ lives)."
  exit 1
fi

echo "This will permanently rewrite git history to remove daraz-session/."
read -p "Type 'yes' to continue: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted."
  exit 1
fi

git filter-repo --path daraz-session --invert-paths --force

echo ""
echo "Done rewriting local history. Next steps:"
echo "  git push origin --force --all"
echo "  git push origin --force --tags"
echo ""
echo "Then have every collaborator run:"
echo "  git fetch origin && git reset --hard origin/main"
