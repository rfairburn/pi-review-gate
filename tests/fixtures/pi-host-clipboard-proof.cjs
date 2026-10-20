'use strict';
// Operator-driven fixture only. It never copies, reads, or pastes a clipboard.
// The user deliberately selects synthetic text using Pi's own native UI.
const fs = require('node:fs');
const path = require('node:path');

const TEXT = 'CLIP466-A αβ café\nCLIP466-B 雪 end';
module.exports = function clipboardProof(pi) {
  require('./session-host-native-provider.cjs')(pi);
  pi.registerCommand('clipboard-proof', {
    description: 'Display distinctive synthetic text; selection and copying remain native',
    handler: async () => pi.sendMessage({ customType: 'clipboard-proof', content: TEXT, display: true }),
  });
  pi.registerCommand('clipboard-proof-popups', {
    description: 'Create synthetic notice/question through the local scripted provider',
    handler: async () => pi.sendUserMessage('Create the synthetic clipboard proof popups.'),
  });
};

if (require.main === module) {
  if (process.argv.length !== 4 || process.argv[2] !== '--prepare') {
    process.stderr.write('Usage: node tests/fixtures/pi-host-clipboard-proof.cjs --prepare EXISTING_PRIVATE_PROOF_DIRECTORY\n');
    process.exitCode = 1;
  } else {
    const supplied = process.argv[3];
    if (!path.isAbsolute(supplied) || fs.lstatSync(supplied).isSymbolicLink() || !fs.lstatSync(supplied).isDirectory()) {
      throw new Error('Proof root must be an existing absolute real directory');
    }
    const root = fs.realpathSync(supplied);
    for (const name of ['agent', 'home', 'a', 'b', 'provider', 'candidate']) {
      fs.mkdirSync(path.join(root, name), { mode: 0o700 }); // exclusive, never reuse unknown entries
    }
    const publish = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    publish('agent/review-gate.json', { enabled: true, review: { activeReviewers: [] }, externalAgents: {}, execution: { workerResources: {}, routes: { execute: [], research: [] }, deferredPiTools: false } });
    publish('agent/settings.json', { fullscreenCopyOnSelect: true });
    publish('provider/turn-script.json', { steps: [
      { toolCalls: [
        { toolName: 'YouShouldKnow', arguments: { title: 'Synthetic clipboard notice', body: 'VISIBLE466-A αβ café\n\nVISIBLE466-B 雪 end' } },
        { toolName: 'AskUserQuestion', arguments: { question: 'VISIBLE466-Q αβ café\n\nVISIBLE466-R 雪 end', choices: ['Synthetic choice only'] } },
      ] }, { text: TEXT },
    ] });
    fs.copyFileSync(path.join(process.cwd(), 'package.json'), path.join(root, 'candidate', 'package.json'), fs.constants.COPYFILE_EXCL);
    fs.symlinkSync(path.join(process.cwd(), 'scripts'), path.join(root, 'candidate', 'scripts'), 'dir');
    fs.symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(root, 'candidate', 'node_modules'), 'dir');
    process.stdout.write('Prepared isolated synthetic agent/home/workspaces. No runtime launched and no clipboard accessed.\n');
  }
}
