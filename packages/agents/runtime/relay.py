"""Bounded request spool transport. Host starts this over authenticated sprite exec."""
import json
import os
import pathlib
import re
import sys
import threading
import time

root = pathlib.Path('/home/sprite/.vibehack-agent/integration')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(root, 0o700)
seen = set()


def replies():
    for line in sys.stdin:
        try:
            item = json.loads(line)
            ident = item['id']
            if not re.fullmatch(r'[a-f0-9-]{36}', ident) or len(line) > 65536:
                continue
            target = root / (ident + '.response')
            if target.is_symlink():
                continue
            temp = root / (ident + '.tmp')
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'w') as output:
                output.write(line)
            temp.replace(target)
        except (ValueError, OSError, KeyError):
            pass
    os._exit(0)


threading.Thread(target=replies, daemon=True).start()
while True:
    for path in list(root.glob('*.request'))[:32]:
        try:
            ident = path.stem
            if not re.fullmatch(r'[a-f0-9-]{36}', ident) or path.is_symlink():
                continue
            if time.time() - path.stat().st_mtime > 600:
                path.unlink(missing_ok=True)
                (root / (ident + '.response')).unlink(missing_ok=True)
                seen.discard(ident)
                continue
            if ident in seen or path.stat().st_size > 65536:
                continue
            data = json.loads(path.read_text())
            data['id'] = ident
            print(json.dumps(data), flush=True)
            seen.add(ident)
        except (ValueError, OSError):
            pass
    if len(seen) > 1000:
        seen = {p.stem for p in root.glob('*.request')}
    time.sleep(0.25)
