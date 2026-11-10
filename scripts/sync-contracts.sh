#!/usr/bin/env bash
#
# Sync the shared contract docs from their canonical home (the World-Forge repo)
# into this fork's contracts/ directory.
#
# Canonical source of truth:
#   https://github.com/AndreiNicu/World-Forge  →  contracts/
#
# The copies here are mirrored read-only; never hand-edit them. Edit the
# canonical file in World-Forge, then run this script to refresh the mirror.
#
# Usage:
#   scripts/sync-contracts.sh            Pull canonical copies into contracts/
#   scripts/sync-contracts.sh --check    Exit non-zero if a copy has drifted
#                                         (used by CI; never writes files)
#
# Env overrides (for testing against a branch/fork):
#   WF_REPO   default: AndreiNicu/World-Forge
#   WF_REF    default: main
#   GITHUB_TOKEN  optional; sent on the directory-listing API call to avoid
#                 the unauthenticated rate limit (CI passes github.token)
#
# Which files are synced is discovered from the canonical contracts/ directory
# (every *.md there except README.md, which is per-repo), so a new contract in
# World-Forge is picked up without editing this script. If the listing can't be
# fetched, the script falls back to FALLBACK_FILES below and says so.
#
set -euo pipefail

WF_REPO="${WF_REPO:-AndreiNicu/World-Forge}"
WF_REF="${WF_REF:-main}"
CANONICAL_BASE="https://raw.githubusercontent.com/${WF_REPO}/${WF_REF}/contracts"
LISTING_URL="https://api.github.com/repos/${WF_REPO}/contents/contracts?ref=${WF_REF}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${ROOT}/contracts"

# Used only when the canonical directory listing is unreachable. It does not
# need to be kept current for new contracts to sync, but keeping it close
# means a listing outage still checks the contracts we know about.
FALLBACK_FILES=(MEMORY_CONTRACT.md WORLD_FORGE_SYNC.md DICE_ORACLE.md BODY_CYCLES.md RPG_STATS.md OUTCOME_AUTHORITY.md RESOLUTION.md)

MODE="sync"
if [[ "${1:-}" == "--check" ]]; then
    MODE="check"
elif [[ -n "${1:-}" ]]; then
    echo "usage: $0 [--check]" >&2
    exit 2
fi

# Discover the shared docs from the canonical contracts/ directory.
discover_files() {
    local auth=()
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
        auth=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
    fi
    local listing
    listing="$(curl -fsSL "${auth[@]+"${auth[@]}"}" -H "Accept: application/vnd.github+json" "$LISTING_URL" 2>/dev/null)" || return 1
    # Direct children only: "path": "contracts/<name>.md" (no further slash).
    printf '%s\n' "$listing" \
        | grep -o '"path": *"contracts/[^"/]*\.md"' \
        | sed -E 's/.*"contracts\/([^"]*)"$/\1/' \
        | grep -vx 'README.md' \
        | sort -u
}

FILES=()
if discovered="$(discover_files)" && [[ -n "$discovered" ]]; then
    while IFS= read -r name; do
        FILES+=("$name")
    done <<< "$discovered"
    echo "discovered ${#FILES[@]} canonical contract(s) in ${WF_REPO}@${WF_REF}: ${FILES[*]}"
else
    echo "warning: could not list ${LISTING_URL} — falling back to the built-in file list" >&2
    FILES=("${FALLBACK_FILES[@]}")
fi

# Mirror files with no canonical counterpart (e.g. a contract removed or renamed
# upstream). Reported, never deleted automatically.
for local_path in "${DEST_DIR}"/*.md; do
    [[ -e "$local_path" ]] || continue
    name="$(basename "$local_path")"
    [[ "$name" == "README.md" ]] && continue
    found=0
    for f in "${FILES[@]}"; do
        [[ "$f" == "$name" ]] && { found=1; break; }
    done
    if [[ "$found" -eq 0 ]]; then
        echo "warning: contracts/${name} has no canonical counterpart in ${WF_REPO}@${WF_REF} — remove it if it was dropped upstream" >&2
    fi
done

drift=0
unreachable=0
for f in "${FILES[@]}"; do
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    if ! curl -fsSL "${CANONICAL_BASE}/${f}" -o "$tmp" 2>/dev/null; then
        # Unreachable is not the same as drift: the canonical contracts/ dir may
        # not be published in World-Forge yet. Warn and skip so this doesn't go
        # red before the World-Forge side lands.
        echo "warning: canonical ${f} unreachable at ${CANONICAL_BASE}/${f} — skipping (is World-Forge contracts/ published?)" >&2
        unreachable=1
        rm -f "$tmp"
        continue
    fi

    local_file="${DEST_DIR}/${f}"
    if [[ "$MODE" == "check" ]]; then
        if [[ ! -f "$local_file" ]] || ! diff -q "$tmp" "$local_file" >/dev/null 2>&1; then
            echo "DRIFT: contracts/${f} differs from canonical ${WF_REPO}@${WF_REF}." >&2
            echo "       run scripts/sync-contracts.sh to update the mirror." >&2
            drift=1
        else
            echo "ok: contracts/${f} matches canonical."
        fi
    else
        cp "$tmp" "$local_file"
        echo "synced: contracts/${f}"
    fi
    rm -f "$tmp"
done

if [[ "$unreachable" -eq 1 && "$MODE" == "check" ]]; then
    echo "note: some canonical files were unreachable; drift not enforced for those." >&2
fi

exit "$drift"
