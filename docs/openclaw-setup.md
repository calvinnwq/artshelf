# OpenClaw Local Setup

This is the setup path for using Shelf 0.1.0 from a local source checkout in an
OpenClaw workspace. Agents should ask for user-specific paths before running it.

Before installing, ask:

- Where should the Shelf repo be cloned? If the user has no preference, suggest
  `$HOME/repos/shelf`.
- Should this setup run `npm link` so `shelf` is available on PATH? For now,
  this is the only supported install method.

npm publishing is intentionally deferred.

## 1. Install Locally

```bash
set -euo pipefail

: "${SHELF_REPO:?Set SHELF_REPO to the user-approved checkout path, for example $HOME/repos/shelf}"

if [ ! -d "$SHELF_REPO/.git" ]; then
  mkdir -p "$(dirname "$SHELF_REPO")"
  git clone https://github.com/calvinnwq/shelf.git "$SHELF_REPO"
fi

cd "$SHELF_REPO"
git pull --ff-only
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
shelf --version
```

If `shelf --version` does not resolve in the OpenClaw runtime, report the PATH
issue and ask before changing shell profiles or service launch environment.

## 2. Smoke Test Registration

```bash
set -euo pipefail

ARTIFACT="$(mktemp -d /tmp/shelf-openclaw-smoke.XXXXXX)"

shelf put "$ARTIFACT" \
  --reason "OpenClaw local Shelf setup smoke" \
  --ttl 3d \
  --kind run-artifact \
  --cleanup review \
  --owner openclaw \
  --label shelf \
  --label openclaw \
  --json

shelf validate --json
shelf due --json
shelf cleanup --dry-run --json
```

Capture the returned Shelf id in the task summary or memory entry if this smoke
matters later. The cleanup dry-run should produce a plan but must not move files.

## 3. Agent Rules

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

Agents may mark a ledger record manually resolved only after the user confirms
the artifact was inspected, is already missing, or is no longer needed:

```bash
shelf resolve <id> --status resolved --reason <text>
```

Use a specific reason. `resolve` only updates the ledger; it does not move or
delete files.

## 4. Update

```bash
: "${SHELF_REPO:?Set SHELF_REPO to the user-approved checkout path}"
cd "$SHELF_REPO"
git pull --ff-only
pnpm install --frozen-lockfile
pnpm run build
npm link
shelf --version
```
