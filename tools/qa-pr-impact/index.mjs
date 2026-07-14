#!/usr/bin/env node

import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { resolveProjectConfig } from '../../lib/project-config.mjs';

const execFile = promisify(execFileCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ENTRY_URL = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
const MAX_PRIMARY_AREAS = 5;
const MAX_RELATED_AREAS = 5;
const MAX_TEST_CASES_PER_BUCKET = 6;
const CONFIDENCE_LABELS = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prUrl = options.pr || options._[0];

  if (options.help || options.h) {
    process.stdout.write(
      [
        'Usage: node tools/qa-pr-impact/index.mjs <github-pr-url> [options]',
        '',
        'The repo is read from the PR URL, so any GitHub repo works out of the box.',
        '',
        'Options:',
        '  --profile <path>   Project profile with pathRules/keywordRules (default: qa-tools.profile.json,',
        '                     then profiles/<owner>-<repo>.json, then profiles/starter.json)',
        '',
      ].join('\n'),
    );
    return;
  }

  if (!prUrl) {
    throw new Error('Usage: node tools/qa-pr-impact/index.mjs <github-pr-url>');
  }

  const report = await analyzePullRequest(prUrl, {
    profilePath: typeof options.profile === 'string' ? options.profile : '',
  });

  process.stdout.write(`${renderMarkdown(report)}\n`);
}

function parseArgs(argv) {
  const options = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return options;
}

