import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Governance and public-surface validation (repo layout only).
//
// Focused checks on the contribution/governance files:
//   - required governance files exist;
//   - issue forms parse as YAML (strict supported subset) and carry the required
//     user-problem / repro / acceptance / security-privacy fields plus the private
//     security-reporting redirect;
//   - the PR template carries the linked-issue policy and docs/changelog/compatibility
//     declarations;
//   - CODEOWNERS is ordinary public default ownership for @rfairburn;
//   - SECURITY.md routes to the private advisory URL without time promises and keeps
//     dependency impact on this package reportable under private embargo coordination;
//   - CHANGELOG.md stays truthful pre-1.0 (Unreleased summary, no fake dated releases);
//   - the governance surface contains no private work-artifact references;
//   - the docs checker accepts a new public doc in repo and installed layouts while
//     arbitrary local planning doc references still fail.

const repoRoot = process.cwd();
const read = (relPath: string): string => fs.readFileSync(path.join(repoRoot, relPath), "utf8");

const ADVISORY_URL = "https://github.com/rfairburn/pi-review-gate/security/advisories/new";

// Generic privacy patterns, kept in sync with scripts/check-docs.cjs. They match
// classes of private-artifact leaks without naming any real private identifier.
// Pattern 4 (prose mentions of non-public markdown files) is applied only to prose:
// inline code spans and fenced blocks may name product files.
const PRIVACY_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "absolute home-directory path", re: /\/(?:Users|home)\/[A-Za-z0-9._-]+/ },
  { name: "numbered project-board reference", re: /\bProject\s+\d{1,4}\b/i },
  { name: "private agent-skill location", re: /~\/\.[A-Za-z0-9_-]+\/agent\/skills\b/ },
];

// Basenames of markdown files that are part of the validated public surface, derived
// from the actual inventory (root governance docs, docs/*.md, and .github/**.md when
// present) so new public docs validate without editing a hardcoded list. Any other
// bare ".md" filename mention (outside URLs) is treated as a private artifact
// reference. Mirrors the derivation in scripts/check-docs.cjs.
const PUBLIC_MD_BASENAMES = (() => {
  const basenames = new Set<string>();
  for (const candidate of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "AGENTS.md"]) {
    if (fs.existsSync(path.join(repoRoot, candidate))) {
      basenames.add(path.basename(candidate).toLowerCase());
    }
  }
  const docsDir = path.join(repoRoot, "docs");
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    for (const entry of fs.readdirSync(docsDir)) {
      if (entry.endsWith(".md")) basenames.add(entry.toLowerCase());
    }
  }
  const githubDir = path.join(repoRoot, ".github");
  if (fs.existsSync(githubDir) && fs.statSync(githubDir).isDirectory()) {
    const walkGithub = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walkGithub(abs);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) basenames.add(entry.name.toLowerCase());
      }
    };
    walkGithub(githubDir);
  }
  basenames.add("skill.md"); // product skill file referenced by the docs
  return basenames;
})();

