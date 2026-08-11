import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeExecutorAdapter } from "../src/execution/adapters/claude-cli";

test("Claude executor streams native activity and returns the final result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-claude-executor-"));
  try {
    const artifactDir = join(dir, "artifacts");
    const command = join(dir, "claude.mjs");
    const argvPath = join(dir, "argv.json");
    await mkdir(artifactDir);
    await writeFile(command, [
      "#!/usr/bin/env node",
      "import {writeFileSync} from 'node:fs';",
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "const events=[",
      "{type:'system',subtype:'init',session_id:'actual-session'},",
      "{type:'assistant',message:{content:[{type:'tool_use',id:'bash-1',name:'Bash',input:{command:'npm test'}},{type:'text',text:'Working'}]}},",
      "{type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash-1',content:'3 passed'}]}},",
      "{type:'result',session_id:'actual-session',result:'complete',usage:{input_tokens:20,output_tokens:4}}",
      "];process.stdout.write(events.map(JSON.stringify).join('\\n')+'\\n');});",
    ].join("\n"), "utf8");
    await chmod(command, 0o755);

    const activity: string[] = [];
    const result = await new ClaudeExecutorAdapter({
      id: "claude", adapter: "claude-cli", command, model: "sonnet", args: [],
    }).run({ cwd: dir, prompt: "implement", artifactDir, turn: 1, onUpdate: (message) => activity.push(message) });
    const argv: string[] = JSON.parse(await readFile(argvPath, "utf8"));

    assert.equal(result.text, "complete");
    assert.equal(result.session.id, "actual-session");
    assert.equal(result.usage?.inputTokens, 20);
    assert.equal(argv[argv.indexOf("--output-format") + 1], "stream-json");
    assert.deepEqual(activity, [
      "model turn started", "bash · npm test", "model update · Working", "bash completed · 3 passed", "model turn completed",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
