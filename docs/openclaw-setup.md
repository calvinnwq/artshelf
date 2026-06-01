# OpenClaw Local Setup

This is the copy-paste setup path for using Shelf 0.1.0 from a local source
checkout in an OpenClaw workspace. It is based on Calvin's current layout:

- Shelf repo: `/Users/ngxcalvin/repos/shelf`
- OpenClaw workspace: `/Users/ngxcalvin/.openclaw/workspace`
- Runtime owner label: `openclaw`
- npm publishing: intentionally deferred

## 1. Install From Source

```bash
set -euo pipefail

SHELF_REPO="${SHELF_REPO:-$HOME/repos/shelf}"

if [ ! -d "$SHELF_REPO/.git" ]; then
  mkdir -p "$(dirname "$SHELF_REPO")"
  git clone https://github.com/calvinnwq/shelf.git "$SHELF_REPO"
fi

cd "$SHELF_REPO"
git pull --ff-only
corepack enable
pnpm install --frozen-lockfile
pnpm run build
node dist/src/cli.js --version
```

If you do not want a shell command, stop here and call Shelf explicitly:

```bash
node /Users/ngxcalvin/repos/shelf/dist/src/cli.js --version
```

## 2. Optional Local Shim

This adds a small `shelf` command that points at the local checkout. It does not
install anything from npm.

```bash
set -euo pipefail

mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/shelf" <<'EOF'
#!/usr/bin/env bash
exec node "$HOME/repos/shelf/dist/src/cli.js" "$@"
EOF
chmod +x "$HOME/.local/bin/shelf"

export PATH="$HOME/.local/bin:$PATH"
shelf --version
```

For persistent interactive shells, add this to your shell profile if it is not
already present:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

OpenClaw agents can still use the explicit `node .../dist/src/cli.js` command
when service PATH behavior is uncertain.

## 3. Smoke Test Registration

```bash
set -euo pipefail

SHELF_REPO="${SHELF_REPO:-$HOME/repos/shelf}"
SHELF_CMD="${SHELF_CMD:-node $SHELF_REPO/dist/src/cli.js}"
ARTIFACT="$(mktemp -d /tmp/shelf-openclaw-smoke.XXXXXX)"

$SHELF_CMD put "$ARTIFACT" \
  --reason "OpenClaw local Shelf setup smoke" \
  --ttl 3d \
  --kind run-artifact \
  --cleanup review \
  --owner openclaw \
  --label shelf \
  --label openclaw \
  --json

$SHELF_CMD validate --json
$SHELF_CMD due --json
$SHELF_CMD cleanup --dry-run --json
```

Capture the returned Shelf id in the task summary or memory entry if this smoke
matters later. The cleanup dry-run should produce a plan but must not move files.

## 4. Agent Rules

Agents may run:

```bash
shelf validate --json
shelf due --json
shelf cleanup --dry-run --json
```

Agents must not run this without explicit human approval for the reviewed plan
id:

```bash
shelf cleanup --execute --plan-id <id>
```

Never generate a fresh plan and execute it in the same step.

## 5. Update

```bash
cd /Users/ngxcalvin/repos/shelf
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build
node dist/src/cli.js --version
```
