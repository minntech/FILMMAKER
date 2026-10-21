/**
 * What an agent may do without the person, decided before it does it: every permission an agent asks for over ACP
 * (agents.mjs), and every tool call of the app's own agent (pi-agent.mjs), passes through `guard`.
 *
 *   deny   writing outside the project folder; writing over, moving or deleting an original (a media file under
 *          assets/: openfilm's studio/server/originals.mjs), unlocking one, or reaching into Studio's own `.film/` or the
 *          store of kept originals beside the project
 *   ask    reading what looks like someone's secrets (keys, SSH, cloud credentials), and a command that writes to a
 *          path outside the project: the person answers in the chat
 *   allow  the rest: edits and commands in the project, as the agent's own work
 *
 * A command is read for what it names, not run: a check before the fact, beside the ones that hold whatever a command
 * does (originals are read-only on disk, kept outside the project, and put back by Studio when changed or gone).
 *
 * Reads no Electron module, so `node --test` can use it.
 */
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { clipKind } from 'openfilm/film-doc';

/** Studio's own folder in a project, its record of originals, and the store of kept ones beside the project (originals.mjs). */
const TOOL_DIR = '.film';
const ORIGINALS_FILE = `${TOOL_DIR}/originals.json`;
const STORE_DIR = '.openfilm-originals';

/** Programs that copy: what they write is their last path. */
const COPIES = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'rsync', 'install', 'ln', 'scp', 'ffmpeg']);
/** Programs that move: what they name goes, and lands at their last path. */
const MOVES = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
/** Programs that write, delete or unlock every path they name. */
const CHANGES = new Set(['rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'remove-item', 'ri', 'shred', 'truncate', 'touch', 'tee', 'set-content', 'sc', 'add-content', 'ac', 'clear-content', 'clc', 'out-file',
  'new-item', 'ni', 'dd', 'chmod', 'chown', 'chattr', 'chflags', 'attrib', 'icacls', 'takeown', 'set-itemproperty', 'sp', 'sed', 'perl', 'git']);
