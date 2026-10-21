import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { besideOriginal, isOriginal, keptPath, moving, noteMade, protect, readRegistry, removing, storeOf, sweep } from './originals.mjs';
import { moveFile, trashFile } from './files.mjs';

let home, root, trash;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'of-originals-'));
  root = join(home, 'film');
  mkdirSync(join(root, 'assets'), { recursive: true });
  trash = mkdtempSync(join(tmpdir(), 'of-trash-'));
  process.env.OPENFILM_TRASH_DIR = trash;
  delete process.env.OPENFILM_ORIGINALS_DIR;
});

/** a file under the project, dated `ago` ms back (a new file is kept once it has settled) */
const put = (rel, text, ago = 60_000) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
  const when = new Date(Date.now() - ago);
  utimesSync(join(root, rel), when, when);
};
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const writable = (abs) => (statSync(abs).mode & 0o222) !== 0;
/* the read-only bit stops the owner on Windows and macOS/Linux alike, but not root (a container's tests) */
const asRoot = process.getuid?.() === 0;

test('an import is kept beside the project, out of it, and locked there and in assets/', async () => {
  put('assets/shot.mp4', 'footage');
  assert.deepEqual(await protect(root, ['assets/shot.mp4', 'assets/page.html', 'film.html']), ['assets/shot.mp4'], 'media under assets/ only');
  const { sha256 } = readRegistry(root).files['assets/shot.mp4'];
  assert.equal(storeOf(root), join(home, '.openfilm-originals'), 'beside the project folder, not in it');
  assert.equal(readFileSync(keptPath(root, sha256), 'utf8'), 'footage');
  assert.equal(writable(join(root, 'assets/shot.mp4')), false, 'the file in assets/ is read-only');
  assert.equal(writable(keptPath(root, sha256)), false, 'its kept copy is read-only');
  assert.ok(isOriginal(root, 'assets/shot.mp4'));
  if (!asRoot) assert.throws(() => writeFileSync(join(root, 'assets/shot.mp4'), 'overwritten'), /EACCES|EPERM/, 'a program cannot write over it');
});

test('an original deleted outside Studio is put back; one changed goes to the trash and the original comes back', async () => {
  put('assets/a.mp4', 'first');
  put('assets/b.png', 'second');
  await protect(root, ['assets/a.mp4', 'assets/b.png']);
  rmSync(join(root, 'assets/a.mp4'), { force: true });
  /* an agent writing over it the way most tools do: a new file renamed over the old */
  chmodSync(join(root, 'assets/b.png'), 0o644);
  writeFileSync(join(root, 'assets/b.tmp'), 'ruined');
  renameSync(join(root, 'assets/b.tmp'), join(root, 'assets/b.png'));

  const done = await sweep(root);
  assert.deepEqual(done.restored.sort(), ['assets/a.mp4', 'assets/b.png']);
  assert.deepEqual(done.changed, ['assets/b.png']);
  assert.equal(read('assets/a.mp4'), 'first');
  assert.equal(read('assets/b.png'), 'second');
  assert.equal(writable(join(root, 'assets/b.png')), false, 'locked again');
  assert.deepEqual(readdirSync(trash), ['b.png'], 'what it had become is in the trash, not lost');
  assert.deepEqual(await sweep(root), { kept: [], restored: [], changed: [], lost: [], waiting: [] }, 'nothing more to do');
});

test('media an agent copied into assets/ is kept once it settles; what Studio made is not', async () => {
  put('assets/copied.mov', 'from the desktop');
  put('assets/rendering.mp4', 'half of it', 0);
  put('assets/voice/intro.mp3', 'a take');
  await noteMade(root, 'assets/voice/intro.mp3');
  put('assets/notes.txt', 'not media');
  const done = await sweep(root);
  assert.deepEqual(done.kept, ['assets/copied.mov']);
  assert.deepEqual(done.waiting, ['assets/rendering.mp4'], 'still being written: looked at again later');
  assert.equal(isOriginal(root, 'assets/voice/intro.mp3'), false, 'made by a provider: made again under its name');
  assert.equal(writable(join(root, 'assets/rendering.mp4')), true);
  assert.deepEqual((await sweep(root, { settledMs: 0 })).kept, ['assets/rendering.mp4']);
});

test('a provider\'s file made again lands beside an original of that name, never over it', async () => {
  put('assets/image/logo.png', 'theirs');
  await protect(root, ['assets/image/logo.png']);
  assert.equal(besideOriginal(root, 'assets/image/logo.png'), 'assets/image/logo 2.png');
  assert.equal(besideOriginal(root, 'assets/image/other.png'), 'assets/image/other.png');
  put('assets/image/logo 2.png', 'taken');
  assert.equal(besideOriginal(root, 'assets/image/logo.png'), 'assets/image/logo 3.png');
});

