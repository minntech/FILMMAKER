// @ts-check
/**
 * A project's originals: the footage, pictures and sound that came into assets/ from outside (an import, a file
 * brought in or collected, a file an agent copied there). They are never changed: whatever happens to the project, the
 * bytes that came in can be had again.
 *
 *   - Each is kept once more, as it came, in a store beside the project folder (`.openfilm-originals/` in the folder
 *     that holds it, by content): outside the project, where an agent working in it cannot write (Codex's sandbox, the
 *     desktop app's guard). A clone where the disk can make one, else a hard link to the same bytes (no room taken
 *     either way), else a copy.
 *   - The file in assets/ and its kept copy are read-only on disk: a program that opens one to write is refused
 *     (ffmpeg -y, an editor's save), on every system.
 *   - Studio never writes over one: a provider's file lands beside it (get.mjs), a version put back leaves it as it is
 *     (history-store.mjs writeFiles), a discard keeps it (history.mjs).
 *   - `sweep` looks at them all (when the project is opened, and as its files change): one that changed is put in the
 *     trash and the original put back; one gone without the person deleting it in Studio is put back. Every media file
 *     in assets/ that is not yet kept is kept, but those Studio made itself (`made`: a provider's, made again under its
 *     name as asked).
 *
 * The record is `.film/originals.json`: by path, each original's SHA-256, size and how it was on disk when last looked
 * at; `removed` when the person deleted it in Studio (its kept copy stays in the store). Paths are relative to the
 * project, with forward slashes, under assets/.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream, existsSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { clipKind } from '../../src/film-doc.mjs';
import { replaceFile, tempPath, writeAtomic } from './atomic.mjs';
import { TOOL_DIR } from './projects.mjs';
import { moveToTrash } from './trash.mjs';

const run = promisify(execFile);

/** The record of a project's originals, in Studio's own folder. */
export const ORIGINALS_FILE = `${TOOL_DIR}/originals.json`;
/** The store of kept originals, beside the project folder (in the folder that holds it). */
export const STORE_DIR = '.openfilm-originals';
const ASSETS = 'assets';

/**
 * @typedef {{ sha256: string, size: number, mtimeMs: number, ino: number, removed?: true }} Original
 * @typedef {{ sha256: string, size: number }} Made
 * @typedef {{ version: 1, files: Record<string, Original>, made: Record<string, Made> }} Registry
 * @typedef {{ kept: string[], restored: string[], changed: string[], lost: string[], waiting: string[] }} Sweep
 *   `kept`: newly kept; `restored`: put back (gone, or changed); `changed`: of those, the ones that had changed (what
 *   they had become is in the trash); `lost`: gone or changed with no kept copy to put back; `waiting`: new files still
 *   being written (changed within SETTLED_MS), kept by a sweep after
 */

/** How long a new file stays as it is before it is kept: a render or a copy writes it for a while. */
export const SETTLED_MS = 15_000;

/** Whether a project-relative path is a media file under assets/ that an original can be. */
export function isMedia(/** @type {string} */ rel) {
  const kind = clipKind(rel);
  return rel.startsWith(`${ASSETS}/`) && (kind === 'video' || kind === 'sound' || kind === 'still') && plainPath(rel);
}

/** A path the record can hold: under assets/, no `..`, no dot names (a tool's, or a file on its way in). */
function plainPath(/** @type {string} */ rel) {
  return typeof rel === 'string' && !rel.includes('\\') && !rel.includes('\0')
    && rel.split('/').every((part) => part && part !== '..' && !part.startsWith('.'));
}

/** Where the kept copies of `root`'s originals are: OPENFILM_ORIGINALS_DIR, else beside the project folder. */
export function storeOf(/** @type {string} */ root) {
  if (process.env.OPENFILM_ORIGINALS_DIR) return process.env.OPENFILM_ORIGINALS_DIR;
  let real = root;
  try { real = realpathSync.native(root); } catch { /* not there yet */ }
  return join(dirname(real), STORE_DIR);
}

/** The kept copy of the bytes with this SHA-256. */
export const keptPath = (/** @type {string} */ root, /** @type {string} */ sha256) => join(storeOf(root), sha256.slice(0, 2), sha256);

