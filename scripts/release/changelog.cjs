"use strict";

// Pure changelog structure rules for per-build prerelease attribution.
//
// This module is deliberately free of Git, environment, and network access so
// the same rules run in history-free contexts (installed tarballs, static
// checks, deterministic tests) and in event/history-aware gates. The
// event/history-aware decisions live elsewhere: pr-candidate.cjs predicts the
// next build number from a pull request's current base, and publish.cjs
// re-validates the exact merged commit (and derives the release notes) before
// any remote write.
//
// Structure contract (post-adoption):
//   - per-build sections are headed `## [0.1.0-dev.N]` (the package version of
//     build bN); numbers are unique and positive;
//   - the TOPMOST numbered section is the candidate for the next build at a
//     pull request head, and the section for the commit's own build at a main
//     commit; it must be non-empty;
//   - no aggregate `## [Unreleased]` section remains;
//   - exactly one `## Previous builds` section preserves the pre-adoption
//     aggregate history verbatim.

const { BASE_VERSION } = require("./common.cjs");

class ChangelogError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChangelogError";
  }
}

const UNRELEASED_HEADING = /^##\s*\[Unreleased\]\s*$/;
const PREVIOUS_BUILDS_HEADING = /^## Previous builds\s*$/;
// Well-formed build heading: `## [0.1.0-dev.N]` with a positive integer N.
// Every literal dot in the pattern must reach the RegExp source escaped:
// interpolated values pass through the template literal untouched, but an
// unescaped `.` written directly in the literal would become a wildcard and
// accept lookalikes such as `## [0.1.0-devX5]`.
const BUILD_HEADING_RE = new RegExp(`^## \\[${BASE_VERSION.replace(/\./g, "\\.")}-dev\\.([1-9][0-9]*)\\]\\s*$`);
// Any line that starts like a build heading but is not well-formed; reported
// so a typo fails loudly instead of being ignored (covers `devX5`, `dev-5`,
// `dev.`, zero-padded numbers, trailing junk, ...).
const MALFORMED_BUILD_HEADING_RE = /^## \[0\.1\.0-dev/;

function devVersionFor(n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new ChangelogError(`build number must be a positive integer, got ${JSON.stringify(n)}`);
  }
  return `${BASE_VERSION}-dev.${n}`;
}

// CommonMark-style code fence tracking. A fence OPENS on a run of three or
// more backticks or tildes (a backtick fence's info string may not contain
// backticks) and CLOSES only on a matching delimiter of at least the opening
// length with nothing but trailing whitespace after it. Remembering the
// character and length is what keeps a four-backtick block containing a
// three-backtick example intact: inner runs are content, never toggles.
function fenceOpen(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const char = match[1][0];
  if (char === "`" && match[2].includes("`")) return null;
  return { char, length: match[1].length };
}

function fenceClose(line, open) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  if (!match) return false;
  return match[1][0] === open.char && match[1].length >= open.length;
}

function buildHeadingFor(n) {
  return `## [${devVersionFor(n)}]`;
}