/** Programs whose options start with a slash (Windows): `/f` is no path. */
const SLASH_OPTIONS = new Set(['del', 'erase', 'rd', 'copy', 'move', 'xcopy', 'robocopy', 'attrib', 'icacls', 'takeown', 'ren', 'rename']);
/** Code run inline that deletes, renames or writes files: every path it names is written. */
const CODE_WRITES = /\.(?:unlink|rename|rm|rmdir|writeFile|writeFileSync|write_text|write_bytes|chmod|truncate)\s*\(|\bos\.(?:remove|replace|rename|unlink|chmod)\s*\(|\bshutil\.(?:move|rmtree|copy\w*)\s*\(|\bopen\s*\([^)]*["'][wa]\+?b?["']/;
/** Paths that hold someone's secrets: read only with the person's yes. */
const SECRETS = /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|ed25519|ecdsa)[^\\/]*|\.env(?:\.[^\\/]*)?|credentials(?:\.json)?|providers\.json|keychain[^\\/]*)$|(?:^|[\\/])\.(?:ssh|aws|gnupg|kube)(?:[\\/]|$)/i;

/**
 * @typedef {{ verdict: 'allow' | 'deny' | 'ask', reason?: string }} Verdict
 * @typedef {{ cwd: string, home?: string }} Where   the project folder the agent works in
 */

/** `abs` as it is on disk: the nearest part of it that is there, its links followed, and the rest as written. */
function onDisk(/** @type {string} */ abs) {
  let at = abs;
  const rest = [];
  for (;;) {
    try { return join(realpathSync.native(at), ...rest.reverse()); } catch { /* not there (yet) */ }
    const up = dirname(at);
    if (up === at) return abs;
    rest.push(basename(at));
    at = up;
  }
}

/** `abs` from `root`, as forward-slash parts, or null when it is not in it. */
function within(/** @type {string} */ root, /** @type {string} */ abs) {
  const back = relative(root, abs);
  if (!back) return '';
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) return null;
  return back.split(sep).join('/');
}

/** The project's originals by path: those recorded, and every media file now under assets/ but those Studio made. */
export function originalsOf(/** @type {string} */ cwd) {
  /** @type {{ files?: Record<string, { removed?: boolean }>, made?: Record<string, unknown> }} */
  let record = {};
  try { record = JSON.parse(readFileSync(join(cwd, ORIGINALS_FILE), 'utf8')) ?? {}; } catch { /* none yet */ }
  const made = new Set(Object.keys(record.made ?? {}));
  const out = new Set(Object.entries(record.files ?? {}).filter(([, e]) => !e?.removed).map(([p]) => p));
  let seen = 0;
  const walk = (/** @type {string} */ rel, /** @type {number} */ depth) => {
    let entries;
    try { entries = readdirSync(join(cwd, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || ++seen > 20_000) continue;
      const path = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (depth < 8) walk(path, depth + 1); } else if (e.isFile() && isMediaName(path) && !made.has(path)) out.add(path);
    }
  };
  walk('assets', 0);
  return out;
}

const isMediaName = (/** @type {string} */ rel) => {
  const kind = clipKind(rel);
  return kind === 'video' || kind === 'sound' || kind === 'still';
};

/** Every path a tool call names: where it acts (`locations`) and the paths in its input. */
export function pathsOf(/** @type {any} */ call) {
  /** @type {string[]} */
  const out = [];
  for (const l of call?.locations ?? []) if (typeof l?.path === 'string') out.push(l.path);
  const input = call?.rawInput ?? call?.input ?? {};
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'target', 'destination', 'source', 'from', 'to', 'old_path', 'new_path']) {
    if (typeof input?.[key] === 'string') out.push(input[key]);
  }
  for (const key of ['paths', 'files']) if (Array.isArray(input?.[key])) out.push(...input[key].filter((p) => typeof p === 'string'));
  if (input?.changes && typeof input.changes === 'object') {
    out.push(...(Array.isArray(input.changes) ? input.changes.map((c) => c?.path).filter((p) => typeof p === 'string') : Object.keys(input.changes)));
  }
  /* Codex asking for more of the disk than its sandbox: where it would write */
  for (const p of input?.permissions?.fileSystem?.write ?? []) if (typeof p === 'string') out.push(p);
  return out;
}

/** The command a tool call runs, as one string ('' for none). */
export function commandOf(/** @type {any} */ call) {
  const input = call?.rawInput ?? call?.input ?? {};
  const c = input.command ?? input.cmd ?? input.script;
  return Array.isArray(c) ? c.map(String).join(' ') : typeof c === 'string' ? c : '';
}

/** What a tool call is: write, execute or read (ACP's `kind`, else the tool's name). */
function actionOf(/** @type {any} */ call) {
  const kind = String(call?.kind ?? '');
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return 'write';
  if (kind === 'execute') return 'execute';
  if (kind === 'read' || kind === 'search' || kind === 'fetch' || kind === 'think' || kind === 'switch_mode') return 'read';
  const name = String(call?.toolName ?? call?.name ?? call?.title ?? '').toLowerCase();
  if (/^(bash|shell|powershell|exec|run|terminal)\b/.test(name) || commandOf(call)) return 'execute';
  if (/^(read|grep|find|ls|glob|search|view|fetch|web)/.test(name)) return 'read';
  if (/(write|edit|patch|delete|remove|move|rename|create|apply)/.test(name)) return 'write';
  if ((call?.rawInput ?? call?.input)?.permissions?.fileSystem?.write?.length) return 'write';
  return pathsOf(call).length ? 'write' : 'read';
}

