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

test("install docs cover the local clone, build, and npm link path", () => {
  const readme = read("README.md");
  const install = read("docs/install.html");
  const packageJson = read("package.json");

  for (const text of [readme, install]) {
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/shelf\.git/);
    assert.match(text, /corepack enable/);
    assert.match(text, /pnpm install --frozen-lockfile/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /npm link/);
    assert.match(text, /shelf --version/);
    assert.doesNotMatch(text, /Optional global link|optional local global link/);
  }

  assert.match(readme, /pnpm docs:serve/);
  assert.match(install, /pnpm docs:serve/);
  assert.match(install, /127\.0\.0\.1:8080/);
  assert.match(packageJson, /"docs:serve": "python3 -m http\.server 8080 --bind 127\.0\.0\.1 --directory docs"/);
});

test("docs site explains cleanup approval boundary", () => {
  const pages = DOC_PAGES.map(read).join("\n");
  assert.match(pages, /shelf validate --json/);
  assert.match(pages, /cleanup --dry-run/);
  assert.match(pages, /cleanup --execute --plan-id/);
  assert.match(pages, /explicit human approval|reviewed plan id/);
  assert.match(pages, /V1 refuses physical delete|refuses delete/);
  assert.match(pages, /updates ledger state|updates touched records/);
  assert.match(pages, /review-required/);
  assert.match(pages, /cleanup-refused/);
  assert.match(pages, /shelf list --status active|--status active/);
  assert.match(pages, /shelf find --path|shelf find --path/);
  assert.match(pages, /shelf ledgers add|shelf ledgers list/);
  assert.match(pages, /shelf review --all/);
  assert.match(pages, /cleanup --dry-run --all/);
  assert.match(pages, /not-created/);
  assert.match(pages, /owner=shelf/);
  assert.match(pages, /reuse the existing plan id|reuses the existing plan id/);
  assert.match(pages, /shelf get <id>|shelf get &lt;id&gt;/);
  assert.match(pages, /shelf resolve <id> --status resolved|shelf resolve &lt;id&gt; --status resolved/);
});

test("docs menu keeps the reference section focused on user-facing pages", () => {
  for (const page of DOC_PAGES) {
    const html = read(page);
    assert.doesNotMatch(html, /<a href="https:\/\/github\.com\/calvinnwq\/shelf\/blob\/main\/SPEC\.md">V1 spec<\/a>/, page);
  }
});

test("agent docs define scheduled review without scheduled execution", () => {
  const markdownGuide = read("docs/agent-usage.md");
  const portableSkill = read("skills/shelf/SKILL.md");
  const agentPage = read("docs/agent-usage.html");

  for (const text of [markdownGuide, portableSkill, agentPage]) {
    assert.match(text, /Scheduled Review/);
    assert.match(text, /shelf validate --json/);
    assert.match(text, /shelf due --json/);
    assert.match(text, /shelf cleanup --dry-run --json/);
    assert.match(text, /shelf cleanup --dry-run --all --json/);
    assert.match(text, /shelf review --all --json/);
    assert.match(text, /ledger registry|Ledger Registry/);
    assert.match(text, /ledger path/);
    assert.match(text, /plan id/);
    assert.match(text, /Do not scan arbitrary filesystem locations|Do not scan arbitrary filesystem/);
    assert.match(text, /Never\s+schedule|Scheduled jobs must not run/);
    assert.match(text, /shelf cleanup --execute --plan-id/);
  }
});

test("agent docs define registration triggers and completion checks", () => {
  const markdownGuide = read("docs/agent-usage.md");
  const portableSkill = read("skills/shelf/SKILL.md");
  const agentPage = read("docs/agent-usage.html");

  for (const text of [markdownGuide, portableSkill, agentPage]) {
    assert.match(text, /created,\s+copied,\s+exported,\s+quarantined,\s+backed up,\s+or preserved/);
    assert.match(text, /may outlive/);
    assert.match(text, /eligible artifact/);
    assert.match(text, /skip reason|state why|record a clear skip reason/);
    assert.match(text, /Do not call work done|Before finalizing|Completion Checklist/);
  }
});

test("agent install guidance prompts for paths and avoids unsupported install methods", () => {
  const markdownGuide = read("docs/agent-usage.md");
  const portableSkill = read("skills/shelf/SKILL.md");
  const agentPage = read("docs/agent-usage.html");

  for (const text of [markdownGuide, portableSkill, agentPage]) {
    assert.match(text, /ask|Ask/);
    assert.match(text, /repo path|where the user wants|where to clone|where the Shelf repo/);
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/shelf\.git/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /npm link/);
    assert.doesNotMatch(text, /\/Users\/ngxcalvin\/repos\/shelf/);
    assert.doesNotMatch(text, /node dist\/src\/cli\.js/);
    assert.doesNotMatch(text, /\.local\/bin\/shelf/);
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
    read("skills/shelf/SKILL.md")
  ].join("\n");

  assert.doesNotMatch(docsAndSkill, /OpenClaw|openclaw/);
  assert.doesNotMatch(docsAndSkill, /coding-workflow|coding_workflow|workflow_plan|shelf-register|artifactRetention/);
  assert.doesNotMatch(docsAndSkill, /\/Users\/ngxcalvin|Calvin's/);
  assert.doesNotMatch(docsAndSkill, /\.agent-workflows|\.gnhf|no-mistakes|ShakedownKit|Momentum/);
  assert.match(readme, /not published to npm/);
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}
