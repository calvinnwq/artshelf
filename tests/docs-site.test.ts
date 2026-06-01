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

test("install docs cover source install and global link", () => {
  const readme = read("README.md");
  const install = read("docs/install.html");

  for (const text of [readme, install]) {
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/shelf\.git/);
    assert.match(text, /corepack enable/);
    assert.match(text, /pnpm install --frozen-lockfile/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /node dist\/src\/cli\.js --version/);
    assert.match(text, /npm link/);
    assert.match(text, /shelf --version/);
  }
});

test("docs site explains cleanup approval boundary", () => {
  const pages = DOC_PAGES.map(read).join("\n");
  assert.match(pages, /shelf validate --json/);
  assert.match(pages, /cleanup --dry-run/);
  assert.match(pages, /cleanup --execute --plan-id/);
  assert.match(pages, /explicit human approval|reviewed plan id/);
  assert.match(pages, /V1 refuses physical delete|refuses delete/);
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

test("OpenClaw setup docs cover source install, shim, and safe smoke", () => {
  const markdownGuide = read("docs/openclaw-setup.md");
  const page = read("docs/openclaw.html");
  const readme = read("README.md");

  for (const text of [markdownGuide, page]) {
    assert.match(text, /OpenClaw/);
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/shelf\.git/);
    assert.match(text, /pnpm install --frozen-lockfile/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /node dist\/src\/cli\.js --version/);
    assert.match(text, /\.local\/bin\/shelf/);
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
