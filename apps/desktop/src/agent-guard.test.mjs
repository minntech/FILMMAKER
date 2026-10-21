import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard } from './agent-guard.mjs';

/** a project with footage in assets/, one file a provider made, and a page */
function project() {
  const home = mkdtempSync(join(tmpdir(), 'of-guard-'));
  const cwd = join(home, 'film');
  mkdirSync(join(cwd, 'assets', 'voice'), { recursive: true });
  mkdirSync(join(cwd, '.film'));
  writeFileSync(join(cwd, 'assets', 'shot.mp4'), 'footage');
  writeFileSync(join(cwd, 'assets', 'logo.png'), 'logo');
  writeFileSync(join(cwd, 'assets', 'voice', 'intro.mp3'), 'a take');
  writeFileSync(join(cwd, 'title.html'), 'page');
  writeFileSync(join(cwd, '.film', 'originals.json'), JSON.stringify({ version: 1, files: { 'assets/shot.mp4': { sha256: 'x' } }, made: { 'assets/voice/intro.mp3': { sha256: 'y' } } }));
  return { home, cwd };
}

const run = (cwd, command) => guard({ kind: 'execute', title: command, rawInput: { command } }, { cwd }).verdict;
const edit = (cwd, path, kind = 'edit') => guard({ kind, title: 'Write', rawInput: { file_path: path }, locations: [{ path }] }, { cwd }).verdict;

test('the agent\'s own work in the project goes ahead without asking', () => {
  const { cwd } = project();
  assert.equal(edit(cwd, join(cwd, 'title.html')), 'allow');
  assert.equal(edit(cwd, 'film.html'), 'allow');
  assert.equal(edit(cwd, 'assets/new-take.mp4'), 'allow', 'a new file under assets/');
  for (const c of [
    'npx -y openfilm@latest render',
    'ffmpeg -y -i assets/shot.mp4 -t 3 work/cut.mp4',
    'ffmpeg -i assets/shot.mp4 assets/shot-graded.mp4',
    'cp ~/Videos/b-roll.mp4 assets/',
    'cp assets/shot.mp4 work/shot.mp4',
    'mv work/cut.mp4 assets/',
    'rm -f work/cut.mp4',
    'ls -la assets && cat film.html',
    'echo done > /dev/null 2>&1',
    `echo x > ${join(tmpdir(), 'scratch.txt')}`,
  ]) assert.equal(run(cwd, c), 'allow', c);
  assert.equal(guard({ kind: 'read', rawInput: { file_path: '/usr/share/dict/words' } }, { cwd }).verdict, 'allow', 'reading is the agent\'s');
});

test('an original is never written over, moved, deleted or unlocked, however it is asked', () => {
  const { cwd } = project();
  assert.equal(edit(cwd, 'assets/shot.mp4'), 'deny');
  assert.equal(edit(cwd, join(cwd, 'assets', 'logo.png'), 'delete'), 'deny', 'media not recorded yet is an original too');
  assert.equal(edit(cwd, 'assets/voice/intro.mp3'), 'allow', 'what a provider made is made again under its name');
  for (const c of [
    'rm assets/shot.mp4',
    'rm -rf assets',
    'rm -rf *',
    'rm assets/*.mp4',
    'cd assets && rm shot.mp4',
    'mv assets/shot.mp4 assets/old.mp4',
    'ffmpeg -y -i work/cut.mp4 assets/shot.mp4',
    'cp work/cut.mp4 assets/shot.mp4',
    'cp work/shot.mp4 assets/',
    'echo x > assets/logo.png',
    'chmod 644 assets/shot.mp4',
    'attrib -r assets\\shot.mp4',
    'del /f /q assets\\shot.mp4',
    'Remove-Item -Path "assets/shot.mp4" -Force',
    'python3 -c "import os; os.remove(\'assets/shot.mp4\')"',
    'git checkout -- assets/shot.mp4',
    'sed -i s/a/b/ assets/logo.png',
  ]) assert.equal(run(cwd, c), 'deny', c);
});

test('outside the project: no edits, and a command that writes there asks the person', () => {
  const { home, cwd } = project();
  assert.equal(edit(cwd, join(home, 'elsewhere.txt')), 'deny');
  assert.equal(edit(cwd, '../other-project/film.html'), 'deny');
  assert.equal(guard({ kind: 'other', rawInput: { permissions: { fileSystem: { write: [homedir()] } } } }, { cwd }).verdict, 'deny', 'Codex asking to write beyond its sandbox');
  assert.equal(run(cwd, `rm -rf ${join(homedir(), 'Documents')}`), 'ask');
  assert.equal(run(cwd, 'mv ~/Downloads/clip.mp4 assets/'), 'ask', 'moving the person\'s own file takes it from where it was');
});