const MD_TOKEN_RE = /(?<![\w.])(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md\b/g;

// Synthetic (fictional) fixtures used only to prove the patterns fire. They contain
// no real private identifiers and are safe to keep in tracked code.
const SYNTHETIC_PRIVATE_FIXTURES = [
  "scratch copy kept at /Users/example-user/notes/draft.md",
  "backup at /home/example-user/todo.md",
  "tracked on Project 42",
  "private skills under ~/.ex-tools/agent/skills",
  "see roadmap-draft.md before merging",
];

function privacyViolations(line: string, inFence: boolean): string[] {
  const violations: string[] = [];
  for (const pattern of PRIVACY_PATTERNS) {
    if (pattern.re.test(line)) violations.push(pattern.name);
  }
  // Prose-only markdown filename mentions: code spans and fenced blocks may name
  // product files, so only prose outside fences is checked. URLs are ignored.
  if (!inFence) {
    const prose = line.replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/g, " ");
    for (const match of prose.matchAll(MD_TOKEN_RE)) {
      if (!PUBLIC_MD_BASENAMES.has(path.basename(match[0]).toLowerCase())) {
        violations.push(`non-public markdown file "${match[0]}"`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Strict YAML subset parser for GitHub issue form files. It accepts exactly the
// shapes these forms use (top-level mappings, nested mappings, lists of mappings,
// plain/quoted scalars, booleans, flow lists, and | / > block scalars) and throws
// on anything else, so a form that drifts into exotic YAML fails loudly instead of
// passing silently.
// ---------------------------------------------------------------------------

interface YamlMap {
  [key: string]: YamlNode;
}

type YamlNode = string | boolean | null | YamlMap | YamlNode[];

function parseYamlSubset(source: string, file: string): YamlMap {
  const lines = source.split(/\r?\n/);
  let i = 0;

  const indentOf = (line: string, lineNo: number): number => {
    let n = 0;
    while (n < line.length && line[n] === " ") n += 1;
    if (n < line.length && line[n] === "\t") {
      throw new Error(`${file}:${lineNo}: tab indentation is not supported`);
    }
    return n;
  };

  const isSkippable = (line: string): boolean => {
    const t = line.trim();
    return t === "" || t.startsWith("#");
  };

  const skipBlank = (): void => {
    while (i < lines.length && isSkippable(lines[i])) i += 1;
  };

  const parseScalar = (raw: string, lineNo: number): YamlNode => {
    const s = raw.trim();
    if (s === "") return null;
    if (/ #/.test(s)) throw new Error(`${file}:${lineNo}: plain scalar cannot contain a comment: ${s}`);
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      try {
        return JSON.parse(s) as string;
      } catch {
        throw new Error(`${file}:${lineNo}: invalid double-quoted scalar: ${s}`);
      }
    }
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
      return s.slice(1, -1).replace(/''/g, "'");
    }
    if (s === "true") return true;
    if (s === "false") return false;
    if (s === "null" || s === "~") return null;
    return s;
  };

  const parseFlowList = (raw: string, lineNo: number): YamlNode[] => {
    const s = raw.trim();
    const m = s.match(/^\[(.*)\]$/);
    if (!m) throw new Error(`${file}:${lineNo}: unsupported flow list: ${s}`);
    if (m[1].trim() === "") return [];
    return m[1].split(",").map((part) => parseScalar(part, lineNo));
  };

  const parseBlockScalar = (parentIndent: number, style: string): string => {
    const collected: string[] = [];
    let blockIndent = -1;
    for (;;) {
      if (i >= lines.length) break;
      const line = lines[i];
      if (line.trim() === "") {
        collected.push("");
        i += 1;
        continue;
      }
      const ind = indentOf(line, i + 1);
      if (ind <= parentIndent) break;
      if (blockIndent === -1) blockIndent = ind;
      if (ind < blockIndent) throw new Error(`${file}:${i + 1}: inconsistent block scalar indentation`);
      collected.push(line.slice(blockIndent));
      i += 1;
    }
    while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
    if (style === "|") return collected.join("\n");
    // Folded style: join lines within a paragraph with spaces; blank lines separate
    // paragraphs.
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const l of collected) {
      if (l === "") {
        if (current.length > 0) paragraphs.push(current.join(" "));
        current = [];
      } else {
        current.push(l);
      }
    }
    if (current.length > 0) paragraphs.push(current.join(" "));
    return paragraphs.join("\n");
  };

  const entryKeyRe = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

  const parseMapping = (indent: number, firstText?: string, firstLineNo?: number): YamlMap => {
    const map: YamlMap = {};
    const processEntry = (lineNo: number, text: string): void => {
      const m = text.match(entryKeyRe);
      if (!m) throw new Error(`${file}:${lineNo}: expected "key: value" mapping entry, got: ${text}`);
      const key = m[1];
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        throw new Error(`${file}:${lineNo}: duplicate key "${key}"`);
      }
      const rest = (m[2] ?? "").trim();
      if (rest === "") {
        skipBlank();
        if (i < lines.length && indentOf(lines[i], i + 1) > indent) {
          const childIndent = indentOf(lines[i], i + 1);
          map[key] = lines[i].trim().startsWith("- ") ? parseList(childIndent) : parseMapping(childIndent);
        } else {
          map[key] = null;
        }
      } else if (/^[|>][+-]?$/.test(rest)) {
        map[key] = parseBlockScalar(indent, rest[0]);
      } else if (rest.startsWith("[")) {
        map[key] = parseFlowList(rest, lineNo);
      } else {
        map[key] = parseScalar(rest, lineNo);
      }
    };
    if (firstText !== undefined) processEntry(firstLineNo ?? i, firstText);
    for (;;) {
      skipBlank();
      if (i >= lines.length) break;
      const ind = indentOf(lines[i], i + 1);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`${file}:${i + 1}: unexpected indentation`);
      const text = lines[i].trim();
      if (text.startsWith("- ")) throw new Error(`${file}:${i + 1}: list item where a mapping key was expected`);
      i += 1;
      processEntry(i, text);
    }
    return map;
  };

  const parseList = (indent: number): YamlNode[] => {
    const items: YamlNode[] = [];
    for (;;) {
      skipBlank();
      if (i >= lines.length) break;
      const ind = indentOf(lines[i], i + 1);
      if (ind !== indent) break;
      const text = lines[i].trim();
      if (!text.startsWith("- ")) break;
      const lineNo = i + 1;
      const rest = text.slice(2).trim();
      i += 1;
      if (rest === "") {
        skipBlank();
        if (i < lines.length && indentOf(lines[i], i + 1) > indent) {
          const childIndent = indentOf(lines[i], i + 1);
          items.push(lines[i].trim().startsWith("- ") ? parseList(childIndent) : parseMapping(childIndent));
        } else {
          throw new Error(`${file}:${lineNo}: empty list item`);
        }
      } else if (entryKeyRe.test(rest)) {
        items.push(parseMapping(indent + 2, rest, lineNo));
      } else {
        items.push(parseScalar(rest, lineNo));
      }
    }
    if (items.length === 0) throw new Error(`${file}: empty list at indentation ${indent}`);
    return items;
  };

  skipBlank();
  if (i >= lines.length) throw new Error(`${file}: empty document`);
  const doc = parseMapping(0);
  skipBlank();
  if (i < lines.length) throw new Error(`${file}:${i + 1}: trailing content after document`);
  return doc;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

const asMap = (value: YamlNode, ctx: string): YamlMap => {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${ctx} should be a mapping`);
  return value as YamlMap;
};

const asList = (value: YamlNode, ctx: string): YamlNode[] => {
  assert.ok(Array.isArray(value), `${ctx} should be a list`);
  return value;
};

const asString = (value: YamlNode, ctx: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${ctx} should be a string, got ${JSON.stringify(value)}`);
  }
  return value;
};

