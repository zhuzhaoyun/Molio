#!/bin/sh
# ============================================================
# Molio — container entrypoint (runs as root, then drops privileges)
#
# Why this exists:
#   The daemon MUST run unprivileged — Claude Code CLI refuses to run with
#   --dangerously-skip-permissions as root. But the knowledge-base directory
#   is a bind mount from the host. On Linux a bind mount keeps the host owner's
#   UID/GID, so a container user with a mismatched UID gets EACCES when creating
#   vaults / installing skills. Docker Desktop (Windows/macOS) hides this
#   because its virtiofs share translates perms.
#
# Zero-config fix (linuxserver.io-style PUID/PGID, but auto-detected):
#   The entrypoint reads the ACTUAL owner of the configured vault directory and
#   aligns the runtime user to it — so one-click deploy "just works" with no
#   .env editing, for ANY host uid (1000, 1001, a NAS's 1026, …). Explicit
#   PUID/PGID env vars still win, for unusual layouts.
#
# Flow:
#   1. pick the dir to match: MOLIO_DEFAULT_VAULT_PATH (if set) → /vaults
#   2. resolve effective UID/GID:  PUID/PGID env  >  owner of that dir  >  1000
#   3. align the `molio` user to it (usermod/groupmod -o) + re-own named volumes
#   4. log what we chose, and probe real writability — printing an actionable
#      fix (chown / PUID) if the dir is not writable (e.g. root-owned + 755)
#   5. drop privileges via gosu and exec the real command (still non-root)
# ============================================================
set -eu

# Remember whether the operator set PUID/PGID explicitly (for logging + so an
# explicit override always beats auto-detection).
explicit_puid="${PUID:-}"
explicit_pgid="${PGID:-}"

# --- 1. pick the directory whose owner we should match ---------------------
# The daemon writes to the configured default-vault path; match ITS owner.
# Prefer MOLIO_DEFAULT_VAULT_PATH when it already exists, else the conventional
# /vaults mount. (Whatever host folder the user configured is mounted at /vaults
# by docker-compose, so this always reflects the real documents directory.)
detect_path=""
for cand in "${MOLIO_DEFAULT_VAULT_PATH:-}" /vaults; do
    if [ -n "$cand" ] && [ -d "$cand" ]; then
        detect_path="$cand"
        break
    fi
done

det_uid=""
det_gid=""
if [ -n "$detect_path" ]; then
    det_uid=$(stat -c '%u' "$detect_path" 2>/dev/null || true)
    det_gid=$(stat -c '%g' "$detect_path" 2>/dev/null || true)
fi

# --- 2. resolve effective UID/GID -----------------------------------------
# Priority: explicit env > detected owner > 1000 fallback.
PUID="${PUID:-$det_uid}"
PUID="${PUID:-1000}"
PGID="${PGID:-$det_gid}"
PGID="${PGID:-1000}"

# Never run as root. Claude Code refuses it; and a root-owned mount (typical on
# Docker Desktop, where virtiofs reports root:root but world-writable) is
# perfectly accessible as uid 1000, so fall back instead of becoming root.
if [ "$PUID" = "0" ]; then PUID=1000; fi
if [ "$PGID" = "0" ]; then PGID=1000; fi

# Fail loudly on non-numeric ids rather than silently running with a broken
# user — a silent fallback here just reproduces the EACCES bug.
case "$PUID" in ''|*[!0-9]*) echo "[entrypoint] PUID must be numeric, got: '$PUID'" >&2; exit 1 ;; esac
case "$PGID" in ''|*[!0-9]*) echo "[entrypoint] PGID must be numeric, got: '$PGID'" >&2; exit 1 ;; esac

# --- 3. align the runtime user + re-own app-internal volumes --------------
# `-o` permits a non-unique UID/GID: the base image already has a `node` user at
# UID 1000, and we deliberately allow molio to share it.
groupmod -o -g "$PGID" molio
usermod  -o -u "$PUID" molio

# Named volumes (SQLite db + config, Claude auth) were first populated under the
# build-time UID; re-own so they stay accessible. App-internal → always safe to
# chown (we never chown the user's documents under the vault dir).
chown -R "$PUID:$PGID" /home/molio/.molio /home/molio/.claude

# Deliberately NOT chowning /app (daemon code + node_modules): it is read-only at
# runtime — the daemon only writes to ~/.molio, ~/.claude, the vault dir and /tmp.
# The image build leaves it world-readable, so any runtime uid can read/exec it.
# A recursive chown over tens of thousands of node_modules files added ~minutes
# to cold start and tripped the healthcheck (and could restart-loop on a NAS).

# --- 4. logging + real writability probe ----------------------------------
if [ -n "$explicit_puid" ] || [ -n "$explicit_pgid" ]; then
    echo "[entrypoint] using PUID/PGID from environment → uid=$PUID gid=$PGID"
elif [ -n "$det_uid" ] && [ "$det_uid" != "0" ]; then
    echo "[entrypoint] auto-detected owner of $detect_path (uid=$det_uid gid=$det_gid) → running as molio uid=$PUID gid=$PGID"
elif [ -n "$det_uid" ]; then
    echo "[entrypoint] $detect_path owned by root → running as uid=$PUID gid=$PGID (set PUID/PGID to override)"
else
    echo "[entrypoint] no vault mount found → defaulting to uid=$PUID gid=$PGID"
fi

# Actually try to write AS the runtime user. This catches the one case auto-
# detection cannot fix — a dir whose owner we can't become (e.g. root-owned
# with mode 755) — and turns a later cryptic EACCES into an actionable hint.
# Not fatal: the daemon still starts; vault provisioning degrades gracefully.
if [ -n "$detect_path" ]; then
    if ! gosu molio sh -c 'touch "$1/.molio_perm_probe" && rm -f "$1/.molio_perm_probe"' _ "$detect_path" 2>/dev/null; then
        own=$(stat -c '%u:%g (mode %a)' "$detect_path" 2>/dev/null || echo '?')
        host="${MOLIO_VAULT_PATH:-<宿主机上的知识库目录>}"
        echo "[entrypoint] WARNING: $detect_path is NOT writable by uid=$PUID gid=$PGID" >&2
        echo "[entrypoint]   dir owner: $own" >&2
        echo "[entrypoint]   fix on the HOST:  sudo chown -R $PUID:$PGID \"$host\"" >&2
        echo "[entrypoint]   or set PUID/PGID in .env to the dir owner (stat -c '%u:%g' \"$host\")" >&2
    fi
fi

# --- 5. drop privileges and hand off to CMD (node dist/src/index.js) ------
exec gosu molio "$@"
