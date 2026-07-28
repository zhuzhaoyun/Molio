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
#   The NAS-standard fix (linuxserver.io convention): align the runtime user's
#   UID/GID to the host owner via PUID/PGID, re-own the app-internal named
#   volumes, then drop to that user before exec'ing the real command.
#
# Env:
#   PUID / PGID  UID/GID to run as (default 1000 — the typical first user on
#                Linux/NAS). Set these to the owner of your host vault dir:
#                    stat -c '%u:%g' /path/to/your/vaults
# ============================================================
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Fail loudly (and early) on non-numeric ids rather than silently running with
# a broken user — a silent fallback here just reproduces the EACCES bug.
case "$PUID" in ''|*[!0-9]*) echo "[entrypoint] PUID must be numeric, got: '$PUID'" >&2; exit 1 ;; esac
case "$PGID" in ''|*[!0-9]*) echo "[entrypoint] PGID must be numeric, got: '$PGID'" >&2; exit 1 ;; esac

# Align the runtime user/group with the host owner of the bind mount.
# `-o` permits a non-unique UID/GID: the base image already has a `node` user
# at UID 1000, and we deliberately allow molio to share it.
groupmod -o -g "$PGID" molio
usermod  -o -u "$PUID" molio

# The named volumes (SQLite db + config, Claude auth) were first populated
# while owned by the build-time UID; re-own them so they stay readable/writable
# under the new UID. These are app-internal, so chowning is always safe.
chown -R "$PUID:$PGID" /home/molio/.molio /home/molio/.claude

# /app (the daemon code + node_modules) is read-only at runtime; re-own it too
# for good measure, but don't abort the container if a stray file resists.
chown -R "$PUID:$PGID" /app 2>/dev/null || true

echo "[entrypoint] running as molio (uid=$PUID gid=$PGID)"

# Drop privileges and hand off to the CMD (node dist/src/index.js).
exec gosu molio "$@"
