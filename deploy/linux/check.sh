#!/usr/bin/env bash
# Try to destroy an original as the agent's user, and say what Linux allowed. Makes a project of its own in the projects
# folder (_guard-check), waits for the guardian to keep its clip, attacks it, and removes the project after.
#
#   sudo deploy/linux/check.sh [--agent grokbot] [--projects /srv/films]
set -uo pipefail

AGENT=grokbot
PROJECTS=/srv/films
while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --projects) PROJECTS="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run it with sudo" >&2; exit 1; }
P="$PROJECTS/_guard-check"
as() { runuser -u "$AGENT" -- bash -c "$1" >/dev/null 2>&1; }

rm -rf "$P"
as "umask 002; mkdir -p '$P/assets' && echo '<!doctype html>' > '$P/film.html' && head -c 200000 /dev/urandom > '$P/assets/clip.mp4' && touch -d '1 minute ago' '$P/assets/clip.mp4'" \
  || { echo "$AGENT cannot make a project in $PROJECTS: is it in the folder's group? (log out and in again after setup)"; exit 1; }
before="$(sha256sum "$P/assets/clip.mp4" | cut -d' ' -f1)"
echo "waiting for the guardian to keep the clip..."
for _ in $(seq 1 90); do [ "$(stat -c %U "$P/assets/clip.mp4")" != "$AGENT" ] && break; sleep 1; done
[ "$(stat -c %U "$P/assets/clip.mp4")" != "$AGENT" ] || { echo "FAIL: the guardian did not take the clip (journalctl -u openfilm-guard)"; rm -rf "$P"; exit 1; }

failed=0
attack() { if as "cd '$P'; $1"; then echo "  ALLOWED  $1"; failed=1; else echo "  refused  $1"; fi; }
echo "as $AGENT, against assets/clip.mp4:"
attack 'echo junk > assets/clip.mp4'
attack 'rm -f assets/clip.mp4'
attack 'mv assets/clip.mp4 assets/other.mp4'
attack 'chmod 644 assets/clip.mp4'
attack 'truncate -s 0 assets/clip.mp4'
attack 'cp film.html assets/clip.mp4'
attack 'rm -rf assets'
attack 'mv assets assets.gone'
attack "rm -rf '$PROJECTS/.openfilm-originals'"
attack 'sudo -n true'
echo "as $AGENT, normal work (should be allowed):"
ok() { if as "cd '$P'; $1"; then echo "  allowed  $1"; else echo "  REFUSED  $1"; failed=1; fi; }
ok 'head -c 1000 /dev/urandom > assets/new.mp4'
ok 'rm -f assets/new.mp4'
ok 'mkdir -p work && cp assets/clip.mp4 work/piece.mp4'
ok "echo '<!doctype html><p>edit' > film.html"

after="$(sha256sum "$P/assets/clip.mp4" | cut -d' ' -f1)"
[ "$before" = "$after" ] && echo "the clip is byte for byte as it came in" || { echo "FAIL: the clip changed"; failed=1; }
rm -rf "$P"
[ "$failed" -eq 0 ] && echo "PASS" || { echo "FAIL"; exit 1; }
