import assert from "node:assert/strict";
import test from "node:test";
import { loadReleaseModule } from "./helpers/release-scripts";
import type { ChangelogModule, Eligibility, PublishModule } from "./helpers/release-scripts";

// Deterministic, history-free tests for the pure changelog rules
// (scripts/release/changelog.cjs) and the release-body rendering that embeds
// the collapsed per-build notes. No Git, no environment, no network: these
// must stay runnable from installed tarballs and static contexts.

const changelog = loadReleaseModule<ChangelogModule>("changelog.cjs");
const publish = loadReleaseModule<PublishModule>("publish.cjs");

const LEGACY_TEXT = [
  "# Changelog",
  "",
  "Intro.",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- Old aggregate content.",
  "",
].join("\n");

function postAdoptionText(top: number, extraSections: Array<[number, string]> = []): string {
  const lines = [
    "# Changelog",
    "",
    "Intro.",
    "",
    `## [0.1.0-dev.${top}]`,
    "",
    "- Candidate content for the top build.",
  ];
  for (const [n, body] of extraSections) {
    lines.push("", `## [0.1.0-dev.${n}]`, "", body);
  }
  lines.push("", "## Previous builds", "", "### Added", "", "- Old aggregate content.", "");
  return lines.join("\n");
}

test("parseChangelog extracts well-formed numbered sections in file order", () => {
  const text = postAdoptionText(6, [[5, "- Archived b5 notes."], [4, "- Archived b4 notes."]]);
  const parsed = changelog.parseChangelog(text);
  assert.deepEqual(parsed.numbered.map((s) => s.n), [6, 5, 4]);
  assert.equal(parsed.numbered[0].version, "0.1.0-dev.6");
  assert.equal(parsed.hasUnreleased, false);
  assert.equal(parsed.previousBuilds, 1);
  assert.deepEqual(parsed.malformedHeadings, []);
});

test("section content is the raw body with outer blank lines trimmed only", () => {
  const body = [
    "### Changed",
    "",
    "- A change (\u00a71).",
    "",
    "```text",
    "## [0.1.0-dev.9] is content inside a fence, not a heading",
    "```",
  ].join("\n");
  const text = `# Changelog\n\nIntro.\n\n## [0.1.0-dev.3]\n\n${body}\n\n\n## Previous builds\n\n- old\n`;
  const parsed = changelog.parseChangelog(text);
  assert.equal(parsed.numbered.length, 1, "a heading inside a fence is not a section");
  assert.equal(parsed.numbered[0].content, body);
  assert.equal(changelog.extractBuildSection(text, 3)?.content, body);
  assert.equal(changelog.extractBuildSection(text, 9), null);
});

test("malformed build headings are reported, not silently ignored", () => {
  const text = [
    "# Changelog",
    "",
    "## [0.1.0-dev.]",
    "",
    "- broken heading above",
    "",
    "## [0.1.0-dev.05]",
    "",
    "- zero-padded number",
    "",
  ].join("\n");
  const parsed = changelog.parseChangelog(text);
  assert.equal(parsed.numbered.length, 0);
  assert.equal(parsed.malformedHeadings.length, 2);
  assert.throws(() => changelog.extractBuildSection(text, 5), /malformed build heading/);
});

test("lookalike build headings with wrong separators are malformed, never accepted", () => {
  const text = [
    "# Changelog",
    "",
    "Intro.",
    "",
    "## [0.1.0-devX5]",
    "",
    "- a wildcard separator dot must not accept this as build 5",
    "",
    "## [0.1.0-dev-5]",
    "",
    "- a hyphen separator is not a build heading either",
    "",
    "## Previous builds",
    "",
    "- old aggregate content.",
    "",
  ].join("\n");
  const parsed = changelog.parseChangelog(text);
  assert.equal(parsed.numbered.length, 0, "no lookalike heading may be accepted as a build section");
  assert.equal(parsed.malformedHeadings.length, 2, "both lookalikes must be reported");
  // Candidate validation fails closed naming the malformed headings.
  const { problems } = changelog.validateCandidateChangelog(text, 5);
  assert.ok(problems.some((p) => p.includes("malformed build heading")), JSON.stringify(problems));
  // Neither lookalike can produce release notes for build 5: the malformed
  // headings fail closed before any topmost-section reasoning.
  assert.throws(() => changelog.deriveReleaseNotes({ text, n: 5, tag: "b5" }), /malformed build heading/);
  assert.throws(() => changelog.extractBuildSection(text, 5), /malformed build heading/);
});