interface FormField {
  id?: YamlNode;
  type?: YamlNode;
  attributes?: YamlNode;
  validations?: YamlNode;
}

const bodyFields = (form: YamlMap, file: string): FormField[] =>
  asList(form.body ?? null, `${file}: body`).map((item) => asMap(item, `${file}: body item`) as unknown as FormField);

const fieldById = (fields: FormField[], id: string, file: string): FormField => {
  const found = fields.find((f) => f.id === id);
  assert.ok(found !== undefined, `${file}: missing form field with id "${id}"`);
  return found;
};

const requiredTextarea = (fields: FormField[], id: string, file: string): FormField => {
  const field = fieldById(fields, id, file);
  assert.equal(field.type, "textarea", `${file}: field "${id}" should be a textarea`);
  const validations = asMap(field.validations ?? null, `${file}: ${id} validations`);
  assert.equal(validations.required, true, `${file}: field "${id}" must be required`);
  return field;
};

const assertSecurityRedirect = (fields: FormField[], file: string): void => {
  const first = fields[0];
  assert.ok(first !== undefined, `${file}: body should start with a markdown note`);
  assert.equal(first.type, "markdown", `${file}: first body item should be markdown`);
  const value = asString(asMap(first.attributes ?? null, `${file}: markdown attributes`).value ?? null, `${file}: markdown value`);
  assert.match(value, /security/i, `${file}: markdown note must mention security reporting`);
  assert.ok(value.includes(ADVISORY_URL), `${file}: markdown note must link the private advisory route`);
};

const assertSanitizedData = (field: FormField, file: string): void => {
  const attrs = asMap(field.attributes ?? null, `${file}: security-privacy attributes`);
  const text = `${asString(attrs.label ?? null, "label")} ${asString(attrs.description ?? null, "description")}`;
  assert.match(text, /sanitiz/i, `${file}: security-privacy field must require sanitized data`);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("governance files exist", () => {
  const required = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    ".github/CODEOWNERS",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/ISSUE_TEMPLATE/feature.yml",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/REVIEW_GUIDANCE.md",
  ];
  for (const rel of required) {
    assert.ok(fs.existsSync(path.join(repoRoot, rel)), `missing governance file: ${rel}`);
  }
});