/** The record as it is on disk (none yet, or unreadable: empty). @returns {Registry} */
export function readRegistry(/** @type {string} */ root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, ORIGINALS_FILE), 'utf8'));
    const files = raw?.files && typeof raw.files === 'object' ? raw.files : {};
    const made = raw?.made && typeof raw.made === 'object' ? raw.made : {};
    return { version: 1, files, made };
  } catch {
    return { version: 1, files: {}, made: {} };
  }
}

async function writeRegistry(/** @type {string} */ root, /** @type {Registry} */ registry) {
  await mkdir(join(root, TOOL_DIR), { recursive: true });
  await writeAtomic(join(root, ORIGINALS_FILE), `${JSON.stringify(registry, null, 1)}\n`);
}

/** Whether `rel` is an original of the project now (kept, and not deleted by the person). */
export function isOriginal(/** @type {string} */ root, /** @type {string} */ rel) {
  const entry = readRegistry(root).files[rel];
  return Boolean(entry && !entry.removed);
}

/**
 * Where a file Studio makes under the name `rel` lands: there, unless an original is (then the next free name beside
 * it: `name 2.ext`, `name 3.ext`…).
 * @param {string} root @param {string} rel
 */
export function besideOriginal(root, rel) {
  const { files } = readRegistry(root);
  if (!files[rel] || files[rel].removed) return rel;
  const ext = rel.slice(rel.lastIndexOf('.'));
  const stem = rel.slice(0, rel.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!files[candidate] && !existsSync(join(root, candidate))) return candidate;
  }
}

/* one change to a project's record at a time: an import, a move and a sweep can all come at once */
/** @type {Map<string, Promise<unknown>>} */
const queues = new Map();
/** @template T @param {string} root @param {() => Promise<T>} job @returns {Promise<T>} */
function queued(root, job) {
  const next = (queues.get(root) ?? Promise.resolve()).then(job);
  const settled = next.then(() => {}, () => {});
  queues.set(root, settled);
  settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
  return next;
}

async function sha256Of(/** @type {string} */ abs) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(abs), hash);
  return hash.digest('hex');
}

/** Read-only for everyone (on Windows, the read-only attribute). */
const lock = (/** @type {string} */ abs) => chmod(abs, 0o444).catch(() => {});
/** Writable by its owner again, for Studio's own move to the trash. */
const unlock = (/** @type {string} */ abs) => chmod(abs, 0o644).catch(() => {});

/**
 * `from`'s bytes at `to` (which is not there), without taking room where the disk can: a clone (macOS `cp -c`,
 * elsewhere the kernel's), else a hard link (`hard`: allowed), else a copy.
 * @param {string} from @param {string} to @param {{ hard: boolean }} o
 */
async function sameBytes(from, to, { hard }) {
  const tmp = tempPath(to);
  try {
    if (process.platform === 'darwin' && await run('/bin/cp', ['-c', from, tmp]).then(() => true, () => false)) return await replaceFile(tmp, to);
    if (await copyFile(from, tmp, constants.COPYFILE_FICLONE_FORCE).then(() => true, () => false)) return await replaceFile(tmp, to);
    await rm(tmp, { force: true });
    if (hard && await link(from, to).then(() => true, () => false)) return undefined;
    await copyFile(from, tmp);
    await replaceFile(tmp, to);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return undefined;
}

/** Keep `abs` (whose bytes are `sha256`) in the store, unless it is there. */
async function keep(/** @type {string} */ root, /** @type {string} */ abs, /** @type {string} */ sha256) {
  const target = keptPath(root, sha256);
  if (existsSync(target)) { await lock(target); return; }
  await mkdir(dirname(target), { recursive: true });
  await sameBytes(abs, target, { hard: true });
  await lock(target);
}

/** The record's entry for the file at `abs` as it is now. */
async function entryOf(/** @type {string} */ abs, /** @type {string} */ sha256) {
  const st = await stat(abs);
  return { sha256, size: st.size, mtimeMs: Math.round(st.mtimeMs), ino: Number(st.ino) };
}

/** Keep one file as an original (its entry), within the queue. */
async function keepOne(/** @type {string} */ root, /** @type {Registry} */ registry, /** @type {string} */ rel) {
  const abs = join(root, rel);
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile()) return null;
  const sha256 = await sha256Of(abs);
  await keep(root, abs, sha256);
  await lock(abs);
  const entry = await entryOf(abs, sha256);
  registry.files[rel] = entry;
  delete registry.made[rel];
  return entry;
}

