#!/usr/bin/env bash
# Dispatch docker01-app.yml on ochanuco/chabatake, wait for the run and exit 0
# only when it concluded success.
set -euo pipefail

repo=ochanuco/chabatake
workflow=docker01-app.yml

body=$(jq -n --arg service "$SERVICE" --arg tag "$TAG" --arg request_id "$REQUEST_ID" '{
  ref: "production",
  return_run_details: true,
  inputs: {service: $service, tag: $tag, request_id: $request_id}
}')
dispatched_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for attempt in 1 2 3; do
  if run_id=$(gh api -X POST "repos/$repo/actions/workflows/$workflow/dispatches" --input - \
      --jq '.workflow_run_id // empty' <<<"$body" 2>"$RUNNER_TEMP/dispatch.err"); then
    break
  fi
  cat "$RUNNER_TEMP/dispatch.err" >&2
  if ! grep -q "HTTP 422" "$RUNNER_TEMP/dispatch.err" || (( attempt == 3 )); then
    exit 1
  fi
  sleep 10
done

if [[ -z "$run_id" ]]; then
  for _ in $(seq 12); do
    run_id=$(gh api "repos/$repo/actions/workflows/$workflow/runs?event=workflow_dispatch&created=>=$dispatched_at" 2>/dev/null \
      | jq -r --arg id "$REQUEST_ID" '[.workflow_runs[] | select(.display_title | contains($id))][0].id // empty' || true)
    [[ -n "$run_id" ]] && break
    sleep 10
  done
fi
if [[ -z "$run_id" ]]; then
  echo "::error::dispatched, but no run of $workflow carries request_id $REQUEST_ID"
  exit 1
fi

url="https://github.com/$repo/actions/runs/$run_id"
echo "chabatake run: $url"

# The run's state is read until it completes. A response that cannot be read (GitHub answered the
# first poll right after a dispatch with an empty body) is polled again, not taken as a failed deploy.
deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
status="unread"
conclusion="-"
while :; do
  if state=$(gh api "repos/$repo/actions/runs/$run_id" --jq '"\(.status) \(.conclusion // "-")"' 2>"$RUNNER_TEMP/poll.err") \
      && [[ "$state" =~ ^[a-z_]+\ [a-z_-]+$ ]]; then
    read -r status conclusion <<<"$state"
    [[ "$status" == completed ]] && break
  else
    echo "could not read the state of run $run_id, polling again: ${state:-(empty response)} $(tr '\n' ' ' <"$RUNNER_TEMP/poll.err")" >&2
  fi
  if (( $(date +%s) >= deadline )); then
    conclusion="unknown"
    break
  fi
  sleep "${POLL_SECONDS:-15}"
done

# The failed jobs only add detail to the summary, so failing to list them does not change the result.
if ! failed_jobs=$(gh api "repos/$repo/actions/runs/$run_id/jobs" --paginate \
    --jq '.jobs[] | select(.conclusion == "failure") | .name' 2>"$RUNNER_TEMP/jobs.err"); then
  echo "::warning::could not list the jobs of run $run_id: $(tr '\n' ' ' <"$RUNNER_TEMP/jobs.err")"
  failed_jobs=""
fi

case "$conclusion" in
  success) result="success" ;;
  cancelled) result=$([[ -z "$failed_jobs" ]] && echo "cancelled" || echo "cancelled after a failed job") ;;
  unknown)
    if [[ "$status" == unread ]]; then
      result="unknown: the run's state could not be read for $WAIT_MINUTES min"
    else
      result="unknown: still $status after $WAIT_MINUTES min"
    fi
    ;;
  *) result="$conclusion" ;;
esac

{
  echo "### docker01-app: $SERVICE $TAG"
  echo
  echo "- run: $url"
  echo "- result: $result"
  [[ -n "$failed_jobs" ]] && echo "- failed jobs: $(paste -sd, - <<<"$failed_jobs")"
} >> "$GITHUB_STEP_SUMMARY"

if [[ "$conclusion" != success ]]; then
  echo "::error::docker01-app $SERVICE $TAG: $result ($url)"
  exit 1
fi
