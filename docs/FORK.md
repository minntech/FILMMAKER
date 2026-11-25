# minntech/filmmaker: fork notes

Last updated: 2026-11-25

## What this is

`minntech/filmmaker` is a fork of **OpenFilm** ([openfilm/openfilm](https://github.com/openfilm/openfilm)), the open source AI video agent. A film is HTML: each shot is a web page that draws any moment with `frame(t)`. Studio is the local editor, which runs in a browser or in the desktop app. Playwright's Chromium and ffmpeg render the result.

| | |
|---|---|
| Forked from | `openfilm/openfilm` at `419da5d` ("Studio: New project inside a folder, made in that folder (#150)"), version 0.2.4 |
| Fork's `main` | Still at `419da5d`, unchanged from upstream |
| Work branch | `protect-originals` (`52dec33`): originals protection and an agent guard |
| Upstream now | `327ef4c`, version **0.4.1**, **183 commits ahead** of the fork point (2026-11-23) |
| Local copy | `D:\antigravity\filmmaker` (Windows) |
| Size | About 141k lines; a pnpm monorepo with Node 22.18+ |

### Layout

| Path | What it is |
|---|---|
| `packages/openfilm/` | The npm `openfilm` package: the film format, the CLI (`bin/`, `src/`), the Studio server (`studio/server/`) and the Studio UI (`studio/ui/`, React and Vite) |
| `packages/shared/` | Types shared between the desktop chat and the main process |
| `apps/desktop/` | The Electron app: Studio with a chat beside it, which drives Claude Code, Codex and other agents over ACP |
| `packages/openfilm/MANUAL.md` | What the `openfilm` command prints for agents |
| `packages/openfilm/SPEC.md` | The film format specification |

## Running it (Windows)

Requires Node 22.18+, git and ffmpeg (`winget install OpenJS.NodeJS.LTS Gyan.FFmpeg`).

```powershell
cd D:\antigravity\filmmaker
corepack enable          # one time; provides pnpm 9.15.9 (ignore pnpm's "update available")
pnpm install
pnpm dev:desktop         # the desktop app, "OpenFilm Dev"
pnpm test                # every package's tests
```

**Always start it from a normal PowerShell window, never as Administrator.** Agents run commands with the permissions of the window that started the app.

To make a new film: click **Projects** (top left) and then **New project**, or click **+** in the tab strip.

## The `protect-originals` branch

### Goal

Media in a project's `assets/` are **originals**. They are never changed, moved or deleted. A project file can be redone; a damaged original cannot.

### Five layers

1. **A kept copy outside the project.** Every original is copied to `.openfilm-originals\` in the folder that holds the project, named by its SHA-256. The copy is a clone where the disk supports it, else a hard link, else a full copy. It lives out of an agent's reach, including Codex's sandbox. Code: `packages/openfilm/studio/server/originals.mjs`. The record of originals is `.film/originals.json`.
2. **Read-only on disk.** Both the file in `assets/` and its kept copy are marked read-only, so a program that tries to overwrite one (`ffmpeg -y`, an editor's save) is refused.
3. **Studio never writes over one.** A file a provider makes again lands beside an original as `name 2.ext` (`get.mjs`, `custom-services.mjs`). Restoring a version and discarding changes both skip originals (`history-store.mjs`, `history.mjs`). A rename or delete done in Studio updates the record (`files.mjs`), and a delete keeps the kept copy.
4. **Self-healing.** A sweep runs when a project opens and on every change in `assets/` (`watch.mjs`, `server.mjs`). An original that changed goes to the Recycle Bin and the original comes back; one deleted outside Studio is put back. Studio then shows "Originals put back". A new file is only protected once it has been unchanged for 15 seconds, so a render that is still writing isn't locked halfway.
5. **The agent guard** (`apps/desktop/src/agent-guard.mjs`) checks every permission request from an agent (`agents.mjs`) and every tool call of the built-in agent (`pi-agent.mjs`):
   - **Allowed once**, without asking: the agent's own work in the project. ("Once" means each next request is checked again.)
   - **Refused**, with a "Not allowed" line in the chat: changing, moving, deleting or unlocking an original; anything in `.film/`; anything in the kept-copy folder.
   - **Asks the person**: writing outside the project; reading secrets such as SSH keys, cloud credentials or `providers.json`.
   - **Agent modes changed.** No agent runs in full-access mode. Claude uses `default`, Codex uses `read-only` (its sandbox, with risky actions sent to the app), and Kimi and MiniMax use `default`. Copilot, Cursor, Qwen and CodeBuddy are started without their auto-approve flags. Claude Code also gets `permissions.deny` rules for `.film/` and for each original.

The agent instructions and `MANUAL.md` now say: read originals, make working pieces in `work/`, and save a new take under a new name.

### Test results (Linux, in the cloud)

| Suite | Upstream at the fork point | `protect-originals` |
|---|---|---|
| Desktop | 303 passed | 311 passed (8 new), 0 failed |
| OpenFilm | 1093 passed, 3 failed, 8 cancelled | 1102 passed (9 new), the same 3 failed, the same 8 cancelled |

The 11 tests that failed or were cancelled are identical on both sides. They are video decoding tests that fail because the cloud container's Chromium is older than Playwright expects, not because of this branch. Typecheck is clean in every package.

A live run against a real Studio worked end to end: a clip deleted from a shell was put back, and a clip overwritten with garbage was restored, with the garbage sent to the trash. A non-admin user was refused when writing over a read-only file. The guard allowed normal work and refused `rm`, `del`, `ffmpeg -y`, `attrib -r` and `Remove-Item` on originals.

### Not yet verified

- **Windows:** the read-only attribute, the Recycle Bin and hard links on NTFS. The app has run on Windows (an agent edited a reel), but the protection itself hasn't been tested there.
- **Real agents:** Kimi's and MiniMax's ask-first mode is set to `default`, which is a best guess. Copilot, Cursor, Qwen and CodeBuddy without their auto-approve flags haven't been run with a real login.

### Known limits

- The guard reads commands; it doesn't sandbox them. A script the agent writes and then runs can do things the guard can't see. Inside the project, the read-only lock and self-healing catch that. Outside the project, Windows doesn't contain it.
- With a hard-linked kept copy (the zero-space option on NTFS), a program that strips read-only and then writes in place damages both copies. Studio then reports the original as lost; it never restores a damaged copy.
- The first time an existing project opens, Studio hashes every media file once, in the background.
- A file the agent writes into `assets/` locks after 15 seconds without changes, so a re-render needs a new name.
- Deleting a project leaves its kept copies in `.openfilm-originals\`. Clean that folder by hand if disk space matters.

## Upstream since the fork

Upstream is now at 0.4.1, 183 commits later. That brings plugins, Community, motion and color tools, local models, more agents, a new README in 22 languages, and many Studio and render fixes.

**Upstream still runs every agent in full access** (`AGENT_FORCED_PREFS`: `bypassPermissions`, `agent-full-access`, `yolo`), and has added two more agents: `openfilm` (its own) and `deepseek`. Bringing this branch up to date with upstream means:

- **Merge conflicts expected** in about 20 of the branch's 25 files. Upstream also changed every shared file except `SpendAsks.tsx`. The new files (`originals.mjs`, `agent-guard.mjs`, their tests and the changeset) carry over cleanly.
- **New agents need the guard.** The `openfilm` and `deepseek` agents need ask-first modes and the guard applied to them.
- **Re-run all tests** after the merge.

Recommended order: test `protect-originals` on Windows first, then rebase or merge it onto upstream 0.4.1 as its own step.

## License and trademark

- **Code:** MIT ("Copyright (c) 2026 OpenFilm contributors"). Keep the copyright notice in copies.
- **Trademark** (`TRADEMARK.md`): the MIT license doesn't cover the name or logo. A **published modified fork must not be called "OpenFilm"**, use its logo, or use "openfilm" in a package, domain or account name that looks official. Using it privately, or working on changes meant to go back upstream, is fine.
- **Before redistributing**, rename all of these:
  - the npm packages (`openfilm`, `@openfilm/*`)
  - the app ID (`dev.openfilm.desktop`)
  - the logos (`docs/logo-*.svg`, `apps/desktop/build/icon*`)
  - the update feed (`product.official.json`)
  - the home folder (`~/.openfilm`) and the default port (4747), so the fork doesn't clash with a real OpenFilm install
- **Bundled ffmpeg** (desktop installers) is GPL-3.0. Shipping installers means including its license and providing its source.
- **Third-party notices** (Inter font: OFL; React: MIT; Lucide icons: ISC; playwright-core: Apache-2.0) must be kept.
- **Release workflows** only run on `openfilm/openfilm`, so they are skipped on this fork until they are set up for it.

## Security review (fork point)

**Good:**
- Studio listens on `127.0.0.1` only, and its API needs a key with a timing-safe check.
- Host and Origin checks block DNS rebinding and cross-site requests.
- File paths are checked, so nothing outside the project can be read or written through Studio.
- No shell commands are built from input.
- Provider keys are stored in `~/.openfilm/providers.json` with owner-only (0600) permissions, and the UI only ever sees the last 4 characters.
- The Electron app is properly locked down (sandbox and context isolation).
- No telemetry. No real secrets are committed; the only key-like strings are two fakes in tests.

**Risks:**
- **Agents in full access with no prompts.** Fixed on `protect-originals`.
- **Untrusted films.** `openfilm open <github-url>` runs other people's pages in Chromium, which Playwright starts without its sandbox.
- **Unsigned Windows updates.** The Windows updater relies only on a hash from the update feed, with no code-signing check.
- **Installer scripts from third-party servers.** The installers for Cursor, CodeBuddy, Qwen, Kimi and MiniMax download and run scripts (`irm | iex`), including from servers in China. They only run when Install is clicked in Settings → Agents.

## Housekeeping

- Delete the leftover `claude/push-check` branch on GitHub. It was a push test.
- Provider keys (ElevenLabs and others) go in Studio under Settings → Providers. They stay on the PC and are never committed.
