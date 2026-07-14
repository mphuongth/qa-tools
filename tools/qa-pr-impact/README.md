# QA PR Impact

Rule-based CLI that turns a GitHub pull request URL into a QA-focused verification plan.

It intentionally avoids listing code changes. The output is:

- primary areas to verify
- related areas possibly affected
- suggested manual test cases
- a simple confidence level

## Usage

The repo is read from the PR URL, so any GitHub repo you can access works with no setup:

```bash
pnpm qa:pr-impact https://github.com/owner/name/pull/1234
```

## Requirements

- `gh` must be installed
- `gh auth login` must already be completed

## How it works

1. Fetch PR title, body, and changed files with `gh api`
2. Match changed file paths against the profile's `pathRules`
3. Expand matched product areas into related regression areas
4. Fall back to `keywordRules` against the title, body, and unmatched paths
5. Pull suggested manual test cases from `test-cases.json`
6. Render a Markdown-style QA checklist

## Tuning it for your project

With no profile the tool uses `profiles/starter.json`, whose rules cover common
product surfaces (auth, subscription, billing, search, playback). That is enough
to get a sensible answer on an unfamiliar repo, but the results get much better
once you describe your own codebase.

Copy `profiles/starter.json` and edit two lists:

- `pathRules` — glob patterns mapped to QA areas. This drives the high-confidence matches.
- `keywordRules` — fallback matches when no path rule fires.

Point the tool at it explicitly:

```bash
node tools/qa-pr-impact/index.mjs <pr-url> --profile ./my-project.profile.json
```

Or drop it at `qa-tools.profile.json` in your working directory, or at
`profiles/<owner>-<repo>.json`, and it is picked up automatically.

Area names used in your rules must match the keys in `test-cases.json` for test
cases to be suggested; add your own areas to that file as you go.

Keep the output focused. Too many areas or too many test cases will make the tool noisy and less trustworthy.
