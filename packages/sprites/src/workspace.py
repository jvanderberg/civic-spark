"""Trusted sync/diff adapter; runs inside the Sprite, never executes project code."""
import base64
import difflib
import fcntl
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path('/home/sprite/project')
LIMIT = 25 * 1024 * 1024
TREE_LIMIT = 50 * 1024 * 1024
DIFF_LIMIT = 1024 * 1024
BUNDLE_LIMIT = 10 * 1024 * 1024
EXCLUDED = {'node_modules', 'dist', 'build', 'coverage', '__pycache__', 'vendor', 'credentials', 'secrets'}


def allowed(name):
    return bool(name) and len(name) <= 500 and not re.search(r'[\\\x00-\x1f<>:"|?*]', name) and all(
        p and not p.startswith('.') and not p.endswith(('.', ' ')) and p.lower() not in EXCLUDED
        and not re.search(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)', p, re.I)
        and not re.search(r'\.(pem|key|p12|pfx|log)$', p, re.I) for p in name.split('/'))


def target(name):
    if not allowed(name):
        raise ValueError('Path is excluded from workspace sync')
    path = ROOT
    for part in name.split('/'):
        path = path / part
        if path.is_symlink():
            raise ValueError('Symbolic links are excluded')
    if not path.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('Invalid path')
    return path


def read(name):
    path = target(name)
    if not path.is_file() or path.stat().st_size > LIMIT:
        raise ValueError('Sync supports files up to 25 MiB; larger files pause the scan')
    return path.read_bytes()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def manifest():
    files, skipped, cases, size = {}, [], set(), 0
    for directory, dirs, names in os.walk(ROOT, followlinks=False, onerror=lambda e: (_ for _ in ()).throw(e)):
        for name in list(dirs):
            path = pathlib.Path(directory, name)
            relative = str(path.relative_to(ROOT))
            if not allowed(relative) or path.is_symlink():
                skipped.append(relative)
                dirs.remove(name)
        for name in names:
            path = pathlib.Path(directory, name)
            relative = str(path.relative_to(ROOT))
            if not allowed(relative) or path.is_symlink():
                skipped.append(relative)
                continue
            data = read(relative)
            size += len(data)
            if size > TREE_LIMIT or len(files) >= 5000:
                raise ValueError('Sync limit: 50 MiB and 5,000 files')
            if relative.lower() in cases:
                raise ValueError('Filenames differ only by case; rename before syncing')
            cases.add(relative.lower())
            files[relative] = {'revision': sha(data), 'size': len(data)}
    return {'files': files, 'skipped': sorted(skipped)}


def git(*args):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=ROOT, stderr=subprocess.DEVNULL, timeout=15)


def snapshot():
    base = None
    for ref in ['refs/vibehack/base', 'origin/main', 'HEAD']:
        try:
            base = git('rev-parse', ref).decode().strip()
            break
        except subprocess.CalledProcessError:
            pass
    if base is None:
        raise ValueError('No Git baseline found')
    head = git('rev-parse', 'HEAD').decode().strip()
    before = {}
    for entry in git('ls-tree', '-rz', base).split(b'\0'):
        if b'\t' not in entry or not entry.startswith(b'100'):
            continue
        meta, raw_name = entry.split(b'\t', 1)
        name = raw_name.decode()
        if allowed(name):
            before[name] = meta.split()[2].decode()
    current, skipped = {}, []
    for directory, dirs, names in os.walk(ROOT, followlinks=False, onerror=lambda e: (_ for _ in ()).throw(e)):
        for name in list(dirs):
            path = pathlib.Path(directory, name)
            relative = str(path.relative_to(ROOT))
            if not allowed(relative) or path.is_symlink():
                skipped.append(relative)
                dirs.remove(name)
        for name in names:
            path = pathlib.Path(directory, name)
            relative = str(path.relative_to(ROOT))
            if not allowed(relative) or path.is_symlink() or not path.is_file():
                skipped.append(relative)
                continue
            # Hash streaming: one data file above the editor/sync limit must not break Changes.
            digest = hashlib.sha256()
            with path.open('rb') as stream:
                for chunk in iter(lambda: stream.read(DIFF_LIMIT), b''):
                    digest.update(chunk)
            current[relative] = {'revision': digest.hexdigest(), 'size': path.stat().st_size,
                                 'mode': '100755' if path.stat().st_mode & 0o111 else '100644'}
            if len(current) > 5000:
                raise ValueError('Changes supports up to 5,000 project files')
    revision = sha(json.dumps([base, head, current, sorted(skipped)], sort_keys=True).encode())
    return base, head, before, current, skipped, revision


