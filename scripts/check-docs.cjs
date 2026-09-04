#!/usr/bin/env node
"use strict";

// Deterministic documentation validation for the public docs tree.
//
// This check is intentionally machine-checkable and free of prose snapshots: it
// verifies structural invariants (links, anchors, reachability, fenced JSON, and
// referenced repository paths) rather than asserting on specific wording. It runs
// against the working tree by default and accepts an optional root-directory
// argument so the package smoke can validate the installed package layout with the
// same rules:
//
//   node scripts/check-docs.cjs [rootDir]
//
// Checks performed:
//   1. Every relative link in README.md and docs/*.md resolves to an existing file
//      or directory (external http/https/mailto links are skipped).
//   2. Every local anchor (#fragment, including page.md#fragment) matches a heading
//      in the target page using GitHub-style slug matching.
//   3. The required public docs set exists and every docs page is reachable from the
//      root README.md through relative links (core reachability).
//   4. Every fenced `json` code block parses as JSON.
//   5. Referenced repository paths (examples, scripts, license files) exist.

const fs = require("node:fs");
const path = require("node:path");

const rootArg = process.argv[2];
const ROOT = rootArg ? path.resolve(rootArg) : path.resolve(__dirname, "..");

// The required public documentation set. README.md is the landing page; the rest
// are the focused pages under docs/.
const REQUIRED_DOCS = [
  "README.md",
  "docs/README.md",
  "docs/getting-started.md",
  "docs/configuration.md",
  "docs/review-workflow.md",
  "docs/delegated-execution.md",
  "docs/web-tools.md",
  "docs/security-model.md",
  "docs/recovery.md",
  "docs/development.md",
  "docs/troubleshooting.md",
];

// The docs-tree pages that must each be reachable from the root README.
const DOCS_PAGES = REQUIRED_DOCS.filter((p) => p.startsWith("docs/"));

// Referenced repository paths that must exist relative to the package/repo root.
// These are the resources the public documentation points users at and that the
// npm package ships; they are validated here as well as through link resolution.
const REFERENCED_REPO_PATHS = ["examples", "scripts", "LICENSE", "NOTICE", "LICENSES"];

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

// GitHub-style heading slug: strip inline markdown to approximate the rendered
// text, downcase, drop punctuation other than spaces and hyphens, then collapse
// whitespace runs to single hyphens. This mirrors the anchor IDs GitHub renders
// for headings (e.g. "BrowserExtract (rendered-page extraction)" ->
// "browserextract-rendered-page-extraction").
function slugify(headingText) {
  let text = headingText.trim();
  // [text](url) -> text; drop code-span backticks and emphasis markers.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/`/g, "");
  text = text.replace(/(\*\*|__)/g, "");
  text = text.toLowerCase();
  // Drop anything that is not a letter, number, space, or hyphen (parens, slash,
  // dots, etc.), then turn whitespace runs into single hyphens.
  text = text.replace(/[^a-z0-9 _-]/g, "");
  text = text.replace(/\s+/g, "-");
  return text.replace(/^-+|-+$/g, "");
}

// Build the ordered set of valid anchor slugs for a list of raw headings, applying
// GitHub's duplicate-heading numbering (base, base-1, base-2, ...).
function buildSlugs(rawHeadings) {
  const seen = new Map();
  const slugs = new Set();
  for (const heading of rawHeadings) {
    const base = slugify(heading);
    if (!base) continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

// Parse a markdown file into headings (raw text), inline links, and fenced json
// blocks. Fence-aware: headings, links, and JSON are only considered outside code
// fences, and only `json`-tagged fences are treated as parseable JSON.
function parseMarkdown(content) {
  const lines = content.split(/\r?\n/);
  const rawHeadings = [];
  const links = []; // { target, line }
  const jsonBlocks = []; // { startLine, body }
  let inFence = false;
  let fenceInfo = "";
  let jsonStart = -1;
  let jsonLines = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceInfo = line.slice(fenceMatch[1].length).trim().toLowerCase();
        if (fenceInfo === "json") {
          jsonStart = i + 1;
          jsonLines = [];
        } else {
          jsonStart = -1;
        }
      } else {
        inFence = false;
        if (fenceInfo === "json" && jsonStart !== -1) {
          jsonBlocks.push({ startLine: jsonStart, body: jsonLines.join("\n") });
          jsonStart = -1;
          fenceInfo = "";
        }
      }
      continue;
    }
    if (inFence) {
      if (fenceInfo === "json" && jsonStart !== -1) jsonLines.push(line);
      continue;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      rawHeadings.push(headingMatch[2].trim());
      continue;
    }
    const linkRe = /\]\(([^)]+)\)/g;
    let m;
    while ((m = linkRe.exec(line)) !== null) {
      links.push({ target: m[1].trim(), line: i + 1 });
    }
  }
  return { rawHeadings, links, jsonBlocks };
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target); // http:, https:, mailto:, etc.
}

