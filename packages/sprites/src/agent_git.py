"""Agent Git integration. Executed inside the Sprite; never on the control plane."""
import base64
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import uuid

ROOT = pathlib.Path('/home/sprite/project')
ENV = dict(os.environ, GIT_AUTHOR_NAME='VibeHack participant', GIT_AUTHOR_EMAIL='participant@vibehack.local',
           GIT_COMMITTER_NAME='VibeHack', GIT_COMMITTER_EMAIL='workspace@vibehack.local', GIT_EDITOR='true', GIT_SEQUENCE_EDITOR='true')


def git(*args, cwd=None):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *args],
                                   cwd=cwd or ROOT, env=ENV, stderr=subprocess.PIPE, timeout=60)


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{40}', value):
        raise ValueError('Invalid Git revision')
    return value


def head():
    return git('rev-parse', 'HEAD').decode().strip()


def directory():
    return pathlib.Path(git('rev-parse', '--absolute-git-dir').decode().strip())


def clean():
    if git('status', '--porcelain', '-z'):
        raise ValueError('Commit only your task changes first. Uncommitted or unrelated edits must be preserved; publishing does not stage or stash them.')
    if any((directory() / p).exists() for p in ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']):
        raise ValueError('Finish or abort the current merge/rebase before publishing.')
    if git('symbolic-ref', '--short', 'HEAD').decode().strip() != 'main':
        raise ValueError('Publish from the workspace main branch. Other branches are preserved.')


def ancestor(a, b):
    try:
        git('merge-base', '--is-ancestor', a, b)
        return True
    except subprocess.CalledProcessError:
        return False


def checked(request):
    expected, remote = sha(request['head']), sha(request['remote'])
    clean()
    if head() != expected:
        raise ValueError('Your branch changed during publication. Retry after reviewing it.')
    if git('rev-parse', 'refs/vibehack/team-incoming').decode().strip() != remote:
        raise ValueError('Team changes moved during publication. Retry to fetch again.')
    return expected, remote


def rebase(request):
    expected, remote = checked(request)
    if ancestor(remote, expected):
        return {'status': 'ready', 'head': expected, 'remote': remote}
    # Preserve native history before any mutation. No rewriting published commits.
    base = git('merge-base', expected, remote).decode().strip()
    if not ancestor(base, remote):
        raise ValueError('The team histories cannot be reconciled safely.')
    # --rebase-merges is deliberately unsupported: do not silently flatten participant merges.
    if git('rev-list', '--merges', remote + '..' + expected).strip():
        raise ValueError('Unpublished merge commits require the existing Team updates merge workflow. They will not be rewritten automatically.')
    if not request.get('confirmed'):
        with tempfile.TemporaryDirectory(prefix='vibehack-rebase-trial-') as folder:
            checkout = folder + '/checkout'
            git('worktree', 'add', '--detach', checkout, expected)
            try:
                try:
                    git('rebase', '--onto', remote, base, cwd=checkout)
                except subprocess.CalledProcessError:
                    conflicts = [p for p in git('diff', '--name-only', '--diff-filter=U', '-z', cwd=checkout).decode().split('\0') if p]
                    return {'status': 'confirmation', 'head': expected, 'remote': remote, 'conflicts': conflicts}
            finally:
                git('worktree', 'remove', '--force', checkout)
        checked(request)
    backup = 'refs/vibehack/recovery/agent-' + str(uuid.uuid4())
    git('update-ref', backup, expected)
    try:
        if ancestor(expected, remote):
            git('merge', '--ff-only', remote)
        else:
            git('rebase', '--onto', remote, base)
    except subprocess.CalledProcessError:
        if not request.get('confirmed'):
            # A race during trial must never start unapproved conflict editing.
            git('rebase', '--abort')
            return {'status': 'confirmation', 'head': expected, 'remote': remote, 'conflicts': []}
        return {'status': 'resolving', 'head': expected, 'remote': remote, 'backup': backup,
                'conflicts': [p for p in git('diff', '--name-only', '--diff-filter=U', '-z').decode().split('\0') if p]}
    git('update-ref', 'refs/vibehack/base', remote)
    return {'status': 'ready', 'head': head(), 'remote': remote, 'backup': backup}


def export(request):
    clean()
    commit = sha(request['head'])
    if head() != commit:
        raise ValueError('Your branch changed before push. Retry after reviewing it.')
    title = git('log', '-1', '--format=%s').decode().strip()[:160]
    revision = hashlib.sha256(('agent-publish:' + commit).encode()).hexdigest()
    ref = 'refs/vibehack/share/' + revision
    git('update-ref', ref, commit)
    with tempfile.TemporaryDirectory(prefix='vibehack-agent-push-') as folder:
        bundle = folder + '/push.bundle'
        git('bundle', 'create', bundle, ref)
        data = pathlib.Path(bundle).read_bytes()
        if len(data) > 10 * 1024 * 1024:
            raise ValueError('Your local commit is saved, but its compressed transfer exceeds 10 MiB.')
        return {'commit': commit, 'title': title, 'revision': revision, 'ref': ref, 'bundle': base64.b64encode(data).decode()}


try:
    request = json.loads(sys.stdin.read(65536))
    operation = request['operation']
    if operation == 'head':
        clean()
        value = {'head': head()}
    elif operation == 'rebase':
        value = rebase(request)
    elif operation == 'export':
        value = export(request)
    else:
        raise ValueError('Unknown agent Git operation')
    print(json.dumps({'ok': True, 'value': value}))
except ValueError as error:
    print(json.dumps({'ok': False, 'error': str(error), 'status': 409}))
except (OSError, KeyError, subprocess.SubprocessError):
    print(json.dumps({'ok': False, 'error': 'Agent Git operation failed. Local commits and recovery refs are preserved. Inspect git status before retrying.', 'status': 409}))
