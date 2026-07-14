#!/usr/bin/env node

import { createServer } from 'node:http';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { ensureLocalClone, parseRepoRef, resolveProjectConfig } from '../../lib/project-config.mjs';
import {
  buildClientSections,
  configureProject as configurePrTracker,
  generateSlackMessage,
} from '../../tools/pr-rollout-tracker/index.mjs';
import {
  buildProdDeliveryReport,
  configureProject as configureProdDelivery,
  renderProdDeliveryMarkdown,
  syncReferenceDescriptionFile,
} from '../../tools/prod-delivery-summary/index.mjs';
import { analyzePullRequest } from '../../tools/qa-pr-impact/index.mjs';

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_PORT = Number(process.env.QA_TOOLS_PORT || process.env.PR_TRACKER_PORT || 4311);
const DEFAULT_HOST = process.env.QA_TOOLS_HOST || process.env.PR_TRACKER_HOST || '127.0.0.1';
const APP_DIR = __dirname;
const TOOLS_UI_DIR = path.join(APP_DIR, 'tools');
const GENERATED_ROOT = path.join(APP_DIR, '.generated');
const LANDING_HTML_PATHS = [path.join(APP_DIR, 'landing.html')];
/** One stylesheet for every page, so the hub and its tools stay one system. */
const CONSOLE_CSS_PATH = path.join(APP_DIR, 'assets', 'console.css');
const SERVER_ERROR_LOG = path.join(GENERATED_ROOT, 'server-error.log');
const HUB_SETTINGS_PATH = path.join(GENERATED_ROOT, 'hub-settings.json');

/**
 * The repo every tool runs against. Set from the UI and persisted, so the hub is
 * not bound to any one project. Env vars only seed the initial value.
 */
let hubSettings = {
  repo: process.env.QA_TOOLS_REPO || '',
  timezone: process.env.PR_TRACKER_REPORT_TIMEZONE || '',
  requiredApprovers: process.env.PR_TRACKER_REQUIRED_APPROVERS || '',
  trackBase: process.env.PR_TRACKER_BASE_BRANCH || 'dev',
};

/**
 * `needsRepo` and `produces` are what the run sheet on the landing page reads:
 * what an instrument needs before it will run, and what it hands you when it does.
 */
const TOOL_CONFIG = {
  prTracker: {
    id: 'pr-tracker',
    title: 'PR Tracking Tool',
    description:
      'Refresh GitHub rollout state, manage your PR list, and generate the client message from selected PRs.',
    icon: 'pr-tracker',
    trackerJson: process.env.PR_TRACKER_JSON || path.join(os.homedir(), 'Downloads', 'pr-tracker-backup.json'),
    needsRepo: true,
    produces: 'Slack update',
  },
  prodDeliverySummary: {
    id: 'prod-delivery-summary',
    title: 'Prod Delivery Summary',
    description:
      'List PRs that reached production for a selected month range, group them by platform, and export a PO-friendly markdown summary.',
    icon: 'prod-delivery-summary',
    defaultMonths: Number(process.env.PROD_DELIVERY_DEFAULT_MONTHS || 6),
    needsRepo: true,
    produces: 'Markdown report',
  },
  qaPrImpact: {
    id: 'qa-pr-impact',
    title: 'QA PR Impact',
    description:
      'Paste a GitHub PR link and get a QA-focused verification plan: primary areas, related regression areas, and suggested manual test cases.',
    icon: 'qa-pr-impact',
    needsRepo: false,
    produces: 'Test plan',
  },
};

const TOOL_DEFINITIONS = [
  {
    ...TOOL_CONFIG.prTracker,
    slug: 'pr-tracker',
    generatedDir: path.join(GENERATED_ROOT, 'pr-tracker'),
    htmlPaths: toolHtmlPaths('pr-tracker'),
    command: 'pnpm serve',
  },
  {
    ...TOOL_CONFIG.prodDeliverySummary,
    slug: 'prod-delivery-summary',
    generatedDir: path.join(GENERATED_ROOT, 'prod-delivery-summary'),
    htmlPaths: toolHtmlPaths('prod-delivery-summary'),
    command: 'pnpm serve',
  },
  {
    ...TOOL_CONFIG.qaPrImpact,
    slug: 'qa-pr-impact',
    generatedDir: path.join(GENERATED_ROOT, 'qa-pr-impact'),
    htmlPaths: toolHtmlPaths('qa-pr-impact'),
    command: 'pnpm serve',
  },
];