// Line-anchored regex matching exactly the well-formed heading for build n.
function selfKeyedHeadingRegex(n) {
  const version = devVersionFor(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## \\[${version}\\]\\s*$`, "m");
}

/**
 * Parse changelog structure. Returns, in file order:
 *   numbered: [{ n, version, headingLine, content }]
 *     - content is the raw section body (lines after the heading up to the
 *       next h2 outside fences or EOF) with leading/trailing blank lines
 *       trimmed; it may contain sub-headings, lists, and code fences.
 *   malformedHeadings: [{ line, text }] — build-heading-like but invalid.
 *   hasUnreleased: boolean (outside fences).
 *   previousBuilds: number of exact `## Previous builds` headings (outside
 *     fences).
 */
function parseChangelog(text) {
  if (typeof text !== "string") throw new ChangelogError("changelog text must be a string");
  const lines = text.split("\n");
  const numbered = [];
  const malformedHeadings = [];
  let hasUnreleased = false;
  let previousBuilds = 0;
  let fence = null; // { char, length } while inside a code fence

  const isH2 = (line) => /^## \S/.test(line);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (fenceClose(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open;
      continue;
    }
    if (UNRELEASED_HEADING.test(line.trim())) {
      hasUnreleased = true;
      continue;
    }
    if (PREVIOUS_BUILDS_HEADING.test(line.trim())) {
      previousBuilds += 1;
      continue;
    }
    const match = line.match(BUILD_HEADING_RE);
    if (match) {
      // Section body runs until the next h2 outside fences (or EOF), with the
      // same delimiter-aware fence tracking as the main loop.
      let end = lines.length;
      let sectionFence = null;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (sectionFence) {
          if (fenceClose(lines[j], sectionFence)) sectionFence = null;
          continue;
        }
        const sectionOpen = fenceOpen(lines[j]);
        if (sectionOpen) {
          sectionFence = sectionOpen;
          continue;
        }
        if (isH2(lines[j])) {
          end = j;
          break;
        }
      }
      const body = lines.slice(i + 1, end);
      while (body.length > 0 && body[0].trim() === "") body.shift();
      while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
      const n = Number(match[1]);
      numbered.push({ n, version: devVersionFor(n), headingLine: i + 1, content: body.join("\n") });
      continue;
    }
    if (MALFORMED_BUILD_HEADING_RE.test(line)) {
      malformedHeadings.push({ line: i + 1, text: line.trim() });
    }
  }
  return { numbered, malformedHeadings, hasUnreleased, previousBuilds };
}

function topmostNumberedBuild(text) {
  const parsed = parseChangelog(text);
  return parsed.numbered.length > 0 ? parsed.numbered[0].n : null;
}

/**
 * Extract the section content for build n. Returns null when absent; throws
 * ChangelogError on duplicates or malformed build headings (structure that
 * must never be interpreted loosely).
 */
function extractBuildSection(text, n) {
  const parsed = parseChangelog(text);
  if (parsed.malformedHeadings.length > 0) {
    throw new ChangelogError(`malformed build heading at line ${parsed.malformedHeadings[0].line}: ${JSON.stringify(parsed.malformedHeadings[0].text)}`);
  }
  const found = parsed.numbered.filter((section) => section.n === n);
  if (found.length > 1) {
    throw new ChangelogError(`duplicate changelog sections for build ${devVersionFor(n)} (lines ${found.map((s) => s.headingLine).join(", ")})`);
  }
  return found.length === 1 ? { content: found[0].content } : null;
}

/**
 * CI-side candidate validation for a pull request head: the topmost numbered
 * section must be the candidate for the predicted next build, numbers must be
 * unique and not pre-claimed beyond the prediction, the aggregate Unreleased
 * section must be gone, and exactly one Previous builds section must remain.
 * Returns { problems } — an empty list means the candidate is valid.
 */
function validateCandidateChangelog(text, predictedN) {
  const problems = [];
  let parsed;
  try {
    parsed = parseChangelog(text);
  } catch (error) {
    return { problems: [String(error.message)] };
  }
  for (const bad of parsed.malformedHeadings) {
    problems.push(`malformed build heading at line ${bad.line}: ${JSON.stringify(bad.text)}`);
  }
  const seen = new Map();
  for (const section of parsed.numbered) {
    if (seen.has(section.n)) {
      problems.push(`duplicate changelog sections for build ${section.version} (lines ${seen.get(section.n)}, ${section.headingLine})`);
    } else {
      seen.set(section.n, section.headingLine);
    }
  }
  if (parsed.hasUnreleased) {
    problems.push("aggregate `## [Unreleased]` section must not remain; attribute changes to the candidate build section");
  }
  if (parsed.previousBuilds === 0) {
    problems.push("missing `## Previous builds` section preserving the pre-adoption aggregate history");
  } else if (parsed.previousBuilds > 1) {
    problems.push(`expected exactly one ` + "`## Previous builds`" + ` section, found ${parsed.previousBuilds}`);
  }
  const topmost = parsed.numbered.length > 0 ? parsed.numbered[0].n : null;
  if (topmost === null) {
    problems.push(`no candidate build section found; expected a non-empty ${buildHeadingFor(predictedN)} section for the next build`);
  } else if (topmost !== predictedN) {
    problems.push(
      `topmost numbered section is ${buildHeadingFor(topmost)} but the current base predicts ${buildHeadingFor(predictedN)}; ` +
      "the candidate number is stale or mismatched — update it against the current base and re-run strict CI",
    );
  }
  for (const section of parsed.numbered) {
    if (section.n > predictedN) {
      problems.push(`build ${section.version} (line ${section.headingLine}) pre-claims a number beyond the predicted next build ${devVersionFor(predictedN)}`);
    }
  }
  const candidate = parsed.numbered.find((section) => section.n === predictedN);
  if (candidate && candidate.content.trim() === "") {
    problems.push(`candidate section ${buildHeadingFor(predictedN)} is empty; state the build's changes or explicitly that it has no notable changes`);
  }
  return { problems };
}

