"""Trusted Git team-update adapter. Executes inside the participant Sprite only."""
import hashlib
import shutil
import json
import os
import pathlib
import re
import subprocess
import sys
import uuid


def diagnostic_error(error):
    trace = error.__traceback__
    while trace and trace.tb_next:
        trace = trace.tb_next
    kinds = {'ValueError', 'KeyError', 'FileNotFoundError', 'PermissionError', 'OSError', 'CalledProcessError', 'TimeoutExpired', 'UnicodeDecodeError'}
    kind = type(error).__name__
    return {'exception': kind if kind in kinds else 'other', 'line': trace.tb_lineno if trace else 0,
            'errno': getattr(error, 'errno', None), 'exitCode': getattr(error, 'returncode', None)}

ROOT = pathlib.Path('/home/sprite/project')
ENV = dict(os.environ, GIT_AUTHOR_NAME='Civic Spark participant', GIT_AUTHOR_EMAIL='participant@civic-spark.local',
           GIT_COMMITTER_NAME='Civic Spark', GIT_COMMITTER_EMAIL='workspace@civic-spark.local')


def git(*args):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', *args], cwd=ROOT,
                                   env=ENV, stderr=subprocess.DEVNULL, timeout=30)


def valid_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{40}', value):
        raise ValueError('Invalid Git revision')
    return value


def directory():
    return pathlib.Path(git('rev-parse', '--absolute-git-dir').decode().strip())


def ancestor(older, newer):
    try:
        git('merge-base', '--is-ancestor', older, newer)
        return True
    except subprocess.CalledProcessError:
        return False


def advance_base(remote):
    # Move the Changes baseline to the merged team commit without ever moving it backwards.
    try:
        base = git('rev-parse', '--verify', 'refs/civic-spark/base').decode().strip()
    except subprocess.CalledProcessError:
        base = None
    if base is None or ancestor(base, remote):
        git('update-ref', 'refs/civic-spark/base', remote)


def status(remote):
    valid_sha(remote)
    head = git('rev-parse', 'HEAD').decode().strip()
    result = {'head': head, 'remote': remote, 'incoming': not ancestor(remote, head), 'outgoing': head != remote and ancestor(remote, head),
              'dirty': bool(git('status', '--porcelain', '-z')), 'merging': (directory() / 'MERGE_HEAD').exists(),
              'conflicts': [p for p in git('diff', '--name-only', '--diff-filter=U', '-z').decode().split('\0') if p]}
    receipt = directory() / 'civic-spark-agent-merge.json'
    if receipt.exists():
        saved = json.loads(receipt.read_text())
        saved_head, saved_remote = valid_sha(saved['head']), valid_sha(saved['remote'])
        if not result['merging'] and not result['conflicts'] and ancestor(saved_head, head) and ancestor(saved_remote, head):
            # The agent merge is complete and both histories are retained. The person
            # may already have moved on (for example by sharing the merge), so finish
            # the resolution here instead of waiting for an explicit check.
            advance_base(saved_remote)
            receipt.unlink()
        else:
            result['resolution'] = {'head': saved_head, 'remote': saved_remote}
    return result


def resolution_prompt(head, remote):
    return ('Resolve the Git merge that I requested in this workspace. The original local commit is ' + head +
            '; the incoming team commit is ' + remote + '. Git has started the merge. Inspect the conflicted files and reconcile both sides\' intent, preserving unrelated work. '
            'Resolve all conflicts and create a normal merge commit retaining both histories. Do not force-push, publish, reset --hard, or discard one side wholesale. '
            'Do not ask me to edit merge markers. Run appropriate existing checks inside this workspace. Verify there are no unmerged index entries, MERGE_HEAD is gone, '
            'and both specified commits are ancestors of HEAD. If resolution is unsafe or ambiguous, leave the work recoverable and explain the issue. Do not push; I will use Share separately.')


