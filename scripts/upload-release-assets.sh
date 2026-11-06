#!/usr/bin/env bash
#
# Upload every release asset to OSS, in PARALLEL, and report throughput.
#
# Why parallel: sequentially this took ~60 minutes for ~340MB (GitHub's US
# runners → Guangzhou OSS ≈ 95KB/s per stream), which ran into the 1-hour STS
# session lifetime — run 36685374706 died at minute 60 with
# SecurityTokenExpired after uploading 5 of 8 assets. The transfers are
# independent, so fan out rather than waiting on each stream in turn.
#
# Raising --duration-seconds in sts_oidc.py is the other half of the fix, but
# the role's MaxSessionDuration caps it, so the wall-clock reduction must not
# depend on it.
#
# Why the throughput report: the ~100KB/s we measured is NOT a property of the
# payload. v0.3.56 (09-18) pushed the same three big files (114/118/102MB) at
# 16694KB/s and finished in 20s; v0.3.58 (09-24) managed 67-121KB/s for the
# same 102MB file. That is a ~170x collapse of the runner→Guangzhou path with
# no repo change in between. Whether PARALLELISM can rescue it depends on
# whether the throttle is per-connection (aggregate throughput scales with
# OSS_UPLOAD_PARALLEL → parallel wins) or applied to the whole link
# (aggregate stays flat → parallel buys nothing, and the real fix is OSS
# transfer acceleration). The summary below is what tells those apart, so
# keep it: a future failure should be diagnosable from the log alone.
#
# Required env:
#   TAG                      release tag, e.g. v0.3.59
#   OSS_BUCKET, OSS_ENDPOINT
#   OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_SECURITY_TOKEN
# Optional env:
#   OSS_UPLOAD_PARALLEL      concurrent transfers (default 4)
#
# Usage: upload-release-assets.sh <asset-dir>
#
# Exits non-zero when ANY transfer fails, so the caller aborts before it
# rewrites the channel pointers — a partially uploaded version must never be
# advertised by latest.json / latest*.yml.

set -euo pipefail

: "${TAG:?TAG is required}"
: "${OSS_BUCKET:?OSS_BUCKET is required}"
: "${OSS_ENDPOINT:?OSS_ENDPOINT is required}"
: "${OSS_ACCESS_KEY_ID:?OSS_ACCESS_KEY_ID is required}"
: "${OSS_ACCESS_KEY_SECRET:?OSS_ACCESS_KEY_SECRET is required}"
: "${OSS_SECURITY_TOKEN:?OSS_SECURITY_TOKEN is required}"

ASSET_DIR="${1:?usage: upload-release-assets.sh <asset-dir>}"
PARALLEL="${OSS_UPLOAD_PARALLEL:-4}"

shopt -s nullglob
assets=("${ASSET_DIR}"/*)
if [ "${#assets[@]}" -eq 0 ]; then
  echo "::error::no assets found in ${ASSET_DIR}" >&2
  exit 1
fi

upload_one() {
  local file="$1"
  local filename
  filename=$(basename "$file")
  ossutil cp "$file" "oss://${OSS_BUCKET}/releases/${TAG}/${filename}" \
    --endpoint="${OSS_ENDPOINT}" \
    -i "${OSS_ACCESS_KEY_ID}" \
    -k "${OSS_ACCESS_KEY_SECRET}" \
    -t "${OSS_SECURITY_TOKEN}" \
    --update
}

# In-flight transfers, one "pid|filename|bytes|started_at" entry per stream.
# A single array rather than four kept in lockstep: dropping the finished
# entry then only needs the bash 3.2 empty-array guard in one place.
inflight=()
failed=0
uploaded=0
total_bytes=0
started_at=$SECONDS

finish_oldest() {
  local entry="${inflight[0]}"
  local pid name bytes began status
  IFS='|' read -r pid name bytes began <<EOF
${entry}
EOF

  status=OK
  wait "${pid}" || {
    status=FAIL
    failed=1
  }

  local secs=$((SECONDS - began))
  [ "${secs}" -lt 1 ] && secs=1
  printf '  %-44s %9s KB  %6ss  %8s KB/s  %s\n' \
    "${name}" "$((bytes / 1024))" "${secs}" "$((bytes / secs / 1024))" "${status}"

  # Drop the finished entry. Guarded rather than sliced unconditionally: under
  # `set -u` bash 3.2 (macOS /bin/bash) treats an empty array expansion as an
  # unbound variable, and slicing a 1-element array empties it — which is
  # exactly what OSS_UPLOAD_PARALLEL=1 does.
  if [ "${#inflight[@]}" -gt 1 ]; then
    inflight=("${inflight[@]:1}")
  else
    inflight=()
  fi
}

echo "Uploading ${#assets[@]} assets to oss://${OSS_BUCKET}/releases/${TAG}/ (parallel=${PARALLEL})"

for file in "${assets[@]}"; do
  filename=$(basename "$file")
  bytes=$(wc -c <"${file}" | tr -d ' ')

  upload_one "${file}" &
  inflight+=("$!|${filename}|${bytes}|${SECONDS}")
  uploaded=$((uploaded + 1))
  total_bytes=$((total_bytes + bytes))

  # Keep at most PARALLEL transfers in flight.
  if [ "${#inflight[@]}" -ge "${PARALLEL}" ]; then
    finish_oldest
  fi
done

# Drain whatever is still running. A bare `wait` would swallow the exit status
# of every background transfer, so collect each one explicitly. Guarded because
# the array is legitimately empty when every asset came off in a full window.
while [ "${#inflight[@]}" -gt 0 ]; do
  finish_oldest
done

elapsed=$((SECONDS - started_at))
[ "${elapsed}" -lt 1 ] && elapsed=1

printf 'Total: %s assets, %s KB in %ss → aggregate %s KB/s (parallel=%s, %s KB/s per stream)\n' \
  "${uploaded}" "$((total_bytes / 1024))" "${elapsed}" \
  "$((total_bytes / elapsed / 1024))" "${PARALLEL}" \
  "$((total_bytes / elapsed / 1024 / PARALLEL))"

if [ "$failed" -ne 0 ]; then
  echo "::error::At least one asset upload failed — channel pointers left unchanged" >&2
  exit 1
fi

echo "Uploaded ${uploaded} assets to oss://${OSS_BUCKET}/releases/${TAG}/"