function main() {
  const errors = [];
  const fail = (msg) => errors.push(msg);

  // --- Required docs set ---------------------------------------------------
  for (const required of REQUIRED_DOCS) {
    if (!fs.existsSync(path.join(ROOT, required))) {
      fail(`missing required doc: ${required}`);
    }
  }

  // --- Collect and parse markdown files ------------------------------------
  const mdFiles = ["README.md"];
  const docsDir = path.join(ROOT, "docs");
  if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
    for (const entry of fs.readdirSync(docsDir)) {
      if (entry.endsWith(".md")) mdFiles.push(path.join("docs", entry));
    }
  }

  const parsed = new Map(); // relPath -> { slugs, links, jsonBlocks, dir }
  for (const fileRel of mdFiles) {
    const abs = path.join(ROOT, fileRel);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, "utf8");
    const info = parseMarkdown(content);
    parsed.set(fileRel, {
      slugs: buildSlugs(info.rawHeadings),
      links: info.links,
      jsonBlocks: info.jsonBlocks,
      dir: path.dirname(abs),
    });
  }

  // --- Fenced JSON parses --------------------------------------------------
  for (const [fileRel, info] of parsed) {
    for (const block of info.jsonBlocks) {
      try {
        JSON.parse(block.body);
      } catch (error) {
        fail(`${fileRel}:${block.startLine} fenced json does not parse: ${error.message}`);
      }
    }
  }

  // --- Relative links and local anchors ------------------------------------
  for (const [fileRel, info] of parsed) {
    for (const { target, line } of info.links) {
      if (isExternal(target)) continue;
      const hashIndex = target.indexOf("#");
      const pathPart = hashIndex === -1 ? target : target.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? null : target.slice(hashIndex + 1);

      if (pathPart === "") {
        // Pure in-page anchor (#fragment).
        if (fragment !== null && !info.slugs.has(fragment)) {
          fail(`${fileRel}:${line} anchor "#${fragment}" has no matching heading`);
        }
        continue;
      }

      const resolved = path.resolve(info.dir, pathPart);
      let stats;
      try {
        stats = fs.statSync(resolved);
      } catch {
        fail(`${fileRel}:${line} link "${target}" does not resolve to an existing path`);
        continue;
      }

      if (fragment !== null) {
        // Anchor into another markdown file.
        const targetRel = rel(resolved);
        const targetInfo = parsed.get(targetRel);
        if (!targetInfo) {
          fail(`${fileRel}:${line} anchor target "${target}" is not a validated markdown page`);
        } else if (!targetInfo.slugs.has(fragment)) {
          fail(`${fileRel}:${line} anchor "${fragment}" in ${targetRel} has no matching heading`);
        }
      } else if (pathPart.endsWith("/") && !stats.isDirectory()) {
        fail(`${fileRel}:${line} link "${target}" points to a directory that does not exist`);
      }
    }
  }

  // --- Core reachability from the root README ------------------------------
  const readmeInfo = parsed.get("README.md");
  if (readmeInfo) {
    const reachable = new Set();
    const queue = ["README.md"];
    while (queue.length > 0) {
      const current = queue.shift();
      if (reachable.has(current)) continue;
      reachable.add(current);
      const info = parsed.get(current);
      if (!info) continue;
      for (const { target } of info.links) {
        if (isExternal(target)) continue;
        const pathPart = target.split("#", 1)[0];
        if (!pathPart || pathPart.endsWith("/")) continue;
        const resolved = path.resolve(info.dir, pathPart);
        const targetRel = rel(resolved);
        if (targetRel.startsWith("docs/") && parsed.has(targetRel) && !reachable.has(targetRel)) {
          queue.push(targetRel);
        }
      }
    }
    for (const page of DOCS_PAGES) {
      if (!reachable.has(page)) {
        fail(`docs page not reachable from README.md: ${page}`);
      }
    }
  }

  // --- Referenced repository paths -----------------------------------------
  for (const repoPath of REFERENCED_REPO_PATHS) {
    if (!fs.existsSync(path.join(ROOT, repoPath))) {
      fail(`referenced repository path missing: ${repoPath}`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`check-docs: ${errors.length} problem(s) in ${ROOT}\n`);
    for (const error of errors) process.stderr.write(`  - ${error}\n`);
    process.exit(1);
  }

  const pageCount = parsed.size;
  process.stdout.write(`check-docs: OK (${pageCount} markdown pages validated under ${ROOT})\n`);
}

main();
