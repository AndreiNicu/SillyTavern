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
#
set -euo pipefail

WF_REPO="${WF_REPO:-AndreiNicu/World-Forge}"
WF_REF="${WF_REF:-main}"
CANONICAL_BASE="https://raw.githubusercontent.com/${WF_REPO}/${WF_REF}/contracts"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${ROOT}/contracts"

# The set of shared docs. Keep this list in step with contracts/.
FILES=(MEMORY_CONTRACT.md WORLD_FORGE_SYNC.md)

MODE="sync"
if [[ "${1:-}" == "--check" ]]; then
    MODE="check"
elif [[ -n "${1:-}" ]]; then
    echo "usage: $0 [--check]" >&2
    exit 2
fi

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