def changes():
    base, head, before, current, skipped, revision = snapshot()
    files, total = [], 0
    for name in sorted(set(before) | set(current)):
        if any(name == p or name.startswith(p + '/') for p in skipped):
            continue
        oid = before.get(name)
        old_size = int(git('cat-file', '-s', oid)) if oid else 0
        item = current.get(name)
        # Git hashes identify unchanged large files without decoding them for the UI.
        new_oid = git('hash-object', '--no-filters', '--', name).decode().strip() if item else None
        if oid == new_oid:
            continue
        large = old_size > DIFF_LIMIT or (item and item['size'] > DIFF_LIMIT)
        old = git('cat-file', 'blob', oid) if oid and not large else b''
        new = target(name).read_bytes() if item and not large else b''
        binary = b'\0' in old or b'\0' in new
        diff = 'Large file changed; preview limited to files up to 1 MB. This file can still be shared.' if large else (
            'Binary file changed' if binary else ''.join(difflib.unified_diff(
                old.decode('utf-8', errors='replace').splitlines(True),
                new.decode('utf-8', errors='replace').splitlines(True), fromfile='a/' + name, tofile='b/' + name)))
        if total >= 2000000:
            diff = 'Diff preview limit reached. This file can still be shared.'
        elif len(diff) > 200000:
            diff = diff[:200000] + '\n[Preview truncated; the full file will be shared.]'
        total += len(diff)
        files.append({'path': name, 'status': 'added' if not oid else 'deleted' if not item else 'modified', 'diff': diff, 'binary': binary})
    return {'base': base, 'revision': revision, 'files': files}


def share(request):
    base, head, before, current, skipped, revision = snapshot()
    if request['revision'] != revision:
        raise ValueError('Files changed since the preview. Refresh Changes and review them before sharing.')
    if sum(item['size'] for item in current.values()) > TREE_LIMIT:
        raise ValueError('Sharing supports up to 50 MiB of project files.')
    git_dir = pathlib.Path(git('rev-parse', '--absolute-git-dir').decode().strip())
    index = git_dir / 'index'
    original = index.read_bytes() if index.exists() else b''
    branch = git('rev-parse', '--symbolic-full-name', 'HEAD').decode().strip()
    lock = git_dir / 'index.lock'
    owns_lock = False
    try:
        # Git's own lock blocks concurrent native commits/checkouts/staging.
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        owns_lock = True
        with os.fdopen(fd, 'wb') as lock_stream, tempfile.TemporaryDirectory(prefix='vibehack-commit-') as folder:
            if (index.read_bytes() if index.exists() else b'') != original:
                raise ValueError('Git staging changed. Review Changes before sharing.')
            env = dict(os.environ, GIT_AUTHOR_NAME='VibeHack participant', GIT_AUTHOR_EMAIL='participant@vibehack.local',
                       GIT_COMMITTER_NAME='VibeHack', GIT_COMMITTER_EMAIL='workspace@vibehack.local')
            def stage(index_name, *args, data=None):
                return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=ROOT,
                    env=dict(env, GIT_INDEX_FILE=folder + '/' + index_name), input=data,
                    stderr=subprocess.DEVNULL, timeout=30)
            stage('commit-index', 'read-tree', head)
            if original:
                pathlib.Path(folder, 'next-index').write_bytes(original)
            else:
                stage('next-index', 'read-tree', '--empty')
            objects = {}
            for name, item in current.items():
                data = target(name).read_bytes()
                if sha(data) != item['revision']:
                    raise ValueError('Files changed since the preview. Refresh Changes before sharing.')
                objects[name] = stage('commit-index', 'hash-object', '-w', '--stdin', data=data).decode().strip()
            for index_name in ['commit-index', 'next-index']:
                for entry in stage(index_name, 'ls-files', '-z').split(b'\0'):
                    name = entry.decode()
                    if name and allowed(name) and name not in current and not any(name == p or name.startswith(p + '/') for p in skipped):
                        stage(index_name, 'update-index', '--force-remove', '--', name)
                for name, oid in objects.items():
                    stage(index_name, 'update-index', '--add', '--cacheinfo', current[name]['mode'], oid, name)
            if snapshot()[-1] != revision or git('rev-parse', '--symbolic-full-name', 'HEAD').decode().strip() != branch:
                raise ValueError('Files or Git branch changed. Refresh Changes before sharing.')
            tree = stage('commit-index', 'write-tree').decode().strip()
            old_tree = git('rev-parse', head + '^{tree}').decode().strip()
            commit = head if tree == old_tree else stage('commit-index', 'commit-tree', tree, '-p', head, data=request['title'].encode()).decode().strip()
            lock_stream.write(pathlib.Path(folder, 'next-index').read_bytes())
            lock_stream.flush()
            os.fsync(lock_stream.fileno())
            if commit != head:
                stage('commit-index', 'update-ref', branch, commit, head)
        os.replace(lock, index)
        owns_lock = False
        ref = 'refs/vibehack/share/' + revision
        git('update-ref', ref, commit)
        with tempfile.TemporaryDirectory(prefix='vibehack-push-') as folder:
            bundle = folder + '/share.bundle'
            git('bundle', 'create', bundle, ref)
            data = pathlib.Path(bundle).read_bytes()
            if len(data) > BUNDLE_LIMIT:
                raise ValueError('Your local commit is saved, but the compressed transfer exceeds 10 MB.')
            return {'commit': commit, 'ref': ref, 'revision': revision, 'bundle': base64.b64encode(data).decode()}
    finally:
        if owns_lock and lock.exists():
            lock.unlink()


