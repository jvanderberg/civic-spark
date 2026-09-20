# Streaming collector for civic-spark diagnostic records.
# fly logs --json prints pretty-printed multi-line objects, so decode a
# growing buffer with raw_decode instead of parsing per line. A periodic
# --no-tail snapshot backfills anything the live tail drops; records are
# deduplicated by their full serialized form. Only structured diagnostic
# records (kind == civic-spark.diagnostic) are written.
#
# Usage: python3 collect.py <output.jsonl>     (app: CIVIC_SPARK_FLY_APP, default civic-spark)
# Verify capture before a paid run: hit /api/health and expect an `http` record.
import json, os, pathlib, subprocess, sys, threading, time
path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).with_name('backend.jsonl')
app = os.environ.get('CIVIC_SPARK_FLY_APP', 'civic-spark')
seen = set()
lock = threading.Lock()
decoder = json.JSONDecoder()

def emit(output, envelope):
    message = envelope.get('message', envelope.get('Message', ''))
    data = None
    if isinstance(message, str) and message.startswith('{'):
        try:
            data = json.loads(message)
        except ValueError:
            return
    if isinstance(data, dict) and data.get('kind') == 'civic-spark.diagnostic':
        line = json.dumps(data, separators=(',', ':'), sort_keys=True)
        with lock:
            if line in seen:
                return
            seen.add(line)
            output.write(line + '\n')
            output.flush()

def consume(stream, output):
    buffer = ''
    for chunk in iter(lambda: stream.read(4096), ''):
        buffer += chunk
        while True:
            buffer = buffer.lstrip()
            if not buffer:
                break
            try:
                obj, end = decoder.raw_decode(buffer)
            except ValueError:
                break
            buffer = buffer[end:]
            if isinstance(obj, dict):
                emit(output, obj)

def snapshots(output, stop):
    while not stop.is_set():
        try:
            result = subprocess.run(['fly', 'logs', '-a', app, '--json', '--no-tail'],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=120)
            buffer = result.stdout
            while True:
                buffer = buffer.lstrip()
                if not buffer:
                    break
                try:
                    obj, end = decoder.raw_decode(buffer)
                except ValueError:
                    break
                buffer = buffer[end:]
                if isinstance(obj, dict):
                    emit(output, obj)
        except Exception:
            pass
        stop.wait(45)

with path.open('a', buffering=1) as output:
    path.chmod(0o600)
    for line in path.read_text().splitlines():
        seen.add(line)
    stop = threading.Event()
    thread = threading.Thread(target=snapshots, args=(output, stop), daemon=True)
    thread.start()
    process = subprocess.Popen(['fly', 'logs', '-a', app, '--json'],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        consume(process.stdout, output)
    finally:
        stop.set()
        process.terminate()
        process.wait()