const TOOL_BY_ID = new Map(TOOL_DEFINITIONS.map((tool) => [tool.id, tool]));
const TOOL_BY_SLUG = new Map(TOOL_DEFINITIONS.map((tool) => [tool.slug, tool]));
const PR_TRACKER_GENERATED_DIR = TOOL_BY_ID.get('pr-tracker').generatedDir;
const PR_TRACKER_STATE_PATH = path.join(PR_TRACKER_GENERATED_DIR, 'dashboard-state.json');
const PR_TRACKER_MESSAGE_PATH = path.join(PR_TRACKER_GENERATED_DIR, 'latest-message.txt');
const PR_TRACKER_SETTINGS_PATH = path.join(PR_TRACKER_GENERATED_DIR, 'settings.json');
const PROD_DELIVERY_GENERATED_DIR = TOOL_BY_ID.get('prod-delivery-summary').generatedDir;
const PR_TRACKER_AUTO_SYNC_ENABLED = normalizeBooleanEnv(process.env.PR_TRACKER_AUTO_SYNC_ENABLED, true);
const PR_TRACKER_AUTO_SYNC_TIME = normalizeScheduleTime(process.env.PR_TRACKER_AUTO_SYNC_TIME || '17:30');

const REVIEWER_CACHE_TTL_MS = 5 * 60 * 1000;
/** repo slug -> { at, payload } for the approver picker. */
const reviewerCandidateCache = new Map();
/** lowercased login -> canonical GitHub login, or null when GitHub says it does not exist. */
const validatedLogins = new Map();

let prTrackerSyncPromise = null;
let prTrackerAutoSyncTimer = null;
const prTrackerAutoSyncState = {
  enabled: PR_TRACKER_AUTO_SYNC_ENABLED,
  time: PR_TRACKER_AUTO_SYNC_TIME,
  timezone: hubSettings.timezone,
  nextRunAt: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastError: '',
};

