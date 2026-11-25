# A Linux machine an AI agent works on

For a headless Linux machine where an agent (Grok, or any other) signs in over SSH and makes films with `openfilm`.
After this setup, **the agent can never change, delete, rename or unlock an original**, meaning any media file in a project's
`assets/`. Linux enforces it: it doesn't matter what the agent runs, or whether it follows any rule.

## How it works

- **Two users.** The agent signs in as its own account (for example `grokbot`). A second account, the **keeper**
  (`openfilm-keeper`), runs the guardian as a systemd service. The keeper has no login and no home.
- **The guardian** (`openfilm guard <projects> --own`) watches every project in the projects folder. When a media
  file lands in `assets/` and stays unchanged for 15 seconds:
  - The keeper takes ownership of it and makes it read-only.
  - It keeps a copy in `<projects>/.openfilm-originals/`, which only the keeper can open.
  - It makes `assets/` and the project folder sticky and the keeper's. The agent can still add files, and remove its
    own new ones, but not the keeper's originals.
- **What the agent cannot do to an original:** write to it, delete it, rename it, `chmod` it, replace it, delete
  `assets/`, or reach the kept copies. If one ever changes or goes missing anyway, the guardian puts the original back
  and moves what it had become to `<projects>/.openfilm-trash/`.
- **What the agent can still do:** everything else. That includes making projects, editing `film.html` and pages,
  adding new media, rendering, and keeping working files in `work/`. `openfilm`'s manual tells the agent this.
- **The service's own limits:** it runs with only three capabilities (`CAP_CHOWN`, `CAP_FOWNER`, `CAP_DAC_OVERRIDE`),
  can write only to the projects folder, and has no network.

## Requirements

- Linux with systemd.
- Node 22.18 or later.
- ffmpeg, which the agent needs for rendering.
- git.
- The agent's account must already exist. **It must not be root, and must not have sudo.** Root ignores every
  permission, so nothing can protect files from an agent running as root.

## Set it up

```bash
sudo git clone https://github.com/minntech/FILMMAKER.git /opt/filmmaker
cd /opt/filmmaker && sudo git checkout protect-originals
sudo corepack enable && sudo pnpm install --prod=false
sudo deploy/linux/setup.sh --agent grokbot --projects /srv/films
sudo deploy/linux/check.sh --agent grokbot --projects /srv/films
```

- Keep the checkout **owned by root** (`/opt/filmmaker`). The guardian runs that code, so the agent must not be able
  to edit it. `setup.sh` warns you if it can.
- `setup.sh` is safe to run again. It warns about the agent being in an admin group, having sudo rights, or root
  being allowed to sign in over SSH.
- `check.sh` makes a test project, attacks its clip as the agent, and prints **PASS** only if every attack was refused
  and normal work still went through.
- **After setup, the agent's open SSH sessions must reconnect** to pick up its new group.

Point the agent at the projects folder:

```bash
cd /srv/films && OPENFILM_NO_BROWSER=1 openfilm open my-film
```

Or run it straight from the checkout: `node /opt/filmmaker/packages/openfilm/bin/openfilm.mjs`.

## Watching it

```bash
journalctl -u openfilm-guard -f     # one JSON line each: guarding, kept, restored, changed, lost
systemctl status openfilm-guard
```

## Limits

- **Root, or sudo, undoes everything.** That's why `setup.sh` refuses an agent that is root, and warns about sudo.
- **The guardian takes over a new file 15 seconds after it last changed.** Until then, the agent that wrote it can
  still change or delete it. That window exists for the agent's own renders still being written.
- **Deleting a whole project needs root.** Once the guardian holds it, the agent can delete its own files in it, but
  not the folders or originals. Kept copies stay in `.openfilm-originals/` until you delete them as root.
- **Disk space:** a kept copy is a hard link to the same bytes when the store is on the same filesystem, so it takes
  no extra room until the file in `assets/` is replaced.