/**
 * Keep these files of the project as originals (an import, a file brought in or collected): media under assets/, as
 * files (a link's original is where it is kept, and is never written). Returns the paths kept.
 * @param {string} root @param {string[]} rels
 */
export function protect(root, rels) {
  return queued(root, async () => {
    const registry = readRegistry(root);
    /** @type {string[]} */
    const kept = [];
    for (const rel of rels) {
      if (!isMedia(rel)) continue;
      if (await keepOne(root, registry, rel)) kept.push(rel);
    }
    if (kept.length) await writeRegistry(root, registry);
    return kept;
  });
}

/**
 * A file Studio made under assets/ (a provider's, get.mjs): not an original, so made again under its name as asked.
 * @param {string} root @param {string} rel
 */
export function noteMade(root, rel) {
  return queued(root, async () => {
    if (!isMedia(rel)) return;
    const abs = join(root, rel);
    const registry = readRegistry(root);
    registry.made[rel] = { sha256: await sha256Of(abs), size: (await stat(abs)).size };
    await writeRegistry(root, registry);
  });
}

/**
 * The person moves or renames `from` (a file, or a folder and what is in it) to `to` in Studio: `move` runs within the
 * queue (a sweep never sees the originals as gone), and they are recorded where they are now.
 * @param {string} root @param {string} from @param {string} to @param {() => Promise<void>} move
 */
export function moving(root, from, to, move) {
  return queued(root, async () => {
    await move();
    const registry = readRegistry(root);
    let changed = false;
    for (const table of [registry.files, registry.made]) {
      for (const rel of Object.keys(table)) {
        const now = rel === from ? to : rel.startsWith(`${from}/`) ? to + rel.slice(from.length) : null;
        if (now === null) continue;
        table[now] = /** @type {any} */ (table[rel]);
        delete table[rel];
        changed = true;
      }
    }
    if (changed) await writeRegistry(root, registry);
  });
}

/**
 * The person deletes `rel` in Studio (a file, or a folder and what is in it): each original in it is unlocked for the
 * move to the trash and recorded as removed; its kept copy stays in the store. Runs `trash` within the queue, so a
 * sweep never sees it as gone.
 * @param {string} root @param {string} rel @param {() => Promise<void>} trash
 */
export function removing(root, rel, trash) {
  return queued(root, async () => {
    const registry = readRegistry(root);
    const theirs = Object.keys(registry.files).filter((p) => p === rel || p.startsWith(`${rel}/`));
    for (const p of theirs) await unlock(join(root, p));
    try { await trash(); } catch (e) {
      for (const p of theirs) await lock(join(root, p));
      throw e;
    }
    for (const p of theirs) {
      registry.files[p] = { ...registry.files[p], removed: true };
      /* a hard link shares its read-only mark with the file: the kept copy is locked again */
      await lock(keptPath(root, registry.files[p].sha256));
    }
    for (const p of Object.keys(registry.made)) if (p === rel || p.startsWith(`${rel}/`)) delete registry.made[p];
    if (theirs.length) await writeRegistry(root, registry);
  });
}

/** Put the kept copy of `entry` back at `abs` (nothing there now). @returns {Promise<boolean>} false: none kept */
async function putBack(/** @type {string} */ root, /** @type {string} */ abs, /** @type {Original} */ entry) {
  const from = keptPath(root, entry.sha256);
  /* a hard-linked kept copy shares its bytes with the file: one written over through an unlocked file is no original */
  if (!existsSync(from) || await sha256Of(from) !== entry.sha256) return false;
  await mkdir(dirname(abs), { recursive: true });
  /* a clone or a copy, never a hard link: the kept copy stays apart from the file in the project */
  await sameBytes(from, abs, { hard: false });
  await lock(abs);
  return true;
}

