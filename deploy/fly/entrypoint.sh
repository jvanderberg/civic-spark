#!/bin/sh
set -eu
umask 077
# Fail closed on misspelled maintenance settings; never fall through into app startup.
case "${CIVIC_SPARK_MAINTENANCE-off}" in
  off|backup) ;;
  *) echo 'Invalid CIVIC_SPARK_MAINTENANCE mode' >&2; exit 1 ;;
esac
# Fly mounts a fresh volume as root. Only initialize this application's directory;
# never recursively change ownership of imported participant data.
test "${CIVIC_SPARK_DATA_DIR}" = /data/civic-spark
mountpoint -q /data || { echo 'Persistent /data volume is required' >&2; exit 1; }
if [ "${CIVIC_SPARK_MAINTENANCE-off}" = backup ]; then
  # Keep this same Machine/volume available for authenticated operator exec/SFTP.
  # No application imports, DB handles, HTTP listener or automatic exit to normal mode.
  test -d /data/civic-spark && test ! -L /data/civic-spark || {
    echo 'Backup maintenance requires the existing data directory' >&2; exit 1;
  }
  echo 'Civic Spark backup maintenance: application writer is not started'
  exec setpriv --reuid=node --regid=node --init-groups /usr/bin/sleep infinity
fi
install -d -m 0700 -o node -g node /data/civic-spark
# Backups, staged restores and replaced data roots are siblings of the data directory,
# so the application user owns the volume root itself. Non-recursive: imported data keeps
# its ownership.
chown node:node /data
# Sprite initializes local CLI state even with environment authentication.
# Precreate only its directory; never rewrite existing children or participant data.
install -d -m 0700 -o node -g node /home/node/.sprites
exec setpriv --reuid=node --regid=node --init-groups node --import tsx apps/server/src/index.ts