def backup_working(id):
    target = directory() / 'civic-spark-recovery' / id
    (target / 'files').mkdir(parents=True, exist_ok=True)
    def paths():
        return sorted(set(p for p in git('ls-files', '-z', '--cached', '--others', '--exclude-standard').decode().split('\0') if p))
    names, revisions, size = paths(), {}, 0
    if len(names) > 5000:
        raise ValueError('The recovery copy exceeds 5,000 files. Your workspace was not replaced.')
    def fingerprint(name):
        path = ROOT / name
        if path.is_symlink():
            return 'link:' + os.readlink(path)
        if not path.exists():
            return None
        if not path.is_file():
            raise ValueError('A workspace path changed type. Your workspace was not replaced.')
        return hashlib.sha256(path.read_bytes()).hexdigest()
    for name in names:
        parts = pathlib.PurePosixPath(name).parts
        if name.startswith('/') or any(p in ['..', '.git'] for p in parts):
            raise ValueError('Invalid recovery path')
        parent = ROOT
        for part in parts[:-1]:
            parent = parent / part
            if parent.is_symlink():
                raise ValueError('A symbolic-link directory prevents safe recovery. Your workspace was not replaced.')
        stamp = fingerprint(name)
        revisions[name] = stamp
        if stamp is None:
            continue
        source = ROOT / name
        size += source.lstat().st_size
        if size > 50 * 1024 * 1024:
            raise ValueError('The recovery copy exceeds 50 MB. Your workspace was not replaced.')
        destination = target / 'files' / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination, follow_symlinks=False)
        if fingerprint(name) != stamp:
            raise ValueError('Files changed while creating the recovery copy. Your workspace was not replaced.')
    for name in ['index', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE']:
        source = directory() / name
        if source.exists():
            shutil.copy2(source, target / name)
    (target / 'manifest.json').write_text(json.dumps({'head': git('rev-parse', 'HEAD').decode().strip(), 'revisions': revisions}, indent=2))
    def verify():
        if names != paths() or any(fingerprint(name) != value for name, value in revisions.items()):
            raise ValueError('Files changed after the recovery copy. Your workspace was not replaced.')
    return verify


def apply(request):
    head, remote, mode = valid_sha(request['head']), valid_sha(request['remote']), request['mode']
    if mode not in ['pull', 'agent', 'replace']:
        raise ValueError('Invalid update mode')
    state = status(remote)
    if state['head'] != head:
        raise ValueError('Your workspace changed since the update preview. Check for updates again.')
    if git('rev-parse', 'refs/civic-spark/team-incoming').decode().strip() != remote:
        raise ValueError('The incoming team version changed. Check for updates again.')
    continuing = state['merging'] and mode == 'agent' and (directory() / 'MERGE_HEAD').read_text().strip() == remote
    if state['merging'] and not continuing and mode != 'replace':
        raise ValueError('A merge is already in progress. Finish the current agent resolution first.')
    if not state['incoming'] and mode != 'replace':
        return {'status': 'updated', 'head': head, 'remote': remote, 'conflicts': []}
    if state['dirty'] and mode != 'replace' and not continuing:
        raise ValueError('Your workspace has uncommitted edits. Save them with Share before getting team updates; any failed push still preserves the local commit.')
    if mode == 'pull':
        try:
            git('merge-tree', '--write-tree', head, remote)
        except subprocess.CalledProcessError:
            return {'status': 'conflict', 'head': head, 'remote': remote, 'conflicts': []}
    backup = None
    if mode != 'pull':
        backup = 'refs/civic-spark/recovery/' + str(uuid.uuid4())
        git('update-ref', backup + '/head', head)
    if mode == 'replace':
        verify_recovery = backup_working(backup.split('/')[-1])
        verify_recovery()
        if status(remote)['head'] != head:
            raise ValueError('Your Git branch changed during recovery. Your workspace was not replaced.')
        git('reset', '--hard', remote)
        git('clean', '-fd')
        (directory() / 'civic-spark-agent-merge.json').unlink(missing_ok=True)
    else:
        if not continuing:
            if status(remote)['head'] != head:
                raise ValueError('Your Git branch changed during the update. Retry after reviewing it.')
            try:
                git('merge', '--no-commit' if mode == 'agent' else '--no-edit', remote)
            except subprocess.CalledProcessError:
                if not (directory() / 'MERGE_HEAD').exists():
                    raise ValueError('Team updates could not be applied. Your local work is preserved.')
        if (directory() / 'MERGE_HEAD').exists():
            unresolved = status(remote)['conflicts']
            if mode == 'pull':
                return {'status': 'conflict', 'head': head, 'remote': remote, 'conflicts': unresolved}
            receipt = directory() / 'civic-spark-agent-merge.json'
            receipt.write_text(json.dumps({'head': head, 'remote': remote, 'backup': backup}))
            receipt.chmod(0o600)
            return {'status': 'agent', 'head': head, 'remote': remote, 'conflicts': unresolved,
                    'backup': backup, 'prompt': resolution_prompt(head, remote)}
    git('update-ref', 'refs/civic-spark/base', remote)
    result = {'status': 'updated', 'head': git('rev-parse', 'HEAD').decode().strip(), 'remote': remote, 'conflicts': []}
    if backup:
        result['backup'] = backup
    return result


def verify(request):
    head, remote = valid_sha(request['head']), valid_sha(request['remote'])
    path = directory() / 'civic-spark-agent-merge.json'
    if not path.exists():
        raise ValueError('No agent merge is awaiting verification.')
    saved = json.loads(path.read_text())
    if saved['head'] != head or saved['remote'] != remote:
        raise ValueError('The pending merge changed. Reopen team updates.')
    # Status finalizes a completed merge itself; a receipt that survives it is unfinished.
    state = status(remote)
    if path.exists():
        raise ValueError('The agent has not finished a merge preserving both versions yet. Continue the resolution in Agent.')
    return {'status': 'updated', 'head': state['head'], 'remote': remote, 'conflicts': [], 'backup': saved['backup']}


try:
    request = json.loads(sys.stdin.read(65536))
    operation = request['operation']
    if operation == 'status':
        value = status(request['remote'])
    elif operation == 'import':
        remote = valid_sha(request['remote'])
        bundle = pathlib.Path(request['bundle'])
        if not re.fullmatch(r'/tmp/civic-spark-team-[a-f0-9-]+\.bundle', str(bundle)):
            raise ValueError('Invalid incoming bundle')
        try:
            git('bundle', 'verify', str(bundle))
            git('fetch', str(bundle), 'refs/heads/main:refs/civic-spark/team-incoming')
            if git('rev-parse', 'refs/civic-spark/team-incoming').decode().strip() != remote:
                raise ValueError('The team version changed during transfer. Check for updates again.')
            value = {'imported': remote}
        finally:
            bundle.unlink(missing_ok=True)
    elif operation == 'apply':
        value = apply(request)
    elif operation == 'verify':
        value = verify(request)
    else:
        raise ValueError('Invalid team operation')
    print(json.dumps({'ok': True, 'value': value}))
except ValueError as error:
    print(json.dumps({'ok': False, 'error': str(error), 'status': 409, 'diagnostic': diagnostic_error(error)}))
except (OSError, KeyError, subprocess.SubprocessError) as error:
    print(json.dumps({'ok': False, 'error': 'The Git update could not complete. Your local work and recovery references are preserved.', 'status': 409, 'diagnostic': diagnostic_error(error)}))
