import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeCliAdapter } from "../src/adapters/claude-cli";

test("Claude reviewer streams native activity without exposing its final JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-review-"));
  try {
    const command = join(dir, "claude.mjs");
    const argvPath = join(dir, "argv.json");
    const review = JSON.stringify({ verdict: "pass", summary: "claude ok", findings: [] });
    await writeFile(command, [
      "#!/usr/bin/env node",
      "import {writeFileSync} from 'node:fs';",
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "const events=[",
      "{type:'system',subtype:'init',session_id:'claude-session'},",
      "{type:'assistant',message:{content:[{type:'tool_use',id:'read-1',name:'Read',input:{file_path:'/repo/a.ts'}},{type:'text',text:" + JSON.stringify(review) + "}]}},",
      "{type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-1',content:'private source'}]}},",
      "{type:'result',session_id:'claude-session',result:" + JSON.stringify(review) + ",usage:{input_tokens:10,output_tokens:2},total_cost_usd:0.01}",
      "];process.stdout.write(events.map(JSON.stringify).join('\\n')+'\\n');});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const activity: string[] = [];
    const result = await new ClaudeCliAdapter({ id: "claude", adapter: "claude-cli", command, timeoutMs: 15000 }).run({
      id: "claude", cwd: dir, prompt: "review", bundleDir: dir, timeoutMs: 15000,
      onUpdate: (message) => activity.push(message),
    });
    const argv: string[] = JSON.parse(await readFile(argvPath, "utf8"));

    assert.equal(result.verdict, "pass");
    assert.equal(result.usage?.costTotal, 0.01);
    assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
    assert.ok(argv.includes("--verbose") && argv.includes("--include-partial-messages"));
    assert.deepEqual(activity, ["model turn started", "read · /repo/a.ts", "read completed", "model turn completed"]);
    assert.equal(activity.some((message) => message.includes("claude ok") || message.includes("private source")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
