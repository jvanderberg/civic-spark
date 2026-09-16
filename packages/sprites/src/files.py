"""Small file API executed inside a participant Sprite. Input arrives over stdin."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import sys

ROOT = pathlib.Path("/home/sprite/project")
LIMIT = 25 * 1024 * 1024
EXCLUDED = {'node_modules', 'dist', 'build', 'coverage', '__pycache__', 'vendor', 'credentials', 'secrets'}


def allowed(name):
    parts = name.split('/')
    return bool(name) and len(name) <= 500 and not re.search(r'[\\\x00-\x1f<>:"|?*]', name) and all(
        p and (not p.startswith('.') or (p == '.gitignore' and i == len(parts) - 1))
        and not p.endswith(('.', ' ')) and p.lower() not in EXCLUDED
        and not re.search(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', p, re.I)
        and not re.search(r'\.(pem|key|p12|pfx|log)$', p, re.I) for i, p in enumerate(parts))


def fail(message, status=400):
    print(json.dumps({"ok": False, "error": message, "status": status}))
    sys.exit(0)


def safe_path(name):
    path = pathlib.PurePosixPath(name)
    if not allowed(name):
        fail("File unavailable", 404)
    current = ROOT
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            fail("File unavailable", 404)
    if not current.is_file() or not current.resolve().is_relative_to(ROOT.resolve()) or current.stat().st_size > LIMIT:
        fail("File unavailable", 404)
    return current


try:
    request = json.loads(sys.stdin.read(LIMIT * 6 + 65536))
    if request["operation"] == "list":
        files = []
        for directory, dirs, names in os.walk(ROOT, followlinks=False):
            dirs[:] = [d for d in dirs if allowed(str(pathlib.Path(directory, d).relative_to(ROOT))) and not pathlib.Path(directory, d).is_symlink()]
            for name in names:
                target = pathlib.Path(directory, name)
                if allowed(str(target.relative_to(ROOT))) and not target.is_symlink() and target.is_file() and target.stat().st_size <= LIMIT:
                    files.append(str(target.relative_to(ROOT)))
                    if len(files) >= 5000:
                        fail("Too many files to browse", 413)
        value = sorted(files)
    else:
        with open("/home/sprite/.civic-spark-file-lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            path = safe_path(request["path"])
            content = path.read_bytes()
            if b"\0" in content:
                fail("This file is binary", 415)
            revision = hashlib.sha256(content).hexdigest()
            if request["operation"] == "save":
                if revision != request["revision"]:
                    fail("This file changed. Reload before saving; your edits are still in the editor.", 409)
                content = request["content"].encode("utf-8")
                if len(content) > LIMIT:
                    fail("File exceeds the 25 MiB editor limit", 413)
                path.write_bytes(content)
                revision = hashlib.sha256(content).hexdigest()
            elif request["operation"] != "read":
                fail("Unknown file operation")
            value = {"path": request["path"], "content": content.decode("utf-8"), "revision": revision}
    print(json.dumps({"ok": True, "value": value}))
except (OSError, UnicodeError, KeyError, ValueError):
    fail("File operation could not complete", 400)
