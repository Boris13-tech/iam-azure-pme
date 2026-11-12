#!/usr/bin/env bash
# The authorized release of a Production operation (database activation, code deploy): one commit, named twice by the
# operator (a release tag or the commit itself, and the full SHA), and accepted only if:
#   - the SHA is a full 40-character lowercase commit SHA;
#   - the release is that same SHA, or a tag that resolves (annotated tags peeled) to exactly that commit, now;
#   - the commit is on main (main is it or descends from it);
#   - the latest completed CI run of that commit on main (push) succeeded.
# Read-only: GitHub API through `gh api` (GH_TOKEN, REPO=owner/name). Inputs arrive as arguments, never interpolated
# into the workflow script. On success it prints key=value lines (release, sha, ci_run_id, ci_run_url); on any doubt it
# prints "REFUSED: ..." and exits 1. Run again after the approval, so that a tag moved meanwhile stops the operation.
set -euo pipefail

release="${1:-}"
sha="${2:-}"
refuse() { echo "REFUSED: $*"; exit 1; }

[[ -n "${REPO:-}" ]] || refuse "REPO is not set"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || refuse "sha must be a full 40-character lowercase commit SHA"
if [[ "$release" =~ ^[0-9a-f]{40}$ ]]; then
  [[ "$release" == "$sha" ]] || refuse "release $release is not the authorized sha $sha"
  commit="$release"
else
  # A tag name only: no path, no option, no expression.
  [[ "$release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || refuse "release must be a tag name or a full commit SHA"
  answer="$(gh api "repos/$REPO/git/ref/tags/$release" --jq '.object.type + " " + .object.sha')" \
    || refuse "tag $release cannot be read"
  read -r kind object <<< "$answer"
  # An annotated tag points to a tag object: follow it, a bounded number of times.
  for _ in 1 2 3 4; do
    [[ "${kind:-}" == "tag" ]] || break
    answer="$(gh api "repos/$REPO/git/tags/$object" --jq '.object.type + " " + .object.sha')" \
      || refuse "tag object $object of $release cannot be read"
    read -r kind object <<< "$answer"
  done
  [[ "${kind:-}" == "commit" ]] || refuse "tag $release does not point to a commit"
  [[ "${object:-}" == "$sha" ]] || refuse "tag $release points to ${object:-nothing}, not to the authorized sha $sha"
  commit="$object"
fi

status="$(gh api "repos/$REPO/compare/$commit...main" --jq '.status')" || refuse "commit $commit cannot be compared with main"
[[ "$status" == "ahead" || "$status" == "identical" ]] || refuse "commit $commit is not on main (compare: $status)"

run="$(gh api "repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$commit&branch=main&event=push&status=completed&per_page=1" \
  --jq '.workflow_runs[0] // {} | [(.id // "" | tostring), (.head_sha // ""), (.conclusion // "none"), (.html_url // "")] | join(" ")')" \
  || refuse "the CI runs of $commit cannot be read"
read -r run_id run_sha conclusion run_url <<< "$run"
[[ -n "${run_id:-}" && "${run_sha:-}" == "$commit" ]] || refuse "no completed CI run on main for $commit"
[[ "${conclusion:-}" == "success" ]] || refuse "the latest CI run on main for $commit is '${conclusion:-none}', not success"

echo "release=$release"
echo "sha=$commit"
echo "ci_run_id=$run_id"
echo "ci_run_url=${run_url:-}"