test("four-backtick fences containing triple-backtick examples keep their content intact", () => {
  // A four-backtick block whose inner triple-backtick example PRECEDES a
  // heading-like line: naive toggle tracking closes the outer fence early and
  // parses the inner heading as structure, truncating exact-source notes.
  const body = [
    "Outer text.",
    "",
    "````text",
    "```",
    "## [0.1.0-dev.9] inside the outer fence is content",
    "```",
    "````",
  ].join("\n");
  const text = [
    "# Changelog",
    "",
    "Intro.",
    "",
    "## [0.1.0-dev.3]",
    "",
    body,
    "",
    "## Previous builds",
    "",
    "- old aggregate content.",
    "",
  ].join("\n");
  const parsed = changelog.parseChangelog(text);
  assert.equal(parsed.numbered.length, 1, "the inner heading-like line is not a section");
  assert.equal(parsed.numbered[0].n, 3);
  assert.equal(parsed.numbered[0].content, body, "section content must survive byte-for-byte");
});

test("tilde fences containing backtick lines and headings keep their content intact", () => {
  const body = [
    "~~~",
    "``` not a fence inside tildes",
    "## [0.1.0-dev.8] still content",
    "~~~",
  ].join("\n");
  const text = [
    "# Changelog",
    "",
    "Intro.",
    "",
    "## [0.1.0-dev.4]",
    "",
    body,
    "",
    "## Previous builds",
    "",
    "- old aggregate content.",
    "",
  ].join("\n");
  const parsed = changelog.parseChangelog(text);
  assert.equal(parsed.numbered.length, 1);
  assert.equal(parsed.numbered[0].content, body);
});

test("fence closing requires a matching delimiter of at least the opening length", () => {
  // A shorter same-character run is content; a longer run closes.
  const body = [
    "````",
    "inner `` two backticks are content",
    "`````",
  ].join("\n");
  const text = [
    "# Changelog",
    "",
    "## [0.1.0-dev.6]",
    "",
    body,
    "after fence: this line is outside the block",
    "",
    "## Previous builds",
    "",
    "- old aggregate content.",
    "",
  ].join("\n");
  const parsed = changelog.parseChangelog(text);
  assert.equal(parsed.numbered.length, 1);
  assert.equal(parsed.numbered[0].content, `${body}\nafter fence: this line is outside the block`);
  // A backtick fence whose info string contains a backtick is not a fence
  // (CommonMark), so structure after it still counts.
  const text2 = [
    "# Changelog",
    "",
    "## [0.1.0-dev.7]",
    "",
    "```x`y",
    "## [Unreleased]",
    "``` ",
    "(the line above opens an ordinary fence; the Unreleased heading above it was already outside any fence)",
    "",
    "## Previous builds",
    "",
    "- old aggregate content.",
    "",
  ].join("\n");
  assert.equal(changelog.parseChangelog(text2).hasUnreleased, true);
});

test("duplicate numbered sections are rejected", () => {
  const text = postAdoptionText(5).replace("## Previous builds", "## [0.1.0-dev.5]\n\n- duplicate\n\n## Previous builds");
  assert.throws(() => changelog.extractBuildSection(text, 5), /duplicate changelog sections for build 0\.1\.0-dev\.5/);
  const { problems } = changelog.validateCandidateChangelog(text, 5);
  assert.ok(problems.some((p) => p.includes("duplicate")), `expected a duplicate problem, got ${JSON.stringify(problems)}`);
});

test("topmostNumberedBuild returns the first numbered section or null", () => {
  assert.equal(changelog.topmostNumberedBuild(postAdoptionText(6, [[5, "- x"]])), 6);
  assert.equal(changelog.topmostNumberedBuild(LEGACY_TEXT), null);
});