/**
 * Whether the agent may make this tool call on its own (`allow`), must not (`deny`, with why: the agent is told), or the
 * person decides (`ask`).
 * @param {any} call an ACP tool call (`kind`, `title`, `rawInput`, `locations`) or Pi's (`toolName`, `input`)
 * @param {Where} where @returns {Verdict}
 */
export function guard(call, { cwd, home = homedir() }) {
  const root = onDisk(resolve(cwd));
  const store = join(dirname(root), STORE_DIR);
  const action = actionOf(call);
  const paths = pathsOf(call).map((p) => onDisk(resolve(root, p.replace(/^~(?=$|[\\/])/, home))));

  if (action === 'read') {
    const secret = paths.find((p) => within(root, p) === null && SECRETS.test(p));
    return secret ? { verdict: 'ask', reason: `reads ${secret}, outside the project` } : { verdict: 'allow' };
  }

  const originals = originalsOf(root);
  if (action === 'write') {
    for (const abs of paths) {
      const rel = within(root, abs);
      if (rel === null) return { verdict: 'deny', reason: `${abs} is outside the project folder: only the project's files can be changed` };
      if (rel.split('/')[0].toLowerCase() === TOOL_DIR) return { verdict: 'deny', reason: `${rel} is Studio's own: leave .film/ alone` };
      if (originals.has(rel) && exists(abs)) return { verdict: 'deny', reason: `${rel} is an original: it is never changed, moved or deleted. Make a new file under a new name instead` };
    }
    return { verdict: 'allow' };
  }

  /* a command: the paths it writes */
  const command = commandOf(call) || String(call?.title ?? '');
  if (command.includes(STORE_DIR)) return { verdict: 'deny', reason: 'the kept originals beside the project are never touched' };
  const names = new Map([...originals].map((rel) => [basename(rel).toLowerCase(), rel]));
  const written = writtenBy(command).flatMap(({ path: asWritten, from }) => {
    /* `assets\shot.mp4` is a path in a shell on Windows, and one an agent elsewhere may write too */
    const path = asWritten.replace(/\\/g, '/');
    const abs = onDisk(resolve(root, path.replace(/^~(?=$|\/)/, home)));
    /* copied or moved into a folder: what lands there is each by its own name */
    const folder = from && (/\/$/.test(path) || lstatSync(abs, { throwIfNoEntry: false })?.isDirectory());
    return folder ? from.map((f) => ({ target: join(path, basename(f)), abs: join(abs, basename(f)) })) : [{ target: path, abs }];
  });
  for (const { target, abs } of written) {
    const rel = within(root, abs);
    if (rel === null) {
      if (within(store, abs) !== null) return { verdict: 'deny', reason: 'the kept originals beside the project are never touched' };
      if (!scratch(abs)) return { verdict: 'ask', reason: `writes to ${abs}, outside the project` };
      continue;
    }
    if (rel.split('/')[0].toLowerCase() === TOOL_DIR) return { verdict: 'deny', reason: "this would change Studio's own .film/: leave it alone" };
    const hit = originals.has(rel) ? rel
      /* a folder (or a pattern) with originals in it, or an original named bare from its own folder (`cd assets && rm a.mp4`) */
      : [...originals].find((o) => (/[*?]/.test(rel) ? prefixes(o).some((p) => globMatch(rel, p)) : !rel || o.startsWith(`${rel.replace(/\/$/, '')}/`)))
        ?? (/[\\/]/.test(target) ? undefined : names.get(target.toLowerCase()));
    if (hit) return { verdict: 'deny', reason: `${hit} is an original: it is never changed, moved or deleted. Read it, and write what you make under a new name` };
  }
  return { verdict: 'allow' };
}

/**
 * The paths a shell command writes, as written (relative ones from where it runs): each part of it (split at `;`,
 * `&&`, `||`, `|`), by its program: a copy's last path (`from`: what it copies there), every path a move names (what
 * goes, and where it lands), every path of one that changes what it names, and where `>` sends output. Code run inline
 * that writes files writes every path it names.
 * @returns {{ path: string, from?: string[] }[]}
 */