test("issue config disables blank issues and redirects security reports", () => {
  const cfg = parseYamlSubset(read(".github/ISSUE_TEMPLATE/config.yml"), "config.yml");
  assert.equal(cfg.blank_issues_enabled, false, "blank issues must be disabled");
  const links = asList(cfg.contact_links ?? null, "contact_links").map((l) => asMap(l, "contact link"));
  const securityLink = links.find(
    (l) => typeof l.url === "string" && (l.url as string).includes("/security/advisories/new"),
  );
  assert.ok(securityLink !== undefined, "contact_links must include the private security reporting route");
  assert.equal(securityLink.url, ADVISORY_URL);
});

test("feature form is valid YAML with required user-problem/acceptance/security-privacy fields", () => {
  const form = parseYamlSubset(read(".github/ISSUE_TEMPLATE/feature.yml"), "feature.yml");
  asString(form.name ?? null, "name");
  asString(form.description ?? null, "description");
  asString(form.title ?? null, "title");
  const fields = bodyFields(form, "feature.yml");
  assertSecurityRedirect(fields, "feature.yml");
  for (const id of ["problem", "proposal", "acceptance", "security-privacy"]) {
    requiredTextarea(fields, id, "feature.yml");
  }
  assertSanitizedData(fieldById(fields, "security-privacy", "feature.yml"), "feature.yml");
});

test("bug form is valid YAML with required repro/acceptance/security-privacy fields", () => {
  const form = parseYamlSubset(read(".github/ISSUE_TEMPLATE/bug.yml"), "bug.yml");
  asString(form.name ?? null, "name");
  asString(form.description ?? null, "description");
  asString(form.title ?? null, "title");
  const fields = bodyFields(form, "bug.yml");
  assertSecurityRedirect(fields, "bug.yml");
  for (const id of ["problem", "repro", "expected", "acceptance", "security-privacy"]) {
    requiredTextarea(fields, id, "bug.yml");
  }
  const evidence = fieldById(fields, "evidence", "bug.yml");
  const evValidations = asMap(evidence.validations ?? null, "bug.yml: evidence validations");
  assert.notEqual(evValidations.required, true, "evidence must stay optional");
  assertSanitizedData(fieldById(fields, "security-privacy", "bug.yml"), "bug.yml");
});

test("YAML subset parser rejects unsupported syntax", () => {
  assert.throws(() => parseYamlSubset("body:\n  - type: [unclosed\n", "bad.yml"));
  assert.throws(() => parseYamlSubset("key: value # trailing comment\n", "bad.yml"));
  assert.throws(() => parseYamlSubset("\tkey: value\n", "bad.yml"));
});

test("PR template requires linked issues and docs/changelog/compatibility declarations", () => {
  const pr = read(".github/PULL_REQUEST_TEMPLATE.md");
  for (const token of ["Closes #N", "Refs #N", "issue-N/", "squash", "Documentation", "Changelog", "Compatibility", "Evidence"]) {
    assert.ok(pr.includes(token), `PR template missing "${token}"`);
  }
  assert.match(pr, /linked issue/i, "PR template must require a linked issue");
  assert.ok(!/rebase/i.test(pr), "no rebase merge exception may remain in the PR template");
  assert.ok(!/never automatic/i.test(pr), "must not promise merges are never automatic");
});

test("CODEOWNERS is ordinary public default ownership", () => {
  const lines = read(".github/CODEOWNERS")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  assert.deepEqual(lines, ["* @rfairburn"]);
});

test("SECURITY.md routes to the private advisory without time promises", () => {
  const sec = read("SECURITY.md");
  assert.ok(sec.includes(ADVISORY_URL), "must link the private advisory route");
  assert.match(sec, /pre-1\.0/, "must state the honest pre-1.0 support policy");
  assert.match(sec, /stays in scope when it\s+affects/i, "dependency impact on this package must stay reportable");
  assert.match(sec, /embargoed/i, "must keep coordination private while a vulnerability is embargoed");
  assert.match(sec, /sanitized public issue/i, "must describe the sanitized public issue once disclosure is safe");
  assert.ok(
    !/within \d+\s*(hours?|days?)\b|\bSLA\b|service level agreement|guaranteed response|we will (respond|reply|fix|patch)/i.test(sec),
    "no support time promises allowed",
  );
});

