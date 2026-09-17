"""Managed preview and project preparation. Executed ONLY inside the owner Sprite."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shlex
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path('/home/sprite/.civic-spark-agent')
PROJECT = pathlib.Path('/home/sprite/project')
SESSION = 'civic-spark-web-preview'
CONFIG = ROOT / 'environment.json'
LOG = ROOT / 'preview.log'
STATE = ROOT / 'preview-state.json'
HOST = ROOT / 'preview-host.json'
MARKER = ROOT / 'project-installed.json'
CANCEL = ROOT / 'preview-cancel'
INSTALL_TIMEOUT = 300
child = None
launch_deadline = float('inf')
preview_host = None


def environment():
    # Do not inherit provider keys, agent configuration or tmux's saved environment.
    return {**{key: value for key, value in os.environ.items()
               if key in ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']},
            **({'__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS': preview_host} if preview_host else {}),
            'npm_config_userconfig': '/dev/null',
            'npm_config_globalconfig': str(ROOT / 'preview-empty.npmrc')}


def tmux(*args):
    return subprocess.run(['tmux', *args], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, timeout=10, env=environment())


def services():
    result = subprocess.run(['sprite-env', 'services', 'list'], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=10, env=environment())
    if result.returncode:
        raise ValueError('Preview service status unavailable. Retry after checking the Sprite.')
    value = json.loads(result.stdout)
    if not isinstance(value, list) or any(not isinstance(item, dict) or not isinstance(item.get('name'), str) for item in value):
        raise ValueError('Invalid preview service status. Retry after checking the Sprite.')
    return value


def managed_service():
    return next((item for item in services() if item['name'] == SESSION), None)


def service_running():
    service = managed_service()
    return bool(service and service.get('state', {}).get('status') in ['running', 'starting'])


def service_command(*args):
    result = subprocess.run(['sprite-env', 'services', *args], stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=15, env=environment())
    if result.returncode:
        raise ValueError('Preview service operation failed. Check Preview logs and retry Launch.')


def stop_service():
    if managed_service():
        service_command('stop', SESSION)


def save(path, value):
    temp = path.with_name(path.name + '.' + str(os.getpid()))
    temp.write_text(json.dumps(value)); temp.chmod(0o600); temp.replace(path)


def saved(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def phase(value, error=None):
    save(STATE, {'phase': value, **({'error': error} if error else {})})


def configuration(request):
    value = saved(CONFIG) if CONFIG.exists() else request['defaults']
    if 'port' in request:
        value = {'port': request['port'], 'command': request['command']}
    if (not isinstance(value.get('port'), int) or not 1024 <= value['port'] <= 65535 or
        not isinstance(value.get('command'), list) or not 1 <= len(value['command']) <= 40 or
        any(not isinstance(p, str) or not p or len(p) > 4096 or '\0' in p for p in value['command'])):
        raise ValueError('Invalid web server command or port')
    return value


def locked(file):
    try:
        fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return False
    except BlockingIOError:
        return True


def valid_host(value):
    return isinstance(value, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]*\.sprites\.app', value) is not None


def server_command(config):
    command = list(config['command'])
    package = saved(PROJECT / 'node_modules/vite/package.json')
    # Vite 5's host check does not consume the environment hook used by newer releases.
    # Adapt a plain npm Vite script through its public config API, in private
    # runtime files only. Other commands keep their configured behavior.
    if not preview_host or not str(package.get('version', '')).startswith('5.'):
        return command
    scripts = saved(PROJECT / 'package.json').get('scripts', {})
    if (len(command) < 3 or command[:2] != ['npm', 'run'] or
        scripts.get(command[2], '').strip() != 'vite' or
        (len(command) > 3 and command[3] != '--')):
        return command
    args = command[4:]
    original_config = None
    remaining = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ['--config', '-c']:
            index += 1
            if index == len(args):
                raise ValueError('The Vite config option needs a file path.')
            original_config = args[index]
        elif arg.startswith('--config='):
            original_config = arg.split('=', 1)[1]
        else:
            remaining.append(arg)
        index += 1
    # The standard managed command has no positional Vite root. Keep custom
    # roots/compound scripts untouched rather than changing their config search.
    options = {'--host', '--port', '--base', '--mode', '-m', '--logLevel', '-l', '--clearScreen'}
    index = 0
    while index < len(remaining):
        arg = remaining[index]
        if arg in options:
            index += 2
        elif arg.startswith('-'):
            index += 1
        else:
            return command
    path = ROOT / 'preview-vite.config.mjs'
    source = ("export default async (environment) => {\n"
              "  const entry = " + json.dumps((PROJECT / 'node_modules/vite/dist/node/index.js').as_uri()) + ";\n"
              "  const { loadConfigFromFile, mergeConfig } = await import(entry);\n"
              "  const loaded = await loadConfigFromFile(environment, " +
              (json.dumps(original_config) if original_config is not None else 'undefined') +
              ", " + json.dumps(str(PROJECT)) + ");\n"
              "  const server = loaded?.config?.server?.allowedHosts === true ? {} : { allowedHosts: [" +
              json.dumps(preview_host) + "] };\n"
              "  return mergeConfig(loaded?.config ?? {}, { server, plugins: [{\n"
              "    name: 'civic-spark-preview-config',\n"
              "    configResolved(config) {\n"
              "      config.configFileDependencies.push(...(loaded?.dependencies ?? []));\n"
              "    },\n"
              "  }] });\n"
              "};\n")
    path.write_text(source)
    path.chmod(0o600)
    return command[:3] + ['--', *remaining, '--config', str(path)]


def status(config):
    with (ROOT / 'preview.lock').open('a') as lock:
        preparing = locked(lock)
    running = service_running()
    value = saved(STATE)
    current = value.get('phase')
    ready = False
    if running and current != 'installing':
        try:
            host = preview_host or saved(HOST).get('hostname')
            if host is not None and not valid_host(host):
                raise ValueError('Invalid preview hostname')
            request = urllib.request.Request('http://127.0.0.1:' + str(config['port']) + '/',
                                             headers={'Host': host} if host else {})
            with urllib.request.urlopen(request, timeout=2) as response:
                ready = 200 <= response.status < 500
        except urllib.error.HTTPError as error:
            if error.code == 403 and host:
                value = {'phase': 'error', 'error': 'The web server rejected its public preview hostname. Check its allowed hosts and restart.'}
            else:
                ready = error.code < 500
        except (OSError, urllib.error.URLError):
            pass
    if ready:
        value = {'phase': 'ready'}
    elif not preparing and current in ['installing', 'starting'] and not running:
        value = {'phase': 'error', 'error': 'Launch was interrupted. Retry Launch.'}
    elif not preparing and not running and current != 'error':
        value = {'phase': 'stopped'}
    return {'port': config['port'], 'command': config['command'],
            'running': running or preparing, 'ready': ready, **value}


def terminate():
    global child
    if child is not None:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait()
        child = None


def interrupted(_signal, _frame):
    terminate()
    raise ValueError('Launch was interrupted. Retry Launch.')


def check_cancel(token):
    if time.monotonic() > launch_deadline:
        raise ValueError('Launch timed out. Check registry access and the launch command, then retry Launch.')
    if CANCEL.read_text() != token:
        raise ValueError('Launch stopped. Retry Launch when ready.')


def run(args, token, timeout=30, output=False):
    global child
    check_cancel(token)
    # npm output can contain registry credentials/URLs. Keep it off the public log.
    child = subprocess.Popen(args, cwd=PROJECT, env=environment(), start_new_session=True,
                             stdout=subprocess.PIPE if output else subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
    start = time.monotonic()
    try:
        while child.poll() is None:
            check_cancel(token)
            if time.monotonic() - start > timeout:
                raise ValueError('Dependency preparation timed out. Check registry access, then retry Launch.')
            time.sleep(0.1)
        result = child.returncode
        data = child.stdout.read() if output else b''
        return result, data
    finally:
        terminate()


def project_inputs():
    files = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc',
             'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']
    values = {}
    for name in files:
        path = PROJECT / name
        if path.is_symlink():
            raise ValueError('Dependency manifests and configuration must be regular project files.')
        if path.exists():
            if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
                raise ValueError('Dependency manifest or configuration exceeds the supported size.')
            values[name] = path.read_bytes()
    return values


def installed_bins(manifest):
    for name in {**manifest.get('dependencies', {}), **manifest.get('devDependencies', {})}:
        package = saved(PROJECT / 'node_modules' / name / 'package.json')
        bins = package.get('bin', {})
        if isinstance(bins, str):
            bins = {name.split('/')[-1]: bins}
        if not isinstance(bins, dict):
            return False
        if any(not (PROJECT / 'node_modules' / '.bin' / name).is_file() for name in bins):
            return False
    return True


def prepare(config, token):
    inputs = project_inputs()
    if 'package.json' not in inputs:
        if config['command'][0] in ['npm', 'npx', 'pnpm', 'yarn', 'bun']:
            raise ValueError('package.json is missing. Configure the launch command for this project.')
        return
    try:
        manifest = json.loads(inputs['package.json'])
    except ValueError:
        raise ValueError('package.json is invalid. Correct it and retry Launch.')
    manager = manifest.get('packageManager', 'npm')
    if (not isinstance(manager, str) or manager.split('@')[0] != 'npm' or
        any(name in inputs for name in ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']) or
        config['command'][0] in ['pnpm', 'yarn', 'bun']):
        raise ValueError('Automatic dependency preparation supports npm projects only. Use its declared package manager in the terminal to run this project.')
    if manifest.get('workspaces'):
        raise ValueError('Automatic dependency preparation does not yet support npm workspaces.')
    if config['command'][:3] == ['npm', 'run', 'dev'] and not manifest.get('scripts', {}).get('dev'):
        raise ValueError('The project has no npm dev script. Configure its launch command or add the script.')
    code, versions = run(['npm', '--version'], token, output=True)
    node_code, node = run(['node', '--version'], token, output=True)
    if code or node_code:
        raise ValueError('Node and npm must be available in the Sprite. Retry after runtime repair.')
    if '@' in manager and manager.split('@', 1)[1].split('+', 1)[0] != versions.decode().strip():
        raise ValueError('The Sprite npm version differs from packageManager. Use the declared version in the terminal; automatic version changes are disabled.')
    digest = hashlib.sha256(b'preview-dependencies-v1' + versions + node)
    for name, data in sorted(inputs.items()):
        digest.update(name.encode() + b'\0' + data)
    fingerprint = digest.hexdigest()
    modules = PROJECT / 'node_modules'
    if modules.is_symlink():
        raise ValueError('node_modules must be a directory inside the project, not a symbolic link.')
    installed = saved(MARKER)
    valid = (modules.is_dir() and installed.get('fingerprint') == fingerprint and
             installed.get('modules') == modules.stat().st_ino)
    # Direct dependencies/bins can remain intact when a required transitive package is missing.
    # Check the complete installed tree before reuse and before writing the success marker.
    if valid and installed_bins(manifest) and run(['npm', 'ls', '--all', '--include=dev', '--include=optional'], token)[0] == 0:
        return
    phase('installing')
    MARKER.unlink(missing_ok=True)
    has_lock = 'npm-shrinkwrap.json' in inputs or 'package-lock.json' in inputs
    args = ['npm', 'ci' if has_lock else 'install', '--ignore-scripts', '--include=dev',
            '--include=optional', '--no-audit', '--no-fund', '--no-save',
            '--userconfig=/dev/null', '--globalconfig=' + str(ROOT / 'preview-empty.npmrc')]
    if not has_lock:
        args.append('--package-lock=false')
    LOG.write_text('Installing project dependencies (' + ('npm ci' if has_lock else 'npm install; no lockfile') + ').\n')
    if run(args, token, INSTALL_TIMEOUT)[0]:
        raise ValueError('Dependency installation failed. Check package.json, the lockfile and registry access, then retry Launch. Install scripts are disabled; packages requiring a build must be prepared in the terminal.')
    if project_inputs() != inputs:
        raise ValueError('Dependency files changed during installation. Retry Launch to use the current files.')
    if not installed_bins(manifest) or run(['npm', 'ls', '--all', '--include=dev', '--include=optional'], token)[0]:
        raise ValueError('Installed dependencies are incomplete. Check the manifest and retry Launch.')
    modules.mkdir(exist_ok=True)
    check_cancel(token)
    save(MARKER, {'fingerprint': fingerprint, 'modules': modules.stat().st_ino})


def launch(request, config):
    global launch_deadline
    launch_deadline = time.monotonic() + 330
    with (ROOT / 'preview.lock').open('a') as lock:
        with (ROOT / 'preview-control.lock').open('a') as control:
            fcntl.flock(control, fcntl.LOCK_EX)
            if locked(lock):
                return
            token = str(uuid.uuid4())
            CANCEL.write_text(token)
        if request['operation'] == 'restart':
            stop_service()
        elif service_running():
            if 'port' in request:
                raise ValueError('Stop the existing preview before changing its command or port.')
            return
        # Explicit Launch retires only our previous managed tmux process.
        tmux('kill-session', '-t', SESSION)
        with socket.socket() as probe:
            if probe.connect_ex(('127.0.0.1', config['port'])) == 0:
                raise ValueError('The configured port is already used by another process. Stop it or choose another port.')
        # Initialize from committed defaults only on explicit Launch. Never overwrite configuration.
        if not CONFIG.exists() or 'port' in request:
            save(CONFIG, config)
        save(HOST, {'hostname': preview_host})
        LOG.write_text(''); LOG.chmod(0o600)
        phase('installing')
        try:
            prepare(config, token)
            check_cancel(token)
            phase('starting')
            # The persistent provider service starts this fixed private wrapper after wake.
            # env -i prevents provider/agent credentials entering the public app.
            wrapper = ROOT / 'preview-service.sh'
            command = shlex.join(['env', '-i', *[key + '=' + value for key, value in environment().items()],
                                  *server_command(config)])
            wrapper.write_text('#!/bin/sh\ncd ' + shlex.quote(str(PROJECT)) + '\nexec ' + command +
                               ' >>' + shlex.quote(str(LOG)) + ' 2>&1\n')
            wrapper.chmod(0o700)
            check_cancel(token)
            # Create updates only our named definition; another HTTP service fails explicitly.
            service_command('create', SESSION, '--cmd', '/bin/sh', '--args', str(wrapper),
                            '--http-port', str(config['port']), '--duration', '1s')
            # Explicit Stop can leave a failed/143 state. Public visits do not restart it.
            # Reapply the definition, then explicitly start if the provider has not done so.
            if not service_running():
                service_command('start', SESSION, '--duration', '1s')
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                check_cancel(token)
                value = status(config)
                if value['ready']:
                    phase('ready')
                    return
                if value.get('phase') == 'error':
                    raise ValueError(value['error'])
                if not service_running():
                    break
                time.sleep(0.3)
            raise ValueError('The server did not become ready. Check Preview logs and the launch command, then retry Launch.')
        except Exception as error:
            stop_service()
            phase('error', str(error) if isinstance(error, ValueError) else 'Launch failed. Check the Sprite connection and retry Launch.')
            raise


def stop():
    with (ROOT / 'preview-control.lock').open('a') as control:
        fcntl.flock(control, fcntl.LOCK_EX)
        CANCEL.write_text(str(uuid.uuid4()))
    with (ROOT / 'preview.lock').open('a') as lock:
        start = time.monotonic()
        while locked(lock):
            if time.monotonic() - start > 15:
                raise ValueError('Launch is still stopping. Retry Stop.')
            time.sleep(0.1)
        stop_service()
        tmux('kill-session', '-t', SESSION)
        phase('stopped')


def main():
    global preview_host
    ROOT.mkdir(mode=0o700, exist_ok=True)
    (ROOT / 'preview-empty.npmrc').write_text('')
    request = json.loads(sys.stdin.read(65536))
    preview_host = request.get('previewHost')
    if preview_host is not None and not valid_host(preview_host):
        raise ValueError('Invalid preview hostname')
    config = configuration(request)
    operation = request['operation']
    if operation in ['start', 'restart']:
        launch(request, config)
    elif operation == 'stop':
        stop()
    elif operation not in ['status', 'logs']:
        raise ValueError('Unknown preview operation')
    value = status(config)
    if operation == 'logs':
        if LOG.exists() and not LOG.is_symlink():
            with LOG.open('rb') as source:
                source.seek(max(0, LOG.stat().st_size - 20000))
                value['logs'] = source.read(20000).decode('utf-8', errors='replace')
        else:
            value['logs'] = 'No web server log yet.'
    print(json.dumps({'ok': True, 'value': value}))


if __name__ == '__main__':
    for sig in [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]:
        signal.signal(sig, interrupted)
    try:
        main()
    except ValueError as error:
        print(json.dumps({'ok': False, 'error': str(error), 'status': 409}))
    except (OSError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        print(json.dumps({'ok': False, 'error': 'Preview operation failed. Check the project command and Sprite connection, then retry Launch.', 'status': 502}))
    finally:
        terminate()
