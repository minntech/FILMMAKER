#!/usr/bin/env bash
# Set up a Linux machine where an AI agent makes films over SSH, so it can never change, delete, rename or unlock an
# original (the media in a project's assets/): Linux refuses it, whatever the agent runs.
#
#   sudo deploy/linux/setup.sh [--agent grokbot] [--projects /srv/films] [--keeper openfilm-keeper] [--group films]
#
# What it does (each step is safe to run again):
#   1. a group for the projects folder, and the keeper: a system user with no login and no home
#   2. the agent's user in that group (it must exist already: the account the agent signs in with over SSH)
#   3. the projects folder: the keeper's, writable by the group, sticky; beside the projects, the store of kept
#      originals and the trash, the keeper's alone
#   4. the guardian as a systemd service (openfilm-guard.service), started now and at every boot
#   5. checks that would undo all of it: the agent as root, with sudo, or root allowed to sign in over SSH
set -euo pipefail

AGENT=grokbot
PROJECTS=/srv/films
KEEPER=openfilm-keeper
GROUP=films
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --projects) PROJECTS="$2"; shift 2 ;;
    --keeper) KEEPER="$2"; shift 2 ;;
    --group) GROUP="$2"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 1; }
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node is not installed (Node 22.18 or later)" >&2; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || { echo "node $("$NODE" -v) is too old: Node 22.18 or later" >&2; exit 1; }
[ -f "$REPO/packages/openfilm/bin/openfilm.mjs" ] || { echo "not a checkout of the fork: $REPO" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is needed for the guardian's service" >&2; exit 1; }
id "$AGENT" >/dev/null 2>&1 || { echo "no user $AGENT: create the account the agent signs in with first" >&2; exit 1; }
[ "$(id -u "$AGENT")" -ne 0 ] || { echo "$AGENT is root: no permission can hold against root. Give the agent a normal account." >&2; exit 1; }

echo "1. group $GROUP and keeper $KEEPER"
getent group "$GROUP" >/dev/null || groupadd "$GROUP"
id "$KEEPER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$GROUP" "$KEEPER"

echo "2. $AGENT in $GROUP"
usermod -aG "$GROUP" "$AGENT"

echo "3. $PROJECTS"
mkdir -p "$PROJECTS" "$PROJECTS/.openfilm-originals" "$PROJECTS/.openfilm-trash"
chown "$KEEPER:$GROUP" "$PROJECTS" "$PROJECTS/.openfilm-originals" "$PROJECTS/.openfilm-trash"
chmod 3775 "$PROJECTS"
chmod 700 "$PROJECTS/.openfilm-originals" "$PROJECTS/.openfilm-trash"
# the guardian runs the checkout's code: readable by the keeper, writable by root alone, never by the agent
if [ "$(stat -c %U "$REPO")" = "$AGENT" ] || runuser -u "$AGENT" -- test -w "$REPO/packages/openfilm/studio/server/originals.mjs"; then
  echo "   WARNING: $AGENT can write $REPO, the guardian's code. Keep the checkout root's (e.g. in /opt/filmmaker)." >&2
fi

echo "4. openfilm-guard.service"
sed -e "s|@KEEPER@|$KEEPER|g" -e "s|@GROUP@|$GROUP|g" -e "s|@PROJECTS@|$PROJECTS|g" -e "s|@NODE@|$NODE|g" -e "s|@REPO@|$REPO|g" \
  "$REPO/deploy/linux/openfilm-guard.service" > /etc/systemd/system/openfilm-guard.service
systemctl daemon-reload
systemctl enable --now openfilm-guard.service
systemctl restart openfilm-guard.service

echo "5. what would undo it"
warn=0
if id -nG "$AGENT" | tr ' ' '\n' | grep -qxE 'sudo|wheel|admin|root'; then
  echo "   PROBLEM: $AGENT is in an admin group ($(id -nG "$AGENT")): with sudo it can undo everything. Remove it." >&2; warn=1
fi
if sudo -l -U "$AGENT" 2>/dev/null | grep -q 'may run'; then
  echo "   PROBLEM: $AGENT has sudo rights (sudo -l -U $AGENT). Remove them." >&2; warn=1
fi
if sshd -T 2>/dev/null | grep -qiE '^permitrootlogin (yes|without-password|prohibit-password)'; then
  echo "   NOTE: root may sign in over SSH (PermitRootLogin). Make sure the agent's key is not root's." >&2
fi
[ -f /root/.ssh/authorized_keys ] && echo "   NOTE: root has SSH keys in /root/.ssh/authorized_keys: make sure none is the agent's." >&2

echo
systemctl --no-pager --lines=3 status openfilm-guard.service || true
echo
echo "Done. The agent ($AGENT) makes projects in $PROJECTS; its media there become originals it cannot change."
echo "Check it: sudo $REPO/deploy/linux/check.sh --agent $AGENT --projects $PROJECTS"
[ "$warn" -eq 0 ] || exit 1
