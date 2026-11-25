# A Mac an AI agent works on

The macOS version of [deploy/linux](../linux/README.md). It's for a Mac where an agent (Grok, or any other) signs in
over SSH (Remote Login) and makes films with `openfilm`. After this setup, **the agent can never change, delete,
rename or unlock an original**, meaning any media file in a project's `assets/`. macOS enforces it: it doesn't matter
what the agent runs, or whether it follows any rule.

## How it works

- **Two accounts.** The agent signs in as its own Standard account (for example `grokbot`). A hidden system account,
  the **keeper** (`_openfilmkeeper`), owns the originals. The keeper has no login, no home and no password.
- **The guardian** (`openfilm guard <projects> --own --owner _openfilmkeeper`) runs as a launchd daemon, so it starts
  at boot and is restarted if it stops. When a media file lands in `assets/` and stays unchanged for 15 seconds:
  - It gives the file to the keeper and makes it read-only.
  - It removes any access control list (ACL) from the file, so no inherited permission can override that.
  - It keeps a copy in `<projects>/.openfilm-originals/`, which only root can open. On APFS that copy is an instant
    clone, taking no extra space and fully separate from the file in `assets/`.
  - It makes `assets/` and the project folder the keeper's and sticky. The agent can still add files, and remove its
    own new ones, but not the keeper's originals.
- **What the agent cannot do to an original:** write to it, delete it, rename it, `chmod` it, remove its ACL, change
  its flags, replace it, delete `assets/`, or reach the kept copies. If one ever changes or goes missing anyway, the
  guardian puts the original back and moves what it had become to `<projects>/.openfilm-trash/`.

**Why it runs as root here:** Linux lets a service user hold just the right to give files away (`CAP_CHOWN`); macOS
has no such right, so only root can make the keeper the owner. The daemon has no network code, reads and writes only
the projects folder, and runs code from a checkout only root can change.

## Requirements

- macOS on APFS.
- Node 22.18 or later (`brew install node`).
- ffmpeg (`brew install ffmpeg`), which the agent needs for rendering.
- git.
- **Remote Login** turned on (System Settings → General → Sharing).
- The agent's account must already exist as a **Standard** user. **It must not be an administrator, and must not have
  sudo.** An administrator can undo everything.

## Set it up

```bash
sudo mkdir -p /opt && sudo git clone https://github.com/minntech/FILMMAKER.git /opt/filmmaker
cd /opt/filmmaker && sudo git checkout protect-originals
sudo corepack enable && sudo pnpm install
sudo deploy/macos/setup.sh --agent grokbot --projects /Users/Shared/films
sudo deploy/macos/check.sh --agent grokbot --projects /Users/Shared/films
```

- **Keep the projects in `/Users/Shared/...` or another folder outside any user's home.** macOS privacy protection
  (TCC) blocks background services from Desktop, Documents and Downloads.
- **Keep the checkout owned by root** (`/opt/filmmaker`). The guardian runs that code as root. `setup.sh` warns you if
  the agent can edit it.
- `setup.sh` is safe to run again. It warns if the agent is an administrator or has sudo rights.
- `check.sh` makes a test project, attacks its clip as the agent, and prints **PASS** only if every attack was refused
  and normal work still went through.
- **After setup, the agent's SSH sessions must reconnect** to pick up its new group.

## Watching it

```bash
tail -f /var/log/openfilm-guard.log            # one JSON line each: guarding, kept, restored, changed, lost
sudo launchctl print system/dev.minntech.openfilm-guard | head -20
```

To stop and remove it: `sudo launchctl bootout system/dev.minntech.openfilm-guard && sudo rm /Library/LaunchDaemons/dev.minntech.openfilm-guard.plist`.

## Limits

- **An administrator, or sudo, undoes everything.** The agent must be a Standard user.
- **The guardian takes over a new file 15 seconds after it last changed.** Until then, the agent that wrote it can
  still change or delete it. That window exists for the agent's own renders still being written.
- **Deleting a whole project needs an administrator** once the guardian holds it. Kept copies stay in
  `.openfilm-originals/` until you delete them with sudo.
- **Not yet run on a Mac.** The guardian's code is the same as on Linux, where it was tested with real users. These
  macOS scripts (users, the launchd daemon, ACLs) haven't been run on macOS yet. Run `check.sh` once and confirm PASS.