/** Media files under assets/, any depth (not links, not dot names), as project-relative paths. */
async function mediaFiles(/** @type {string} */ root) {
  /** @type {string[]} */
  const out = [];
  const walk = async (/** @type {string} */ rel, /** @type {number} */ depth) => {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith('.')) continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) { if (depth < 8) await walk(path, depth + 1); } else if (entry.isFile() && isMedia(path)) out.push(path);
    }
  };
  await walk(ASSETS, 0);
  return out;
}

/**
 * Look at every original of the project: put back one that is gone or changed (what it had become goes to the trash),
 * keep one whose kept copy is missing (the project moved away from its store), lock one that was unlocked; then keep
 * every media file under assets/ not kept yet, but those Studio made. `paths`: only these changed (a folder event's), all
 * when not given. `settledMs`: how long a new file must have been as it is (SETTLED_MS).
 * @param {string} root @param {{ paths?: string[], settledMs?: number }} [o] @returns {Promise<Sweep>}
 */
export function sweep(root, { paths, settledMs = SETTLED_MS } = {}) {
  return queued(root, async () => {
    /** @type {Sweep} */
    const out = { kept: [], restored: [], changed: [], lost: [], waiting: [] };
    if (!existsSync(join(root, ASSETS))) return out;
    const registry = readRegistry(root);
    let dirty = false;
    const asked = paths ? new Set(paths.filter((p) => p.startsWith(`${ASSETS}/`))) : null;
    /* a folder's event names the folder: what is under it is asked for too */
    const touched = (/** @type {string} */ rel) => !asked || asked.has(rel) || [...asked].some((p) => rel.startsWith(`${p}/`));
    for (const [rel, entry] of Object.entries(registry.files)) {
      if (entry.removed || !plainPath(rel) || !touched(rel)) continue;
      const abs = join(root, rel);
      const st = await lstat(abs).catch(() => null);
      if (!st || !st.isFile()) {
        /* gone (or something else in its place): put back */
        if (st) { await unlock(abs); await moveToTrash(abs).catch(() => rm(abs, { recursive: true, force: true })); }
        if (await putBack(root, abs, entry)) { registry.files[rel] = await entryOf(abs, entry.sha256); out.restored.push(rel); }
        else out.lost.push(rel);
        dirty = true;
        continue;
      }
      const same = st.size === entry.size && Math.round(st.mtimeMs) === entry.mtimeMs && Number(st.ino) === entry.ino;
      const sha256 = same ? entry.sha256 : await sha256Of(abs);
      if (sha256 === entry.sha256) {
        if (!same) { registry.files[rel] = await entryOf(abs, sha256); dirty = true; }
        if (st.mode & 0o222) await lock(abs);
        if (!existsSync(keptPath(root, sha256))) await keep(root, abs, sha256);
        continue;
      }
      /* changed: what it became goes to the trash, the original comes back */
      const from = keptPath(root, entry.sha256);
      if (!existsSync(from) || await sha256Of(from) !== entry.sha256) { out.lost.push(rel); continue; }
      await unlock(abs);
      await moveToTrash(abs);
      await putBack(root, abs, entry);
      registry.files[rel] = await entryOf(abs, entry.sha256);
      out.restored.push(rel);
      out.changed.push(rel);
      dirty = true;
    }
    for (const rel of await mediaFiles(root)) {
      if (registry.files[rel] && !registry.files[rel].removed) continue;
      if (!touched(rel)) continue;
      const st = await stat(join(root, rel)).catch(() => null);
      if (!st) continue;
      if (Date.now() - st.mtimeMs < settledMs) { out.waiting.push(rel); continue; }
      const made = registry.made[rel];
      if (made && st.size === made.size && await sha256Of(join(root, rel)) === made.sha256) continue;
      if (await keepOne(root, registry, rel)) { out.kept.push(rel); dirty = true; }
    }
    if (dirty) await writeRegistry(root, registry);
    return out;
  });
}

