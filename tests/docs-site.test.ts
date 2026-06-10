import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { test } from "node:test";

const DOC_PAGES = [
  "docs/index.html",
  "docs/install.html",
  "docs/quickstart.html",
  "docs/agent-usage.html",
  "docs/agent-create.html",
  "docs/agent-monitor.html",
  "docs/agent-review.html",
  "docs/agent-clean.html",
  "docs/reference.html"
];

test("docs site pages share the expected chrome", () => {
  for (const page of DOC_PAGES) {
    const html = read(page);
    const name = page.replace("docs/", "");
    assert.match(html, /class="masthead"/, page);
    assert.match(html, /class="brand" href="index\.html"/, page);
    assert.match(html, /data-theme-toggle/, page);
    assert.match(html, /data-search-open/, page);
    assert.match(html, /href="site\.css"/, page);
    assert.match(html, /src="site\.js" defer/, page);
    assert.match(html, /artshelf-docs-theme/, page);
    assert.match(html, /try\{stored=localStorage\.getItem\("artshelf-docs-theme"\);/, page);
    assert.doesNotMatch(html, /dataset\.theme=localStorage\.getItem/, page);
    assert.match(html, new RegExp(`<body data-page="${name.replace(".", "\\.")}"`), page);
    assert.match(html, /<nav id="sidebar" class="sidebar" aria-label="Documentation">/, page);
    assert.match(html, /<nav id="toc" aria-label="On this page">/, page);
    assert.match(html, /<footer class="pager" id="pager">/, page);
    assert.match(html, /<a class="skip" href="#content">/, page);
    assert.doesNotMatch(html, /redesign|preview-flag/i, page);
  }
});

test("navigation manifest covers every page in numbered reading order", () => {
  const js = read("docs/site.js");

  for (const page of DOC_PAGES) {
    const name = page.replace("docs/", "");
    assert.match(js, new RegExp(`h: "${name.replace(".", "\\.")}"`), name);
  }
  for (const n of ["01", "02", "03", "04", "4.1", "4.2", "4.3", "4.4", "05"]) {
    assert.match(js, new RegExp(`n: "${n.replace(".", "\\.")}"`), n);
  }
  assert.match(js, /setAttribute\("aria-current", "page"\)/);
  assert.match(js, /THEME_KEY = "artshelf-docs-theme"/);
  assert.match(js, /artshelf-docs-index-v1/);
  assert.doesNotMatch(js, /redesign/i);
});

test("docs chrome renders when web storage is unavailable", () => {
  const clickHandlers: Array<(event: { target: { closest: (selector: string) => unknown } }) => void> = [];
  const makeElement = (tagName = "div"): any => {
    const el: any = {
      tagName: tagName.toUpperCase(),
      childNodes: [{ textContent: "" }],
      children: [],
      classList: {
        add() {},
        remove() {},
        contains() { return false; },
        toggle() { return true; }
      },
      addEventListener() {},
      appendChild(child: unknown) {
        this.children.push(child);
        return child;
      },
      setAttribute() {}
    };
    return el;
  };
  const sidebar = makeElement("nav");
  const pager = makeElement("footer");
  const document: any = {
    body: {
      dataset: { page: "index.html" },
      classList: { remove() {}, contains() { return false; }, toggle() { return true; } },
      appendChild() {}
    },
    documentElement: { dataset: {}, scrollHeight: 1000 },
    addEventListener(type: string, handler: (event: { target: { closest: (selector: string) => unknown } }) => void) {
      if (type === "click") clickHandlers.push(handler);
    },
    createElement: makeElement,
    createTextNode(textContent: string) {
      return { textContent };
    },
    getElementById(id: string) {
      return id === "sidebar" ? sidebar : id === "pager" ? pager : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const window = {
    localStorage: {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); }
    },
    matchMedia() {
      return { matches: true };
    },
    addEventListener() {},
    innerHeight: 800,
    scrollY: 0
  };

  assert.doesNotThrow(() => {
    const runSite = new Function("document", "window", "navigator", "setTimeout", read("docs/site.js"));
    runSite(document, window, {}, setTimeout);
  });
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.ok(sidebar.children.length > 0, "sidebar should render without storage");

  assert.doesNotThrow(() => {
    for (const handler of clickHandlers) {
      handler({
        target: {
          closest(selector: string) {
            return selector === "[data-theme-toggle]" ? {} : null;
          }
        }
      });
    }
  });
  assert.equal(document.documentElement.dataset.theme, "light");
});

test("docs search cache uses guarded session storage", () => {
  const js = read("docs/site.js");

  assert.match(js, /var INDEX_KEY = "artshelf-docs-index-v1"/);
  assert.match(js, /var INDEX = null;\s*var INDEX_PROMISE = null;/);
  assert.match(js, /if \(INDEX_PROMISE\) return INDEX_PROMISE/);
  assert.match(js, /getStorageItem\("sessionStorage", INDEX_KEY\)/);
  assert.match(js, /function isSearchIndex\(value\) \{\s*return Array\.isArray\(value\) && value\.every\(isSearchEntry\);/);
  assert.match(js, /var parsed = JSON\.parse\(cached\);\s*if \(isSearchIndex\(parsed\)\) \{\s*INDEX = parsed;/);
  assert.match(js, /setStorageItem\("sessionStorage", INDEX_KEY, JSON\.stringify\(INDEX\)\)/);
  assert.match(js, /if \(paletteInput && paletteInput\.value !== capturedQuery\) return/);
  assert.doesNotMatch(js, /sessionStorage\.getItem/);
});

test("agent workflow navigation is a visible child hierarchy", () => {
  const js = read("docs/site.js");
  const css = read("docs/site.css");

  assert.match(
    js,
    /t: "Agent usage", h: "agent-usage\.html",\s*children: \[\s*\{ n: "4\.1", t: "Create", h: "agent-create\.html" \},\s*\{ n: "4\.2", t: "Monitor", h: "agent-monitor\.html" \},\s*\{ n: "4\.3", t: "Review", h: "agent-review\.html" \},\s*\{ n: "4\.4", t: "Clean", h: "agent-clean\.html" \}\s*\]/
  );
  assert.match(css, /\.sidebar \.children\s*\{[\s\S]*?border-left: 1px solid var\(--rule\)/);
  assert.doesNotMatch(css, /\.sidebar \.children\s*\{[^}]*display: none/);
});

test("docs site collapses to a mobile drawer", () => {
  const css = read("docs/site.css");
  const js = read("docs/site.js");

  assert.match(css, /@media \(max-width: 880px\)/);
  assert.match(css, /@media \(max-width: 880px\)[\s\S]*\.menu-btn \{ display: inline-flex; \}/);
  assert.match(css, /@media \(max-width: 880px\)[\s\S]*\.sidebar \{\s*position: fixed/);
  assert.match(css, /body\.nav-open \.sidebar \{ transform: none; \}/);
  assert.match(js, /classList\.toggle\("nav-open"\)/);
  assert.match(js, /aria-expanded/);
});

test("docs site uses ledger visual components instead of dense prose only", () => {
  const css = read("docs/site.css");

  for (const selector of [
    "ledger-row",
    "cmdline",
    "boundary-list",
    "stamp",
    "def-rows",
    "callout",
    "kicker",
    "lede",
    "copy-btn",
    "palette"
  ]) {
    assert.match(css, new RegExp(`\\.${selector}`), selector);
  }

  const overview = read("docs/index.html");
  const agentHub = read("docs/agent-usage.html");
  assert.match(overview, /class="ledger"/);
  assert.match(overview, /class="stamp refused"/);
  assert.match(agentHub, /class="ledger"/);
  assert.match(agentHub, /class="boundary-list"/);
  assert.match(read("docs/agent-create.html"), /data-kind="boundary"/);
  assert.match(read("docs/agent-monitor.html"), /class="stamp readonly"/);
  assert.match(read("docs/agent-clean.html"), /class="boundary-list"/);
  assert.match(read("docs/reference.html"), /class="cmd-head"/);
});

test("docs site contains long code blocks inside the content column", () => {
  const css = read("docs/site.css");

  assert.match(css, /pre\s*\{[\s\S]*?overflow-x: auto/);
  assert.match(css, /pre code\s*\{[\s\S]*?white-space: pre/);
  assert.match(css, /\.article-col \{ min-width: 0; max-width: 70ch; \}/);
});

test("docs site local links resolve inside docs", () => {
  const docsRoot = resolve("docs");

  for (const page of DOC_PAGES) {
    const html = read(page);
    const links = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((link): link is string => Boolean(link));
    for (const link of links) {
      if (link.startsWith("http") || link.startsWith("mailto:") || link.startsWith("#")) continue;
      const target = resolve(dirname(page), link.split("#")[0] ?? link);
      const docsRelativePath = relative(docsRoot, target);
      assert.equal(
        !docsRelativePath.startsWith("..") && !isAbsolute(docsRelativePath),
        true,
        `${page} references local asset outside docs ${link}`
      );
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
  assert.doesNotMatch(packageJson, /"shelf": "dist\/src\/cli\.js"/);
  assert.match(packageJson, /"access": "public"/);
  assert.match(packageJson, /"prepack": "pnpm run build"/);
  assert.match(packageJson, /"prepublishOnly": "pnpm run build"/);
  assert.match(readme, /pnpm docs:serve/);
  assert.doesNotMatch(install, /Preview Docs Locally|pnpm docs:serve/);
  assert.match(packageJson, /"docs:serve": "python3 -m http\.server 8080 --bind 127\.0\.0\.1 --directory docs"/);
});

test("release workflow publishes npm only after release creation", () => {
  const workflow = read(".github/workflows/release-please.yml");

  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /id: release/);
  assert.match(workflow, /release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}/);
  assert.match(workflow, /if: \$\{\{ needs\.release-please\.outputs\.release_created == 'true' \}\}/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org\//);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm check/);
  assert.match(workflow, /npm publish --access public/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test("docs site explains cleanup approval boundary", () => {
  const pages = DOC_PAGES.map(read).join("\n");
  assert.match(pages, /artshelf validate --json/);
  assert.match(pages, /cleanup --dry-run/);
  assert.match(pages, /cleanup --execute --plan-id/);
  assert.match(pages, /explicit human approval|reviewed plan id/);
  assert.match(pages, /Delete is refused|refuses delete/);
  assert.match(pages, /updates ledger state|updates touched ledger records/);
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

test("public docs use Artshelf storage names", () => {
  const docsText = [
    ...DOC_PAGES.map(read),
    read("docs/agent-usage.md")
  ].join("\n");

  assert.doesNotMatch(docsText, /\.shelf/);
  assert.doesNotMatch(docsText, /(?:^|[^A-Z])SHELF_REGISTRY|(?:^|[^A-Z])SHELF_NOW/);
  assert.match(docsText, /\.artshelf/);
});

test("agent docs define scheduled review without scheduled execution", () => {
  const portableSkill = read("skills/artshelf/SKILL.md");
  const monitorPage = read("docs/agent-monitor.html");

  for (const text of [portableSkill, monitorPage]) {
    assert.match(text, /Scheduled [Rr]eview/);
    assert.match(text, /artshelf validate --json/);
    assert.match(text, /artshelf due --json/);
    assert.match(text, /artshelf cleanup --dry-run --json/);
    assert.match(text, /artshelf cleanup --dry-run --all --json/);
    assert.match(text, /artshelf review --all --json/);
    assert.match(text, /[Ll]edger [Rr]egistry/);
    assert.match(text, /ledger path/);
    assert.match(text, /plan id/);
    assert.match(text, /Do not scan arbitrary filesystem locations|Do not scan arbitrary filesystem/);
    assert.match(text, /Never\s+schedule|Scheduled jobs must not run/);
    assert.match(text, /artshelf cleanup --execute --plan-id/);
  }
});

test("agent docs turn daily reviews into decision packets", () => {
  const portableSkill = read("skills/artshelf/SKILL.md");
  const reviewPage = read("docs/agent-review.html");

  for (const text of [portableSkill, reviewPage]) {
    assert.match(text, /Daily [Rr]eview [Ww]orkflow/);
    assert.match(text, /decision packet/);
    assert.match(text, /trash-safe/);
    assert.match(text, /needs-human-review/);
    assert.match(text, /resolve-candidate/);
    assert.match(text, /registry-problem/);
    assert.match(text, /approve artshelf cleanup ledger/);
    assert.match(text, /Review [Pp]lan [Rr]eport [Ss]chema/);
    assert.match(text, /ArtshelfReviewReport/);
    assert.match(text, /schemas\/artshelf-review-report\.schema\.json/);
    assert.match(text, /examples\/artshelf-review-report\.json/);
    assert.match(text, /compact decision card/);
    assert.match(text, /decisionSummary/);
    assert.match(text, /decisionGroups/);
    assert.match(text, /Emojis\s+are encouraged/);
    assert.match(text, /Artshelf daily review/);
    assert.match(text, /Ready for approval/);
    assert.match(text, /Needs review first/);
    assert.match(text, /Blocked/);
    assert.match(text, /Why:/);
    assert.match(text, /Action:/);
    assert.match(text, /Suggested next step:/);
    assert.match(text, /Dry-run only\. No execute, resolve, or delete ran/);
    assert.match(text, /Do not paste the whole packet into chat unless the user\s+asks for it/);
    assert.match(text, /exact approval target in the message body as a fallback/);
    assert.match(text, /approve artshelf resolve missing ledger/);
    assert.match(text, /read-only preview id/);
    assert.match(text, /verify quiet|verify with `artshelf review --all --json`/);
  }
});

test("portable skill stays concise and delegates deterministic review rendering", () => {
  const portableSkill = read("skills/artshelf/SKILL.md");
  const lineCount = portableSkill.trimEnd().split("\n").length;

  assert.ok(lineCount <= 260, `portable skill should stay concise, got ${lineCount} lines`);
  assert.match(portableSkill, /scripts\/render-review-report\.mjs/);

  const renderResult = spawnSync(
    process.execPath,
    ["skills/artshelf/scripts/render-review-report.mjs", "examples/artshelf-review-report.json"],
    { cwd: process.cwd(), encoding: "utf8" }
  );
  assert.equal(renderResult.status, 0, renderResult.stderr);
  const rendered = renderResult.stdout;

  assert.match(rendered, /Artshelf daily review/);
  assert.match(rendered, /Status: attention; registry ok/);
  assert.match(rendered, /Ready for approval: 2/);
  assert.match(rendered, /Needs review first: 1/);
  assert.match(rendered, /Blocked: 0/);
  assert.match(rendered, /approve artshelf cleanup ledger .* plan plan_/);
  assert.match(rendered, /approve artshelf resolve missing ledger .* ids shf_/);
  assert.match(rendered, /Suggested next step: Inspect the path/);
  assert.match(rendered, /Dry-run only\. No execute, resolve, or delete ran\./);
});

test("review report renderer rejects malformed decision groups", () => {
  const example = JSON.parse(read("examples/artshelf-review-report.json"));

  for (const key of ["readyForApproval", "needsReviewFirst", "blocked"]) {
    const malformed = structuredClone(example);
    malformed.decisionGroups[key] = {};
    const renderResult = spawnSync(
      process.execPath,
      ["skills/artshelf/scripts/render-review-report.mjs", "-"],
      { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(malformed) }
    );

    assert.equal(renderResult.status, 1, `${key} should be required as an array`);
    assert.match(renderResult.stderr, new RegExp(`missing array decisionGroups\\.${key}`));
  }
});

test("review report renderer rejects malformed approval decisions", () => {
  const example = JSON.parse(read("examples/artshelf-review-report.json"));
  const cases = [
    ["label", /missing string decisionGroups\.readyForApproval\.0\.label/],
    ["reason", /missing string decisionGroups\.readyForApproval\.0\.reason/],
    ["nextStep", /missing string decisionGroups\.readyForApproval\.0\.nextStep/],
    ["actionType", /missing string decisionGroups\.readyForApproval\.0\.actionType/],
    ["approvalTarget", /missing string decisionGroups\.readyForApproval\.0\.approvalTarget/]
  ] as const;

  for (const [field, message] of cases) {
    const malformed = structuredClone(example);
    delete malformed.decisionGroups.readyForApproval[0][field];
    const renderResult = spawnSync(
      process.execPath,
      ["skills/artshelf/scripts/render-review-report.mjs", "-"],
      { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(malformed) }
    );

    assert.equal(renderResult.status, 1, `${field} should be required`);
    assert.match(renderResult.stderr, message);
  }
});

test("review report renderer rejects mismatched approval targets", () => {
  const example = JSON.parse(read("examples/artshelf-review-report.json"));
  const cases = [
    ["cleanup", "approve artshelf resolve missing ledger /tmp/ledger.jsonl ids shf_123"],
    ["trash-purge", "approve artshelf cleanup ledger /tmp/ledger.jsonl plan plan_123"],
    ["resolve-missing", "approve artshelf trash purge ledger /tmp/ledger.jsonl plan purge_123"]
  ] as const;

  for (const [actionType, approvalTarget] of cases) {
    const malformed = structuredClone(example);
    malformed.decisionGroups.readyForApproval[0].actionType = actionType;
    malformed.decisionGroups.readyForApproval[0].approvalTarget = approvalTarget;
    const renderResult = spawnSync(
      process.execPath,
      ["skills/artshelf/scripts/render-review-report.mjs", "-"],
      { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(malformed) }
    );

    assert.equal(renderResult.status, 1, `${actionType} should require a matching approval target`);
    assert.match(renderResult.stderr, /invalid approvalTarget decisionGroups\.readyForApproval\.0\.approvalTarget/);
  }
});

test("review report renderer derives visible counts and requires recommendation", () => {
  const example = JSON.parse(read("examples/artshelf-review-report.json"));
  const mismatchedSummary = structuredClone(example);
  mismatchedSummary.decisionSummary.readyForApproval = 0;
  mismatchedSummary.decisionSummary.needsReviewFirst = 0;
  mismatchedSummary.decisionSummary.blocked = 4;

  const renderResult = spawnSync(
    process.execPath,
    ["skills/artshelf/scripts/render-review-report.mjs", "-"],
    { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(mismatchedSummary) }
  );

  assert.equal(renderResult.status, 0, renderResult.stderr);
  assert.match(renderResult.stdout, /Ready for approval: 2/);
  assert.match(renderResult.stdout, /Needs review first: 1/);
  assert.match(renderResult.stdout, /Blocked: 0/);

  const missingRecommendation = structuredClone(example);
  delete missingRecommendation.recommendation;
  const missingResult = spawnSync(
    process.execPath,
    ["skills/artshelf/scripts/render-review-report.mjs", "-"],
    { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(missingRecommendation) }
  );

  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /missing string recommendation/);
});

test("review report renderer requires execute-all refusal in safety line", () => {
  const example = JSON.parse(read("examples/artshelf-review-report.json"));

  const missingFlag = structuredClone(example);
  delete missingFlag.safety.executeAllRefused;
  const missingResult = spawnSync(
    process.execPath,
    ["skills/artshelf/scripts/render-review-report.mjs", "-"],
    { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(missingFlag) }
  );

  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /missing boolean safety\.executeAllRefused/);

  const notRefused = structuredClone(example);
  notRefused.safety.executeAllRefused = false;
  const notRefusedResult = spawnSync(
    process.execPath,
    ["skills/artshelf/scripts/render-review-report.mjs", "-"],
    { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(notRefused) }
  );

  assert.equal(notRefusedResult.status, 0, notRefusedResult.stderr);
  assert.match(notRefusedResult.stdout, /Attention: safety flags show a mutation may have run\./);
});

test("review report renderer can be imported without running the CLI", () => {
  const importResult = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { renderReviewReport } from './skills/artshelf/scripts/render-review-report.mjs'; console.log(typeof renderReviewReport);"
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(importResult.status, 0, importResult.stderr);
  assert.equal(importResult.stdout.trim(), "function");
});

test("review report schema and example define the deterministic packet", () => {
  const packageJson = JSON.parse(read("package.json"));
  const schema = JSON.parse(read("schemas/artshelf-review-report.schema.json"));
  const example = JSON.parse(read("examples/artshelf-review-report.json"));

  assert.equal(
    read("docs/schemas/artshelf-review-report.schema.json"),
    read("schemas/artshelf-review-report.schema.json")
  );
  assert.equal(
    read("docs/examples/artshelf-review-report.json"),
    read("examples/artshelf-review-report.json")
  );
  assert.equal(
    read("skills/artshelf/schemas/artshelf-review-report.schema.json"),
    read("schemas/artshelf-review-report.schema.json")
  );
  assert.equal(
    read("skills/artshelf/examples/artshelf-review-report.json"),
    read("examples/artshelf-review-report.json")
  );
  assert.equal(packageJson.files.includes("schemas"), true);
  assert.equal(packageJson.files.includes("examples"), true);
  assert.equal(packageJson.files.includes("skills"), true);

  assert.equal(schema.title, "ArtshelfReviewReport");
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "scope",
    "decisionSummary",
    "decisionGroups",
    "summary",
    "recommendation",
    "items",
    "alternatives",
    "safety",
    "verification"
  ]);
  assert.deepEqual(schema.properties.decisionSummary.required, [
    "readyForApproval",
    "needsReviewFirst",
    "blocked"
  ]);
  assert.deepEqual(schema.properties.scope.required, [
    "registryPath",
    "ledgerCount",
    "health",
    "registryHealth"
  ]);
  assert.deepEqual(schema.properties.decisionGroups.required, [
    "readyForApproval",
    "needsReviewFirst",
    "blocked"
  ]);
  assert.deepEqual(schema.properties.decisionGroups.properties.readyForApproval.items, {
    "$ref": "#/$defs/approvalDecision"
  });
  assert.deepEqual(schema.properties.decisionGroups.properties.needsReviewFirst.items, {
    "$ref": "#/$defs/nonApprovalDecision"
  });
  assert.deepEqual(schema.properties.decisionGroups.properties.blocked.items, {
    "$ref": "#/$defs/nonApprovalDecision"
  });
  assert.deepEqual(schema.properties.plans.items, { "$ref": "#/$defs/plan" });
  assert.deepEqual(schema.properties.items.items, { "$ref": "#/$defs/item" });
  assert.deepEqual(schema.$defs.approvalDecision.allOf[1].properties.actionType.enum, [
    "cleanup",
    "trash-purge",
    "resolve-missing"
  ]);
  assert.deepEqual(schema.$defs.nonApprovalDecision.allOf[1].properties.actionType.enum, [
    "inspect",
    "fix-registry",
    "keep-or-snooze",
    "change-retention"
  ]);
  assert.equal(schema.$defs.nonApprovalDecision.allOf[1].properties.approvalTarget.type, "null");
  assert.match(
    schema.$defs.approvalDecision.allOf[2].then.properties.approvalTarget.pattern,
    /approve artshelf cleanup ledger/
  );
  assert.match(
    schema.$defs.approvalDecision.allOf[3].then.properties.approvalTarget.pattern,
    /approve artshelf trash purge ledger/
  );
  assert.match(
    schema.$defs.approvalDecision.allOf[4].then.properties.approvalTarget.pattern,
    /approve artshelf resolve missing ledger/
  );
  assert.deepEqual(schema.$defs.decision.properties.actionType.enum, [
    "cleanup",
    "trash-purge",
    "resolve-missing",
    "inspect",
    "fix-registry",
    "keep-or-snooze",
    "change-retention"
  ]);
  assert.deepEqual(schema.$defs.item.properties.classification.enum, [
    "trash-safe",
    "needs-human-review",
    "resolve-candidate",
    "registry-problem"
  ]);
  assert.deepEqual(schema.properties.safety.required, [
    "dryRunOnly",
    "executeAllRefused",
    "noExecuteRan",
    "noResolveRan",
    "noDeleteRan"
  ]);

  assert.equal(example.schemaVersion, 1);
  assert.equal(example.scope.health, "attention");
  assert.equal(example.scope.registryHealth, "ok");
  assert.equal(example.decisionSummary.readyForApproval, 2);
  assert.equal(example.decisionSummary.needsReviewFirst, 1);
  assert.equal(example.decisionSummary.blocked, 0);
  assert.equal(example.decisionGroups.readyForApproval.length, 2);
  assert.equal(example.decisionGroups.needsReviewFirst.length, 1);
  assert.equal(example.decisionGroups.blocked.length, 0);
  assert.equal(example.decisionGroups.readyForApproval[0].actionType, "cleanup");
  assert.equal(example.decisionGroups.readyForApproval[1].actionType, "resolve-missing");
  assert.equal(example.decisionGroups.needsReviewFirst[0].approvalTarget, null);
  assert.match(example.plans[0].approvalTarget, /approve artshelf cleanup ledger .* plan plan_/);
  assert.match(example.decisionGroups.readyForApproval[1].approvalTarget, /approve artshelf resolve missing ledger .* ids shf_/);
  assert.equal(example.summary.missingPath, 1);
  assert.equal(example.items[0].classification, "trash-safe");
  assert.equal(example.items[1].classification, "resolve-candidate");
  assert.equal(example.items[2].classification, "needs-human-review");
  assert.equal(example.safety.dryRunOnly, true);
  assert.equal(example.safety.noDeleteRan, true);
  assert.match(example.verification.command, /artshelf review --all --json/);
});

test("agent docs define registration triggers and completion checks", () => {
  const portableSkill = read("skills/artshelf/SKILL.md");
  const createPage = read("docs/agent-create.html");
  const finalizationTrigger = /before .*(final|finaliz|handoff|done|status)/i;

  for (const text of [portableSkill, createPage]) {
    assert.match(text, finalizationTrigger);
    assert.match(text, /created,\s+copied,\s+exported,\s+quarantined,\s+backed up,\s+or preserved/);
    assert.match(text, /may outlive/);
    assert.match(text, /eligible artifact/);
    assert.match(text, /skip reason|state why|record a clear skip reason/);
    assert.match(text, /Do not call work done|Before finalizing|Completion Checklist/);
    assert.match(text, /artshelf put --json/);
    assert.match(text, /deterministic Artshelf\s+footnote/);
    assert.match(text, /Artshelf footnote: registered <artifact-path> as <artshelf-id>|Artshelf footnote: registered &lt;artifact-path&gt; as &lt;artshelf-id&gt;/);
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
  const portableSkill = read("skills/artshelf/SKILL.md");
  const installPage = read("docs/install.html");
  const installGuide = read("INSTALL.md");

  for (const text of [portableSkill, installPage, installGuide]) {
    assert.match(text, /ask|Ask/);
    assert.match(text, /repo path|where the user wants|where to clone|where the Artshelf repo/);
    assert.match(text, /install, copy, or reference (?:the )?portable skill|installing a skill|portable skill/);
    assert.match(text, /read-only (?:review job|cron|recurring job)|schedule read-only/i);
    assert.match(text, /git clone https:\/\/github\.com\/calvinnwq\/artshelf\.git/);
    assert.match(text, /pnpm run build/);
    assert.match(text, /npm link/);
    assert.doesNotMatch(text, /\/Users\/ngxcalvin\/repos\/artshelf/);
    assert.doesNotMatch(text, /node dist\/src\/cli\.js/);
    assert.doesNotMatch(text, /\.local\/bin\/artshelf/);
  }

  assert.match(installPage, /Recommended [Aa]gent [Ss]etup/);
  assert.doesNotMatch(installPage, /Optional [Aa]gent [Ss]etup/);

  // INSTALL.md drives the agent setup: the install page carries the one-line
  // prompt and embeds the guide verbatim so the two cannot drift apart.
  assert.match(
    installPage,
    /Follow the instructions in https:\/\/github\.com\/calvinnwq\/artshelf\/blob\/main\/INSTALL\.md to set up Artshelf in this workspace\./
  );
  const embedded = installGuide.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  assert.ok(installPage.includes(embedded), "install page embeds INSTALL.md verbatim");
  assert.match(installGuide, /[Aa]sk the user (?:whether|where)/);
  assert.match(installGuide, /scripts\/render-review-report\.mjs/);
  assert.match(installGuide, /[Nn]ever schedule/);

  for (const text of [installPage, installGuide]) {
    assert.match(text, /rm -rf (?:&lt;your-skills-dir&gt;|<your-skills-dir>)\/artshelf/);
    assert.match(text, /cp -R .*skills\/artshelf" (?:&lt;your-skills-dir&gt;|<your-skills-dir>)\//);
    assert.doesNotMatch(text, /cp -R .*skills\/artshelf" (?:&lt;your-skills-dir&gt;|<your-skills-dir>)\/artshelf/);
  }
});

test("public docs describe current behavior without future-plan setup language", () => {
  const docsAndSkill = [
    read("README.md"),
    read("docs/agent-usage.md"),
    read("docs/agent-usage.html"),
    read("docs/install.html"),
    read("skills/artshelf/SKILL.md")
  ].join("\n");

  assert.doesNotMatch(docsAndSkill, /artshelf setup/);
  assert.doesNotMatch(docsAndSkill, /future CLI|future release|Until that exists|would be a good/);
});

test("overview avoids roadmap-style status and scope sections", () => {
  const overview = read("docs/index.html");

  assert.doesNotMatch(overview, /Status and scope/);
  assert.doesNotMatch(overview, /Current status/);
  assert.doesNotMatch(overview, /Out of scope/);
});

test("overview keeps the hard safety boundaries visible", () => {
  const overview = read("docs/index.html");

  assert.match(overview, /No automatic cleanup/);
  assert.match(overview, /Nothing runs on a schedule/);
  assert.match(overview, /cleanup --execute --all<\/code> does not exist/);
  assert.match(overview, /Delete is refused/);
  assert.match(overview, /separate reviewed (?:trash )?purge plan/);
  // The first command leads the page: install/put/review appear before the loop section.
  const firstCommandIdx = overview.indexOf("First command");
  const loopIdx = overview.indexOf("The loop");
  assert.ok(firstCommandIdx > -1, "overview should lead with the first command");
  assert.ok(loopIdx > firstCommandIdx, "the first command should lead the loop section");
});

test("agent docs define the Create Monitor Review Clean loop", () => {
  const docsAndSkill = [
    read("README.md"),
    read("docs/agent-usage.md"),
    read("docs/agent-usage.html"),
    read("skills/artshelf/SKILL.md")
  ];

  for (const text of docsAndSkill) {
    assert.match(text, /Create/);
    assert.match(text, /Monitor/);
    assert.match(text, /Review/);
    assert.match(text, /Clean/);
    assert.match(text, /ArtshelfReviewReport/);
    assert.match(text, /exact approval targets?|reviewed ledger and plan id|reviewed plan/);
  }

  const overview = read("docs/index.html");
  assert.match(overview, /approval-first artifact retention/);
  assert.match(overview, /A shelf for temporary work/);
  assert.match(overview, /Create[\s\S]*Monitor[\s\S]*Review[\s\S]*Clean/);
});

test("agent workflow page splits the loop into focused subpages", () => {
  const hub = read("docs/agent-usage.html");
  const create = read("docs/agent-create.html");
  const monitor = read("docs/agent-monitor.html");
  const review = read("docs/agent-review.html");
  const clean = read("docs/agent-clean.html");

  assert.match(hub, /href="agent-create\.html"[\s\S]*Create/);
  assert.match(hub, /href="agent-monitor\.html"[\s\S]*Monitor/);
  assert.match(hub, /href="agent-review\.html"[\s\S]*Review/);
  assert.match(hub, /href="agent-clean\.html"[\s\S]*Clean/);
  assert.match(create, /<h1>Register artifacts while intent is fresh\.<\/h1>/);
  assert.match(monitor, /<h1>Surface attention without touching artifacts\.<\/h1>/);
  assert.match(review, /<h1>Turn raw counts into a decision packet\.<\/h1>/);
  assert.match(clean, /<h1>Execute only what was reviewed and approved\.<\/h1>/);
});

test("agent workflow hub stays summary-only", () => {
  const hub = read("docs/agent-usage.html");
  const markdownHub = read("docs/agent-usage.md");

  for (const text of [hub, markdownHub]) {
    assert.match(text, /Workflow [Ss]ummary/);
    assert.match(text, /Create/);
    assert.match(text, /Monitor/);
    assert.match(text, /Review/);
    assert.match(text, /Clean/);
    assert.match(text, /ArtshelfReviewReport/);
    assert.doesNotMatch(text, /Review [Pp]lan [Rr]eport [Ss]chema/);
    assert.doesNotMatch(text, /Daily [Rr]eview [Ww]orkflow/);
    assert.doesNotMatch(text, /npm install -g artshelf/);
    assert.doesNotMatch(text, /pnpm add -g artshelf/);
    assert.doesNotMatch(text, /git clone https:\/\/github\.com\/calvinnwq\/artshelf\.git/);
    assert.doesNotMatch(text, /artshelf trash purge --execute/);
    assert.doesNotMatch(text, /Artshelf footnote: registered/);
  }

  // The hub's stage rows show one command line each; the markdown mirror stays command-free.
  assert.doesNotMatch(markdownHub, /artshelf cleanup --execute --plan-id/);
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
    read("docs/agent-create.html"),
    read("docs/agent-monitor.html"),
    read("docs/agent-review.html"),
    read("docs/agent-clean.html"),
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

test("README and quickstart lead with the core workflow", () => {
  const readme = read("README.md");
  const quickstart = read("docs/quickstart.html");

  const readmeWorkflows = [
    "Register a temp artifact",
    "Review everything safely",
    "Approve cleanup safely"
  ];
  const quickstartWorkflows = [
    "Create something temporary",
    "Review without moving files",
    "Execute only an approved plan",
    "Verify quiet",
    "Purge trash separately"
  ];

  // README centers a dedicated core-workflows section that names all three.
  assert.match(readme, /##\s+Core Workflows/);
  for (const workflow of readmeWorkflows) {
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
  for (const workflow of readmeWorkflows) {
    const idx = readme.indexOf(workflow);
    assert.ok(idx > readmeCursor, `README workflows out of order at "${workflow}"`);
    readmeCursor = idx;
  }

  // The docs quickstart leads with the minimal first-run workflow in order.
  let quickstartCursor = -1;
  for (const workflow of quickstartWorkflows) {
    const idx = quickstart.indexOf(workflow);
    assert.ok(idx > -1, `quickstart is missing core workflow "${workflow}"`);
    assert.ok(idx > quickstartCursor, `quickstart workflows out of order at "${workflow}"`);
    quickstartCursor = idx;
  }

  assert.match(quickstart, /--ttl 0m/);
  assert.match(quickstart, /--older-than 0m/);
  assert.match(quickstart, /immediately due/);
  assert.match(quickstart, /cleanup <code>--dry-run<\/code> may register a review plan/);
  assert.doesNotMatch(quickstart, /They never mutate files/);
});

function read(path: string): string {
  return readFileSync(path, "utf8");
}