export function writtenBy(/** @type {string} */ command) {
  /** @type {{ path: string, from?: string[] }[]} */
  const out = [];
  const add = (/** @type {string[]} */ paths) => { for (const path of paths) out.push({ path }); };
  for (const part of command.split(/;|&&|\|\||\||\n/)) {
    const words = tokens(part);
    /* where output is sent: `> file`, `>> file`, `>file`, `2> file` (not 2>&1) */
    for (let i = 0; i < words.length; i++) {
      const m = /^(?:\d?>{1,2})(.*)$/.exec(words[i]);
      if (!m) continue;
      const to = m[1] || words[i + 1];
      if (to && !to.startsWith('&')) add([to]);
    }
    const args = words.filter((w, i) => !/^\d?>{1,2}/.test(w) && !/^\d?>{1,2}$/.test(words[i - 1] ?? ''));
    /* the program, past `sudo`, `env A=b`, `command`, `exec` */
    let at = 0;
    while (at < args.length && (/^(?:sudo|command|exec|env|nohup|time)$/.test(args[at]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[at]))) at++;
    const program = basename(String(args[at] ?? '')).toLowerCase().replace(/\.exe$/, '');
    const slash = SLASH_OPTIONS.has(program);
    const paths = args.slice(at + 1).filter((w) => !w.startsWith('-') && !(slash && /^\/[a-z?]{1,3}(?::\S*)?$/i.test(w)) && !/^\d{3,4}$/.test(w) && !/^[ugoa]*[+-=][rwxst]+$/.test(w));
    if (program === 'sed' || program === 'perl') { if (/\s-[a-zA-Z]*i|--in-place/.test(part)) add(paths.slice(1)); continue; }
    if (program === 'git') { if (/^(?:rm|mv|clean|checkout|restore|reset)$/.test(paths[0] ?? '')) add(paths.slice(1)); continue; }
    if (program === 'dd') { add(args.filter((w) => w.startsWith('of=')).map((w) => w.slice(3))); continue; }
    if (COPIES.has(program) || MOVES.has(program)) {
      if (!paths.length) continue;
      const from = program === 'ffmpeg' ? [] : paths.slice(0, -1);
      if (MOVES.has(program)) add(from);
      out.push({ path: paths[paths.length - 1], ...(from.length ? { from } : {}) });
      continue;
    }
    if (CHANGES.has(program)) { add(paths); continue; }
    if (CODE_WRITES.test(part)) add([...part.matchAll(/["']([^"']+\.[A-Za-z0-9]{2,5})["']/g)].map((m) => m[1]));
  }
  return out;
}

/** A command's words, quotes taken off (a quoted path with spaces is one word). */
function tokens(/** @type {string} */ part) {
  return [...part.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** Whether a shell pattern (`*`, `?`) matches a path. */
function globMatch(/** @type {string} */ pattern, /** @type {string} */ path) {
  const re = new RegExp(`^${pattern.split('').map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : escape(c))).join('')}$`);
  return re.test(path);
}

/** A path and each folder it is in: `assets/a/b.mp4`, `assets/a`, `assets`. */
const prefixes = (/** @type {string} */ rel) => rel.split('/').map((_, i, parts) => parts.slice(0, parts.length - i).join('/'));

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exists = (/** @type {string} */ abs) => Boolean(lstatSync(abs, { throwIfNoEntry: false }));

/** Places a command may write without asking: the system's temporary folder and the null device. */
function scratch(/** @type {string} */ abs) {
  if (/^(?:\/dev\/(?:null|stdout|stderr|tty)|NUL|nul)$/.test(abs)) return true;
  for (const t of [tmpdir(), '/tmp', '/private/tmp', '/var/folders']) {
    const back = relative(onDisk(t), abs);
    if (!back || (!back.startsWith('..') && !isAbsolute(back))) return true;
  }
  return false;
}