/**
 * Publisher-side derivation of the exact collapsible release notes for build
 * n from the changelog of the exact released commit. Fails closed (throws
 * ChangelogError) on any structural violation: the topmost numbered section
 * must be this build's, non-empty; no Unreleased section; exactly one
 * non-empty Previous builds section; no malformed or duplicate headings.
 */
function deriveReleaseNotes({ text, n, tag }) {
  const parsed = parseChangelog(text);
  if (parsed.malformedHeadings.length > 0) {
    throw new ChangelogError(`malformed build heading at line ${parsed.malformedHeadings[0].line}: ${JSON.stringify(parsed.malformedHeadings[0].text)}`);
  }
  const seen = new Set();
  for (const section of parsed.numbered) {
    if (seen.has(section.n)) throw new ChangelogError(`duplicate changelog sections for build ${section.version}`);
    seen.add(section.n);
  }
  const topmost = parsed.numbered.length > 0 ? parsed.numbered[0].n : null;
  if (topmost !== n) {
    throw new ChangelogError(
      `changelog topmost numbered section is ${topmost === null ? "absent" : buildHeadingFor(topmost)} but this target is build ${devVersionFor(n)}; ` +
      "a stale or mismatched candidate number never publishes",
    );
  }
  if (parsed.hasUnreleased) {
    throw new ChangelogError("aggregate `## [Unreleased]` section must not remain in a per-build changelog");
  }
  if (parsed.previousBuilds !== 1) {
    throw new ChangelogError(`expected exactly one ` + "`## Previous builds`" + ` section, found ${parsed.previousBuilds}`);
  }
  const candidate = parsed.numbered.find((section) => section.n === n);
  if (candidate.content.trim() === "") {
    throw new ChangelogError(`changelog section for build ${devVersionFor(n)} is empty; refusing to publish without notes`);
  }
  return { content: candidate.content, notesBlock: renderChangesDetails({ tag, n, content: candidate.content }) };
}

/**
 * Render the collapsed-by-default release notes block for a build. The
 * summary names the exact tag (`Changes in bN`); the section content is
 * embedded verbatim except that every `<` is escaped to `&lt;` so contributor
 * content can never terminate the details block early, open an HTML comment,
 * or inject markup into the release body layout.
 */
function renderChangesDetails({ tag, n, content }) {
  if (typeof content !== "string") throw new ChangelogError("release notes content must be a string");
  const escaped = content.replace(/</g, "&lt;");
  return ["<details>", `<summary>Changes in ${tag}</summary>`, "", escaped, "", "</details>"].join("\n");
}

module.exports = {
  ChangelogError,
  buildHeadingFor,
  selfKeyedHeadingRegex,
  deriveReleaseNotes,
  devVersionFor,
  extractBuildSection,
  parseChangelog,
  renderChangesDetails,
  topmostNumberedBuild,
  validateCandidateChangelog,
};