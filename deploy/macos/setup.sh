#!/bin/bash
# Set up a Mac where an AI agent makes films over SSH (Remote Login), so it can never change, delete, rename or unlock
# an original (the media in a project's assets/): macOS refuses it, whatever the agent runs.
#
#   sudo deploy/macos/setup.sh [--agent grokbot] [--projects /Users/Shared/films] [--keeper _openfilmkeeper] [--group films]
#
# What it does (each step is safe to run again):
#   1. a group for the projects folder, and the keeper: a hidden system account with no login and no home
#   2. the agent's user in that group (it must exist already: the account the agent signs in with over SSH)
#   3. the projects folder: writable by the group, sticky; beside the projects, the store of kept originals and the
#      trash, root's alone
#   4. the guardian as a launchd daemon (dev.minntech.openfilm-guard), started now and at every boot
#   5. checks that would undo all of it: the agent as root, an administrator, or with sudo
# Written for macOS's own bash 3.2.
set -euo pipefail

AGENT=grokbot
PROJECTS=/Users/Shared/films
KEEPER=_openfilmkeeper
GROUP=films
LABEL=dev.minntech.openfilm-guard
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --projects) PROJECTS="$2"; shift 2 ;;
    --keeper) KEEPER="$2"; shift 2 ;;
    --group) GROUP="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(uname)" = "Darwin" ] || { echo "this is for macOS: deploy/linux is for Linux" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 1; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do [ -n "$NODE" ] || { [ -x "$candidate" ] && NODE="$candidate"; }; done
[ -n "$NODE" ] || { echo "node is not installed (Node 22.18 or later: brew install node)" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || { echo "node $("$NODE" -v) is too old: Node 22.18 or later" >&2; exit 1; }
[ -f "$REPO/packages/openfilm/bin/openfilm.mjs" ] || { echo "not a checkout of the fork: $REPO" >&2; exit 1; }
id "$AGENT" >/dev/null 2>&1 || { echo "no user $AGENT: create the account the agent signs in with first" >&2; exit 1; }
[ "$(id -u "$AGENT")" -ne 0 ] || { echo "$AGENT is root: no permission can hold against root. Give the agent a normal account." >&2; exit 1; }

echo "1. group $GROUP and keeper $KEEPER"
dscl . -read "/Groups/$GROUP" >/dev/null 2>&1 || dseditgroup -o create -r "OpenFilm projects" "$GROUP"
GID="$(dscl . -read "/Groups/$GROUP" PrimaryGroupID | awk '{print $2}')"
if ! id "$KEEPER" >/dev/null 2>&1; then
  # a system account's id is below 500: the first one free from 400
  used="$(dscl . -list /Users UniqueID | awk '{print $2}')"
  KUID=400
  while echo "$used" | grep -qx "$KUID"; do KUID=$((KUID + 1)); done
  [ "$KUID" -lt 500 ] || { echo "no free system user id below 500" >&2; exit 1; }
  dscl . -create "/Users/$KEEPER"
  dscl . -create "/Users/$KEEPER" UniqueID "$KUID"
  dscl . -create "/Users/$KEEPER" PrimaryGroupID "$GID"
  dscl . -create "/Users/$KEEPER" UserShell /usr/bin/false
  dscl . -create "/Users/$KEEPER" NFSHomeDirectory /var/empty
  dscl . -create "/Users/$KEEPER" RealName "OpenFilm keeper"
  dscl . -create "/Users/$KEEPER" IsHidden 1
  dscl . -create "/Users/$KEEPER" Password '*'
fi

echo "2. $AGENT in $GROUP"
dseditgroup -o edit -a "$AGENT" -t user "$GROUP"

echo "3. $PROJECTS"
mkdir -p "$PROJECTS" "$PROJECTS/.openfilm-originals" "$PROJECTS/.openfilm-trash"
chown "$KEEPER:$GROUP" "$PROJECTS"
chmod 3775 "$PROJECTS"
chown root:wheel "$PROJECTS/.openfilm-originals" "$PROJECTS/.openfilm-trash"
chmod 700 "$PROJECTS/.openfilm-originals" "$PROJECTS/.openfilm-trash"
# the guardian runs the checkout's code as root: writable by root alone, never by the agent
if [ "$(stat -f %Su "$REPO")" = "$AGENT" ] || sudo -u "$AGENT" test -w "$REPO/packages/openfilm/studio/server/originals.mjs"; then
  echo "   WARNING: $AGENT can write $REPO, the guardian's code, which runs as root. Keep the checkout root's (e.g. /opt/filmmaker)." >&2
fi

echo "4. $LABEL"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
sed -e "s|@KEEPER@|$KEEPER|g" -e "s|@GROUP@|$GROUP|g" -e "s|@PROJECTS@|$PROJECTS|g" -e "s|@NODE@|$NODE|g" -e "s|@REPO@|$REPO|g" \
  "$REPO/deploy/macos/$LABEL.plist" > "$PLIST"
chown root:wheel "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null
launchctl bootout "system/$LABEL" 2>/dev/null || true
launchctl bootstrap system "$PLIST"
launchctl enable "system/$LABEL"
launchctl kickstart -k "system/$LABEL"

echo "5. what would undo it"
warn=0
if dsmemberutil checkmembership -U "$AGENT" -G admin 2>/dev/null | grep -q 'is a member'; then
  echo "   PROBLEM: $AGENT is an administrator: with sudo it can undo everything. Make it a Standard user." >&2; warn=1
fi
if sudo -l -U "$AGENT" 2>/dev/null | grep -q 'may run'; then
  echo "   PROBLEM: $AGENT has sudo rights (sudo -l -U $AGENT). Remove them." >&2; warn=1
fi
if [ -f /var/root/.ssh/authorized_keys ]; then
  echo "   NOTE: root has SSH keys in /var/root/.ssh/authorized_keys: make sure none is the agent's." >&2
fi

echo
sleep 2
tail -n 3 /var/log/openfilm-guard.log 2>/dev/null || true
echo
echo "Done. The agent ($AGENT) makes projects in $PROJECTS; its media there become originals it cannot change."
echo "Check it: sudo $REPO/deploy/macos/check.sh --agent $AGENT --projects $PROJECTS"
[ "$warn" -eq 0 ] || exit 1
