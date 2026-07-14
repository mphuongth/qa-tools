import { execFile as execFileCb } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const CACHE_ROOT = process.env.QA_TOOLS_CACHE_DIR || path.join(os.homedir(), '.cache', 'qa-tools');

/**
 * Platform buckets that hold for any repo, regardless of its app layout.
 * Repo-specific buckets come from the profile or from detectPlatforms().
 */
const UNIVERSAL_PREFIXES = [
  ['.github/workflows/', 'Deployment'],
  ['.devcontainer/', 'Deployment'],
  ['docker/', 'Deployment'],
];

const DEFAULT_PLATFORM_META = {
  Deployment: { key: 'deploy', intro: 'Deployment, CI, and workflow changes.' },
  E2E: { key: 'e2e', intro: 'End-to-end and load-test coverage.' },
  'Unit-test': { key: 'unit-test', intro: 'Unit tests, snapshots, mocks, and test-only tooling changes.' },
  Other: { key: 'other', intro: 'Shared packages, workers, backend plumbing, docs, and mixed-scope work.' },
};

/**
 * Accepts every shape a user might paste: owner/repo, an https or ssh clone URL,
 * or any deep link into the repo (PR, issue, tree).
 */
export function parseRepoRef(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Missing repo. Pass --repo <owner/name or GitHub URL>.');

  const sshMatch = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return buildRepoRef(sshMatch[1], sshMatch[2]);

  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`Invalid repo URL: ${raw}`);
    }
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)/);
    if (!match) throw new Error(`Could not parse a repo out of: ${raw}`);
    return buildRepoRef(match[1], match[2].replace(/\.git$/, ''));
  }

  const slugMatch = raw.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!slugMatch) throw new Error(`Could not parse a repo out of: ${raw}`);
  return buildRepoRef(slugMatch[1], slugMatch[2]);
}

function buildRepoRef(owner, repo) {
  return { owner, repo, slug: `${owner}/${repo}` };
}

/**
 * Profile lookup, most specific first: an explicit path, a file the project
 * drops in its own working directory, then a per-repo file under profiles/.
 */
export async function loadProfile({ profilePath, repoRef, baseDir }) {
  const candidates = [];
  if (profilePath) candidates.push(path.resolve(profilePath));
  if (process.env.QA_TOOLS_PROFILE) candidates.push(path.resolve(process.env.QA_TOOLS_PROFILE));
  candidates.push(path.resolve('qa-tools.profile.json'));
  if (repoRef && baseDir) {
    candidates.push(path.join(baseDir, 'profiles', `${repoRef.owner}-${repoRef.repo}.json`));
  }

  for (const candidate of candidates) {
    try {
      const raw = await readFile(candidate, 'utf8');
      return { ...JSON.parse(raw), profilePath: candidate };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Could not read profile ${candidate}: ${error.message}`);
      }
    }
  }

  if (profilePath) throw new Error(`Profile not found: ${profilePath}`);
  return null;
}

/**
 * Derives platform buckets from the repo's own top-level app directories, so a
 * repo with no profile still produces a grouped report instead of one big
 * "Other" pile. Anything we cannot place falls through to Other by design.
 */
export async function detectPlatforms(repoRef, options = {}) {
  const dirs = await listAppDirs(repoRef, options);
  const prefixes = [];
  const order = [];
  const meta = {};

  for (const dir of dirs) {
    const label = platformLabel(dir);
    prefixes.push([`apps/${dir}/`, label]);
    if (!order.includes(label)) {
      order.push(label);
      meta[label] = { key: slugify(label), intro: `Changes under \`apps/${dir}\`.` };
    }
  }

  for (const [prefix, label] of UNIVERSAL_PREFIXES) {
    prefixes.push([prefix, label]);
    if (!order.includes(label)) order.push(label);
  }

  for (const label of ['E2E', 'Unit-test', 'Other']) {
    if (!order.includes(label)) order.push(label);
  }

  return {
    order,
    prefixes,
    meta: { ...DEFAULT_PLATFORM_META, ...meta },
  };
}

async function listAppDirs(repoRef, options = {}) {
  try {
    const { stdout } = await execFile('gh', ['api', `repos/${repoRef.slug}/contents/apps`], {
      env: githubEnv(options.token),
      maxBuffer: 10 * 1024 * 1024,
    });
    const entries = JSON.parse(stdout);
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry.type === 'dir').map((entry) => entry.name);
  } catch {
    // No apps/ directory, or no API access. A flat repo is a valid shape.
    return [];
  }
}