test("CHANGELOG.md is truthful pre-1.0", () => {
  const cl = read("CHANGELOG.md");
  assert.ok(cl.includes("## [Unreleased]"), "must have an Unreleased section");
  assert.ok(!/^##\s*\[?0\.1\.0\b/m.test(cl), "no dated 0.1.0 release section may exist");
  assert.ok(!/releases\.md/i.test(cl), "must not link a releases page that does not exist yet");
});

test("CONTRIBUTING.md states the public workflow and release summary", () => {
  const c = read("CONTRIBUTING.md");
  for (const token of ["Closes #N", "Refs #N", "issue-N/", "b<number>", "0.1.0-dev.N"]) {
    assert.ok(c.includes(token), `CONTRIBUTING.md missing "${token}"`);
  }
  assert.match(c, /squash/i, "must name the squash merge policy");
  assert.match(c, /sole enabled PR merge method/i, "must state squash is the sole enabled PR merge method");
  assert.ok(!/rebase\b/i.test(c), "no rebase merge exception may remain in CONTRIBUTING.md");
  assert.match(c, /maintainer-authorized/i, "must state merges are maintainer-authorized after review and checks");
  assert.ok(
    !/never automatic|auto-merge is disabled/i.test(c),
    "must not promise auto-merge stays disabled unconditionally",
  );
  assert.ok(
    c.includes("npm run build:test") && c.includes("npm run test:run"),
    "must point at the safe full-suite commands for a working checkout",
  );
  assert.match(c, /no npm\s+publishing is configured or authorized/i, "must state the truthful current npm status");
  assert.match(c, /self-approval/i, "must document the maintainer self-approval distinction honestly");
  assert.match(c, /administrator/i, "must name the administrator merge path rather than implying GitHub enforces authorship exemptions");
  assert.match(c, /approving maintainer review/i, "must require approving maintainer review for external contributions");
  assert.match(
    c,
    /actor-based, not authorship-enforced/i,
    "must distinguish the actor-based GitHub exemption from authorship-based policy enforcement",
  );
  assert.ok(
    !/bypasses of any kind/i.test(c),
    "must not overstate that GitHub bypass is impossible; policy distinctions must stay honest",
  );
});

test("AGENTS.md links structure and safety docs", () => {
  const a = read("AGENTS.md");
  for (const token of ["docs/development.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "fail-closed"]) {
    assert.ok(a.includes(token), `AGENTS.md missing "${token}"`);
  }
});

test("review guidance requires precise, actionable findings without fabrication or budgets", () => {
  const g = read(".github/REVIEW_GUIDANCE.md");
  for (const token of ["evidence", "severity", "Actionable", "nit"]) {
    assert.ok(g.includes(token), `review guidance missing "${token}"`);
  }
  assert.match(g, /fabricat/i, "must prohibit fabricated test results");
  assert.match(g, /arbitrary .*budgets?/i, "must prohibit arbitrary model/token budgets");
  assert.match(g, /maintainer-authored/i, "must distinguish maintainer-authored PR review expectations");
});

test("generic privacy patterns catch synthetic private references", () => {
  for (const fixture of SYNTHETIC_PRIVATE_FIXTURES) {
    const violations = privacyViolations(fixture, false);
    assert.ok(violations.length > 0, `fixture not caught by any pattern: ${fixture}`);
  }
});

test("governance surface contains no private artifact references", () => {
  const targets: string[] = ["AGENTS.md"];
  const githubDir = path.join(repoRoot, ".github");
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) targets.push(path.relative(repoRoot, abs).split(path.sep).join("/"));
    }
  };
  walk(githubDir);
  for (const rel of targets) {
    const lines = read(rel).split(/\r?\n/);
    let inFence = false;
    for (let n = 0; n < lines.length; n += 1) {
      const isFenceLine = /^\s*(```+|~~~+)/.test(lines[n]);
      if (isFenceLine) inFence = !inFence;
      const violations = privacyViolations(lines[n], inFence || isFenceLine);
      assert.deepEqual(violations, [], `${rel}:${n + 1}: ${violations.join("; ")}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Docs-checker regression: a new public doc must validate in both the repo and
// installed layouts while arbitrary local planning doc references still fail.
// Sparse markdown fixtures are built in a temp dir and validated by running
// scripts/check-docs.cjs against them; no external dependencies.
// ---------------------------------------------------------------------------

const CHECKER = path.join(repoRoot, "scripts", "check-docs.cjs");

const FIXTURE_DOCS: Array<[string, string]> = [
  ["CONTRIBUTING.md", "# Contributing\n"],
  ["SECURITY.md", "# Security policy\n"],
  ["CHANGELOG.md", "# Changelog\n"],
  ["docs/README.md", "# Docs\n"],
  ["docs/getting-started.md", "# Getting started\n"],
  ["docs/configuration.md", "# Configuration\n"],
  ["docs/review-workflow.md", "# Review workflow\n"],
  ["docs/delegated-execution.md", "# Delegated execution\n"],
  ["docs/web-tools.md", "# Web tools\n"],
  ["docs/security-model.md", "# Security model\n"],
  ["docs/recovery.md", "# Recovery\n"],
  ["docs/development.md", "# Development\n"],
  ["docs/troubleshooting.md", "# Troubleshooting\n"],
];

function makeDocsFixture(opts: { sourceOnly: boolean }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-fixture-"));
  const write = (relPath: string, body: string): void => {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  };
  for (const [relPath, body] of FIXTURE_DOCS) write(relPath, body);
  // A new public doc that is linked from the README and named in prose; it must
  // validate even though it is not part of any hardcoded required-docs list.
  write("docs/releases.md", "# Releases\n\nPer-merge prereleases.\n");
  const links = [
    "- [Contributing](CONTRIBUTING.md)",
    "- [Security](SECURITY.md)",
    "- [Changelog](CHANGELOG.md)",
    "- [Docs home](docs/README.md)",
    "- [Getting started](docs/getting-started.md)",
    "- [Configuration](docs/configuration.md)",
    "- [Review workflow](docs/review-workflow.md)",
    "- [Delegated execution](docs/delegated-execution.md)",
    "- [Web tools](docs/web-tools.md)",
    "- [Security model](docs/security-model.md)",
    "- [Recovery](docs/recovery.md)",
    "- [Development](docs/development.md)",
    "- [Troubleshooting](docs/troubleshooting.md)",
    "- [Releases](docs/releases.md)",
  ];
  write(
    "README.md",
    `# Fixture project\n\n${links.join("\n")}\n\nThe prerelease cadence is summarized on the releases page at docs/releases.md.\n`,
  );
  for (const repoPath of ["LICENSE", "NOTICE"]) write(repoPath, "license text\n");
  fs.mkdirSync(path.join(root, "examples"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "LICENSES"), { recursive: true });
  if (opts.sourceOnly) {
    // Repo layout: source-only governance files are present, and a prose reference
    // to the known .github page must still validate.
    write("AGENTS.md", "# Agent guide\n");
    write(".github/REVIEW_GUIDANCE.md", "# Review guidance\n");
    write(
      "CONTRIBUTING.md",
      "# Contributing\n\nExternal reviewers follow the review guidance at .github/REVIEW_GUIDANCE.md.\n",
    );
  }
  return root;
}

function runDocsChecker(root: string): { status: number; stderr: string } {
  const res = spawnSync(process.execPath, [CHECKER, root], { encoding: "utf8" });
  return { status: res.status ?? -1, stderr: res.stderr ?? "" };
}

test("docs checker accepts a new public doc in repo and installed layouts", () => {
  const roots = [makeDocsFixture({ sourceOnly: true }), makeDocsFixture({ sourceOnly: false })];
  try {
    for (const root of roots) {
      const res = runDocsChecker(root);
      assert.equal(res.status, 0, `docs checker should pass for the fixture layout: ${res.stderr}`);
    }
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test("docs checker still rejects arbitrary local planning doc references", () => {
  const root = makeDocsFixture({ sourceOnly: false });
  try {
    fs.appendFileSync(path.join(root, "docs/development.md"), "\nSee local-plan-draft.md before merging.\n", "utf8");
    const res = runDocsChecker(root);
    assert.notEqual(res.status, 0, "an arbitrary local planning doc reference must fail the docs checker");
    assert.match(res.stderr, /non-public markdown file/, "the failure must cite the non-public markdown reference");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package.json ships root governance docs but keeps source-only files out", () => {
  const pkg = JSON.parse(read("package.json")) as { files?: string[] };
  const files = pkg.files ?? [];
  for (const f of ["CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]) {
    assert.ok(files.includes(f), `package.json files must include ${f}`);
  }
  assert.ok(!files.includes(".github"), ".github must stay source-only");
  assert.ok(!files.includes("AGENTS.md"), "AGENTS.md must stay source-only");
});
