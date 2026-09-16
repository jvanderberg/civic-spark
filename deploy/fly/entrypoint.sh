#!/bin/sh
set -eu
umask 077
# Fly mounts a fresh volume as root. Only initialize this application's directory;
# never recursively change ownership of imported participant data.
test "${CIVIC_SPARK_DATA_DIR}" = /data/civic-spark
mountpoint -q /data || { echo 'Persistent /data volume is required' >&2; exit 1; }
install -d -m 0700 -o node -g node /data/civic-spark
# Sprite initializes local CLI state even with environment authentication.
# Precreate only its directory; never rewrite existing children or participant data.
install -d -m 0700 -o node -g node /home/node/.sprites
exec setpriv --reuid=node --regid=node --init-groups node --import tsx apps/server/src/index.ts
