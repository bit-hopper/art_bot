#!/usr/bin/env bash
# Checks the `state` branch out into ./state as a git worktree (spec 8.2), creating an empty orphan branch on the very
# first run. Pushes from the worktree reuse the credentials actions/checkout configured.
set -euo pipefail
branch="${STATE_BRANCH:-state}"
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch -q origin "$branch"
  git worktree add -q -B "$branch" state "origin/$branch"
else
  git worktree add -q --orphan -b "$branch" state
  mkdir -p state/index
  printf '{"indexBuiltAt":{}}\n' > state/meta.json
  git -C state add -A
  git -C state -c user.name=art-bot -c user.email=art-bot@users.noreply.github.com commit -q -m "Initialise the state branch"
  git -C state push -q origin "HEAD:$branch"
fi
