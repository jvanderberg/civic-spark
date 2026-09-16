#!/bin/sh
set -eu
umask 077
# Run as the operator only after the same Machine has entered backup maintenance.
test "${CIVIC_SPARK_MAINTENANCE-}" = backup || {
  echo 'Backup input staging requires maintenance mode' >&2; exit 1;
}
# Verify the actual mount before making a directory or accepting credential uploads.
# No on-disk fallback, link resolution or parent-filesystem match is acceptable.
fail_tmpfs() {
  echo 'Backup input staging requires a real /dev/shm tmpfs mount' >&2; exit 1;
}
test -d /dev/shm && test ! -L /dev/shm || fail_tmpfs
civic_spark_backup_canonical=$(readlink -f /dev/shm) || fail_tmpfs
test "$civic_spark_backup_canonical" = /dev/shm || fail_tmpfs
civic_spark_backup_fstype=$(findmnt --noheadings --output FSTYPE --mountpoint /dev/shm) || fail_tmpfs
test "$civic_spark_backup_fstype" = tmpfs || fail_tmpfs
# Refuse existing staging, including a previous interrupted attempt.
mkdir -m 0700 /dev/shm/civic-spark-backup-input
chown node:node /dev/shm/civic-spark-backup-input
install -d -m 0700 -o node -g node \
  /dev/shm/civic-spark-backup-input/operator /data/civic-spark-backups
echo 'Backup input staging ready on tmpfs'
