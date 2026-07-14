# PR Rollout Tracker

Refreshes a rollout tracker JSON from GitHub, appends newly opened PRs, and generates a Slack-ready client update.

It works against any GitHub repo you can read. Point it at one with `--repo`:

```bash
node tools/pr-rollout-tracker/index.mjs --repo owner/name
# a full URL works too
node tools/pr-rollout-tracker/index.mjs --repo https://github.com/owner/name
```

## What It Updates

- Refreshes tracked PR titles, URLs, and status from GitHub
- Sets each synced row's **`date`** from the latest commit author date in the PR's commit list, not from PR open time, approval time, or merge time. Falls back to the previous `date` or PR `created_at` if PR commits cannot be read.
- Marks open PRs as `Approved` only when all required reviewers have approved
- Marks merged PRs as `Merged` when GitHub has `merged_at` (code landed on that PR's **base branch**, usually **`dev`**). **Slack** labels that block **"MERGED TO DEV (NOT PRODUCTION)"** so it is not confused with a production release.
- Preserves manual `Hold` on open PRs until merged
- **Closed without merge** (`state: closed`, no `merged_at`): main-repo PRs are **dropped from the saved JSON** on the next sync. Rows pointing at **other repos** are **kept** as manual entries.
- Adds any newly opened PRs not already in the tracker (see draft/bot rules below)
- Defaults new PRs to `Medium` priority
- Infers a platform bucket from changed files and PR text
- Records who approved each PR in `approvedBy`
- Persists `baseRef` and **`draft`** on synced rows

### Open PR discovery

- Open PRs are loaded across all base branches, so stacked PRs targeting feature branches can be appended and tracked.
- The **Slack message** only lists PRs targeting the tracked base branch (`--track-base`, default `dev`): rows with another `baseRef` or titles like `dev -> staging` are omitted from the Slack text (they can stay in JSON for your records). PR rows for **other GitHub repos** are still included.
- **Draft** PRs are **omitted from Slack** even when already in your tracker JSON.

### Other repositories

If a row's `url` points at an `OWNER/REPO` that **differs** from `--repo`, that row is **left exactly as in your JSON** — no GitHub API calls. This lets you keep PRs from repos you have no API access to and update title/status by hand. Those PR numbers are **not** reused for auto-append from the main repo.

### New PRs (auto-append)

By default, **draft** PRs and **bot**-authored PRs (`dependabot`, GitHub `app/*`, logins ending in `[bot]` or `-bot`) are **not** appended. To append them anyway, use `--append-include-drafts-and-bots` or set `PR_TRACKER_APPEND_SKIP_DRAFT_BOT=0`.

### Bypass PR numbers (main repo only)

Long-lived or sample PRs can be **ignored entirely**: not written to JSON, not in Slack, never re-added from GitHub.

- **Default**: none, or whatever the profile's `bypassPrs` lists
- **Override**: `--bypass-prs "1234,5678"` or `PR_TRACKER_BYPASS_PRS=1234,5678`
- **Disable**: `PR_TRACKER_BYPASS_PRS=none` (also `off`, `0`, or `false`)

### Slack: hide PRs with a "Do not merge" label

If a row has GitHub **`labels`** stored and any label matches **`Do not merge`** (any spacing / case), that PR is **omitted from the entire Slack message**.

### Slack: hide merges that are already on production

For the **MERGED TO DEV** block only, the script compares each merged PR's **`mergeSha`** to the **`prod`** branch (override with `--prod-branch` or `PR_TRACKER_PROD_BRANCH`). If that commit is **already contained in prod**, the PR is **omitted** so you do not call out work that has shipped. Set **`PR_TRACKER_SKIP_PROD_COMPARE=1`** to skip these calls.

### Slack message

Default output includes **Merged to dev**, **Approved**, and **Pending**, and omits **Hold**. To include Hold:

- `--slack-include-hold`, or `PR_TRACKER_SLACK_INCLUDE_HOLD=1`

Optional section toggles: `--slack-exclude-merged`, `--slack-exclude-approved`, `--slack-exclude-pending`.

The headline date uses **system local time** unless you set `--report-timezone Asia/Ho_Chi_Minh` or `PR_TRACKER_REPORT_TIMEZONE`.

## Required approvers

There is no default — a PR is marked `Approved` once every listed approver has approved. Use GitHub logins:

```bash
--required-approvers "alice,bob"
# or
export PR_TRACKER_REQUIRED_APPROVERS="alice,bob"
```

Or set `requiredApprovers` in the profile.

## Project profile

Per-project settings (platform buckets, reviewer display names, tracked branches) live in a profile.
See `profiles/starter.json`. The tool looks for, in order: `--profile <path>`, `qa-tools.profile.json`
in the working directory, then `profiles/<owner>-<repo>.json`. Without one it auto-detects platform
buckets from the repo's `apps/*` directories.

Useful keys for this tool:

- `requiredApprovers` — logins that must approve before a PR counts as `Approved`
- `devAliases` — map a GitHub author name to the short name your team uses in Slack
- `bypassPrs` — PR numbers to ignore entirely
- `trackBase` / `prodBranch` — branch names, if you do not use `dev` / `prod`

## Usage

```bash
node tools/pr-rollout-tracker/index.mjs \
  --repo owner/name \
  --input ~/Downloads/pr-tracker-backup.json \
  --output ~/Downloads/pr-tracker-backup.json \
  --message-out ~/Downloads/pr-rollout-message.txt \
  --html-out ~/Downloads/pr-tracker-generated.html \
  --required-approvers "alice,bob" \
  --report-timezone Asia/Ho_Chi_Minh \
  --slack-webhook-url https://hooks.slack.com/services/...
```

The Slack message is also printed to stdout.

## End-of-day wrapper (`run-eod.sh`)

```bash
export PR_TRACKER_REPO="owner/name"
export PR_TRACKER_JSON="$HOME/Downloads/pr-tracker-backup.json"
# optional: export PR_TRACKER_MESSAGE_OUT="$HOME/Downloads/pr-rollout-slack.txt"
# optional: export PR_TRACKER_REQUIRED_APPROVERS="alice,bob"
# optional: export PR_TRACKER_REPORT_TIMEZONE="Asia/Ho_Chi_Minh"
./tools/pr-rollout-tracker/run-eod.sh
```

If `GITHUB_TOKEN` / `GH_TOKEN` are unset and `gh` is installed, the script runs `gh auth token` and exports `GITHUB_TOKEN`.

Extra CLI flags can be passed after the script name:

```bash
./tools/pr-rollout-tracker/run-eod.sh --html-out "$HOME/Downloads/pr-tracker-generated.html"
```

## Scheduling

A daily run works well from `cron`:

```cron
30 17 * * * PR_TRACKER_REPO=owner/name PR_TRACKER_JSON=$HOME/Downloads/pr-tracker-backup.json /path/to/qa-tools/tools/pr-rollout-tracker/run-eod.sh >>$HOME/Library/Logs/pr-rollout-tracker.log 2>&1
```

On macOS a `launchd` agent with a `StartCalendarInterval` block does the same thing and survives reboots.

## Authentication

For public repositories the GitHub API works without a token, but rate limits are low. For private repositories a token is required. Set `GITHUB_TOKEN` or `GH_TOKEN`.

To auto-send the generated message, set `SLACK_WEBHOOK_URL` or pass `--slack-webhook-url`.

## Verify Slack format (fixture)

```bash
node tools/pr-rollout-tracker/verify-slack-format.mjs
```

Asserts the generator still matches the expected layout for a fixed dataset.

## Help

```bash
node tools/pr-rollout-tracker/index.mjs --help
```