test('Studio\'s own folder and the kept originals are not the agent\'s', () => {
  const { home, cwd } = project();
  assert.equal(edit(cwd, '.film/originals.json'), 'deny');
  assert.equal(run(cwd, 'rm -rf .film'), 'deny');
  assert.equal(run(cwd, `ls ${join(home, '.openfilm-originals')}`), 'deny');
  assert.equal(edit(cwd, join(home, '.openfilm-originals', 'ab', 'abc')), 'deny');
});

test('reading someone\'s secrets outside the project asks first', () => {
  const { cwd } = project();
  for (const path of [join(homedir(), '.ssh', 'id_ed25519'), join(homedir(), '.aws', 'credentials'), join(homedir(), '.openfilm', 'providers.json')]) {
    assert.equal(guard({ kind: 'read', rawInput: { file_path: path } }, { cwd }).verdict, 'ask', path);
  }
});

test('the reason says what to do instead', () => {
  const { cwd } = project();
  const { reason } = guard({ kind: 'execute', rawInput: { command: 'rm assets/shot.mp4' } }, { cwd });
  assert.match(reason, /assets\/shot\.mp4 is an original/);
  assert.match(reason, /new name/);
});

test('a session answers its agent\'s permission requests with the guard: its own work once, an original never, the rest the person\'s', { timeout: 60_000 }, async () => {
  const { AgentSession, setChosenPaths } = await import('./agents.mjs');
  const { cwd } = project();
  const out = join(mkdtempSync(join(tmpdir(), 'of-guard-out-')), 'answers.jsonl');
  const dir = mkdtempSync(join(tmpdir(), 'of-fake-agent-'));
  const file = join(dir, 'qwen.mjs');
  const options = [
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ];
  const asks = [
    { toolCallId: '1', kind: 'edit', title: 'Write film.html', rawInput: { file_path: join(cwd, 'film.html') } },
    { toolCallId: '2', kind: 'execute', title: 'rm', rawInput: { command: 'rm -f assets/shot.mp4' } },
    { toolCallId: '3', kind: 'execute', title: 'rm', rawInput: { command: `rm -rf ${join(homedir(), 'Documents')}` } },
  ];
  writeFileSync(file, `
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as acp from ${JSON.stringify(import.meta.resolve('@agentclientprotocol/sdk'))};
const connection = new acp.AgentSideConnection(() => ({
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, agentInfo: { name: 'fake', version: '1' }, authMethods: [] }; },
  async newSession() { return { sessionId: 'fake-session' }; },
  async prompt(params) {
    for (const toolCall of ${JSON.stringify(asks)}) {
      const answer = await connection.requestPermission({ sessionId: params.sessionId, toolCall, options: ${JSON.stringify(options)} });
      appendFileSync(${JSON.stringify(out)}, JSON.stringify(answer.outcome) + '\\n');
    }
    await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } } });
    return { stopReason: 'end_turn' };
  },
  async cancel() {},
}), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
`);
  setChosenPaths({ qwen: file });
  const asked = [];
  const updates = [];
  const session = new AgentSession({
    agent: 'qwen', cwd, binDir: '/app/bin', env: {},
    onUpdate: (u) => updates.push(u),
    onPermission: async (params) => { asked.push(params.toolCall.toolCallId); return 'no'; },
  });
  try {
    await session.start();
    await session.prompt([{ type: 'text', text: 'go' }]);
  } finally {
    session.close();
  }
  const answers = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(answers.map((a) => a.optionId), ['once', 'no', 'no']);
  assert.deepEqual(asked, ['3'], 'only what writes outside the project reached the person');
  assert.ok(updates.some((u) => u.sessionUpdate === 'notice' && /assets\/shot\.mp4 is an original/.test(u.description)), 'the refusal is said in the chat');
});

test('Claude Code is started with rules it keeps in any mode: Studio\'s folder and the originals are never edited', async () => {
  const { claudeOptions } = await import('./agents.mjs');
  const { cwd } = project();
  const skills = { plugins: [{ type: 'local', path: '/x' }], settings: { skillOverrides: { a: 'off' } } };
  const options = claudeOptions(skills, cwd);
  assert.deepEqual(options.plugins, skills.plugins, 'its skills kept');
  assert.deepEqual(options.settings.skillOverrides, { a: 'off' });
  assert.deepEqual(options.settings.permissions.deny.sort(), ['Edit(./.film/**)', 'Edit(./assets/logo.png)', 'Edit(./assets/shot.mp4)']);
  assert.deepEqual(claudeOptions(undefined, cwd).settings.permissions.deny.length, 3, 'with no skills too');
});
