#!/bin/sh
# ============================================================
# Molio — container entrypoint (runs as root, then drops privileges)
#
# Why this exists:
#   The daemon MUST run unprivileged — Claude Code CLI refuses to run with
#   --dangerously-skip-permissions as root. But the knowledge-base directory
#   (/vaults) is a bind mount from the host. On Linux a bind mount keeps the
#   host owner's UID/GID, so a container user with a mismatched UID gets
#   EACCES when creating vaults / installing skills. Docker Desktop
#   (Windows/macOS) hides this because its virtiofs share translates perms.
#
# Zero-config fix (linuxserver.io-style PUID/PGID, but auto-detected):
#   The entrypoint reads the ACTUAL owner of the mounted /vaults and aligns the
#   runtime user to it — so one-click deploy "just works" with no .env editing.
#   Explicit PUID/PGID env vars still win, for unusual layouts (multiple mounts,
#   a root-owned dir, etc.).
#
# Flow:
#   1. resolve effective UID/GID:  PUID/PGID env  >  owner of /vaults  >  1000
#   2. align the `molio` user to that UID/GID (usermod/groupmod -o)
#   3. re-own the app-internal named volumes (db/config, Claude auth)
#   4. drop privileges via gosu and exec the real command (still non-root)
# ============================================================
set -eu

# --- 1. resolve effective UID/GID -----------------------------------------
# Remember whether the operator set PUID/PGID explicitly (for logging + so an
# explicit override always beats auto-detection).
explicit_puid="${PUID:-}"
explicit_pgid="${PGID:-}"

# Auto-detect the owner of the mounted docs dir. This is the host user who owns
# the documents, and matching it is exactly what makes the daemon able to write.
det_uid=""
det_gid=""
if [ -d /vaults ]; then
    det_uid=$(stat -c '%u' /vaults 2>/dev/null || true)
    det_gid=$(stat -c '%g' /vaults 2>/dev/null || true)
fi

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

# --- 2. align the runtime user with the resolved UID/GID ------------------
# `-o` permits a non-unique UID/GID: the base image already has a `node` user
# at UID 1000, and we deliberately allow molio to share it.
groupmod -o -g "$PGID" molio
usermod  -o -u "$PUID" molio

# --- 3. re-own app-internal named volumes ---------------------------------
# First populated while owned by the build-time UID; re-own so SQLite/config and
# Claude auth stay readable/writable under the new UID. App-internal → always
# safe to chown (we never chown the user's /vaults documents).
chown -R "$PUID:$PGID" /home/molio/.molio /home/molio/.claude

# /app (daemon code + node_modules) is read-only at runtime; re-own for good
# measure, but don't abort the container if a stray file resists.
chown -R "$PUID:$PGID" /app 2>/dev/null || true

# --- logging (helps debug permission issues on the NAS) -------------------
if [ -n "$explicit_puid" ] || [ -n "$explicit_pgid" ]; then
    echo "[entrypoint] using PUID/PGID from environment → uid=$PUID gid=$PGID"
elif [ -n "$det_uid" ] && [ "$det_uid" != "0" ]; then
    echo "[entrypoint] auto-detected /vaults owner (uid=$det_uid gid=$det_gid) → running as molio uid=$PUID gid=$PGID"
elif [ -n "$det_uid" ]; then
    echo "[entrypoint] /vaults owned by root; running as uid=$PUID gid=$PGID (set PUID/PGID to override)"
else
    echo "[entrypoint] no /vaults mount found → defaulting to uid=$PUID gid=$PGID"
fi

# --- 4. drop privileges and hand off to CMD (node dist/src/index.js) ------
exec gosu molio "$@"
