#!/usr/bin/env bash
# One Production operation at a time, never queued: a new activation or deploy is refused while another run of either
# Production workflow is queued, waiting (for its approval, for example) or in progress. A refused dispatch fails at
# once, with its reason in its own log; GitHub's concurrency group (on the Production jobs) stays as the backstop
# against two dispatches in the same seconds, which then both see each other and both refuse.
# Read-only: GitHub API through `gh api` (GH_TOKEN, REPO=owner/name, RUN_ID = this run, never refused for itself).
set -euo pipefail

refuse() { echo "REFUSED: $*"; exit 1; }
[[ -n "${REPO:-}" ]] || refuse "REPO is not set"
[[ "${RUN_ID:-}" =~ ^[0-9]+$ ]] || refuse "RUN_ID is not set"

others=""
for workflow in production-activation-gate.yml production-deploy.yml; do
  for status in queued waiting requested pending in_progress; do
    found="$(gh api "repos/$REPO/actions/workflows/$workflow/runs?status=$status&per_page=100" \
      --jq '.workflow_runs[]? | "\(.id) \(.name) \(.status) \(.html_url)"')" \
      || refuse "the runs of $workflow cannot be read: refused, since another operation cannot be excluded"
    while read -r id rest; do
      [[ -z "${id:-}" || "$id" == "$RUN_ID" ]] && continue
      others+="$id $rest"$'\n'
    done <<< "$found"
  done
done
if [[ -n "$others" ]]; then
  printf '%s' "$others" | sort -u | sed 's/^/  other Production operation: /'
  refuse "another Production operation is queued, waiting or in progress: let it finish, then dispatch again"
fi
echo "No other Production operation is queued, waiting or in progress"