function platformLabel(dir) {
  if (/e2e|load-test|playwright|cypress/i.test(dir)) return 'E2E';
  const cleaned = dir.replace(/[-_]/g, ' ').trim();
  return cleaned
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Full config for a run: profile values win, detection fills the gaps, and the
 * platform bucket set is always non-empty.
 */
export async function resolveProjectConfig({ repo, profilePath, baseDir, token, detect = true }) {
  const preliminary = await loadProfile({ profilePath, repoRef: null, baseDir });
  const repoInput = repo || preliminary?.repo;
  const repoRef = parseRepoRef(repoInput);
  const profile = (await loadProfile({ profilePath, repoRef, baseDir })) || preliminary || {};

  let platforms = profile.platforms;
  if (!platforms?.prefixes?.length && detect) {
    platforms = await detectPlatforms(repoRef, { token });
  }
  if (!platforms?.order?.length) {
    platforms = { order: ['Other'], prefixes: [...UNIVERSAL_PREFIXES], meta: DEFAULT_PLATFORM_META };
  }

  return {
    repoRef,
    repo: repoRef.slug,
    profilePath: profile.profilePath || null,
    trackBase: profile.trackBase || 'dev',
    prodBranch: profile.prodBranch || 'prod',
    requiredApprovers: profile.requiredApprovers || [],
    devAliases: profile.devAliases || {},
    bypassPrs: profile.bypassPrs || [],
    aggregateRefs: profile.aggregateRefs || [],
    prOverrides: profile.prOverrides || {},
    pathRules: profile.pathRules || [],
    keywordRules: profile.keywordRules || [],
    platforms: {
      order: platforms.order,
      prefixes: platforms.prefixes || [],
      meta: { ...DEFAULT_PLATFORM_META, ...(platforms.meta || {}) },
    },
  };
}

/**
 * prod-delivery-summary reads git history rather than the API, so a URL-only
 * invocation needs a local clone. Cached per repo and refreshed on reuse.
 */
export async function ensureLocalClone(repoRef, options = {}) {
  const target = path.join(CACHE_ROOT, `${repoRef.owner}-${repoRef.repo}`);
  const cloneUrl = `https://github.com/${repoRef.slug}.git`;
  const hasToken = Boolean(options.token);

  let cloned = false;
  try {
    await access(path.join(target, '.git'));
    cloned = true;
  } catch {
    cloned = false;
  }

  try {
    if (cloned) {
      await execFile('git', ['-C', target, 'fetch', '--all', '--prune', '--quiet'], {
        env: githubEnv(options.token),
        maxBuffer: 64 * 1024 * 1024,
      });
      return target;
    }

    await mkdir(CACHE_ROOT, { recursive: true });
    await execFile('git', ['clone', '--filter=blob:none', '--no-checkout', cloneUrl, target], {
      env: githubEnv(options.token),
      maxBuffer: 64 * 1024 * 1024,
    });
    return target;
  } catch (error) {
    throw new Error(describeGitFailure(error, repoRef, hasToken));
  }
}

/**
 * git reports a missing repo and an unauthorised one identically, and buries both
 * under "Command failed: git clone …". Say what actually needs doing instead.
 */
function describeGitFailure(error, repoRef, hasToken) {
  const detail = `${error.stderr || ''}\n${error.message || ''}`;

  if (/repository not found|could not read from remote repository/i.test(detail)) {
    return hasToken
      ? `GitHub has no repository at ${repoRef.slug}, or this token cannot see it. Check the name, and that the token has access to private repos in ${repoRef.owner}.`
      : `GitHub has no repository at ${repoRef.slug}. Check the name — and if it is private, sign in first with: gh auth login`;
  }

  if (/authentication failed|invalid username or password|403 forbidden|bad credentials/i.test(detail)) {
    return `GitHub rejected the credentials for ${repoRef.slug}. Refresh them with: gh auth login`;
  }

  if (/could not resolve host|network is unreachable|connection (refused|timed out)/i.test(detail)) {
    return `Cannot reach github.com, so ${repoRef.slug} could not be fetched. Check the network and try again.`;
  }

  if (/not found: git|git: command not found|enoent/i.test(detail) && /spawn git/i.test(detail)) {
    return 'git is not installed, and the delivery summary reads git history. Install git and try again.';
  }

  const firstLine = String(error.stderr || error.message || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^command failed/i.test(line));

  return `Could not sync a local copy of ${repoRef.slug}${firstLine ? `: ${firstLine}` : '.'}`;
}

export function githubEnv(token) {
  const env = { ...process.env };
  if (token) {
    env.GH_TOKEN = token;
    env.GITHUB_TOKEN = token;
  }
  return env;
}

/** Maps a changed file path to a platform bucket using the resolved config. */
export function platformForPath(filePath, platforms) {
  const normalized = String(filePath || '').replace(/^\.\//, '');
  for (const [prefix, label] of platforms.prefixes) {
    if (normalized.startsWith(prefix)) return label;
  }
  if (/(^|\/)(e2e|__e2e__)\//i.test(normalized)) return 'E2E';
  if (/\.(test|spec)\.[jt]sx?$/i.test(normalized) || /(^|\/)__tests__\//.test(normalized)) return 'Unit-test';
  return 'Other';
}
