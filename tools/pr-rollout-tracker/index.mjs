#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { platformForPath, resolveProjectConfig } from '../../lib/project-config.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_TRACK_BASE = 'dev';
const DEFAULT_PROD_BRANCH = 'prod';
const STATUS_ORDER = ['Merged', 'Approved', 'Pending', 'Hold', 'Closed'];
const PRIORITY_ORDER = ['High', 'Medium', 'Low'];

/**
 * Project-specific knowledge (platform buckets, reviewer display names) lives in
 * the profile. The defaults below are the generic fallback for a repo with no
 * profile: three universal buckets and no name rewriting.
 */
let project = {
  platforms: { order: ['Mobile', 'Web', 'Other'], prefixes: [] },
  devAliases: new Map(),
  trackBase: DEFAULT_TRACK_BASE,
};

export function configureProject({ platforms, devAliases, trackBase } = {}) {
  project = {
    platforms: platforms?.order?.length ? platforms : project.platforms,
    devAliases: devAliases instanceof Map ? devAliases : new Map(Object.entries(devAliases || {})),
    trackBase: String(trackBase || DEFAULT_TRACK_BASE).toLowerCase(),
  };
}

const PLATFORM_ORDER_FALLBACK = ['Mobile', 'Web', 'Other'];
function platformOrder() {
  return project.platforms.order?.length ? project.platforms.order : PLATFORM_ORDER_FALLBACK;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await resolveProjectConfig({
    repo: options.repo || process.env.PR_TRACKER_REPO || '',
    profilePath: typeof options.profile === 'string' ? options.profile : '',
    baseDir: REPO_ROOT,
  });
  const repo = config.repo;
  const trackBase = String(options.trackBase || process.env.PR_TRACKER_BASE_BRANCH || config.trackBase || DEFAULT_TRACK_BASE).toLowerCase();
  configureProject({ platforms: config.platforms, devAliases: config.devAliases, trackBase });
  const trackerPath = path.resolve(options.input || './pr-tracker-backup.json');
  const outputPath = path.resolve(options.output || trackerPath);
  const messageOutPath = options.messageOut ? path.resolve(options.messageOut) : null;
  const htmlOutPath = options.htmlOut ? path.resolve(options.htmlOut) : null;
  const stateOutPath = options.stateOut ? path.resolve(options.stateOut) : null;
  const slackWebhookUrl = options.slackWebhookUrl || process.env.SLACK_WEBHOOK_URL || '';
  const requiredApprovers = parseRequiredApprovers(
    options.requiredApprovers || process.env.PR_TRACKER_REQUIRED_APPROVERS || config.requiredApprovers.join(','),
  );
  const reportTimeZone =
    options.reportTimezone ||
    process.env.PR_TRACKER_REPORT_TIMEZONE ||
    '';
  const slackFilters = buildSlackFilters(options);
  const skipDraftAndBotOnAppend =
    !options.appendIncludeDraftsAndBots && process.env.PR_TRACKER_APPEND_SKIP_DRAFT_BOT !== '0';
  const prodBranch =
    process.env.PR_TRACKER_SKIP_PROD_COMPARE === '1'
      ? ''
      : String(options.prodBranch || process.env.PR_TRACKER_PROD_BRANCH || config.prodBranch || DEFAULT_PROD_BRANCH).trim();
  const bypassPrs = resolveBypassPrSet(options, config.bypassPrs);

  const today = new Date();

  const tracker = await loadTracker(trackerPath);
  const api = createGitHubApi({
    repo,
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  });

  const openPulls = await api.listOpenPulls();
  const openMap = new Map(openPulls.map((pull) => [String(pull.number), pull]));
  const synced = [];
  let nextId = Math.max(0, ...tracker.map((entry) => Number(entry.id) || 0)) + 1;
  const repoNorm = repo.toLowerCase();
  const trackerNums = new Set(tracker.map((e) => String(e.num)));

  for (const entry of tracker) {
    const pullNumber = String(entry.num);
    const entryRepo = repoFromGithubPrUrl(entry.url);
    if (entryRepo && entryRepo !== repoNorm) {
      synced.push({ ...entry });
      continue;
    }

    if (bypassPrs.has(pullNumber)) {
      continue;
    }

    const openPull = openMap.get(pullNumber);

    if (openPull) {
      const createdShort = formatShortDate(openPull.created_at || today);
      const [files, reviews, dateShort] = await Promise.all([
        api.listPullFiles(openPull.number),
        api.listPullReviews(openPull.number),
        shortDateFromPullAuthorCommits(api, openPull.number, createdShort),
      ]);
      synced.push(mergeTrackedEntry(entry, openPull, files, reviews, requiredApprovers, dateShort));
      openMap.delete(pullNumber);
      continue;
    }

    const details = await api.getPull(pullNumber);
    if (!details) {
      process.stderr.write(
        `Warning: PR #${pullNumber} not found on GitHub (404); leaving tracker row unchanged.\n`,
      );
      synced.push({ ...entry });
      continue;
    }

    if (details.state === 'open' && String(details.base?.ref || '').toLowerCase() !== trackBase) {
      const fallbackShort =
        entry.date || formatShortDate(details.created_at || today);
      const [dateShort, reviews] = await Promise.all([
        shortDateFromPullAuthorCommits(api, pullNumber, fallbackShort),
        api.listPullReviews(pullNumber),
      ]);
      synced.push(mergeOpenOtherBaseEntry(entry, details, dateShort, reviews));
      continue;
    }

    const closedDateFallback =
      entry.date || formatShortDate(details.created_at || today);
    const [closedDateShort, closedReviews] = await Promise.all([
      shortDateFromPullAuthorCommits(api, pullNumber, closedDateFallback),
      api.listPullReviews(pullNumber),
    ]);
    const closedOrMerged = mergeClosedEntry(entry, details, closedDateShort, closedReviews);
    if (closedOrMerged.status !== 'Closed') {
      synced.push(closedOrMerged);
    }
  }

  for (const pull of openMap.values()) {
    if (trackerNums.has(String(pull.number))) {
      continue;
    }
    if (bypassPrs.has(String(pull.number))) {
      continue;
    }
    if (skipDraftAndBotOnAppend && shouldSkipPullForAutoAppend(pull)) {
      continue;
    }
    const createdShort = formatShortDate(pull.created_at || today);
    const [files, reviews, dateShort] = await Promise.all([
      api.listPullFiles(pull.number),
      api.listPullReviews(pull.number),
      shortDateFromPullAuthorCommits(api, pull.number, createdShort),
    ]);
    synced.push(createEntryFromPull(pull, files, reviews, nextId++, requiredApprovers, dateShort));
  }

  synced.sort(compareEntries);
  const persisted = synced.filter((entry) => {
    if (entry.status !== 'Closed') return true;
    const urlRepo = repoFromGithubPrUrl(entry.url);
    // Keep manual rows for other GitHub repos (e.g. webhook); only drop closed-unmerged monorepo PRs.
    return Boolean(urlRepo && urlRepo !== repoNorm);
  });

  const [owner, repoName] = repo.split('/');
  const excludeMergedOnProd = await collectMergedPrNumsOnProdBranch(
    api,
    owner,
    repoName,
    prodBranch,
    persisted,
    repoNorm,
  );

  const message = generateSlackMessage(persisted, today, {
    ...slackFilters,
    reportTimeZone,
    slackRepo: repoNorm,
    excludeMergedPrNumsOnProd: excludeMergedOnProd,
  });
  const clientSections = buildClientSections(persisted, {
    ...slackFilters,
    reportTimeZone,
    slackRepo: repoNorm,
    excludeMergedPrNumsOnProd: excludeMergedOnProd,
  });

  await ensureParentDir(outputPath);
  await writeFile(outputPath, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');

  if (messageOutPath) {
    await ensureParentDir(messageOutPath);
    await writeFile(messageOutPath, `${message}\n`, 'utf8');
  }

  if (htmlOutPath) {
    await ensureParentDir(htmlOutPath);
    await writeFile(
      htmlOutPath,
      renderHtmlReport({ repo, prs: persisted, message, generatedAt: today, reportTimeZone }),
      'utf8',
    );
  }

  if (stateOutPath) {
    await ensureParentDir(stateOutPath);
    await writeFile(
      stateOutPath,
      `${JSON.stringify(
        {
          repo,
          generatedAt: today.toISOString(),
          reportTimeZone,
          requiredApprovers,
          trackBase,
          prodBranch,
          slackFilters,
          excludeMergedPrNumsOnProd: [...excludeMergedOnProd],
          summary: buildSummary(persisted),
          clientSections,
          message,
          prs: persisted,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  if (slackWebhookUrl) {
    await postToSlack(slackWebhookUrl, message);
  }

  process.stdout.write(`${message}\n`);
}

/**
 * PR numbers whose merge commit is already contained in `prodBranch` (Slack merged section omits them).
 */
async function collectMergedPrNumsOnProdBranch(api, owner, name, prodBranch, synced, mainRepoNorm) {
  const excluded = new Set();
  if (!prodBranch) return excluded;

  const merged = synced.filter(
    (p) =>
      p.status === 'Merged' &&
      includePrInSlack(p, mainRepoNorm) &&
      repoFromGithubPrUrl(p.url) === mainRepoNorm,
  );

  const pullCache = new Map();
  for (const pr of merged) {
    let sha = String(pr.mergeSha || '').trim();
    if (!sha) {
      if (!pullCache.has(pr.num)) {
        pullCache.set(pr.num, await api.getPull(pr.num));
      }
      const pull = pullCache.get(pr.num);
      sha = String(pull?.merge_commit_sha || '').trim();
    }
    if (!sha) continue;
    try {
      const cmp = await api.compareRefs(sha, prodBranch);
      if (Number(cmp.behind_by) === 0) {
        excluded.add(String(pr.num));
      }
    } catch {
      /* prod missing or compare error — keep PR in Slack */
    }
  }

  return excluded;
}

/** Returns `owner/name` for a github.com pull URL, or null if not parseable. */
function repoFromGithubPrUrl(url) {
  const m = String(url || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

function isDevToStagingTitle(title) {
  return /dev\s*[-→—>]\s*staging/i.test(String(title || '').trim());
}

/** Slack list: main-repo PRs only when targeting `dev` (by baseRef or title); other repos always included. */
function normalizeLabelsField(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && 'name' in x ? String(x.name) : String(x)))
    .map((s) => s.trim())
    .filter(Boolean);
}

function labelsFromPull(pull) {
  const raw = pull?.labels;
  if (!Array.isArray(raw)) return [];
  return raw.map((lab) => String(lab?.name || '').trim()).filter(Boolean);
}

function hasDoNotMergeLabel(pr) {
  const labels = normalizeLabelsField(pr.labels);
  return labels.some((name) => /do\s*not\s*merge/i.test(name));
}

function includePrInSlack(pr, mainRepoNorm) {
  if (hasDoNotMergeLabel(pr)) return false;
  const urlRepo = repoFromGithubPrUrl(pr.url);
  // A PR from a satellite repo is always worth reporting; the filters below only
  // make sense for the repo we track branch-by-branch.
  if (mainRepoNorm && urlRepo && urlRepo !== mainRepoNorm) return true;
  if (isDevToStagingTitle(pr.title)) return false;
  const br = String(pr.baseRef || '').trim().toLowerCase();
  if (br && br !== project.trackBase) return false;
  if (pr.draft) return false;
  return true;
}

function buildSlackFilters(options) {
  const envHold = process.env.PR_TRACKER_SLACK_INCLUDE_HOLD === '1';
  return {
    includeMerged: options.slackExcludeMerged ? false : true,
    includeApproved: options.slackExcludeApproved ? false : true,
    includePending: options.slackExcludePending ? false : true,
    includeHold: options.slackIncludeHold || envHold,
  };
}

function shouldSkipPullForAutoAppend(pull) {
  if (pull.draft) return true;
  const login = String(pull.user?.login || '');
  return isBotLogin(login);
}

function isBotLogin(login) {
  if (!login) return false;
  if (/dependabot/i.test(login)) return true;
  if (/\[bot\]$/i.test(login)) return true;
  if (/-bot$/i.test(login)) return true;
  if (/^app\//i.test(login)) return true;
  return false;
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--input') {
      options.input = next;
      index += 1;
      continue;
    }

    if (arg === '--output') {
      options.output = next;
      index += 1;
      continue;
    }

    if (arg === '--message-out') {
      options.messageOut = next;
      index += 1;
      continue;
    }

    if (arg === '--html-out') {
      options.htmlOut = next;
      index += 1;
      continue;
    }

    if (arg === '--state-out') {
      options.stateOut = next;
      index += 1;
      continue;
    }

    if (arg === '--repo') {
      options.repo = next;
      index += 1;
      continue;
    }

    if (arg === '--profile') {
      options.profile = next;
      index += 1;
      continue;
    }

    if (arg === '--track-base') {
      options.trackBase = next;
      index += 1;
      continue;
    }

    if (arg === '--required-approvers') {
      options.requiredApprovers = next;
      index += 1;
      continue;
    }

    if (arg === '--slack-webhook-url') {
      options.slackWebhookUrl = next;
      index += 1;
      continue;
    }

    if (arg === '--report-timezone') {
      options.reportTimezone = next;
      index += 1;
      continue;
    }

    if (arg === '--slack-include-hold') {
      options.slackIncludeHold = true;
      continue;
    }

    if (arg === '--slack-exclude-merged') {
      options.slackExcludeMerged = true;
      continue;
    }

    if (arg === '--slack-exclude-approved') {
      options.slackExcludeApproved = true;
      continue;
    }

    if (arg === '--slack-exclude-pending') {
      options.slackExcludePending = true;
      continue;
    }

    if (arg === '--append-include-drafts-and-bots') {
      options.appendIncludeDraftsAndBots = true;
      continue;
    }

    if (arg === '--base-branch') {
      options.trackBase = next;
      index += 1;
      continue;
    }

    if (arg === '--prod-branch') {
      options.prodBranch = next;
      index += 1;
      continue;
    }

    if (arg === '--bypass-prs') {
      options.bypassPrs = next;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node tools/pr-rollout-tracker/index.mjs [options]',
      '',
      'Options:',
      '  --input <path>        Source tracker JSON file',
      '  --output <path>       Where to write refreshed tracker JSON',
      '  --message-out <path>  Where to write the generated Slack message',
      '  --html-out <path>     Where to write a static HTML status page',
      '  --state-out <path>    Where to write machine-readable dashboard state JSON',
      '  --repo <owner/name|url>  GitHub repo to inspect. Required unless a profile supplies it.',
      '  --profile <path>      Project profile (default: qa-tools.profile.json, then profiles/<owner>-<repo>.json)',
      '  --track-base <branch> Base branch PRs must target to appear in Slack (default: dev).',
      '                        Env: PR_TRACKER_BASE_BRANCH',
      '  --required-approvers  Comma-separated reviewer names/logins required for Approved',
      '  --slack-webhook-url   Post the generated message to Slack',
      '  --report-timezone     IANA timezone for the Slack headline date (e.g. Asia/Ho_Chi_Minh);',
      '                        default: system local. Env: PR_TRACKER_REPORT_TIMEZONE',
      '  --slack-include-hold  Include the HOLD block (default: off, matches HTML Slack tab).',
      '                        Env: PR_TRACKER_SLACK_INCLUDE_HOLD=1',
      '  --slack-exclude-merged|--slack-exclude-approved|--slack-exclude-pending',
      '                        Omit that section from the Slack message',
      '  --append-include-drafts-and-bots',
      '                        When appending new open PRs, also add drafts and bot PRs',
      '                        (default: skip them). Env: PR_TRACKER_APPEND_SKIP_DRAFT_BOT=0',
      '  --base-branch <name>  Primary rollout base label kept in generated state (default: dev).',
      '                        Open PR discovery scans all base branches. Env: PR_TRACKER_BASE_BRANCH',
      '  --prod-branch <name>  Production branch for Slack: merged PRs whose merge commit is on this',
      '                        branch are omitted from the MERGED TO DEV block (default: prod).',
      '                        Env: PR_TRACKER_PROD_BRANCH. Disable compare: PR_TRACKER_SKIP_PROD_COMPARE=1',
      '  --bypass-prs <nums>   Comma-separated monorepo PR numbers to drop from output and never append.',
      '                        Default: none, or the profile\'s bypassPrs. Env: PR_TRACKER_BYPASS_PRS.',
      '                        Disable bypass: PR_TRACKER_BYPASS_PRS=none (or off/0/false).',
      '  --help                Show this help',
    ].join('\n'),
  );
}

async function loadTracker(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    // First run against a repo: start from an empty tracker rather than failing.
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error(`Tracker file must contain a JSON array: ${filePath}`);
  }

  return parsed.map(normalizeEntry);
}

function normalizeEntry(entry) {
  const devRaw = String(entry.dev || '?').trim() || '?';
  return {
    id: Number(entry.id) || 0,
    num: String(entry.num || '').trim(),
    dev: displayDevName(devRaw),
    date: String(entry.date || '').trim(),
    platform: normalizePlatform(entry.platform),
    title: String(entry.title || '').trim(),
    url: String(entry.url || '').trim(),
    prio: normalizePriority(entry.prio),
    status: normalizeStatus(entry.status),
    clientAppr: Boolean(entry.clientAppr),
    techAppr: Boolean(entry.techAppr),
    approvedBy: Array.isArray(entry.approvedBy) ? entry.approvedBy : [],
    baseRef: String(entry.baseRef || '').trim(),
    mergeSha: String(entry.mergeSha || '').trim(),
    labels: normalizeLabelsField(entry.labels),
    draft: Boolean(entry.draft),
  };
}

function mergeTrackedEntry(entry, pull, files, reviews, requiredApprovers, dateShort) {
  const inferredStatus = inferOpenStatus(entry.status, reviews, requiredApprovers);
  const approvalFlags = approvalFlagsFromReviews(reviews);

  return {
    ...entry,
    title: pull.title,
    url: pull.html_url,
    date: dateShort,
    status: inferredStatus,
    clientAppr: isApprovedState(inferredStatus),
    techAppr: isApprovedState(inferredStatus),
    approvedBy: approvalFlags.approvedBy,
    platform: preserveKnownPlatform(entry.platform, inferPlatform(pull, files)),
    dev: displayDevName(inferDevName(pull)),
    baseRef: String(pull.base?.ref || '').trim(),
    mergeSha: '',
    labels: labelsFromPull(pull),
    draft: Boolean(pull.draft),
  };
}

function mergeClosedEntry(entry, pull, dateShort, reviews = []) {
  const baseRef = String(pull.base?.ref || '').trim();
  const dev = displayDevName(inferDevName(pull));
  const approvalFlags = approvalFlagsFromReviews(reviews);

  if (pull.merged_at) {
    return {
      ...entry,
      title: pull.title || entry.title,
      url: pull.html_url || entry.url,
      date: dateShort,
      status: 'Merged',
      clientAppr: true,
      techAppr: true,
    approvedBy: approvalFlags.approvedBy,
      baseRef,
      dev,
      mergeSha: pull.merge_commit_sha ? String(pull.merge_commit_sha) : '',
      labels: labelsFromPull(pull),
      draft: false,
    };
  }

  if (pull.state === 'closed') {
    return {
      ...entry,
      title: pull.title || entry.title,
      url: pull.html_url || entry.url,
      date: dateShort,
      status: 'Closed',
      clientAppr: false,
      techAppr: false,
    approvedBy: Array.isArray(entry.approvedBy) ? entry.approvedBy : [],
      baseRef,
      dev,
      mergeSha: '',
      labels: labelsFromPull(pull),
      draft: false,
    };
  }

  const status = entry.status === 'Hold' ? 'Hold' : 'Pending';

  return {
    ...entry,
    title: pull.title || entry.title,
    url: pull.html_url || entry.url,
    date: dateShort,
    status,
    clientAppr: isApprovedState(status),
    techAppr: isApprovedState(status),
    approvedBy: Array.isArray(entry.approvedBy) ? entry.approvedBy : [],
    baseRef,
    dev,
    mergeSha: '',
    labels: labelsFromPull(pull),
    draft: Boolean(pull.draft),
  };
}

function mergeOpenOtherBaseEntry(entry, pull, dateShort, reviews = []) {
  const approvalFlags = approvalFlagsFromReviews(reviews);
  return {
    ...entry,
    title: pull.title,
    url: pull.html_url,
    date: dateShort,
    baseRef: String(pull.base?.ref || '').trim(),
    dev: displayDevName(inferDevName(pull)),
    approvedBy: approvalFlags.approvedBy,
    mergeSha: '',
    labels: labelsFromPull(pull),
    draft: Boolean(pull.draft),
  };
}

function createEntryFromPull(pull, files, reviews, id, requiredApprovers, dateShort) {
  const status = inferOpenStatus('Pending', reviews, requiredApprovers);
  const approvalFlags = approvalFlagsFromReviews(reviews);

  return {
    id,
    num: String(pull.number),
    dev: inferDevName(pull),
    date: dateShort,
    platform: inferPlatform(pull, files),
    title: pull.title,
    url: pull.html_url,
    prio: 'Medium',
    status,
    clientAppr: isApprovedState(status),
    techAppr: isApprovedState(status),
    approvedBy: approvalFlags.approvedBy,
    baseRef: String(pull.base?.ref || '').trim(),
    mergeSha: '',
    labels: labelsFromPull(pull),
    draft: Boolean(pull.draft),
  };
}

function compareEntries(left, right) {
  const statusDelta = STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status);
  if (statusDelta !== 0) return statusDelta;

  const prioDelta = PRIORITY_ORDER.indexOf(left.prio) - PRIORITY_ORDER.indexOf(right.prio);
  if (prioDelta !== 0) return prioDelta;

  return Number(right.num) - Number(left.num);
}

function inferOpenStatus(previousStatus, reviews, requiredApprovers) {
  if (previousStatus === 'Hold') return 'Hold';

  const approvers = collectApprovedReviewers(reviews);

  // With no required approvers configured, `every` on an empty list would call
  // every PR approved. Fall back to "at least one approving review" instead.
  const isFullyApproved = requiredApprovers.length
    ? requiredApprovers.every((requiredApprover) => approvers.has(normalizeApprover(requiredApprover)))
    : approvers.size > 0;

  return isFullyApproved ? 'Approved' : 'Pending';
}

/** Records who approved, so the tracker JSON stays readable without hardcoding names. */
function approvalFlagsFromReviews(reviews) {
  return { approvedBy: [...collectApprovedReviewers(reviews)].sort() };
}

/**
 * Votes each changed file into a platform bucket. Profile prefixes win; the
 * filename and title heuristics below only break ties for repos with no profile.
 */
function inferPlatform(pull, files) {
  const title = `${pull.title || ''} ${pull.body || ''}`.toLowerCase();
  const votes = new Map();
  const addVote = (platform, weight) => {
    if (!platform) return;
    votes.set(platform, (votes.get(platform) || 0) + weight);
  };

  for (const file of files) {
    const name = String(file.filename || '').toLowerCase();
    const mapped = project.platforms.prefixes?.length ? platformForPath(name, project.platforms) : '';

    if (mapped && mapped !== 'Other') {
      addVote(mapped, 3);
      continue;
    }

    if (/(^|\/)(ios|android)\/|react-native/.test(name)) addVote('Mobile', 1);
    else if (/next|web|browser/.test(name)) addVote('Web', 1);
    else addVote('Other', 1);
  }

  if (/\b(ios|android|mobile)\b/.test(title)) addVote('Mobile', 1);
  if (/\b(web|browser)\b/.test(title)) addVote('Web', 1);

  let best = 'Other';
  let bestScore = 0;
  for (const platform of platformOrder()) {
    const score = votes.get(platform) || 0;
    if (platform !== 'Other' && score > bestScore) {
      best = platform;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : 'Other';
}

/** Shortens GitHub handles to the names a team actually uses in standup. */
function displayDevName(raw) {
  const s = String(raw || '?').trim() || '?';
  const key = normalizeApprover(s);
  return project.devAliases.get(key) || s;
}

function inferDevName(pull) {
  const raw = pull.user?.name || pull.user?.login || '?';
  const formatted = String(raw)
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return displayDevName(formatted);
}

function collectApprovedReviewers(reviews) {
  const approvers = new Set();

  for (const review of reviews) {
    if (review.state !== 'APPROVED') continue;

    // Identities only. author_association (MEMBER, OWNER, ...) is a role, not a
    // person, and would both pollute approvedBy and falsely satisfy a required approver.
    const candidates = [
      review.user?.login,
      review.user?.name,
    ].filter(Boolean);

    for (const candidate of candidates) {
      approvers.add(normalizeApprover(candidate));
    }
  }

  return approvers;
}

function parseRequiredApprovers(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Comma-separated PR numbers for the main `--repo` only; omitted from JSON and Slack, never auto-appended. */
function parseBypassPrNums(commaList) {
  const set = new Set();
  if (commaList == null || commaList === '') return set;
  for (const part of String(commaList).split(',')) {
    const n = part.trim();
    if (n) set.add(n);
  }
  return set;
}

function resolveBypassPrSet(options, profileBypassPrs = []) {
  if (options.bypassPrs !== undefined) {
    return parseBypassPrNums(options.bypassPrs);
  }
  const envRaw = process.env.PR_TRACKER_BYPASS_PRS;
  if (envRaw !== undefined && envRaw !== '') {
    if (/^(none|off|0|false)$/i.test(String(envRaw).trim())) {
      return new Set();
    }
    return parseBypassPrNums(envRaw);
  }
  return parseBypassPrNums(profileBypassPrs.join(','));
}

function normalizeApprover(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function preserveKnownPlatform(current, inferred) {
  return current && current !== 'Other' ? current : inferred;
}

function normalizePlatform(value) {
  return platformOrder().includes(value) ? value : 'Other';
}

function normalizePriority(value) {
  return PRIORITY_ORDER.includes(value) ? value : 'Medium';
}

function normalizeStatus(value) {
  return STATUS_ORDER.includes(value) ? value : 'Pending';
}

function isApprovedState(status) {
  return status === 'Approved' || status === 'Merged';
}

function formatShortDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  });
}

async function shortDateFromPullAuthorCommits(api, pullNumber, fallbackShortDate) {
  try {
    const commits = await api.listPullCommits(pullNumber);
    const latest = commits
      .map((commit) => commit.commit?.author?.date || commit.commit?.committer?.date || '')
      .filter(Boolean)
      .sort()
      .at(-1);
    return latest ? formatShortDate(latest) : fallbackShortDate;
  } catch {
    return fallbackShortDate;
  }
}

export function generateSlackMessage(prs, today, filterOpts = {}) {
  const { merged, approved, pending, hold } = buildClientSections(prs, filterOpts);
  const lines = [`PRs submitted for rollout (${formatReportDate(today, filterOpts.reportTimeZone || '')})`, ''];

  if (merged.length > 0) {
    lines.push('✅ MERGED TO DEV (NOT PRODUCTION)');
    merged.forEach((pr, index) => lines.push(`${index + 1}. [${pr.dev}] [${pr.date}] ${pr.url} - ${pr.title}`));
    lines.push('');
  }

  if (approved.length > 0) {
    lines.push('✅ APPROVED');
    approved.forEach((pr, index) => lines.push(`${index + 1}. [${pr.dev}] [${pr.date}] ${pr.url} - ${pr.title}`));
    lines.push('');
  }

  if (pending.length > 0) {
    lines.push('❌ NOT APPROVED YET');

    for (const priority of PRIORITY_ORDER) {
      const priorityPulls = pending.filter((pr) => pr.prio === priority);
      if (priorityPulls.length === 0) continue;

      const icon = priority === 'High' ? '🔴' : priority === 'Medium' ? '🟡' : '🟢';
      lines.push(`${icon} ${priority} Priority`);

      for (const platform of platformOrder()) {
        const platformPulls = priorityPulls.filter((pr) => pr.platform === platform);
        if (platformPulls.length === 0) continue;
        lines.push(platform);
        platformPulls.forEach((pr, index) =>
          lines.push(`${index + 1}. [${pr.dev}] [${pr.date}] ${pr.url} - ${pr.title}`),
        );
      }
    }

    lines.push('');
  }

  if (hold.length > 0) {
    lines.push('⏸ HOLD');
    hold.forEach((pr, index) => lines.push(`${index + 1}. [${pr.dev}] [${pr.date}] ${pr.url} - ${pr.title}`));
  }

  return lines.join('\n').trim();
}

export function buildClientSections(prs, filterOpts = {}) {
  const {
    includeMerged = true,
    includeApproved = true,
    includePending = true,
    includeHold = false,
    slackRepo = '',
    excludeMergedPrNumsOnProd = new Set(),
  } = filterOpts;

  const mainRepoNorm = String(slackRepo).toLowerCase();
  const inSlack = (pr) => includePrInSlack(pr, mainRepoNorm);
  const notOnProdSlack = (pr) => !excludeMergedPrNumsOnProd.has(String(pr.num));

  const merged = includeMerged
    ? prs.filter((pr) => pr.status === 'Merged' && inSlack(pr) && notOnProdSlack(pr))
    : [];
  const approved = includeApproved ? prs.filter((pr) => pr.status === 'Approved' && inSlack(pr)) : [];
  const pending = includePending ? prs.filter((pr) => pr.status === 'Pending' && inSlack(pr)) : [];
  const hold = includeHold ? prs.filter((pr) => pr.status === 'Hold' && inSlack(pr)) : [];
  return { merged, approved, pending, hold };
}

export function formatReportDate(date, timeZone = '') {
  const opts = {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  };
  if (timeZone) {
    opts.timeZone = timeZone;
  }
  return date.toLocaleDateString('en-GB', opts);
}

function renderHtmlReport({ repo, prs, message, generatedAt, reportTimeZone = '' }) {
  const counts = STATUS_ORDER.reduce((accumulator, status) => {
    accumulator[status] = prs.filter((pr) => pr.status === status).length;
    return accumulator;
  }, {});

  const rows = prs
    .map(
      (pr) => `
        <tr>
          <td><a href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">#${escapeHtml(pr.num)}</a></td>
          <td>${escapeHtml(pr.dev)}</td>
          <td>${escapeHtml(pr.date)}</td>
          <td>${escapeHtml(pr.platform)}</td>
          <td>${escapeHtml(pr.prio)}</td>
          <td><span class="status status-${pr.status.toLowerCase()}">${escapeHtml(pr.status)}</span></td>
          <td>${escapeHtml(pr.title)}</td>
        </tr>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PR Rollout Tracker</title>
  <style>
    :root {
      --bg: #f4f1eb;
      --card: #ffffff;
      --text: #1e1b18;
      --muted: #6e655c;
      --border: #ddd5cb;
      --merged: #0f9d75;
      --approved: #2c7a4b;
      --pending: #b7791f;
      --hold: #6b7280;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #f9f7f2 0%, #efe9dd 100%);
      color: var(--text);
    }
    .wrap { max-width: 1200px; margin: 0 auto; }
    .hero, .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 20px;
      box-shadow: 0 12px 30px rgba(48, 41, 33, 0.06);
    }
    .hero {
      padding: 28px;
      margin-bottom: 20px;
      display: grid;
      gap: 18px;
    }
    .eyebrow {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
    }
    h1 {
      margin: 0;
      font-size: 34px;
      line-height: 1.1;
    }
    .sub {
      color: var(--muted);
      font-size: 14px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 12px;
    }
    .stat {
      padding: 16px;
      border-radius: 16px;
      background: #faf7f2;
      border: 1px solid var(--border);
    }
    .stat strong {
      display: block;
      font-size: 28px;
      margin-top: 4px;
    }
    .panel {
      padding: 24px;
      margin-bottom: 20px;
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 18px;
    }
    pre {
      margin: 0;
      padding: 18px;
      border-radius: 16px;
      background: #1e1b18;
      color: #f9f7f2;
      overflow: auto;
      white-space: pre-wrap;
      line-height: 1.65;
      font-size: 13px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      text-align: left;
      padding: 12px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    a { color: #1d4ed8; text-decoration: none; }
    .status {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }
    .status-merged { background: rgba(15, 157, 117, 0.12); color: var(--merged); }
    .status-approved { background: rgba(44, 122, 75, 0.12); color: var(--approved); }
    .status-pending { background: rgba(183, 121, 31, 0.12); color: var(--pending); }
    .status-hold { background: rgba(107, 114, 128, 0.12); color: var(--hold); }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div>
        <div class="eyebrow">Repository</div>
        <h1>${escapeHtml(repo)} PR Rollout Tracker</h1>
        <div class="sub">Generated ${escapeHtml(formatReportDate(generatedAt, reportTimeZone))}</div>
      </div>
      <div class="stats">
        <div class="stat">Total<strong>${prs.length}</strong></div>
        <div class="stat">Merged to dev<strong>${counts.Merged}</strong></div>
        <div class="stat">Approved<strong>${counts.Approved}</strong></div>
        <div class="stat">Pending<strong>${counts.Pending}</strong></div>
      </div>
    </section>
    <section class="panel">
      <h2>Slack Message</h2>
      <pre>${escapeHtml(message)}</pre>
    </section>
    <section class="panel">
      <h2>PR Status</h2>
      <table>
        <thead>
          <tr>
            <th>PR</th>
            <th>Dev</th>
            <th>Date</th>
            <th>Platform</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Title</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

function buildSummary(prs) {
  return STATUS_ORDER.reduce((accumulator, status) => {
    accumulator[status] = prs.filter((pr) => pr.status === status).length;
    return accumulator;
  }, {});
}

async function postToSlack(webhookUrl, text) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook ${response.status}: ${body}`);
  }
}

function createGitHubApi({ repo, token }) {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repo: ${repo}`);
  }

  return {
    listOpenPulls: () =>
      paginate(`/repos/${owner}/${name}/pulls?state=open&per_page=100`),
    listPullFiles: (number) => paginate(`/repos/${owner}/${name}/pulls/${number}/files?per_page=100`),
    listPullReviews: (number) => paginate(`/repos/${owner}/${name}/pulls/${number}/reviews?per_page=100`),
    listPullCommits: (number) => paginate(`/repos/${owner}/${name}/pulls/${number}/commits?per_page=100`),
    getPull: (number) => requestJsonAllow404(`/repos/${owner}/${name}/pulls/${number}`),
    compareRefs: (baseRef, headRef) =>
      request(`/repos/${owner}/${name}/compare/${baseRef}...${headRef}`),
  };

  async function paginate(resource) {
    const pages = [];
    let url = resource;

    while (url) {
      const response = await rawRequest(url);
      const payload = await response.json();

      if (!Array.isArray(payload)) {
        throw new Error(`Expected array response from GitHub for ${url}`);
      }

      pages.push(...payload);
      url = parseNextLink(response.headers.get('link'));
    }

    return pages;
  }

  async function request(resource) {
    const response = await rawRequest(resource);
    return response.json();
  }

  async function requestJsonAllow404(resource) {
    const response = await rawRequest(resource, { allow404: true });
    if (!response) return null;
    return response.json();
  }

  async function rawRequest(resource, { allow404 = false } = {}) {
    const url = resource.startsWith('http') ? resource : `https://api.github.com${resource}`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pr-rollout-tracker',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      if (allow404 && response.status === 404) {
        return null;
      }
      const body = await response.text();
      if (response.status === 404 && !token) {
        throw new Error(
          `GitHub API 404 for ${url}. This usually means the repository is private; set GITHUB_TOKEN or GH_TOKEN before running the tracker.`,
        );
      }
      throw new Error(`GitHub API ${response.status} for ${url}: ${body}`);
    }

    return response;
  }
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(',').find((part) => part.includes('rel="next"'));
  if (!match) return null;
  return match.slice(match.indexOf('<') + 1, match.indexOf('>'));
}

const isEntryPoint =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