test("candidate validation accepts a well-formed candidate for the predicted build", () => {
  const { problems } = changelog.validateCandidateChangelog(postAdoptionText(5, [[4, "- archived"]]), 5);
  assert.deepEqual(problems, []);
});

test("candidate validation rejects a stale low number with both numbers named", () => {
  const { problems } = changelog.validateCandidateChangelog(postAdoptionText(4), 5);
  assert.ok(
    problems.some((p) => p.includes("## [0.1.0-dev.4]") && p.includes("## [0.1.0-dev.5]")),
    `expected stale-number problem naming both builds, got ${JSON.stringify(problems)}`,
  );
});

test("candidate validation rejects pre-claimed future numbers", () => {
  const { problems } = changelog.validateCandidateChangelog(postAdoptionText(7), 6);
  assert.ok(
    problems.some((p) => p.includes("pre-claims a number beyond")),
    `expected pre-claim problem, got ${JSON.stringify(problems)}`,
  );
});

test("candidate validation rejects missing, empty, Unreleased, and Previous-builds violations", () => {
  // Missing candidate entirely.
  const missing = "# Changelog\n\nIntro.\n\n## Previous builds\n\n- old\n";
  assert.ok(changelog.validateCandidateChangelog(missing, 5).problems.some((p) => p.includes("no candidate build section")));
  // Empty candidate section.
  const empty = "# Changelog\n\n## [0.1.0-dev.5]\n\n   \n\n## Previous builds\n\n- old\n";
  assert.ok(changelog.validateCandidateChangelog(empty, 5).problems.some((p) => p.includes("is empty")));
  // Aggregate Unreleased still present.
  const unreleased = postAdoptionText(5).replace("Intro.", "Intro.\n\n## [Unreleased]\n\n- leftover");
  assert.ok(changelog.validateCandidateChangelog(unreleased, 5).problems.some((p) => p.includes("Unreleased")));
  // Previous builds missing.
  const noPrevious = "# Changelog\n\n## [0.1.0-dev.5]\n\n- content\n";
  assert.ok(changelog.validateCandidateChangelog(noPrevious, 5).problems.some((p) => p.includes("missing `## Previous builds`")));
  // Previous builds duplicated.
  const dupPrevious = postAdoptionText(5).replace("- Old aggregate content.\n", "- Old aggregate content.\n\n## Previous builds\n");
  assert.ok(changelog.validateCandidateChangelog(dupPrevious, 5).problems.some((p) => p.includes("exactly one")));
});

test("renderChangesDetails produces the exact collapsed block and escapes all angle brackets", () => {
  const content = "### Changed\n\n- A note with `</details>`, <!-- a comment -->, and <script> text.";
  const block = changelog.renderChangesDetails({ tag: "b5", n: 5, content });
  assert.equal(
    block,
    [
      "<details>",
      "<summary>Changes in b5</summary>",
      "",
      "### Changed",
      "",
      "- A note with `&lt;/details>`, &lt;!-- a comment -->, and &lt;script> text.",
      "",
      "</details>",
    ].join("\n"),
  );
  // Deterministic: same input, same bytes.
  assert.equal(block, changelog.renderChangesDetails({ tag: "b5", n: 5, content }));
});

