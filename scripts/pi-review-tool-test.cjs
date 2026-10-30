#!/usr/bin/env node
"use strict";

// Thin public entry for the inert tool-auditor tester (#544). The implementation,
// fixture data, context builder, runner, and parser are the compiled production
// modules shipped in this package. This wrapper never builds, installs, provisions
// a runtime, loads a session, or executes a proposal.

const path = require("node:path");

let cli;
try {
  cli = require(path.join(__dirname, "..", "dist", "src", "tool-protection", "test-cli.js"));
} catch (error) {
  process.stderr.write(
    "pi-review-tool-test: the compiled tester is missing; run the package build before using a source checkout.\n",
  );
  process.exitCode = 2;
  return;
}

cli.runToolProtectionTestCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`Tester error: ${String((error && error.message) || error)}\n`);
    process.exitCode = 2;
  },
);
