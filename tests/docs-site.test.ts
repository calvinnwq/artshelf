import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const DOC_PAGES = [
  "docs/index.html",
  "docs/install.html",
  "docs/quickstart.html",
  "docs/agent-usage.html",
  "docs/openclaw.html",
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
    assert.match(html, /href="openclaw\.html"/, page);
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

  for (const text of [readme, install]) {
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/shelf\.git/);
    assert.match(text, /corepack enable/);
    assert.match(text, /pnpm install --frozen-lockfile/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /npm link/);
    assert.match(text, /shelf --version/);
    assert.doesNotMatch(text, /Optional global link|optional local global link/);
  }
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
    assert.match(text, /ledger path/);
    assert.match(text, /plan id/);
    assert.match(text, /Do not scan arbitrary filesystem locations|Do not scan arbitrary filesystem/);
    assert.match(text, /Never\s+schedule|Scheduled jobs must not run/);
    assert.match(text, /shelf cleanup --execute --plan-id/);
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

test("OpenClaw setup docs prompt for path, use npm link, and safe smoke", () => {
  const markdownGuide = read("docs/openclaw-setup.md");
  const page = read("docs/openclaw.html");
  const readme = read("README.md");

  for (const text of [markdownGuide, page]) {
    assert.match(text, /OpenClaw/);
    assert.match(text, /ask|Ask/);
    assert.match(text, /user-approved checkout path|where Shelf should be cloned/);
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/shelf\.git/);
    assert.match(text, /pnpm install --frozen-lockfile/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /npm link/);
    assert.match(text, /shelf --version/);
    assert.doesNotMatch(text, /\/Users\/ngxcalvin\/repos\/shelf/);
    assert.doesNotMatch(text, /\.local\/bin\/shelf/);
    assert.match(text, /OpenClaw local Shelf setup smoke/);
    assert.match(text, /cleanup --dry-run --json/);
    assert.match(text, /cleanup --execute/);
    assert.match(text, /explicit human approval/);
  }

  assert.match(readme, /docs\/openclaw-setup\.md/);
  assert.match(readme, /not published to npm/);
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}
