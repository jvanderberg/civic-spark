#!/usr/bin/env bash
# Trusted, repeatable first checkout. Never replace an existing participant project.
set -euo pipefail
bundle=/tmp/civic-spark-seed.bundle
project=/home/sprite/project
seed=$(git bundle list-heads "$bundle" HEAD | cut -d ' ' -f 1)
test -n "$seed"
if [ -e "$project" ] || [ -L "$project" ]; then
  test -d "$project/.git"
  git -C "$project" merge-base --is-ancestor "$seed" HEAD
  printf 'Existing project verified; files preserved\n'
  exit 0
fi
staging=$(mktemp -d /home/sprite/.civic-spark-checkout-XXXXXX)
trap 'rm -rf "$staging"' EXIT
git clone "$bundle" "$staging/project"
git -C "$staging/project" remote remove origin
git -C "$staging/project" update-ref refs/civic-spark/base HEAD
git -C "$staging/project" config user.name 'Civic Spark participant'
git -C "$staging/project" config user.email 'participant@civic-spark.local'
test ! -e "$project"
test ! -L "$project"
mv "$staging/project" "$project"
printf 'Git workspace ready\n'
git -C "$project" log -1 --format=%H