def adopt_existing(request):
    commit, expected = request['commit'], request['head']
    if not re.fullmatch(r'[a-f0-9]{40}', commit) or not re.fullmatch(r'[a-f0-9]{40}', expected):
        raise ValueError('Invalid commit')
    git_dir = pathlib.Path(git('rev-parse', '--absolute-git-dir').decode().strip())
    index, lock = git_dir / 'index', git_dir / 'index.lock'
    owned = False
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        owned = True
        with os.fdopen(fd, 'wb') as stream, tempfile.TemporaryDirectory(prefix='vibehack-adopt-') as folder:
            head = git('rev-parse', 'HEAD').decode().strip()
            if head == commit:
                return {'commit': commit, 'alreadyCompleted': True}
            if head != expected or git('show', '-s', '--format=%P', commit).decode().strip() != expected or git('diff', '--cached', '--name-only', '--no-ext-diff', '--no-textconv', expected):
                raise ValueError('Git changed since the repair preview; nothing was overwritten.')
            branch = git('rev-parse', '--symbolic-full-name', 'HEAD').decode().strip()
            temp_index = folder + '/index'
            subprocess.check_call(['git', '-c', 'core.hooksPath=/dev/null', 'read-tree', commit], cwd=ROOT,
                                  env=dict(os.environ, GIT_INDEX_FILE=temp_index), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            stream.write(pathlib.Path(temp_index).read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
            git('update-ref', branch, commit, expected)
        os.replace(lock, index)
        owned = False
        return {'commit': commit, 'alreadyCompleted': False}
    finally:
        if owned and lock.exists():
            lock.unlink()


try:
    request = json.loads(sys.stdin.read(((LIMIT + 2) // 3) * 4 + 65536))
    with open('/home/sprite/.vibehack-file-lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        op = request['operation']
        if op == 'manifest':
            value = manifest()
        elif op == 'changes':
            value = changes()
        elif op == 'share':
            value = share(request)
        elif op == 'adopt-share':
            value = adopt_existing(request)
        elif op == 'shared':
            if not re.fullmatch(r'[a-f0-9]{64}', request['revision']) or not re.fullmatch(r'[a-f0-9]{40}', request['commit']):
                raise ValueError('Invalid shared snapshot')
            ref = 'refs/vibehack/share/' + request['revision']
            if git('rev-parse', ref).decode().strip() != request['commit']:
                raise ValueError('Shared snapshot has changed')
            git('update-ref', 'refs/vibehack/base', request['commit'])
            value = {'updated': True}
        else:
            name = request['path']
            path = target(name)
            current = read(name) if path.exists() else None
            revision = sha(current) if current is not None else None
            if op == 'mutate':
                if revision != request['revision']:
                    raise ValueError('File changed since sync preview. Refresh to reconcile; neither version was overwritten.')
                if request['data'] is None:
                    if current is not None:
                        path.unlink()
                    value = {'revision': None}
                else:
                    data = base64.b64decode(request['data'], validate=True)
                    if len(data) > LIMIT:
                        raise ValueError('File exceeds 25 MiB')
                    path.parent.mkdir(parents=True, exist_ok=True)
                    target(name)
                    handle, temp = tempfile.mkstemp(prefix='.vibehack-', dir=path.parent)
                    try:
                        with os.fdopen(handle, 'wb') as stream:
                            stream.write(data)
                        os.replace(temp, path)
                    finally:
                        if os.path.exists(temp):
                            os.unlink(temp)
                    value = {'revision': sha(data)}
            elif op == 'read' and current is not None:
                value = {'path': name, 'data': base64.b64encode(current).decode(), 'revision': revision}
            else:
                raise ValueError('File unavailable')
    print(json.dumps({'ok': True, 'value': value}))
except ValueError as error:
    print(json.dumps({'ok': False, 'error': str(error), 'status': 409}))
except (OSError, KeyError, subprocess.SubprocessError):
    print(json.dumps({'ok': False, 'error': 'Workspace scan or transfer could not complete. Files may have changed, a path may be excluded, or a size limit was reached. Refresh to reconcile.', 'status': 409}))
