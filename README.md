# QA Tools

QA and release tooling that runs against **any GitHub repo** — as a local web hub or as CLIs.
Point it at a repo and it works, with no per-project code changes.

| Tool | What it does |
| --- | --- |
| [`qa-pr-impact`](tools/qa-pr-impact) | Turns a PR URL into a QA verification plan: areas to test, related regressions, suggested test cases. |
| [`pr-rollout-tracker`](tools/pr-rollout-tracker) | Syncs a rollout tracker from GitHub and writes a Slack-ready client update. |
| [`prod-delivery-summary`](tools/prod-delivery-summary) | Reads git history and produces a production delivery report grouped by platform. |

Need to shrink a screen recording before attaching it to a PR? That lives in
[video-tools](https://github.com/mphuongth/video-tools) — these tools all talk to GitHub, that one does not.

## Requirements

- Node.js 18+
- [`gh`](https://cli.github.com) installed and authenticated (`gh auth login`)

## The hub

```bash
pnpm serve   # http://127.0.0.1:4380
```

Enter a GitHub repo (`owner/name` or a full URL) in the box at the top of the page and every tool
follows it. The choice is saved, so it survives a restart, and can be changed at any time.

To move the hub off port 4380 — it clashes with something, or you want two copies running — set
`QA_TOOLS_PORT`:

```bash
QA_TOOLS_PORT=4381 pnpm serve
```

`prod-delivery-summary` reads git history rather than the API, so the hub clones the selected repo
into a local cache (`~/.cache/qa-tools`) the first time it runs and refreshes it afterwards.

The PR tracker keeps **one file per repo**, also under that cache —
`~/.cache/qa-tools/pr-tracker/<owner>-<name>.json` — so switching repos never mixes their PRs, and
the hub never writes over a tracker some other tool owns. Set `PR_TRACKER_JSON` to pin one location
instead.

## CLI

```bash
# QA plan for a pull request — repo comes from the URL, nothing to configure
node tools/qa-pr-impact/index.mjs https://github.com/owner/name/pull/1234

# Rollout tracker for a repo
node tools/pr-rollout-tracker/index.mjs --repo owner/name

# Delivery summary for the last 3 months (clones the repo into a local cache)
node tools/prod-delivery-summary/index.mjs --repo owner/name --months 3
```

## Project profiles

The tools run on an unfamiliar repo with zero setup: platform buckets are auto-detected from the
repo's `apps/*` directories, and `qa-pr-impact` falls back to the generic rules in
`profiles/starter.json`.

A **profile** makes the output sharper by describing your project. Copy `profiles/starter.json`,
edit it, and save it as either:

- `qa-tools.profile.json` in your working directory (picked up automatically), or
- `profiles/<owner>-<repo>.json` (picked up automatically when `--repo owner/repo` matches), or
- anywhere, passed explicitly with `--profile <path>`

Every key is optional:

| Key | Used by | Purpose |
| --- | --- | --- |
| `repo` | all | Default repo, so you can omit `--repo` |
| `platforms` | tracker, delivery | Platform buckets and the path prefixes that map into them |
| `pathRules` / `keywordRules` | qa-pr-impact | Map changed paths and PR text to QA areas |
| `requiredApprovers` | tracker | Logins that must **all** approve before a PR counts as `Approved` (also settable in the hub UI) |
| `devAliases` | tracker | Short display names for GitHub authors |
| `bypassPrs` | tracker | PR numbers to ignore entirely |
| `aggregateRefs` | delivery | Promotion branches whose merges should not count as delivered work |
| `prOverrides` | delivery | Pin a platform or hand-written description for specific PR numbers |
| `platformKeywords` | delivery | Text hints when file paths do not identify a platform |
| `trackBase` / `prodBranch` | tracker, delivery | Branch names, if you do not use `dev` / `prod` |

## Optional: LLM descriptions

`prod-delivery-summary` writes plain-English PR descriptions. Without an API key it falls back to
heuristics derived from titles and paths. To use an LLM, set `OPENAI_API_KEY` (model overridable via
`PROD_DELIVERY_DESCRIPTION_MODEL`).

## Authentication

Public repos work without a token but hit low rate limits. For private repos set `GITHUB_TOKEN` or
`GH_TOKEN`, or just stay logged in with `gh auth login`.