async function loadJson(filename) {
  const filePath = path.join(__dirname, filename);
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

export function parsePullRequestUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid PR URL: ${input}`);
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
  if (!match) {
    throw new Error(`Could not parse PR URL: ${input}`);
  }

  const owner = match[1];
  const repo = match[2];
  const number = Number(match[3]);

  return {
    owner,
    repo,
    repoSlug: `${owner}/${repo}`,
    number,
    url: input,
  };
}

export async function fetchPullRequest(prRef, options = {}) {
  const [pullData, filesData] = await Promise.all([
    ghApi(`repos/${prRef.repoSlug}/pulls/${prRef.number}`, options),
    ghApi(`repos/${prRef.repoSlug}/pulls/${prRef.number}/files?per_page=100`, options),
  ]);

  return {
    ...prRef,
    title: String(pullData.title || '').trim(),
    body: String(pullData.body || '').trim(),
    changedFiles: Array.isArray(filesData)
      ? filesData.map((file) => ({
        filename: String(file.filename || '').trim(),
        status: String(file.status || '').trim(),
      }))
      : [],
  };
}

async function ghApi(endpoint, options = {}) {
  try {
    const { stdout } = await execFile('gh', ['api', endpoint], {
      cwd: process.cwd(),
      env: githubCliEnv(options.token),
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    if (/authentication/i.test(stderr) || /not logged in/i.test(stderr)) {
      throw new Error('GitHub CLI is not authenticated. Run `gh auth login` first.');
    }
    throw new Error(stderr || `Failed to fetch GitHub API endpoint: ${endpoint}`);
  }
}

function githubCliEnv(tokenOverride = '') {
  const token =
    tokenOverride ||
    process.env.QA_PR_IMPACT_GITHUB_TOKEN ||
    process.env.QA_TOOLS_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    '';
  if (!token) return process.env;
  return {
    ...process.env,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };
}

export async function analyzePullRequest(prUrl, options = {}) {
  const prRef = parsePullRequestUrl(prUrl);
  const rules = await resolveRules({ repo: prRef.repoSlug, profilePath: options.profilePath });
  const testCases = await loadJson('test-cases.json');
  const pull = await fetchPullRequest(prRef, { token: options.token || '' });
  return buildQaImpactReport({ pull, rules, testCases });
}

/**
 * Area rules are the one thing this tool cannot infer from the repo itself, so
 * a project without a profile still gets the starter rules rather than nothing.
 */
async function resolveRules({ repo, profilePath }) {
  const config = await resolveProjectConfig({
    repo,
    profilePath,
    baseDir: REPO_ROOT,
    detect: false,
  });

  if (config.pathRules.length > 0 || config.keywordRules.length > 0) {
    return { pathRules: config.pathRules, keywordRules: config.keywordRules };
  }

  const starterPath = path.join(REPO_ROOT, 'profiles', 'starter.json');
  const starter = JSON.parse(await readFile(starterPath, 'utf8'));
  return { pathRules: starter.pathRules || [], keywordRules: starter.keywordRules || [] };
}

export function buildQaImpactReport({ pull, rules, testCases }) {
  const areaMap = new Map();
  const unmatchedFiles = [];

  for (const file of pull.changedFiles) {
    const matchedRules = rules.pathRules.filter((rule) => matchesAnyPattern(file.filename, rule.match));

    if (matchedRules.length === 0) {
      unmatchedFiles.push(file.filename);
      continue;
    }

    for (const rule of matchedRules) {
      for (const area of rule.areas || []) {
        registerArea(areaMap, {
          area,
          kind: 'primary',
          source: file.filename,
          ruleConfidence: rule.confidence || 'medium',
          related: rule.related || [],
          labels: rule.labels || [],
        });
      }
    }
  }

  for (const areaRecord of areaMap.values()) {
    for (const relatedArea of areaRecord.related) {
      registerArea(areaMap, {
        area: relatedArea,
        kind: 'related',
        source: areaRecord.area,
        ruleConfidence: downgradeConfidence(areaRecord.confidence),
        related: [],
        labels: [],
      });
    }
  }

  if (unmatchedFiles.length > 0 || areaMap.size === 0) {
    applyKeywordInference({ pull, unmatchedFiles, areaMap, keywordRules: rules.keywordRules || [] });
  }

  const ranked = [...areaMap.values()].sort(compareAreas);
  const primaryAreas = ranked.filter((item) => item.kind === 'primary').slice(0, MAX_PRIMARY_AREAS);
  const relatedAreas = ranked
    .filter((item) => item.kind === 'related' && !primaryAreas.some((primary) => primary.area === item.area))
    .slice(0, MAX_RELATED_AREAS);

  const testPlan = buildTestPlan({ primaryAreas, relatedAreas, testCases });

  return {
    pull,
    primaryAreas,
    relatedAreas,
    testPlan,
    confidence: deriveOverallConfidence(primaryAreas),
    unmatchedFiles,
  };
}

function registerArea(areaMap, { area, kind, source, ruleConfidence, related, labels }) {
  const existing = areaMap.get(area);
  const confidence = normalizeConfidence(ruleConfidence);

  if (!existing) {
    areaMap.set(area, {
      area,
      kind,
      score: kind === 'primary' ? 3 : 1,
      evidence: [source],
      confidence,
      related: [...new Set(related)],
      labels: [...new Set(labels)],
    });
    return;
  }

  existing.score += kind === 'primary' ? 3 : 1;
  existing.kind = existing.kind === 'primary' || kind === 'primary' ? 'primary' : 'related';
  existing.confidence = maxConfidence(existing.confidence, confidence);
  existing.related = [...new Set([...existing.related, ...related])];
  existing.labels = [...new Set([...existing.labels, ...labels])];

  if (!existing.evidence.includes(source)) {
    existing.evidence.push(source);
  }
}

function applyKeywordInference({ pull, unmatchedFiles, areaMap, keywordRules }) {
  const haystack = buildInferenceHaystack(pull, unmatchedFiles);

  for (const rule of keywordRules) {
    if (!rule.keywords.some((keyword) => haystack.includes(normalizeForInference(keyword)))) {
      continue;
    }

    for (const area of rule.areas || []) {
      registerArea(areaMap, {
        area,
        kind: 'primary',
        source: `keyword:${rule.keywords[0]}`,
        ruleConfidence: rule.confidence || 'low',
        related: rule.related || [],
        labels: ['inferred'],
      });
    }
  }
}

function buildInferenceHaystack(pull, unmatchedFiles) {
  const pieces = [
    pull.title || '',
    pull.body || '',
    ...pull.changedFiles.map((file) => file.filename),
    ...unmatchedFiles,
  ];

  return normalizeForInference(pieces.join(' '));
}

function normalizeForInference(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildTestPlan({ primaryAreas, relatedAreas, testCases }) {
  const must = [];
  const nice = [];
  const seen = new Set();
  const areaOrder = [...primaryAreas, ...relatedAreas];

  for (const area of areaOrder) {
    const config = testCases[area.area];
    if (!config) continue;

    for (const item of config.must || []) {
      if (seen.has(item) || must.length >= MAX_TEST_CASES_PER_BUCKET) continue;
      must.push(item);
      seen.add(item);
    }

    for (const item of config.nice || []) {
      if (seen.has(item) || nice.length >= MAX_TEST_CASES_PER_BUCKET) continue;
      nice.push(item);
      seen.add(item);
    }
  }

  return { must, nice };
}

function deriveOverallConfidence(primaryAreas) {
  if (primaryAreas.some((area) => area.confidence === 'high')) return 'High';
  if (primaryAreas.some((area) => area.confidence === 'medium')) return 'Medium';
  return 'Low';
}

function compareAreas(left, right) {
  if (left.kind !== right.kind) return left.kind === 'primary' ? -1 : 1;
  if (left.score !== right.score) return right.score - left.score;
  if (left.confidence !== right.confidence) return confidenceRank(right.confidence) - confidenceRank(left.confidence);
  return left.area.localeCompare(right.area);
}

function normalizeConfidence(value) {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function downgradeConfidence(value) {
  if (value === 'high') return 'medium';
  if (value === 'medium') return 'low';
  return 'low';
}

function maxConfidence(left, right) {
  return confidenceRank(left) >= confidenceRank(right) ? left : right;
}

function confidenceRank(value) {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  return 1;
}

function matchesAnyPattern(filePath, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');

  return new RegExp(`^${escaped}$`);
}

export function renderMarkdown(report) {
  const lines = [];
  const { pull, primaryAreas, relatedAreas, testPlan, confidence } = report;

  lines.push(`PR: ${pull.title || `#${pull.number}`}`);
  lines.push(`Link: ${pull.url}`);
  lines.push('');
  lines.push('Primary Areas To Verify');
  if (primaryAreas.length === 0) {
    lines.push('- No strong feature match found from the current rules.');
  } else {
    for (const area of primaryAreas) {
      lines.push(`- ${formatArea(area)}`);
    }
  }

  lines.push('');
  lines.push('Related Areas Possibly Affected');
  if (relatedAreas.length === 0) {
    lines.push('- None surfaced from the current rule set.');
  } else {
    for (const area of relatedAreas) {
      lines.push(`- ${formatArea(area)}`);
    }
  }

  lines.push('');
  lines.push('Suggested Test Cases');
  if (testPlan.must.length === 0 && testPlan.nice.length === 0) {
    lines.push('- No test cases mapped yet for the matched areas.');
  } else {
    if (testPlan.must.length > 0) {
      lines.push('Must Test');
      for (const item of testPlan.must) {
        lines.push(`- ${item}`);
      }
    }

    if (testPlan.nice.length > 0) {
      if (testPlan.must.length > 0) lines.push('');
      lines.push('Nice To Test');
      for (const item of testPlan.nice) {
        lines.push(`- ${item}`);
      }
    }
  }

  lines.push('');
  lines.push('Confidence');
  lines.push(`- ${confidence}`);

  return lines.join('\n');
}

function formatArea(area) {
  const confidence = CONFIDENCE_LABELS[area.confidence] || 'Medium';
  return `${titleCase(area.area)} (${confidence})`;
}

function titleCase(value) {
  return String(value)
    .split(' ')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

if (ENTRY_URL === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