test("deriveReleaseNotes requires the topmost section to be this build's and well-formed", () => {
  const text = postAdoptionText(2);
  const derived = changelog.deriveReleaseNotes({ text, n: 2, tag: "b2" });
  assert.equal(derived.content, "- Candidate content for the top build.");
  assert.ok(derived.notesBlock.startsWith("<details>\n<summary>Changes in b2</summary>"));
  // Stale topmost number.
  assert.throws(() => changelog.deriveReleaseNotes({ text, n: 3, tag: "b3" }), /topmost numbered section is ## \[0\.1\.0-dev\.2\]/);
  // Legacy-shaped text has no candidate at all.
  assert.throws(() => changelog.deriveReleaseNotes({ text: LEGACY_TEXT, n: 2, tag: "b2" }), /topmost numbered section is absent/);
  // Empty candidate.
  const empty = "# Changelog\n\n## [0.1.0-dev.2]\n\n## Previous builds\n\n- old\n";
  assert.throws(() => changelog.deriveReleaseNotes({ text: empty, n: 2, tag: "b2" }), /is empty/);
  // Unreleased present in a per-build changelog.
  const withUnreleased = postAdoptionText(2).replace("Intro.", "Intro.\n\n## [Unreleased]\n\n- leftover");
  assert.throws(() => changelog.deriveReleaseNotes({ text: withUnreleased, n: 2, tag: "b2" }), /Unreleased/);
  // Previous builds missing.
  const noPrevious = "# Changelog\n\n## [0.1.0-dev.2]\n\n- content\n";
  assert.throws(() => changelog.deriveReleaseNotes({ text: noPrevious, n: 2, tag: "b2" }), /exactly one/);
});

test("releaseBody without notes is byte-identical to the legacy shape", () => {
  const eligibility: Eligibility = {
    n: 4,
    target: "a".repeat(40),
    baseline: "b".repeat(40),
    tag: "b4",
    version: "0.1.0-dev.4",
    prNumber: 33,
    prMergeCommitSha: "a".repeat(40),
    associatedPullRequests: [33],
  };
  const provenance = { schema: "pi-review-gate-release-provenance/1", package: { version: "0.1.0-dev.4" } };
  const legacy = publish.releaseBody(eligibility, provenance);
  assert.equal(
    legacy,
    [
      publish.identityMarker(eligibility),
      "",
      "Prerelease `b4` of `pi-review-gate@0.1.0-dev.4`.",
      "",
      `- Source: rfairburn/pi-review-gate@${"a".repeat(40)}`,
      `- Baseline: ${"b".repeat(40)} (first-parent distance 4)`,
      `- Merged pull request: #33 (merge commit ${"a".repeat(40)})`,
      "",
      "```json",
      JSON.stringify(provenance, null, 2),
      "```",
    ].join("\n") + "\n",
  );
  // Explicit undefined notes must not change the legacy bytes either.
  assert.equal(publish.releaseBody(eligibility, provenance, undefined), legacy);
});

test("releaseBody with notes places the block between identity lines and the provenance fence", () => {
  const eligibility: Eligibility = {
    n: 5,
    target: "a".repeat(40),
    baseline: "b".repeat(40),
    tag: "b5",
    version: "0.1.0-dev.5",
    prNumber: 36,
    prMergeCommitSha: "a".repeat(40),
    associatedPullRequests: [36],
  };
  const provenance = { schema: "pi-review-gate-release-provenance/1", package: { version: "0.1.0-dev.5" } };
  const notesBlock = changelog.renderChangesDetails({ tag: "b5", n: 5, content: "- The exact notes." });
  const body = publish.releaseBody(eligibility, provenance, notesBlock);
  const markerIndex = body.indexOf(publish.identityMarker(eligibility));
  const notesIndex = body.indexOf(notesBlock);
  const fenceIndex = body.indexOf("```json\n" + JSON.stringify(provenance, null, 2));
  assert.ok(markerIndex >= 0 && notesIndex > markerIndex && fenceIndex > notesIndex,
    "order must be identity lines, then notes block, then provenance fence");
  assert.equal(body.endsWith("```\n"), true, "the provenance fence stays the final element");
});

test("parseProvenanceFromBody returns the last parseable JSON fence (notes fences are ignored)", () => {
  const notesFence = "```json\n{\"not\": \"provenance\"}\n```";
  const provenance = { schema: "pi-review-gate-release-provenance/1", source: { sha: "a".repeat(40) } };
  const body = [
    "notes with",
    notesFence,
    "",
    "real manifest:",
    "",
    "```json",
    JSON.stringify(provenance, null, 2),
    "```",
  ].join("\n") + "\n";
  assert.deepEqual(publish.parseProvenanceFromBody(body), provenance);
  // An unparseable trailing fence falls back to the earlier parseable one.
  const broken = [
    "```json",
    JSON.stringify(provenance, null, 2),
    "```",
    "",
    "tampered tail:",
    "```json",
    "{broken json",
    "```",
  ].join("\n") + "\n";
  assert.deepEqual(publish.parseProvenanceFromBody(broken), provenance);
  // No parseable fence at all.
  assert.equal(publish.parseProvenanceFromBody("no fences here"), null);
});