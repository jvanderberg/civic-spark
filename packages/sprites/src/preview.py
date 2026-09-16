"""Managed web-process lifecycle; only executed within the participant Sprite."""
import json
import os
import pathlib
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path('/home/sprite/.vibehack-agent')
SESSION = 'vibehack-web-preview'
CONFIG = ROOT / 'environment.json'
LOG = ROOT / 'preview.log'


def tmux(*args):
    return subprocess.run(['tmux', *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)


def configuration(request):
    value = json.loads(CONFIG.read_text())
    if 'port' in request:
        value = {'port': request['port'], 'command': request['command']}
    if (not isinstance(value['port'], int) or not 1024 <= value['port'] <= 65535 or
        not isinstance(value['command'], list) or not 1 <= len(value['command']) <= 40 or
        any(not isinstance(p, str) or not p or len(p) > 4096 or '\0' in p for p in value['command'])):
        raise ValueError('Invalid web server command or port')
    return value


def status(config):
    running = tmux('has-session', '-t', SESSION).returncode == 0
    ready = False
    if running:
        try:
            with urllib.request.urlopen('http://127.0.0.1:' + str(config['port']) + '/', timeout=2) as response:
                ready = 200 <= response.status < 500
        except urllib.error.HTTPError as error:
            ready = error.code < 500
        except (OSError, urllib.error.URLError):
            pass
    return {'port': config['port'], 'command': config['command'], 'running': running, 'ready': ready}


try:
    ROOT.mkdir(mode=0o700, exist_ok=True)
    request = json.loads(sys.stdin.read(65536))
    config = configuration(request)
    operation = request['operation']
    if operation in ['start', 'restart']:
        if config['command'][:3] == ['npm', 'run', 'dev']:
            package = pathlib.Path('/home/sprite/project/package.json')
            if not package.is_file():
                raise ValueError('No app is configured at the project root yet (package.json is missing). Ask the agent to create your app with Vite, or configure the launch command for an existing app. Your files were not changed.')
            manifest = json.loads(package.read_text())
            if not manifest.get('scripts', {}).get('dev'):
                raise ValueError('The project has no npm dev script. Ask the agent to add the correct launch script, or configure the command for your existing app.')
        if operation == 'restart':
            tmux('kill-session', '-t', SESSION)
        elif tmux('has-session', '-t', SESSION).returncode == 0:
            if 'port' in request:
                raise ValueError('Stop the existing preview before changing its command or port.')
        if tmux('has-session', '-t', SESSION).returncode != 0:
            # Refuse to label an unrelated listener as our managed app.
            import socket
            with socket.socket() as probe:
                if probe.connect_ex(('127.0.0.1', config['port'])) == 0:
                    raise ValueError('The configured port is already used by another process. Stop it or choose another port; VibeHack will not kill it.')
            CONFIG.write_text(json.dumps(config)); CONFIG.chmod(0o600)
            LOG.write_text(''); LOG.chmod(0o600)
            command = shlex.join(config['command']) + ' >>' + shlex.quote(str(LOG)) + ' 2>&1'
            if tmux('new-session', '-d', '-s', SESSION, '-c', '/home/sprite/project', command).returncode:
                raise ValueError('The web server could not start. Check that the project and tmux are available.')
        for _ in range(30):
            value = status(config)
            if value['ready'] or not value['running']:
                break
            time.sleep(0.3)
    elif operation == 'stop':
        tmux('kill-session', '-t', SESSION)
        value = status(config)
    elif operation == 'status':
        value = status(config)
    elif operation == 'logs':
        value = status(config)
        if LOG.exists() and not LOG.is_symlink():
            with LOG.open('rb') as source:
                source.seek(max(0, LOG.stat().st_size - 20000))
                value['logs'] = source.read(20000).decode('utf-8', errors='replace')
        else:
            value['logs'] = 'No web server log yet.'
    else:
        raise ValueError('Unknown preview operation')
    print(json.dumps({'ok': True, 'value': value}))
except ValueError as error:
    print(json.dumps({'ok': False, 'error': str(error), 'status': 409}))
except (OSError, KeyError, subprocess.SubprocessError):
    print(json.dumps({'ok': False, 'error': 'Preview operation failed. Check the project command and Sprite connection.', 'status': 502}))
