// @ts-check
/**
 * `openfilm guard <folder>`: the originals of every project in a folder kept (originals.mjs) with no Studio page open:
 * on a machine an agent works on alone, headless, where nobody opens the editor. Each project's assets/ is watched; a
 * change is swept once it settles, every project is swept whole now and then (what a watch missed), and a project that
 * appears in the folder is taken in.
 *
 * `own`: the guardian keeps them as their keeper (originals.mjs useKeeper): run as a user of its own (deploy/linux), it
 * owns each original and the folders around it, so the agent's user cannot change one whatever it runs.
 *
 * What it does is said as one JSON line each (`log`): kept, restored, changed, lost, and errors.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STORE_DIR, sweep, useKeeper } from './originals.mjs';
import { watchTree } from './watch.mjs';

/** How long changes are gathered before a sweep: an agent copies a file in chunks, often several files. */
const SETTLE_MS = 500;
/** How often every project is swept whole, and the folder looked at for new projects. */
const EVERY_MS = 60_000;

/**
 * The projects in `folder`: the folder itself when it is one (a film.html or an assets/ in it), else each folder in it
 * that is (not dot folders: the store of kept originals, a trash).
 * @param {string} folder
 */
export function projectsIn(folder) {
  const isProject = (/** @type {string} */ dir) => existsSync(join(dir, 'film.html')) || existsSync(join(dir, 'assets'));
  if (isProject(folder)) return [folder];
  let names = [];
  try { names = readdirSync(folder); } catch { return []; }
  return names.filter((n) => !n.startsWith('.') && n !== STORE_DIR).map((n) => join(folder, n))
    .filter((dir) => { try { return statSync(dir).isDirectory() && isProject(dir); } catch { return false; } });
}

/**
 * Guard the projects in `folder` until `stop` is called.
 * @param {string} folder
 * @param {{ own?: boolean, log?: (event: object) => void, everyMs?: number, settledMs?: number }} [o]
 * @returns {{ stop: () => void, settled: () => Promise<void> }} `settled`: resolves once the sweeps running now are done
 */
export function guard(folder, { own = false, log = (e) => console.log(JSON.stringify(e)), everyMs = EVERY_MS, settledMs } = {}) {
  const root = resolve(folder);
  if (own) useKeeper({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
  /** @type {Map<string, { close: () => void, timer: NodeJS.Timeout | null, paths: Set<string> | null }>} */
  const watched = new Map();
  /** @type {Set<Promise<unknown>>} */
  const running = new Set();
  let stopped = false;

  const run = (/** @type {string} */ project, /** @type {string[] | undefined} */ paths) => {
    const job = sweep(project, { paths, ...(settledMs !== undefined ? { settledMs } : {}) }).then((done) => {
      for (const kind of /** @type {const} */ (['kept', 'restored', 'changed', 'lost'])) {
        if (done[kind].length) log({ at: new Date().toISOString(), project, [kind]: done[kind] });
      }
      /* still being written: looked at again once it has settled */
      if (done.waiting.length && !stopped) setTimeout(() => { if (!stopped) run(project, done.waiting); }, (settledMs ?? 15_000) + 1000).unref();
    }, (e) => log({ at: new Date().toISOString(), project, error: String(e?.message ?? e) }));
    running.add(job);
    job.finally(() => running.delete(job));
    return job;
  };

  const take = (/** @type {string} */ project) => {
    if (watched.has(project)) return;
    const entry = { close: () => {}, timer: /** @type {NodeJS.Timeout | null} */ (null), paths: /** @type {Set<string> | null} */ (new Set()) };
    entry.close = watchTree(project, (name) => {
      if (name !== null && name !== 'assets' && !name.startsWith('assets/')) return;
      if (name === null) entry.paths = null; else entry.paths?.add(name);
      if (entry.timer) return;
      entry.timer = setTimeout(() => {
        const paths = entry.paths ? [...entry.paths] : undefined;
        entry.timer = null;
        entry.paths = new Set();
        run(project, paths);
      }, SETTLE_MS);
    });
    watched.set(project, entry);
    log({ at: new Date().toISOString(), project, guarding: true });
    run(project, undefined);
  };

  const look = () => {
    const now = new Set(projectsIn(root));
    for (const [project, entry] of watched) {
      if (now.has(project)) { run(project, undefined); continue; }
      /* gone (deleted, or moved away): no longer watched; its kept copies stay in the store */
      entry.close();
      if (entry.timer) clearTimeout(entry.timer);
      watched.delete(project);
    }
    /* new ones: watched, and swept whole as they are taken in */
    for (const project of now) take(project);
  };

  look();
  const every = setInterval(look, everyMs);
  return {
    stop() {
      stopped = true;
      clearInterval(every);
      for (const entry of watched.values()) { entry.close(); if (entry.timer) clearTimeout(entry.timer); }
      watched.clear();
      if (own) useKeeper(null);
    },
    async settled() {
      while (running.size) await Promise.allSettled([...running]);
    },
  };
}