test('moved or renamed in Studio, an original is followed; deleted in Studio, it stays deleted and its copy is kept', async () => {
  put('assets/clips/a.mp4', 'one');
  put('assets/clips/b.mp4', 'two');
  await protect(root, ['assets/clips/a.mp4', 'assets/clips/b.mp4']);
  await moveFile(root, 'assets/clips', 'assets/shots');
  assert.deepEqual(Object.keys(readRegistry(root).files).sort(), ['assets/shots/a.mp4', 'assets/shots/b.mp4']);
  assert.deepEqual((await sweep(root)).restored, [], 'not taken for gone');

  const { sha256 } = readRegistry(root).files['assets/shots/a.mp4'];
  await trashFile(root, 'assets/shots/a.mp4');
  assert.equal(existsSync(join(root, 'assets/shots/a.mp4')), false);
  assert.equal(isOriginal(root, 'assets/shots/a.mp4'), false);
  assert.deepEqual((await sweep(root)).restored, [], 'the person deleted it: not put back');
  assert.equal(readFileSync(keptPath(root, sha256), 'utf8'), 'one', 'its kept copy stays');
  assert.equal(writable(keptPath(root, sha256)), false);
});

test('a move or a delete that fails leaves the record as it was', async () => {
  put('assets/a.mp4', 'one');
  await protect(root, ['assets/a.mp4']);
  await assert.rejects(moving(root, 'assets/a.mp4', 'assets/b.mp4', async () => { throw new Error('no'); }));
  await assert.rejects(removing(root, 'assets/a.mp4', async () => { throw new Error('no'); }));
  assert.ok(isOriginal(root, 'assets/a.mp4'));
  assert.equal(writable(join(root, 'assets/a.mp4')), false, 'locked again');
});

test('a project moved away from its store keeps its originals there again', async () => {
  put('assets/a.mp4', 'one');
  await protect(root, ['assets/a.mp4']);
  const { sha256 } = readRegistry(root).files['assets/a.mp4'];
  process.env.OPENFILM_ORIGINALS_DIR = mkdtempSync(join(tmpdir(), 'of-store-'));
  assert.equal(existsSync(keptPath(root, sha256)), false);
  await sweep(root);
  assert.equal(readFileSync(keptPath(root, sha256), 'utf8'), 'one');
  delete process.env.OPENFILM_ORIGINALS_DIR;
});

test('one gone with no kept copy is told as lost, not made up', async () => {
  process.env.OPENFILM_ORIGINALS_DIR = mkdtempSync(join(tmpdir(), 'of-store-'));
  put('assets/a.mp4', 'one');
  await protect(root, ['assets/a.mp4']);
  const { sha256 } = readRegistry(root).files['assets/a.mp4'];
  chmodSync(keptPath(root, sha256), 0o644);
  rmSync(keptPath(root, sha256));
  rmSync(join(root, 'assets/a.mp4'), { force: true });
  assert.deepEqual((await sweep(root)).lost, ['assets/a.mp4']);
  delete process.env.OPENFILM_ORIGINALS_DIR;
});

const film = (src) => `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=1920, height=1080">\n</head>\n<body>\n<section>\n  <video src="${src}" at="0"></video>\n</section>\n</body>\n</html>\n`;

test('version history never writes over an original, nor takes one back on discard', async () => {
  const { commitChanges, discardChanges, restoreCommit } = await import('./history.mjs');
  mkdirSync(join(root, '.film'), { recursive: true });
  writeFileSync(join(root, 'film.html'), film('assets/a.mp4'));
  put('assets/a.mp4', 'a take the agent made');
  const first = await commitChanges(root, 'One');
  /* the person brings their own footage in under that name */
  rmSync(join(root, 'assets/a.mp4'));
  put('assets/a.mp4', 'their footage');
  await protect(root, ['assets/a.mp4']);
  await commitChanges(root, 'Two');
  await restoreCommit(root, first);
  assert.equal(read('assets/a.mp4'), 'their footage', 'going back to a version leaves the original as it is');
  await discardChanges(root);

  writeFileSync(join(root, 'film.html'), film('assets/b.mp4'));
  put('assets/b.mp4', 'imported since');
  await protect(root, ['assets/b.mp4']);
  await discardChanges(root);
  assert.equal(read('assets/b.mp4'), 'imported since', 'a discard keeps an original that came in since');
});