async function main() {
  await mkdir(GENERATED_ROOT, { recursive: true });
  await Promise.all(TOOL_DEFINITIONS.map((tool) => mkdir(tool.generatedDir, { recursive: true })));
  await loadHubSettings();
  prTrackerAutoSyncState.timezone = hubSettings.timezone;
  await loadPrTrackerAutoSyncSettings();
  startPrTrackerAutoSyncScheduler();
  const server = createServer(handleRequest);
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    process.stdout.write(`QA tools hub: http://${DEFAULT_HOST}:${DEFAULT_PORT}\n`);
    process.stdout.write(hubSettings.repo ? `Repo: ${hubSettings.repo}\n` : 'No repo selected yet — set one in the UI.\n');
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const toolPage = resolveToolPage(url.pathname);
    const toolApi = resolveToolApi(url.pathname);

    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, await readFirstExisting(LANDING_HTML_PATHS, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && toolPage) {
      return send(res, 200, await readFirstExisting(toolPage.htmlPaths, 'utf8'), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/assets/console.css') {
      return send(res, 200, await readFile(CONSOLE_CSS_PATH, 'utf8'), 'text/css; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/tools') {
      return sendJson(res, 200, buildToolsPayload());
    }

    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') return sendJson(res, 200, hubSettings);
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await saveHubSettings(body || {}));
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/reviewers') {
      return sendJson(res, 200, await buildReviewerCandidates());
    }

    if (toolApi) {
      const payload = await handleToolApi(toolApi, req, url);
      if (payload !== null) {
        return sendJson(res, 200, payload);
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    // Bad input from the UI (an unknown login, say) is a 400, not a server fault.
    return sendJson(res, error.status || 500, { error: error.message || 'Unexpected error' });
  }
}

function toolHtmlPaths(slug) {
  return [path.join(TOOLS_UI_DIR, slug, 'dashboard.html')];
}

async function loadHubSettings() {
  const saved = await readJsonIfExists(HUB_SETTINGS_PATH);
  if (saved && typeof saved === 'object') {
    hubSettings = { ...hubSettings, ...saved };
  }
  return hubSettings;
}

async function saveHubSettings(patch) {
  const next = { ...hubSettings };

  if (patch.repo !== undefined) {
    const raw = String(patch.repo).trim();
    // Accept a full GitHub URL or owner/name; store the canonical slug.
    next.repo = raw ? parseRepoRef(raw).slug : '';
  }
  if (patch.timezone !== undefined) next.timezone = String(patch.timezone).trim();
  if (patch.requiredApprovers !== undefined) {
    // A typo here would silently hold every PR at Pending forever, since a login
    // that cannot approve can never be satisfied. Confirm each one with GitHub
    // and store the casing GitHub itself uses.
    const logins = parseApproverList(patch.requiredApprovers);
    next.requiredApprovers = logins.length ? (await canonicalApproverLogins(logins)).join(',') : '';
  }
  if (patch.trackBase !== undefined) next.trackBase = String(patch.trackBase).trim() || 'dev';

  hubSettings = next;
  await mkdir(GENERATED_ROOT, { recursive: true });
  await writeFile(HUB_SETTINGS_PATH, `${JSON.stringify(hubSettings, null, 2)}\n`, 'utf8');
  return hubSettings;
}

/**
 * Resolves the profile for the repo currently selected in the UI and pushes it
 * into the tool modules, which hold it as module state.
 */
async function activeProjectConfig() {
  if (!hubSettings.repo) {
    throw new Error('No repo selected. Set a GitHub repo at the top of the page first.');
  }

  const config = await resolveProjectConfig({
    repo: hubSettings.repo,
    baseDir: ROOT_DIR,
    token: await resolveGithubToken(),
  });

  configurePrTracker({
    platforms: config.platforms,
    devAliases: config.devAliases,
    trackBase: hubSettings.trackBase || config.trackBase,
  });
  configureProdDelivery(config);

  return config;
}

/** prod-delivery-summary reads git history, so it needs a working copy of the repo. */
async function activeRepoPath(config) {
  return ensureLocalClone(config.repoRef, { token: await resolveGithubToken() });
}

function activeRequiredApprovers(config) {
  const raw = hubSettings.requiredApprovers || (config.requiredApprovers || []).join(',');
  return parseApproverList(raw);
}

/** Accepts a comma string or an array; drops blanks, `@` prefixes, and duplicates. */
function parseApproverList(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Set();
  const logins = [];

  for (const item of items) {
    const login = String(item ?? '').trim().replace(/^@/, '');
    if (!login || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    logins.push(login);
  }

  return logins;
}

/** Rejects logins GitHub does not know, and rewrites the rest to GitHub's own casing. */
async function canonicalApproverLogins(logins) {
  const token = await resolveGithubToken();
  const canonical = [];

  for (const login of logins) {
    const key = login.toLowerCase();

    if (!validatedLogins.has(key)) {
      const user = await githubJson(`/users/${encodeURIComponent(login)}`, token, { allow404: true });
      validatedLogins.set(key, user?.login || null);
    }

    const known = validatedLogins.get(key);
    if (!known) {
      const error = new Error(
        `"${login}" is not a GitHub user. Pick a name from the list, or check the spelling.`,
      );
      error.status = 400;
      throw error;
    }
    canonical.push(known);
  }

  return canonical;
}

/**
 * People who can plausibly be required approvers on the selected repo. Listing
 * collaborators needs a token with push access, so review history from recent
 * PRs backfills the list whenever that call is denied.
 */
async function buildReviewerCandidates() {
  if (!hubSettings.repo) {
    throw new Error('No repo selected. Set a GitHub repo at the top of the page first.');
  }

  const { slug } = parseRepoRef(hubSettings.repo);
  const cached = reviewerCandidateCache.get(slug);
  if (cached && Date.now() - cached.at < REVIEWER_CACHE_TTL_MS) return cached.payload;

  const token = await resolveGithubToken();
  const people = new Map();
  const addPerson = (user, source) => {
    const login = String(user?.login || '').trim();
    if (!login || user.type === 'Bot' || login.endsWith('[bot]')) return;

    const existing = people.get(login.toLowerCase());
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    people.set(login.toLowerCase(), { login, avatarUrl: user.avatar_url || '', sources: [source] });
  };

  const collaborators = await githubJson(`/repos/${slug}/collaborators?per_page=100`, token, {
    allow403: true,
    allow404: true,
  });
  if (Array.isArray(collaborators)) {
    for (const user of collaborators) addPerson(user, 'collaborator');
  }

  const pulls = await githubJson(
    `/repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=30`,
    token,
    { allow404: true },
  );
  const recentPulls = Array.isArray(pulls) ? pulls : [];

  // requested_reviewers rides along on the PR list, so pending review requests
  // cost nothing extra; only the actual reviews need a call per PR.
  for (const pull of recentPulls) {
    for (const user of pull.requested_reviewers || []) addPerson(user, 'requested');
  }

  const reviewPages = await Promise.all(
    recentPulls.slice(0, 15).map((pull) =>
      githubJson(`/repos/${slug}/pulls/${pull.number}/reviews?per_page=100`, token, { allow404: true }).catch(
        () => null,
      ),
    ),
  );
  for (const reviews of reviewPages) {
    if (!Array.isArray(reviews)) continue;
    for (const review of reviews) {
      addPerson(review.user, String(review.state).toUpperCase() === 'APPROVED' ? 'approved' : 'reviewed');
    }
  }

  const payload = {
    repo: slug,
    collaboratorsVisible: Array.isArray(collaborators),
    reviewers: [...people.values()].sort((a, b) => a.login.localeCompare(b.login)),
  };
  reviewerCandidateCache.set(slug, { at: Date.now(), payload });
  return payload;
}

async function githubJson(resource, token, { allow403 = false, allow404 = false } = {}) {
  const url = resource.startsWith('http') ? resource : `https://api.github.com${resource}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'qa-tools-hub',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    if (allow404 && response.status === 404) return null;
    if (allow403 && response.status === 403) return null;
    throw new Error(`GitHub API ${response.status} for ${url}: ${await response.text()}`);
  }

  return response.json();
}

async function readFirstExisting(filePaths, encoding) {
  let lastError;
  for (const filePath of filePaths) {
    try {
      return await readFile(filePath, encoding);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function buildToolsPayload() {
  return {
    tools: TOOL_DEFINITIONS.map((tool) => ({
      id: tool.id,
      title: tool.title,
      description: tool.description,
      href: `/tools/${tool.slug}`,
      command: tool.command,
      icon: tool.icon || tool.id,
      needs: tool.needsRepo ? 'Repo' : 'PR link',
      produces: tool.produces || '',
    })),
  };
}

function resolveToolPage(pathname) {
  const match = String(pathname || '').match(/^\/tools\/([^/]+)$/);
  if (!match) return null;
  return TOOL_BY_SLUG.get(match[1]) || null;
}

function resolveToolApi(pathname) {
  const match = String(pathname || '').match(/^\/api\/tools\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { tool: TOOL_BY_SLUG.get(match[1]) || null, action: match[2] };
}

async function handleToolApi(toolApi, req, url) {
  const { tool, action } = toolApi;
  if (!tool) return null;

  if (tool.id === 'pr-tracker') {
    if (req.method === 'GET' && action === 'state') return buildPrTrackerState();
    if (req.method === 'POST' && action === 'sync') return runPrTrackerSync();
    if (req.method === 'POST' && action === 'update-status') return updatePrTrackerStatus(req);
    if (req.method === 'POST' && action === 'update-priority') return updatePrTrackerPriority(req);
    if (req.method === 'POST' && action === 'update-auto-sync') return updatePrTrackerAutoSync(req);
    return null;
  }

  if (tool.id === 'prod-delivery-summary') {
    if (req.method === 'GET' && action === 'report') return buildProdDeliveryState(url.searchParams);
    if (req.method === 'POST' && action === 'refresh') return refreshProdDeliveryReport(req);
    if (req.method === 'POST' && action === 'export-markdown') return exportProdDeliveryMarkdown(req);
    return null;
  }

  if (tool.id === 'qa-pr-impact') {
    if (req.method === 'POST' && action === 'analyze') return analyzeQaPrImpact(req);
    return null;
  }

  return null;
}

async function analyzeQaPrImpact(req) {
  const config = TOOL_BY_ID.get('qa-pr-impact');
  const body = await readJsonBody(req);
  const prUrl = String(body?.prUrl || '').trim();

  if (!prUrl) {
    throw new Error('Missing PR URL');
  }

  // The repo is read from the PR URL itself, so this tool needs no repo setting.
  const report = await analyzePullRequest(prUrl);
  return report;
}

async function buildProdDeliveryState(searchParams) {
  const tool = TOOL_BY_ID.get('prod-delivery-summary');
  const config = await activeProjectConfig();
  const repoPath = await activeRepoPath(config);
  const query = resolveProdDeliveryQuery(searchParams, tool.defaultMonths);
  const report = await buildProdDeliveryReport({
    repoPath,
    repoSlug: config.repo,
    mode: query.mode,
    months: query.months,
    startMonth: query.startMonth,
    endMonth: query.endMonth,
  });
  return {
    ...report,
    repo: config.repo,
    query,
    markdown: renderProdDeliveryMarkdown(report),
  };
}

async function refreshProdDeliveryReport(req) {
  const tool = TOOL_BY_ID.get('prod-delivery-summary');
  const config = await activeProjectConfig();
  const repoPath = await activeRepoPath(config);
  const body = await readJsonBody(req);
  const query = resolveProdDeliveryQuery(body, tool.defaultMonths);
  await refreshGitRefs(repoPath);
  const initialReport = await buildProdDeliveryReport({
    repoPath,
    repoSlug: config.repo,
    mode: query.mode,
    months: query.months,
    startMonth: query.startMonth,
    endMonth: query.endMonth,
  });
  const syncResult = await syncReferenceDescriptionFile(repoPath, initialReport);
  const report = syncResult.updated
    ? await buildProdDeliveryReport({
      repoPath,
      repoSlug: config.repo,
      mode: query.mode,
      months: query.months,
      startMonth: query.startMonth,
      endMonth: query.endMonth,
      })
    : initialReport;

  return {
    ...report,
    repo: config.repo,
    query,
    markdown: renderProdDeliveryMarkdown(report),
    sync: syncResult,
  };
}

async function refreshGitRefs(repoPath) {
  await execFile('git', ['fetch', 'origin'], {
    cwd: repoPath,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function exportProdDeliveryMarkdown(req) {
  const tool = TOOL_BY_ID.get('prod-delivery-summary');
  const config = await activeProjectConfig();
  const repoPath = await activeRepoPath(config);
  const body = await readJsonBody(req);
  const query = resolveProdDeliveryQuery(body, tool.defaultMonths);
  const report = await buildProdDeliveryReport({
    repoPath,
    repoSlug: config.repo,
    mode: query.mode,
    months: query.months,
    startMonth: query.startMonth,
    endMonth: query.endMonth,
  });
  const markdown = renderProdDeliveryMarkdown(report);
  const suffix =
    query.mode === 'custom'
      ? `${report.range.startMonth}_to_${report.range.endMonth}`
      : query.mode === 'latest-release'
        ? 'latest_release'
        : query.mode === 'today-release'
          ? 'today_release'
      : `last_${query.months}_months`;
  const outputPath = path.join(PROD_DELIVERY_GENERATED_DIR, `prod-delivery-summary-${suffix}.md`);
  await writeFile(outputPath, `${markdown}\n`, 'utf8');
  return {
    ...report,
    query,
    markdown,
    outputPath,
  };
}

function resolveProdDeliveryQuery(source, defaultMonths) {
  const rawMode = readInputValue(source, 'mode');
  const mode =
    rawMode === 'custom'
      ? 'custom'
      : rawMode === 'latest-release'
        ? 'latest-release'
        : rawMode === 'today-release'
          ? 'today-release'
          : 'preset';
  if (mode === 'custom') {
    return {
      mode,
      months: null,
      startMonth: readInputValue(source, 'startMonth'),
      endMonth: readInputValue(source, 'endMonth'),
    };
  }

  if (mode === 'latest-release') {
    return {
      mode,
      months: null,
      startMonth: '',
      endMonth: '',
    };
  }

  if (mode === 'today-release') {
    return {
      mode,
      months: null,
      startMonth: '',
      endMonth: '',
    };
  }

  const requestedMonths = Number(readInputValue(source, 'months'));
  const months = requestedMonths > 0 ? requestedMonths : defaultMonths;
  return {
    mode: 'preset',
    months,
    startMonth: '',
    endMonth: '',
  };
}

function readInputValue(source, key) {
  if (!source) return '';
  if (typeof source.get === 'function') {
    return String(source.get(key) || '').trim();
  }
  return String(source[key] || '').trim();
}

/** Required approvers who have not approved this PR yet. */
function missingApprovers(pr, requiredApprovers) {
  const approved = new Set((Array.isArray(pr.approvedBy) ? pr.approvedBy : []).map((name) => String(name).toLowerCase()));
  return requiredApprovers.filter((name) => !approved.has(String(name).toLowerCase()));
}

async function buildPrTrackerState() {
  const tool = TOOL_BY_ID.get('pr-tracker');
  const config = await activeProjectConfig();
  const requiredApprovers = activeRequiredApprovers(config);
  const tracker = await loadTrackerJson(tool.trackerJson);
  const cachedState = await readJsonIfExists(PR_TRACKER_STATE_PATH);
  const excludeMergedPrNumsOnProd = new Set(cachedState?.excludeMergedPrNumsOnProd || []);
  const boardTracker = tracker.filter(
    (pr) => !(pr.status === 'Merged' && excludeMergedPrNumsOnProd.has(String(pr.num))),
  );
  const clientSections = buildClientSections(tracker, {
    slackRepo: config.repo.toLowerCase(),
    reportTimeZone: hubSettings.timezone,
    excludeMergedPrNumsOnProd,
  });
  const message =
    cachedState?.message ||
    generateSlackMessage(tracker, new Date(), {
      slackRepo: config.repo.toLowerCase(),
      reportTimeZone: hubSettings.timezone,
      excludeMergedPrNumsOnProd,
    });

  const visibleNums = new Set(
    [...clientSections.merged, ...clientSections.approved, ...clientSections.pending, ...clientSections.hold].map((pr) =>
      String(pr.num),
    ),
  );

  return {
    repo: config.repo,
    trackerPath: tool.trackerJson,
    reportTimeZone: hubSettings.timezone,
    autoSync: {
      enabled: prTrackerAutoSyncState.enabled,
      time: prTrackerAutoSyncState.time,
      timezone: prTrackerAutoSyncState.timezone,
      nextRunAt: prTrackerAutoSyncState.nextRunAt,
      lastStartedAt: prTrackerAutoSyncState.lastStartedAt,
      lastFinishedAt: prTrackerAutoSyncState.lastFinishedAt,
      lastError: prTrackerAutoSyncState.lastError,
    },
    requiredApprovers,
    lastSyncAt: cachedState?.generatedAt || null,
    summary: summarize(tracker),
    workingSummary: summarize(boardTracker),
    clientSummary: {
      merged: clientSections.merged.length,
      approved: clientSections.approved.length,
      pending: clientSections.pending.length,
      hold: clientSections.hold.length,
    },
    message,
    prs: boardTracker.map((pr) => ({
      ...pr,
      workVisible: true,
      displayStatus: hasDoNotMergeLabel(pr) ? 'Do not merge' : pr.status,
      approvedBy: Array.isArray(pr.approvedBy) ? pr.approvedBy : [],
      missingApprovers: missingApprovers(pr, requiredApprovers),
      clientVisible: visibleNums.has(String(pr.num)),
      excludedReason: getExcludedReason(pr, excludeMergedPrNumsOnProd),
    })),
    clientSections,
  };
}

async function updatePrTrackerStatus(req) {
  const config = TOOL_BY_ID.get('pr-tracker');
  const body = await readJsonBody(req);
  const num = String(body?.num || '').trim();
  const status = normalizeEditableStatus(body?.status);

  if (!num) {
    throw new Error('Missing PR number');
  }

  if (!status) {
    throw new Error('Invalid status');
  }

  const tracker = await loadTrackerJson(config.trackerJson);
  const index = tracker.findIndex((pr) => String(pr.num) === num);
  if (index === -1) {
    throw new Error(`PR #${num} not found in tracker`);
  }

  tracker[index] = {
    ...tracker[index],
    status,
    clientAppr: status === 'Approved' || status === 'Merged',
    techAppr: status === 'Approved' || status === 'Merged',
  };

  await writeFile(config.trackerJson, `${JSON.stringify(tracker, null, 2)}\n`, 'utf8');
  return buildPrTrackerState();
}

async function updatePrTrackerPriority(req) {
  const config = TOOL_BY_ID.get('pr-tracker');
  const body = await readJsonBody(req);
  const num = String(body?.num || '').trim();
  const prio = normalizeEditablePriority(body?.prio);

  if (!num) {
    throw new Error('Missing PR number');
  }

  if (!prio) {
    throw new Error('Invalid priority');
  }

  const tracker = await loadTrackerJson(config.trackerJson);
  const index = tracker.findIndex((pr) => String(pr.num) === num);
  if (index === -1) {
    throw new Error(`PR #${num} not found in tracker`);
  }

  tracker[index] = {
    ...tracker[index],
    prio,
  };

  await writeFile(config.trackerJson, `${JSON.stringify(tracker, null, 2)}\n`, 'utf8');
  return buildPrTrackerState();
}

async function updatePrTrackerAutoSync(req) {
  const body = await readJsonBody(req);
  const enabled = normalizeBooleanEnv(body?.enabled, prTrackerAutoSyncState.enabled);
  const time = normalizeScheduleTime(body?.time || prTrackerAutoSyncState.time);

  prTrackerAutoSyncState.enabled = enabled;
  prTrackerAutoSyncState.time = time;
  prTrackerAutoSyncState.lastError = '';

  await writeFile(
    PR_TRACKER_SETTINGS_PATH,
    `${JSON.stringify({ autoSync: { enabled, time } }, null, 2)}\n`,
    'utf8',
  );

  if (prTrackerAutoSyncTimer) {
    clearTimeout(prTrackerAutoSyncTimer);
    prTrackerAutoSyncTimer = null;
  }

  if (enabled) {
    scheduleNextPrTrackerAutoSync();
  } else {
    prTrackerAutoSyncState.nextRunAt = null;
  }

  return buildPrTrackerState();
}

async function runPrTrackerSync() {
  return runPrTrackerSyncWithLock('manual');
}

async function runPrTrackerSyncWithLock(trigger) {
  if (prTrackerSyncPromise) {
    await prTrackerSyncPromise;
    return buildPrTrackerState();
  }

  prTrackerSyncPromise = runPrTrackerSyncInternal(trigger);
  try {
    await prTrackerSyncPromise;
  } finally {
    prTrackerSyncPromise = null;
  }

  return buildPrTrackerState();
}

async function runPrTrackerSyncInternal(trigger) {
  const tool = TOOL_BY_ID.get('pr-tracker');
  const config = await activeProjectConfig();
  const token = await resolveGithubToken();
  const env = {
    ...process.env,
    ...(token ? { GITHUB_TOKEN: token } : {}),
  };

  const args = [
    path.join(ROOT_DIR, 'tools', 'pr-rollout-tracker', 'index.mjs'),
    '--input',
    tool.trackerJson,
    '--output',
    tool.trackerJson,
    '--message-out',
    PR_TRACKER_MESSAGE_PATH,
    '--state-out',
    PR_TRACKER_STATE_PATH,
    '--repo',
    config.repo,
    '--track-base',
    hubSettings.trackBase || config.trackBase,
  ];

  const requiredApprovers = activeRequiredApprovers(config);
  if (requiredApprovers.length) {
    args.push('--required-approvers', requiredApprovers.join(','));
  }
  if (hubSettings.timezone) {
    args.push('--report-timezone', hubSettings.timezone);
  }

  await execFile(process.execPath, args, {
    cwd: ROOT_DIR,
    env,
    maxBuffer: 20 * 1024 * 1024,
  });

  if (trigger === 'auto') {
    process.stdout.write(`[pr-tracker:auto-sync] Completed at ${new Date().toISOString()}\n`);
  }
}

async function resolveGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  try {
    const { stdout } = await execFile('gh', ['auth', 'token'], {
      cwd: ROOT_DIR,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || '';
  } catch {
    return '';
  }
}

async function loadPrTrackerAutoSyncSettings() {
  const settings = await readJsonIfExists(PR_TRACKER_SETTINGS_PATH);
  const autoSync = settings?.autoSync || {};

  prTrackerAutoSyncState.enabled = normalizeBooleanEnv(autoSync.enabled, prTrackerAutoSyncState.enabled);
  prTrackerAutoSyncState.time = normalizeScheduleTime(autoSync.time || prTrackerAutoSyncState.time);
}

function startPrTrackerAutoSyncScheduler() {
  if (!prTrackerAutoSyncState.enabled) {
    prTrackerAutoSyncState.nextRunAt = null;
    return;
  }
  scheduleNextPrTrackerAutoSync();
}

function scheduleNextPrTrackerAutoSync() {
  if (prTrackerAutoSyncTimer) {
    clearTimeout(prTrackerAutoSyncTimer);
  }

  const nextRun = getNextScheduledDateTime(prTrackerAutoSyncState.timezone, prTrackerAutoSyncState.time);
  prTrackerAutoSyncState.nextRunAt = nextRun.toISOString();

  const delayMs = Math.max(nextRun.getTime() - Date.now(), 1_000);
  prTrackerAutoSyncTimer = setTimeout(() => {
    void runScheduledPrTrackerSync();
  }, delayMs);
}

async function runScheduledPrTrackerSync() {
  // Nothing to sync until the user picks a repo; reschedule quietly.
  if (!hubSettings.repo) {
    scheduleNextPrTrackerAutoSync();
    return;
  }

  prTrackerAutoSyncState.lastStartedAt = new Date().toISOString();
  prTrackerAutoSyncState.lastError = '';

  try {
    await runPrTrackerSyncWithLock('auto');
    prTrackerAutoSyncState.lastFinishedAt = new Date().toISOString();
  } catch (error) {
    prTrackerAutoSyncState.lastFinishedAt = new Date().toISOString();
    prTrackerAutoSyncState.lastError = error.message || 'Auto sync failed';
    process.stderr.write(`[pr-tracker:auto-sync] ${prTrackerAutoSyncState.lastError}\n`);
  } finally {
    scheduleNextPrTrackerAutoSync();
  }
}

function getNextScheduledDateTime(timezone, time) {
  const [hour, minute] = time.split(':').map((value) => Number(value));
  const nowParts = getTimeZoneParts(new Date(), timezone);
  const todayTarget = zonedDateTimeToUtcDate(
    timezone,
    nowParts.year,
    nowParts.month,
    nowParts.day,
    hour,
    minute,
  );

  if (todayTarget.getTime() > Date.now()) {
    return todayTarget;
  }

  const tomorrow = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day));
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

  return zonedDateTimeToUtcDate(
    timezone,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute,
  );
}

function getTimeZoneParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    // An empty string is not a valid time zone; undefined means "use system local".
    timeZone: timezone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function zonedDateTimeToUtcDate(timezone, year, month, day, hour, minute) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = targetAsUtc;

  for (let index = 0; index < 5; index += 1) {
    const parts = getTimeZoneParts(new Date(guess), timezone);
    const observedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
    const diff = targetAsUtc - observedAsUtc;

    if (Math.abs(diff) < 1_000) {
      break;
    }

    guess += diff;
  }

  return new Date(guess);
}

async function loadTrackerJson(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Tracker file must contain a JSON array: ${filePath}`);
  }
  return parsed;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function normalizeEditableStatus(value) {
  const allowed = new Set(['Pending', 'Approved', 'Merged', 'Hold', 'Closed']);
  const normalized = String(value || '').trim();
  return allowed.has(normalized) ? normalized : '';
}

function normalizeEditablePriority(value) {
  const allowed = new Set(['High', 'Medium', 'Low']);
  const normalized = String(value || '').trim();
  return allowed.has(normalized) ? normalized : '';
}

function normalizeBooleanEnv(value, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeScheduleTime(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(normalized)) return '17:30';
  const [hour, minute] = normalized.split(':').map((part) => Number(part));
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return '17:30';
  return normalized;
}

function summarize(prs) {
  return prs.reduce(
    (acc, pr) => {
      acc.total += 1;
      acc[pr.status] = (acc[pr.status] || 0) + 1;
      return acc;
    },
    { total: 0, Merged: 0, Approved: 0, Pending: 0, Hold: 0, Closed: 0 },
  );
}

function hasDoNotMergeLabel(pr) {
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  return labels.some((label) => /do\s*not\s*merge/i.test(String(label)));
}

function getExcludedReason(pr, excludeMergedPrNumsOnProd) {
  if (hasDoNotMergeLabel(pr)) return 'Do not merge';
  if (/dev\s*[-→—>]\s*staging/i.test(String(pr.title || ''))) return 'Promotion PR';
  if (pr.draft) return 'Draft PR';
  if (String(pr.baseRef || '').trim() && String(pr.baseRef).toLowerCase() !== 'dev') {
    return `Base ${pr.baseRef}`;
  }
  if (pr.status === 'Merged' && excludeMergedPrNumsOnProd.has(String(pr.num))) {
    return 'Already on prod';
  }
  return '';
}

async function readJsonIfExists(filePath) {
  try {
    await access(filePath);
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

main().catch(async (error) => {
  await mkdir(path.dirname(SERVER_ERROR_LOG), { recursive: true });
  await writeFile(SERVER_ERROR_LOG, `${error.stack || error.message}\n`, 'utf8');
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
