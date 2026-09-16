"""Fixed maintenance command, executed ONLY inside the allocated Sprite.

Stop managed tmux workloads and release our active-turn hold. The provider API
stops exec sessions/services afterwards. Never read project files or secrets.
"""
import http.client
import json
import os
import socket
import subprocess

for name in ["civic-spark-workspace", "civic-spark-web-preview"]:
    result = subprocess.run(["tmux", "has-session", "-t", name], capture_output=True)
    if result.returncode == 0:
        subprocess.run(["tmux", "kill-session", "-t", name], check=True, capture_output=True)

if os.path.exists('/.sprite/api.sock'):
    class UnixConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(5)
            self.sock.connect('/.sprite/api.sock')

    connection = UnixConnection('sprite')
    connection.request('DELETE', '/v1/tasks/civic-spark-agent')
    response = connection.getresponse()
    response.read()
    if response.status not in [200, 204, 404]:
        raise RuntimeError('Could not release managed activity hold')
    connection.request('GET', '/v1/tasks')
    response = connection.getresponse()
    data = json.loads(response.read(1048576))
    connection.close()
    if response.status != 200 or data.get('tasks'):
        # An unknown task may renew itself. Do not claim all compute has stopped.
        raise RuntimeError('Unmanaged activity holds remain')
