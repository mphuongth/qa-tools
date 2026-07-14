#!/usr/bin/env bash
# End-of-day: refresh external tracker JSON and write Slack message text.
# Run from any directory; resolves the tools root from this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

JSON_FILE="${PR_TRACKER_JSON:-$HOME/Downloads/pr-tracker-backup.json}"
MESSAGE_OUT="${PR_TRACKER_MESSAGE_OUT:-${JSON_FILE%.json}-slack-message.txt}"

if [[ -z "${GITHUB_TOKEN:-}" && -z "${GH_TOKEN:-}" ]] && command -v gh >/dev/null 2>&1; then
  export GITHUB_TOKEN="$(gh auth token)"
fi

user_args=("$@")
set -- node "$SCRIPT_DIR/index.mjs" \
  --input "$JSON_FILE" \
  --output "$JSON_FILE" \
  --message-out "$MESSAGE_OUT"

if [[ -n "${PR_TRACKER_REPO:-}" ]]; then
  set -- "$@" --repo "$PR_TRACKER_REPO"
fi
if [[ -n "${PR_TRACKER_REQUIRED_APPROVERS:-}" ]]; then
  set -- "$@" --required-approvers "$PR_TRACKER_REQUIRED_APPROVERS"
fi

if [[ -n "${PR_TRACKER_REPORT_TIMEZONE:-}" ]]; then
  set -- "$@" --report-timezone "$PR_TRACKER_REPORT_TIMEZONE"
fi
if [[ "${PR_TRACKER_SLACK_INCLUDE_HOLD:-}" == "1" ]]; then
  set -- "$@" --slack-include-hold
fi
if [[ "${PR_TRACKER_APPEND_SKIP_DRAFT_BOT:-1}" == "0" ]]; then
  set -- "$@" --append-include-drafts-and-bots
fi

if [[ ${#user_args[@]} -gt 0 ]]; then
  set -- "$@" "${user_args[@]}"
fi
"$@"
