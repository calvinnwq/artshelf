# Artshelf agent setup

These instructions are written for a coding agent. If you are a human, paste
this one line into your agent and let it do the rest:

> Follow the instructions in
> https://github.com/calvinnwq/artshelf/blob/main/INSTALL.md
> to set up Artshelf in this workspace.

## 1. Install the CLI

Check whether it is already installed before changing anything:

```bash
artshelf --version
artshelf doctor
```

If the command is missing, install it from npm and verify again:

```bash
npm install -g artshelf      # or: pnpm add -g artshelf
artshelf --version
artshelf doctor
```

If Artshelf says a newer version is available and you used npm, update the npm
install and verify again:

```bash
artshelf update
artshelf --version
artshelf doctor
```

If you used pnpm, update with `pnpm add -g artshelf@latest` instead.

Only use a source install when the user asks for one, and ask the user where
to clone the repo first instead of assuming a repo path:

```bash
git clone https://github.com/calvinnwq/artshelf.git "$ARTSHELF_REPO"
cd "$ARTSHELF_REPO"
corepack enable
pnpm install --frozen-lockfile
pnpm run build
npm link
artshelf --version
artshelf doctor
```

## 2. Install the portable skill, including its script

Install, copy, or reference the portable skill so you register temporary
artifacts when you create them and check the shelf before handoffs. Copy the
whole `skills/artshelf` directory, not just SKILL.md: the skill ships with
`scripts/render-review-report.mjs` (the deterministic review report renderer)
plus its `schemas/` and `examples/`, and those must travel together.

```bash
# from the installed npm package
rm -rf <your-skills-dir>/artshelf
cp -R "$(npm root -g)/artshelf/skills/artshelf" <your-skills-dir>/

# or from a source checkout
rm -rf <your-skills-dir>/artshelf
cp -R "$ARTSHELF_REPO/skills/artshelf" <your-skills-dir>/
```

Re-run the replacement copy after upgrading the package so the skill and
script stay in sync with the CLI.

## 3. Register existing ledgers

`artshelf put` registers its ledger automatically. Register any existing
project ledgers so `--all` commands can see them:

```bash
artshelf ledgers add --ledger <repo>/.artshelf/ledger.jsonl --name <project> --scope repo --json
artshelf ledgers list --json
```

## 4. Scheduled review (ask the user first)

Ask the user whether they want a scheduled review job before creating one.
If they approve, schedule a read-only review job (daily works well) in your
host runtime that runs:

```bash
artshelf review --all --json
```

and reports what needs attention. Scheduled jobs are review and report only:
never schedule `artshelf cleanup --execute` or `artshelf trash purge
--execute`.

## 5. Verify and report

Finish by showing the user the output of:

```bash
artshelf doctor
artshelf ledgers list --json
```
