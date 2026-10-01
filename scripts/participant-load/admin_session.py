# Admin session for the load-test scripts. Owners and event admins sign in with an
# emailed code, demo mode included. The code is read from the file named by
# CIVIC_SPARK_LOAD_ADMIN_CODE_FILE when set (polled, then deleted), otherwise from a
# prompt. Requests carry the site's Origin, as a browser's would.
import http.cookiejar
import json
import os
import time
import urllib.error
import urllib.request


def read_code(email):
    path = os.environ.get("CIVIC_SPARK_LOAD_ADMIN_CODE_FILE")
    if not path:
        return "".join(c for c in input(f"Sign-in code emailed to {email}: ") if c.isdigit())
    print(f"Waiting for the code emailed to {email} in {path}", flush=True)
    deadline = time.time() + 600
    while time.time() < deadline:
        if os.path.exists(path):
            with open(path) as handle:
                code = handle.read()
            os.remove(path)
            return "".join(c for c in code if c.isdigit())
        time.sleep(1)
    raise SystemExit("No sign-in code arrived within 10 minutes")


class AdminSession:
    def __init__(self, origin, email):
        self.origin = origin
        self.email = email
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def call(self, path, method="GET", body=None, timeout=600):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"origin": self.origin}
        if data is not None:
            headers["content-type"] = "application/json"
        request = urllib.request.Request(self.origin + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                text = response.read().decode()
                return response.status, (json.loads(text) if text else None)
        except urllib.error.HTTPError as error:
            text = error.read().decode()
            try:
                return error.code, json.loads(text)
            except ValueError:
                return error.code, {"error": text[:200]}

    def sign_in(self):
        _, session = self.call("/api/session")
        if (session or {}).get("authMode") == "demo":
            status, body = self.call("/api/demo/sign-in", "POST", {"email": self.email, "name": ""})
            if status != 200:
                raise SystemExit(f"Demo sign-in failed: {status} {body}")
            if not (body or {}).get("codeSent"):
                return  # A local site without owners signs in directly.
        else:
            status, body = self.call(
                "/api/auth/sign-in/magic-link",
                "POST",
                {"email": self.email, "callbackURL": self.origin, "errorCallbackURL": self.origin},
            )
            if status != 200:
                raise SystemExit(f"Could not send a sign-in code: {status} {body}")
        status, body = self.call(
            "/api/auth/sign-in/email-otp", "POST", {"email": self.email, "otp": read_code(self.email)}
        )
        if status != 200:
            raise SystemExit(f"Code sign-in failed: {status} {body}")

    def sign_out(self):
        self.call("/api/auth/sign-out", "POST", {})
