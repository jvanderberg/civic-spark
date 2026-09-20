"""Read-only helper dispatcher. Runs ONLY inside the participant Sprite.

The management host keeps one of these per Sprite instead of spawning a CLI
process per poll. Line protocol on stdin/stdout, one JSON object per line:

  host -> {"type": "hello", "scripts": {"files.py": "<source>", ...}}
  host -> {"type": "request", "id": "...", "script": "files.py",
           "payload": {...}, "timeoutMs": 30000, "limit": 16777216}
  host -> {"type": "ping", "id": "..."}
  here -> {"type": "ready"}
  here -> {"type": "response", "id": "...", "stdout": "<helper output>"}
  here -> {"type": "response", "id": "...", "error": "timeout" |
           "buffer_limit" | "process_failed" | "unknown_script", "exitCode": n}
  here -> {"type": "pong", "id": "..."}

Each request runs the named helper exactly as the one-shot path does:
``python3 -c <source>`` with the payload on stdin. Nothing is written to the
project directory or to disk; helper stderr is discarded, never relayed.
Stdin EOF ends every running helper and this process.
"""
import json
import os
import signal
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

WORKERS = 4
MAX_LINE = 4 * 1024 * 1024
MAX_LIMIT = 256 * 1024 * 1024
scripts = {}
running = {}
running_lock = threading.Lock()
write_lock = threading.Lock()


def send(message):
    data = json.dumps(message, separators=(',', ':')).encode()
    with write_lock:
        sys.stdout.buffer.write(data + b'\n')
        sys.stdout.buffer.flush()


def kill(process):
    # The helper and any Git or npm children share a session; an already
    # exited group can refuse the signal, so fall back to the process itself.
    for target in (lambda: os.killpg(process.pid, signal.SIGKILL), process.kill):
        try:
            target()
            return
        except (ProcessLookupError, PermissionError):
            continue


def execute(request):
    identifier = request['id']
    script = scripts.get(request.get('script'))
    if script is None:
        return {'type': 'response', 'id': identifier, 'error': 'unknown_script'}
    payload = json.dumps(request.get('payload', {})).encode()
    timeout = min(max(float(request.get('timeoutMs', 30000)) / 1000, 1), 900)
    limit = min(max(int(request.get('limit', 16 * 1024 * 1024)), 1), MAX_LIMIT)
    process = subprocess.Popen([sys.executable, '-c', script], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               start_new_session=True)
    with running_lock:
        running[identifier] = process
    state = {'timeout': False}

    def expire():
        state['timeout'] = True
        kill(process)

    def feed():
        try:
            process.stdin.write(payload)
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    timer = threading.Timer(timeout, expire)
    timer.daemon = True
    timer.start()
    threading.Thread(target=feed, daemon=True).start()
    chunks, size, overflow = [], 0, False
    try:
        while True:
            chunk = process.stdout.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                overflow = True
                kill(process)
                break
            chunks.append(chunk)
        process.stdout.close()
        code = process.wait()
    finally:
        timer.cancel()
        with running_lock:
            running.pop(identifier, None)
    if state['timeout']:
        return {'type': 'response', 'id': identifier, 'error': 'timeout'}
    if overflow:
        return {'type': 'response', 'id': identifier, 'error': 'buffer_limit'}
    if code != 0:
        return {'type': 'response', 'id': identifier, 'error': 'process_failed', 'exitCode': code}
    return {'type': 'response', 'id': identifier,
            'stdout': b''.join(chunks).decode('utf-8', errors='replace')}


def handle(request):
    try:
        send(execute(request))
    except Exception:
        send({'type': 'response', 'id': request.get('id'), 'error': 'process_failed'})


def main():
    executor = ThreadPoolExecutor(max_workers=WORKERS)
    stream = sys.stdin.buffer
    try:
        while True:
            line = stream.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE or not line.endswith(b'\n'):
                raise ValueError('Helper session line exceeds the limit')
            message = json.loads(line)
            kind = message.get('type')
            if kind == 'hello':
                incoming = message.get('scripts', {})
                if not isinstance(incoming, dict) or any(
                        not isinstance(k, str) or not isinstance(v, str) for k, v in incoming.items()):
                    raise ValueError('Invalid helper scripts')
                scripts.update(incoming)
                send({'type': 'ready'})
            elif kind == 'request' and isinstance(message.get('id'), str):
                executor.submit(handle, message)
            elif kind == 'ping' and isinstance(message.get('id'), str):
                send({'type': 'pong', 'id': message['id']})
            else:
                raise ValueError('Unknown helper session message')
    finally:
        with running_lock:
            processes = list(running.values())
        for process in processes:
            kill(process)
        executor.shutdown(wait=False, cancel_futures=True)


if __name__ == '__main__':
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    try:
        main()
    except (ValueError, OSError):
        sys.exit(1)
