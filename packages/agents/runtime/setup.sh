#!/usr/bin/env bash
# Run inside a Sprite; no agent, credentials, or project commands are involved.
set -euo pipefail
runtime=/home/sprite/.vibehack-agent
mkdir -p "$runtime"
cd "$runtime"
if ! test -f environment.json; then cp environment.defaults.json environment.json; chmod 600 environment.json; fi
exec 9>setup.lock
flock -w 180 9
fingerprint=$(sha256sum package.json package-lock.json setup.sh | sha256sum | cut -d ' ' -f 1)
verify() {
  test "$(node_modules/opencode-ai/bin/opencode.exe --version 2>/dev/null)" = "1.18.31" &&
  node_modules/@anthropic-ai/claude-code/bin/claude.exe --version 2>/dev/null | grep -q '^2\.1\.273 ' &&
  node --input-type=module -e 'await import("@anthropic-ai/claude-agent-sdk"); await import("@opencode-ai/sdk/v2"); await import("zod")'
}
if test "$(cat .installed 2>/dev/null || true)" != "$fingerprint" || ! verify; then
  # A committed lock pins transitive dependencies. Run the known binary installer
  # explicitly so npm's lifecycle policy cannot leave a nonfunctional wrapper.
  npm ci --ignore-scripts --include=optional --no-audit --no-fund
  node node_modules/opencode-ai/postinstall.mjs
  node node_modules/@anthropic-ai/claude-code/install.cjs
  verify || { echo 'Runtime verification failed; no ready marker written.' >&2; exit 1; }
  printf '%s\n' "$fingerprint" > .installed
fi
# Install wrappers after verification. Repoint npm's generated command links too:
# existing tmux shells already have node_modules/.bin in PATH.
mkdir -p "$runtime/bin" /home/sprite/.local/bin
for command in opencode claude; do
  printf '#!/usr/bin/env bash\nexec node --experimental-strip-types /home/sprite/.vibehack-agent/cli.ts %s "$@"\n' "$command" > "$runtime/bin/$command"
  chmod 755 "$runtime/bin/$command"
  ln -sfn "$runtime/bin/$command" "$runtime/node_modules/.bin/$command"
  ln -sfn "$runtime/bin/$command" "/home/sprite/.local/bin/$command"
done
printf '#!/usr/bin/env bash\nexec node --experimental-strip-types /home/sprite/.vibehack-agent/integration-cli.ts "$@"\n' > "$runtime/bin/vibehack"
chmod 755 "$runtime/bin/vibehack"
ln -sfn "$runtime/bin/vibehack" "$runtime/node_modules/.bin/vibehack"
ln -sfn "$runtime/bin/vibehack" /home/sprite/.local/bin/vibehack
test "$("$runtime/bin/opencode" --version 2>/dev/null)" = "1.18.31"
"$runtime/bin/claude" --version 2>/dev/null | grep -q '^2\.1\.273 '
printf 'VibeHack runtime verified: OpenCode 1.18.31; Claude Code 2.1.273\n'
