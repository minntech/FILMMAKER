import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard, projectsIn } from './guardian.mjs';
import { readRegistry, sweep, useKeeper } from './originals.mjs';

let folder;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'of-guardian-'));
  process.env.OPENFILM_TRASH_DIR = mkdtempSync(join(tmpdir(), 'of-trash-'));
  delete process.env.OPENFILM_ORIGINALS_DIR;
});

const put = (rel, text, ago = 60_000) => {
  mkdirSync(join(folder, rel, '..'), { recursive: true });
  writeFileSync(join(folder, rel), text);
  const when = new Date(Date.now() - ago);
  utimesSync(join(folder, rel), when, when);
};
const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (check()) return true;
  return false;
};

test('the projects in a folder: it, when it is one; else each folder in it that is, not dot folders', () => {
  put('reel/film.html', 'x');
  put('raw/assets/a.mp4', 'x');
  put('notes/readme.txt', 'x');
  mkdirSync(join(folder, '.openfilm-originals', 'assets'), { recursive: true });
  assert.deepEqual(projectsIn(folder).sort(), [join(folder, 'raw'), join(folder, 'reel')]);
  assert.deepEqual(projectsIn(join(folder, 'reel')), [join(folder, 'reel')]);
  assert.deepEqual(projectsIn(join(folder, 'nowhere')), []);
});

test('headless, with no Studio page: media copied in is kept, and an original deleted is put back', { timeout: 30_000 }, async () => {
  put('reel/film.html', 'x');
  put('reel/assets/shot.mp4', 'footage');
  const said = [];
  const g = guard(folder, { log: (e) => said.push(e), settledMs: 0, everyMs: 3_600_000 });
  try {
    assert.ok(await until(() => readRegistry(join(folder, 'reel')).files['assets/shot.mp4']), 'kept as it is found');
    rmSync(join(folder, 'reel', 'assets', 'shot.mp4'), { force: true });
    assert.ok(await until(() => existsSync(join(folder, 'reel', 'assets', 'shot.mp4'))), 'put back');
    assert.equal(readFileSync(join(folder, 'reel', 'assets', 'shot.mp4'), 'utf8'), 'footage');
    await g.settled();
  } finally {
    g.stop();
  }
  assert.ok(said.some((e) => e.kept?.includes('assets/shot.mp4')));
  assert.ok(said.some((e) => e.restored?.includes('assets/shot.mp4')));
});

test('a new project in the folder is taken in at the next look', { timeout: 30_000 }, async () => {
  const g = guard(folder, { log: () => {}, settledMs: 0, everyMs: 200 });
  try {
    put('late/assets/b.png', 'picture');
    assert.ok(await until(() => readRegistry(join(folder, 'late')).files['assets/b.png']));
  } finally {
    g.stop();
  }
});

/* owning another user's files needs root (or CAP_CHOWN): the keeper is checked where the tests run as root */
const asRoot = { skip: process.getuid?.() !== 0 && 'owning files for another user needs root or CAP_CHOWN' };

test('a keeper owns each original, the project folder and every folder under assets/, which are sticky', asRoot, async () => {
  put('reel/film.html', 'x');
  put('reel/assets/clips/a.mp4', 'one');
  const project = join(folder, 'reel');
  /* nobody's uid: a keeper that is not the files' owner */
  useKeeper({ uid: 65534, gid: 65534 });
  try {
    await sweep(project, { settledMs: 0 });
  } finally {
    useKeeper(null);
  }
  for (const dir of [project, join(project, 'assets'), join(project, 'assets', 'clips')]) {
    const st = statSync(dir);
    assert.equal(st.uid, 65534, dir);
    assert.equal(st.mode & 0o7777, 0o3775, `${dir}: sticky, setgid, writable by its group`);
  }
  const file = statSync(join(project, 'assets', 'clips', 'a.mp4'));
  assert.equal(file.uid, 65534);
  assert.equal(file.mode & 0o777, 0o444);
  assert.equal(existsSync(join(project, '.film')), false, 'the keeper makes no .film/ of its own: Studio\'s history would be the keeper\'s');
});
