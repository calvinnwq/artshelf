import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const DOC_PAGES = [
  "docs/index.html",
  "docs/install.html",
  "docs/quickstart.html",
  "docs/agent-usage.html",
  "docs/reference.html"
];

test("docs site pages share the expected chrome", () => {
  for (const page of DOC_PAGES) {
    const html = read(page);
    assert.match(html, /class="global-nav"/, page);
    assert.match(html, /class="nav-scroll"/, page);
    assert.match(html, /data-theme-toggle/, page);
    assert.match(html, /href="site\.css"/, page);
    assert.match(html, /src="theme\.js"/, page);
    assert.match(html, /href="index\.html"/, page);
    assert.match(html, /href="install\.html"/, page);
    assert.match(html, /href="quickstart\.html"/, page);
    assert.match(html, /href="agent-usage\.html"/, page);
    assert.match(html, /href="reference\.html"/, page);
  }
});

test("docs site uses clawpatch-style mobile navigation", () => {
  const css = read("docs/site.css");

  assert.match(css, /@media \(max-width: 960px\)/);
  assert.match(css, /\.nav-scroll\s*\{[\s\S]*display: flex/);
  assert.match(css, /\.nav-scroll\s*\{[\s\S]*overflow-x: auto/);
  assert.match(css, /\.nav-section\s*\{[\s\S]*flex: 0 0 auto/);
  assert.match(css, /\.global-nav a:not\(\.site-mark\)\s*\{[\s\S]*white-space: nowrap/);
  assert.match(css, /\.nav-section-title\s*\{[\s\S]*display: none/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.actions\s*\{[\s\S]*display: grid/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.button,[\s\S]*\.pill\s*\{[\s\S]*width: 100%/);
});

test("docs site contains long code blocks inside the content column", () => {
  const css = read("docs/site.css");

  assert.match(css, /pre\s*\{[\s\S]*max-width: 100%/);
  assert.match(css, /pre\s*\{[\s\S]*min-width: 0/);
  assert.match(css, /pre code\s*\{[\s\S]*width: max-content/);
  assert.match(css, /pre code\s*\{[\s\S]*min-width: 100%/);
  assert.match(css, /article\s*\{[\s\S]*min-width: 0/);
  assert.match(css, /article > section\s*\{[\s\S]*min-width: 0/);
  assert.match(css, /\.docs-content\s*\{[\s\S]*overflow-x: clip/);
});

test("docs site local links resolve inside docs", () => {
  for (const page of DOC_PAGES) {
    const html = read(page);
    const links = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((link): link is string => Boolean(link));
    for (const link of links) {
      if (link.startsWith("http") || link.startsWith("mailto:") || link.startsWith("#")) continue;
      const target = `docs/${link}`;
      assert.equal(existsSync(target), true, `${page} references missing local asset ${link}`);
    }
  }
});

test("install docs cover npm install and source fallback paths", () => {
  const readme = read("README.md");
  const install = read("docs/install.html");
  const packageJson = read("package.json");

  for (const text of [readme, install]) {
    assert.match(text, /npm install -g artshelf/);
    assert.match(text, /pnpm add -g artshelf/);
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/artshelf\.git/);
    assert.match(text, /corepack enable/);
    assert.match(text, /pnpm install --frozen-lockfile/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /npm link/);
    assert.match(text, /artshelf --version/);
    assert.match(text, /artshelf doctor/);
    assert.doesNotMatch(text, /Optional global link|optional local global link/);
  }

  assert.match(packageJson, /"name": "artshelf"/);
  assert.match(packageJson, /"artshelf": "dist\/src\/cli\.js"/);
  assert.match(packageJson, /"shelf": "dist\/src\/cli\.js"/);
  assert.match(packageJson, /"access": "public"/);
  assert.match(readme, /pnpm docs:serve/);
  assert.match(install, /pnpm docs:serve/);
  assert.match(install, /127\.0\.0\.1:8080/);
  assert.match(packageJson, /"docs:serve": "python3 -m http\.server 8080 --bind 127\.0\.0\.1 --directory docs"/);
});

test("docs site explains cleanup approval boundary", () => {
  const pages = DOC_PAGES.map(read).join("\n");
  assert.match(pages, /artshelf validate --json/);
  assert.match(pages, /cleanup --dry-run/);
  assert.match(pages, /cleanup --execute --plan-id/);
  assert.match(pages, /explicit human approval|reviewed plan id/);
  assert.match(pages, /V1 refuses physical delete|refuses delete/);
  assert.match(pages, /updates ledger state|updates touched records/);
  assert.match(pages, /review-required/);
  assert.match(pages, /cleanup-refused/);
  assert.match(pages, /artshelf list --status active|--status active/);
  assert.match(pages, /artshelf find --path|artshelf find --path/);
  assert.match(pages, /artshelf ledgers add|artshelf ledgers list/);
  assert.match(pages, /artshelf review --all/);
  assert.match(pages, /cleanup --dry-run --all/);
  assert.match(pages, /not-created/);
  assert.match(pages, /owner=artshelf/);
  assert.match(pages, /reuse the existing plan id|reuses the existing plan id/);
  assert.match(pages, /artshelf get <id>|artshelf get &lt;id&gt;/);
  assert.match(pages, /artshelf resolve <id> --status resolved|artshelf resolve &lt;id&gt; --status resolved/);
  assert.match(pages, /artshelf trash purge --older-than &lt;ttl&gt; --dry-run \[--ledger/);
  assert.match(pages, /artshelf trash purge --execute --plan-id &lt;id&gt; \[--ledger/);
});

test("docs menu keeps the reference section focused on user-facing pages", () => {
  for (const page of DOC_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /<a href="https:\/\/github\.com\/calvinnwq\/artshelf\/blob\/main\/SPEC\.md">V1 spec<\/a>/, page);
  }
});

test("agent docs define scheduled review without scheduled execution", () => {
  const markdownGuide = read("docs/agent-usage.md");
  const portableSkill = read("skills/artshelf/SKILL.md");
  const agentPage = read("docs/agent-usage.html");

  for (const text of [markdownGuide, portableSkill, agentPage]) {
    assert.match(text, /Scheduled Review/);
    assert.match(text, /artshelf validate --json/);
    assert.match(text, /artshelf due --json/);
    assert.match(text, /artshelf cleanup --dry-run --json/);
    assert.match(text, /artshelf cleanup --dry-run --all --json/);
    assert.match(text, /artshelf review --all --json/);
    assert.match(text, /ledger registry|Ledger Registry/);
    assert.match(text, /ledger path/);
    assert.match(text, /plan id/);
    assert.match(text, /Do not scan arbitrary filesystem locations|Do not scan arbitrary filesystem/);
    assert.match(text, /Never\s+schedule|Scheduled jobs must not run/);
    assert.match(text, /artshelf cleanup --execute --plan-id/);
  }
});

test("agent docs turn daily reviews into decision packets", () => {
  const markdownGuide = read("docs/agent-usage.md");
  const portableSkill = read("skills/artshelf/SKILL.md");
  const agentPage = read("docs/agent-usage.html");

  for (const text of [markdownGuide, portableSkill, agentPage]) {
    assert.match(text, /Daily Review Workflow/);
    assert.match(text, /decision packet/);
    assert.match(text, /trash-safe/);
    assert.match(text, /needs-human-review/);
    assert.match(text, /resolve-candidate/);
    assert.match(text, /registry-problem/);
    assert.match(text, /approve artshelf cleanup ledger/);
    assert.match(text, /read-only preview id/);
    assert.match(text, /verify quiet|verify with `artshelf review --all --json`/);
  }
});

test("agent docs define registration triggers and completion checks", () => {
  const markdownGuide = read("docs/agent-usage.md");
  const portableSkill = read("skills/artshelf/SKILL.md");
  const agentPage = read("docs/agent-usage.html");
  const finalizationTrigger = /before .*(final|finaliz|handoff|done|status)/i;

  for (const text of [markdownGuide, portableSkill, agentPage]) {
    assert.match(text, finalizationTrigger);
    assert.match(text, /created,\s+copied,\s+exported,\s+quarantined,\s+backed up,\s+or preserved/);
    assert.match(text, /may outlive/);
    assert.match(text, /eligible artifact/);
    assert.match(text, /skip reason|state why|record a clear skip reason/);
    assert.match(text, /Do not call work done|Before finalizing|Completion Checklist/);
  }
});

test("portable skill description exposes the completion gate", () => {
  const portableSkill = read("skills/artshelf/SKILL.md");
  const description = portableSkill.split("\n").slice(0, 4).join("\n");

  assert.match(description, /before any final response/i);
  assert.match(description, /status update/i);
  assert.match(description, /handoff/i);
  assert.match(description, /done report/i);
  assert.match(description, /outlive the command/i);
});

test("agent install guidance prompts for paths and avoids unsupported install methods", () => {
  const markdownGuide = read("docs/agent-usage.md");
  const portableSkill = read("skills/artshelf/SKILL.md");
  const agentPage = read("docs/agent-usage.html");

  for (const text of [markdownGuide, portableSkill, agentPage]) {
    assert.match(text, /ask|Ask/);
    assert.match(text, /repo path|where the user wants|where to clone|where the Artshelf repo/);
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/artshelf\.git/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /npm link/);
    assert.doesNotMatch(text, /\/Users\/ngxcalvin\/repos\/artshelf/);
    assert.doesNotMatch(text, /node dist\/src\/cli\.js/);
    assert.doesNotMatch(text, /\.local\/bin\/artshelf/);
  }
});

test("docs and portable skill stay workflow-agnostic", () => {
  const readme = read("README.md");
  const docsAndSkill = [
    readme,
    read("SPEC.md"),
    read("docs/agent-usage.md"),
    read("docs/index.html"),
    read("docs/install.html"),
    read("docs/quickstart.html"),
    read("docs/agent-usage.html"),
    read("docs/reference.html"),
    read("skills/artshelf/SKILL.md")
  ].join("\n");

  assert.doesNotMatch(docsAndSkill, /OpenClaw|openclaw/);
  assert.doesNotMatch(docsAndSkill, /coding-workflow|coding_workflow|workflow_plan|artshelf-register|artifactRetention/);
  assert.doesNotMatch(docsAndSkill, /\/Users\/ngxcalvin|Calvin's/);
  assert.doesNotMatch(docsAndSkill, /\.agent-workflows|\.gnhf|no-mistakes|ShakedownKit|Momentum/);
  assert.match(readme, /npm install -g artshelf/);
  assert.match(readme, /pnpm add -g artshelf/);
});

test("README and quickstart lead with the three core workflows", () => {
  const readme = read("README.md");
  const quickstart = read("docs/quickstart.html");

  const workflows = [
    "Register a temp artifact",
    "Review everything safely",
    "Approve cleanup safely"
  ];

  // README centers a dedicated core-workflows section that names all three.
  assert.match(readme, /##\s+Core Workflows/);
  for (const workflow of workflows) {
    assert.ok(readme.includes(workflow), `README is missing core workflow "${workflow}"`);
  }

  // The core workflows lead: they precede the reference-heavy sections.
  const coreIdx = readme.indexOf("## Core Workflows");
  const ledgersIdx = readme.indexOf("## Explicit Ledgers");
  const commandsIdx = readme.indexOf("## Commands");
  assert.ok(coreIdx > -1, "README should have a Core Workflows section");
  assert.ok(
    ledgersIdx > coreIdx,
    "Core Workflows should lead the Explicit Ledgers reference"
  );
  assert.ok(
    commandsIdx > coreIdx,
    "Core Workflows should lead the Commands reference"
  );

  // Reference detail stays available, just below the first-run lead.
  assert.match(readme, /## Explicit Ledgers/);
  assert.match(readme, /## Commands/);

  // The three workflows appear in README in their canonical order.
  let readmeCursor = -1;
  for (const workflow of workflows) {
    const idx = readme.indexOf(workflow);
    assert.ok(idx > readmeCursor, `README workflows out of order at "${workflow}"`);
    readmeCursor = idx;
  }

  // The docs quickstart leads with the same three workflows in the same order.
  let quickstartCursor = -1;
  for (const workflow of workflows) {
    const idx = quickstart.indexOf(workflow);
    assert.ok(idx > -1, `quickstart is missing core workflow "${workflow}"`);
    assert.ok(idx > quickstartCursor, `quickstart workflows out of order at "${workflow}"`);
    quickstartCursor = idx;
  }
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}
