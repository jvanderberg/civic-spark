#!/usr/bin/env bash
# Trusted, repeatable first checkout. Never replace an existing participant project.
set -euo pipefail
bundle=/tmp/civic-spark-seed.bundle
project=/home/sprite/project
seed=$(git bundle list-heads "$bundle" HEAD | cut -d ' ' -f 1)
test -n "$seed"
if [ -e "$project" ] || [ -L "$project" ]; then
  test ! -L "$project"
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
# Publish atomically without replacing, nesting into, or following a new destination.
# Linux Sprite runtime; Darwin equivalent keeps local trusted-adapter tests portable.
python3 - "$staging/project" "$project" <<'PYTHON'
import ctypes
import os
import sys
libc = ctypes.CDLL(None, use_errno=True)
source, destination = (os.fsencode(arg) for arg in sys.argv[1:])
if sys.platform == 'linux':
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    result = rename(-100, source, -100, destination, 1)  # RENAME_NOREPLACE
elif sys.platform == 'darwin':
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    result = rename(source, destination, 4)  # RENAME_EXCL
else:
    raise SystemExit('Atomic checkout publication is unavailable')
if result != 0:
    raise SystemExit('Checkout destination changed or atomic publication failed; existing files preserved')
PYTHON
printf 'Git workspace ready\n'
git -C "$project" log -1 --format=%H
