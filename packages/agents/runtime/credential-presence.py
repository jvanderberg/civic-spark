# Report names only. Never emit credentials, configuration contents or exceptions.
import json
from pathlib import Path

home = Path.home()
providers = []
for provider, path in [
    ("opencode", home / ".local/share/opencode/auth.json"),
    ("claude", home / ".claude/settings.json"),
]:
    try:
        data = json.loads(path.read_text())
        if provider == "opencode":
            auth = data.get("openrouter", {})
            key = auth.get("key") if auth.get("type") == "api" else None
        else:
            key = data.get("env", {}).get("ANTHROPIC_API_KEY")
        if isinstance(key, str) and key.strip():
            providers.append(provider)
    except (OSError, ValueError, AttributeError):
        pass
print(json.dumps({"savedProviders": providers}))
