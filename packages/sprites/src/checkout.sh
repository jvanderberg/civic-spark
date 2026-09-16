#!/usr/bin/env bash
# Trusted, repeatable first checkout. Never replace an existing participant project.
set -euo pipefail
bundle=/tmp/vibehack-seed.bundle
project=/home/sprite/project
seed=$(git bundle list-heads "$bundle" HEAD | cut -d ' ' -f 1)
test -n "$seed"
if [ -e "$project" ]; then
  test -d "$project/.git"
  git -C "$project" merge-base --is-ancestor "$seed" HEAD
  printf 'Existing project verified; files preserved\n'
  exit 0
fi
staging=$(mktemp -d /home/sprite/.vibehack-checkout-XXXXXX)
trap 'rm -rf "$staging"' EXIT
git clone "$bundle" "$staging/project"
git -C "$staging/project" remote remove origin
git -C "$staging/project" update-ref refs/vibehack/base HEAD
git -C "$staging/project" config user.name 'VibeHack participant'
git -C "$staging/project" config user.email 'participant@vibehack.local'
test ! -e "$project"
mv "$staging/project" "$project"
printf 'Git workspace ready\n'
git -C "$project" log -1 --format=%H
