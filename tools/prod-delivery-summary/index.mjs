#!/usr/bin/env node

import { execFile as execFileCb } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ensureLocalClone, resolveProjectConfig } from '../../lib/project-config.mjs';

const execFile = promisify(execFileCb);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const MERGE_PR_RE = /^Merge pull request #(\d+) from (\S+)/;
const SQUASH_PR_RE = /^(?!Merge pull request\b)(.+?)\s+\(#(\d+)\)$/;
const INFRA_PLATFORMS = ['E2E', 'Unit-test', 'Deployment', 'Other'];

/**
 * Everything that varies by project. The defaults keep the tool runnable against
 * a repo with no profile: platforms come from auto-detection, and the override
 * and keyword tables start empty.
 */
let project = {
  platforms: { order: ['Web', 'Mobile', 'Deployment', 'E2E', 'Unit-test', 'Other'], prefixes: [], meta: {} },
  platformKeywords: {},
  aggregateRefs: [],
  prOverrides: {},
  owner: '',
  prodBranch: 'prod',
};

export function configureProject(config = {}) {
  project = {
    platforms: config.platforms?.order?.length ? config.platforms : project.platforms,
    platformKeywords: config.platformKeywords || {},
    aggregateRefs: (config.aggregateRefs || []).map((ref) => String(ref).toLowerCase()),
    prOverrides: config.prOverrides || {},
    owner: config.repoRef?.owner || '',
    prodBranch: config.prodBranch || 'prod',
  };
}

/**
 * The ref production ships from. Repos that have no dedicated prod branch report
 * against their default branch instead of failing.
 */
async function resolveProdRef(repoPath) {
  const preferred = `origin/${project.prodBranch}`;
  if (await gitRefExists(repoPath, preferred)) return preferred;

  const fallback = await gitDefaultBranch(repoPath);
  if (!fallback) {
    throw new Error(`Repo has no ${preferred} branch and no detectable default branch.`);
  }
  return fallback;
}

async function gitRefExists(repoPath, ref) {
  try {
    await gitText(repoPath, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

async function gitDefaultBranch(repoPath) {
  try {
    const text = await gitText(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    return text.trim().replace(/^refs\/remotes\//, '');
  } catch {
    return '';
  }
}

function platformOrder() {
  return project.platforms.order;
}

function platformMeta(platform) {
  return project.platforms.meta?.[platform] || {};
}

/** Platforms that ship product, as opposed to the infra/test buckets. */
function productPlatforms() {
  return platformOrder().filter((platform) => !INFRA_PLATFORMS.includes(platform));
}

const SKIP_BODY_PREFIXES = ['co-authored-by:', 'signed-off-by:', 'reviewed-by:'];
const NOISY_SUBJECT_RE =
  /^(fix pr (comment|review|feedback)|address (feedback|ai|copilot|claude|review)|remove (redundant|unused|console\.?log)|update snapshot|fix typo|clean( up)?$|minor|nit:|pr feedback|add log$|add missing$|fix tests?$|fix lint|update (type|deps|dependencies|pnpm|package\.json|lock)|bump |revert |merge dev|merge staging|fix merge|resolve conflict)/i;
const GENERIC_DESCRIPTION_RE =
  /^(updates?|improves?|changes?)\s+(web|mobile|payload|tv|e2e|unit-test|deployment|other)\s+(code|behavior)(?:\s+(?:in|across)\s+.+)?\.?$/i;
const PATH_ONLY_DESCRIPTION_RE =
  /^(updates?|changes?)\s+.+\s+code\s+(?:in|across)\s+`?[\w./-]+`?(?:,\s*`?[\w./-]+`?)*\.?$/i;
const DESCRIPTION_MODEL = process.env.PROD_DELIVERY_DESCRIPTION_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const PLATFORM_SUMMARY_MODEL = process.env.PROD_DELIVERY_PLATFORM_SUMMARY_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const REPORT_TIMEZONE = process.env.PROD_DELIVERY_REPORT_TIMEZONE || 'Asia/Ho_Chi_Minh';
const REPORT_TIMEZONE_LABEL = process.env.PROD_DELIVERY_REPORT_TIMEZONE_LABEL || 'VNT';
const DESCRIPTION_PROMPT = `You write one-line Product Owner friendly release descriptions for pull requests that reached production.

Goal:
- Describe what the PR changed in plain English for a non-engineer stakeholder.
- Be specific enough to explain user/admin/business impact.
- Stay in one sentence.

Style rules:
- 18 to 38 words.
- Start with the changed thing or area, not with "This PR".
- Prefer concrete nouns from the codebase: "Live chat", "Videos", "Payload admin", "Mobile player", "Download API", "Gift paywall".
- Explain the outcome using phrases like "now", "adds", "lets", "uses", "fixes", "prevents", "hides", "supports", "restores".
- Mention implementation details only when they explain the outcome clearly (examples: AsyncStorage, Cloudflare R2, LaunchDarkly, ActionSheet, StoreKit 2).
- Avoid vague wording like "improves system", "enhances experience", "refactors code", "minor fixes".
- Avoid markdown formatting, bullet markers, quotes, or PR-number references.
- Output only the final one-line description.

When reading context:
- Use changed files to identify the surface area.
- Use PR title/body and commit subjects to infer intent.
- Ignore noise like lockfiles, tests, lint-only changes, or merge/revert mechanics unless they materially affect the shipped result.
- If the change is operational/admin-facing, describe the admin or deployment outcome, not low-level code mechanics.
`;
const platformSummaryPrompt = () => `You are writing a technical delivery summary for a client-facing report. Given a list of merged pull requests, each with a date, PR number, git commit title, plain-English description, and platform label, write concise bullet-point summaries grouped by platform.
Platforms: ${platformOrder().join(', ')}
Rules for each platform section:
- Write 4–8 bullet points per platform, depending on volume
- Each bullet should group related PRs into a single coherent sentence — do not write one bullet per PR
- Lead with the most impactful or user-facing work first
- Use plain, clear technical English — no marketing language, no fluff
- Name specific features, components, or systems (e.g. "live chat", "checkout flow", "deploy-web workflow") rather than vague descriptions
- If a PR is a revert followed by a re-apply, mention both in one bullet (e.g. "rolled back and re-applied")
- For security patches or dependency bumps, mention the CVE or version number if available
- Do not repeat information across platforms — if a feature spans platforms, mention the cross-platform nature in the most relevant section and reference it briefly in others
Tone: engineering-facing, factual, past tense. Written as if a senior engineer is summarising what shipped to a technical client.
Format per bullet:
- Start with the subject (feature, system, or component), not a verb
- One sentence per bullet, max ~25 words
- No PR numbers in the bullets`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await resolveProjectConfig({
    repo: options.repo || process.env.PROD_DELIVERY_REPO || '',
    profilePath: typeof options.profile === 'string' ? options.profile : '',
    baseDir: REPO_ROOT,
  });
  configureProject(config);

  // This tool reads git history, so a URL-only run needs a working copy.
  const repoPath = options.repoPath
    ? path.resolve(options.repoPath)
    : await ensureLocalClone(config.repoRef);

  const report = await buildProdDeliveryReport({
    repoPath,
    repoSlug: config.repo,
    months: options.months ? Number(options.months) : undefined,
    startMonth: options.startMonth || '',
    endMonth: options.endMonth || '',
    mode: options.mode || 'preset',
    now: options.now || '',
  });
  const markdown = renderProdDeliveryMarkdown(report);

  if (options.output) {
    const outputPath = path.resolve(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${markdown}\n`, 'utf8');
  }

  process.stdout.write(`${markdown}\n`);
}

export async function buildProdDeliveryReport({
  repoPath,
  repoSlug,
  months,
  startMonth,
  endMonth,
  mode,
  now,
}) {
  const range = await resolveRange({ repoPath, months, startMonth, endMonth, mode, now });
  const referenceData = await loadReferenceData(repoPath);
  const referenceDescriptions = referenceData.descriptions;
  const referencePlatforms = referenceData.platforms;
  const curatedPlatformHighlights = await loadCuratedPlatformHighlights(repoPath, range);
  const prodPrs = await rebuildProdPrMap(repoPath, range);
  const rows = [];

  for (const item of prodPrs) {
    const mergeMeta = await readMergeMeta(repoPath, item.mergeSha);
    const diffPaths = await listDiffPaths(repoPath, item.mergeSha);
    const override = project.prOverrides[String(item.prNumber)] || {};
    const parsedSubject = parsePrSubject(mergeMeta.subject);
    const platformChoice = choosePlatform({
      override,
      referencePlatform: referencePlatforms.get(String(item.prNumber)),
      diffPaths,
      ref: mergeMeta.ref,
    });
    const platform = platformChoice.platform;
    const title = parsedSubject?.title || derivePrTitle(mergeMeta.body, mergeMeta.ref, item.prNumber);
    const commitSubjects = await listBranchCommitSubjects(repoPath, item.mergeSha);
    const referenceDescription = referenceDescriptions.get(String(item.prNumber));
    const descriptionChoice = override.description
      ? {
        description: override.description,
        source: 'curated override',
        confidence: 'high',
      }
      : referenceDescription
        ? {
          description: referenceDescription,
          source: 'saved reference',
          confidence: mergeMeta.body ? 'medium' : 'low',
        }
        : {
          description: await derivePoDescription({
        repoPath,
        prNumber: item.prNumber,
        body: mergeMeta.body,
        ref: mergeMeta.ref,
        title,
        diffPaths,
        platform,
            commitSubjects,
        referenceExamples: referenceData.examples,
          }),
          source: 'generated heuristic',
          confidence: mergeMeta.body || commitSubjects.length ? 'medium' : 'low',
        };
    const reviewWarnings = buildReviewWarnings({
      platformChoice,
      descriptionChoice,
      body: mergeMeta.body,
      diffPaths,
      referencePlatform: referencePlatforms.get(String(item.prNumber)),
      referenceDescription,
      override,
      parsedSubject,
    });

    rows.push({
      date: item.mergeDate,
      prNumber: String(item.prNumber),
      prUrl: `https://github.com/${repoSlug}/pull/${item.prNumber}`,
      title,
      description: descriptionChoice.description,
      platform,
      paths: diffPaths,
      platformSource: platformChoice.source,
      platformReason: platformChoice.reason,
      descriptionSource: descriptionChoice.source,
      descriptionConfidence: descriptionChoice.confidence,
      reviewWarnings,
      needsReview: reviewWarnings.length > 0,
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return Number(a.prNumber) - Number(b.prNumber);
  });

  const counts = Object.fromEntries(platformOrder().map((name) => [name, 0]));
  for (const row of rows) {
    counts[row.platform] = (counts[row.platform] || 0) + 1;
  }

  const platformGroups = platformOrder().map((platform) => ({
    platform,
    count: counts[platform] || 0,
    intro: platformMeta(platform).intro || '',
    className: platformMeta(platform).key || 'other',
    items: rows.filter((row) => row.platform === platform),
    highlights: [],
  })).filter((group) => group.count > 0);

  for (const group of platformGroups) {
    group.highlights =
      curatedPlatformHighlights[group.platform] ||
      buildPlatformHighlights(group.platform, group.items, { detailed: group.count < 20 });
  }

  return {
    generatedAt: new Date().toISOString(),
    repoSlug,
    range,
    totalPrs: rows.length,
    counts,
    prs: rows,
    platformGroups,
  };
}

/**
 * Enriches the report from a hand-written PR summary table the repo may keep.
 * Most repos do not keep one — that is the normal case, not a failure, so a
 * missing file skips the enrichment instead of killing a report that is already
 * built. A file that exists but cannot be parsed is still an error worth raising.
 */
export async function syncReferenceDescriptionFile(repoPath, report) {
  const filePath = path.join(repoPath, 'data', 'prod-delivery', 'prod-pr-merges-first-5-po-summaries.md');

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { updated: false, skipped: 'no-reference-file', appendedPrNumbers: [], rewrittenPrNumbers: [], filePath };
  }

  const lines = raw.split('\n');
  const tableStart = lines.findIndex((line) => line.trim().startsWith('| merge_date |'));
  if (tableStart === -1 || tableStart + 1 >= lines.length) {
    throw new Error(
      `${filePath} has no PR summary table — it needs a markdown table whose header row starts with "| merge_date |".`,
    );
  }

  const tableEnd = findTableEnd(lines, tableStart);
  const header = lines[tableStart];
  const separator = lines[tableStart + 1];
  const prefix = lines.slice(0, tableStart);
  const suffix = lines.slice(tableEnd);
  const existingRows = lines.slice(tableStart + 2, tableEnd).filter((line) => line.trim().startsWith('|'));

  const rowsByPr = new Map();
  for (const line of existingRows) {
    const parsed = parseReferenceTableRow(line);
    if (!parsed) continue;
    rowsByPr.set(parsed.prNumber, {
      prNumber: parsed.prNumber,
      mergeDate: parsed.mergeDate,
      sortKey: buildSortKey(parsed.mergeDate, parsed.prNumber),
      rawLine: line,
    });
  }

  const appended = [];
  const rewritten = [];
  for (const pr of report.prs) {
    const rawLine = formatReferenceTableRow(pr);
    const existing = rowsByPr.get(pr.prNumber);
    if (!existing) {
      rowsByPr.set(pr.prNumber, {
        prNumber: pr.prNumber,
        mergeDate: pr.date,
        sortKey: buildSortKey(pr.date, pr.prNumber),
        rawLine,
      });
      appended.push(pr.prNumber);
      continue;
    }

    if (existing.rawLine !== rawLine) {
      rowsByPr.set(pr.prNumber, {
        prNumber: pr.prNumber,
        mergeDate: pr.date,
        sortKey: buildSortKey(pr.date, pr.prNumber),
        rawLine,
      });
      rewritten.push(pr.prNumber);
    }
  }

  if (!appended.length && !rewritten.length) {
    return { updated: false, appendedPrNumbers: [], rewrittenPrNumbers: [], filePath };
  }

  const orderedRows = [...rowsByPr.values()]
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map((row) => row.rawLine);

  const nextContent = [...prefix, header, separator, ...orderedRows, ...suffix].join('\n').replace(/\n+$/, '\n');
  await writeFile(filePath, nextContent, 'utf8');

  return {
    updated: true,
    appendedPrNumbers: appended,
    rewrittenPrNumbers: rewritten,
    filePath,
  };
}

export function renderProdDeliveryMarkdown(report) {
  const lines = [
    '# Production Delivery Summary',
    '',
    `Period: **${report.range.label}**`,
    `Total PRs: **${report.totalPrs}**`,
    `Generated: **${formatGeneratedAt(report.generatedAt)}**`,
    '',
    '## Overview',
    '',
    '| Platform | PRs |',
    '| --- | ---: |',
  ];

  for (const platform of platformOrder()) {
    const count = report.counts[platform] || 0;
    if (!count) continue;
    lines.push(`| ${platform} | ${count} |`);
  }

  lines.push('', '## Platform Summary', '');

  for (const group of report.platformGroups) {
    lines.push(`### ${group.platform} (${group.count})`, '');
    lines.push(group.intro, '');
    for (const highlight of group.highlights) {
      lines.push(`- ${highlight}`);
    }
    lines.push('');
  }

  lines.push('## PR List', '', '| Date | PR | Title | Description | Platform |', '| --- | --- | --- | --- | --- |');

  for (const item of report.prs) {
    lines.push(
      `| ${item.date} | [#${item.prNumber}](${item.prUrl}) | ${escapeMdTable(item.title)} | ${escapeMdTable(item.description)} | ${item.platform} |`,
    );
  }

  return lines.join('\n').trimEnd();
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--repo-path') options.repoPath = next, (index += 1);
    else if (arg === '--repo') options.repo = next, (index += 1);
    else if (arg === '--profile') options.profile = next, (index += 1);
    else if (arg === '--months') options.months = next, (index += 1);
    else if (arg === '--start-month') options.startMonth = next, (index += 1);
    else if (arg === '--end-month') options.endMonth = next, (index += 1);
    else if (arg === '--mode') options.mode = next, (index += 1);
    else if (arg === '--output') options.output = next, (index += 1);
    else if (arg === '--now') options.now = next, (index += 1);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage: node tools/prod-delivery-summary/index.mjs [options]',
          '',
          'Options:',
          '  --repo <owner/name|url> GitHub repo. Required unless a profile supplies it.',
          '  --repo-path <path>      Existing local clone. Omit to clone the repo into a local cache.',
          '  --profile <path>        Project profile (default: qa-tools.profile.json, then profiles/<owner>-<repo>.json)',
          '  --mode <preset|custom|latest-release|today-release>',
          '  --months <n>            Preset month window including the current month (e.g. 3, 6)',
          '  --start-month <YYYY-MM> Custom start month',
          '  --end-month <YYYY-MM>   Custom end month, inclusive',
          '  --output <path>         Write markdown to a file',
          '  --now <YYYY-MM-DD>      Override current date for range calculations',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  return options;
}

async function resolveRange({ repoPath, months, startMonth, endMonth, mode, now }) {
  if (mode === 'latest-release') {
    return resolveLatestReleaseRange(repoPath);
  }
  if (mode === 'today-release') {
    return resolveTodayReleaseRange(now);
  }

  if (startMonth || endMonth) {
    if (!/^\d{4}-\d{2}$/.test(startMonth) || !/^\d{4}-\d{2}$/.test(endMonth)) {
      throw new Error('Custom range requires startMonth and endMonth in YYYY-MM format');
    }
    if (startMonth > endMonth) {
      throw new Error('startMonth must be earlier than or equal to endMonth');
    }
    return buildRangeFromMonths(startMonth, endMonth);
  }

  const resolvedMonths = Number(months) > 0 ? Number(months) : 6;
  const today = parseLocalDate(now || new Date().toISOString().slice(0, 10));
  const currentMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const start = new Date(Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() - resolvedMonths + 1, 1));
  const endInclusive = currentMonthStart;
  return buildRangeFromMonths(formatMonth(start), formatMonth(endInclusive));
}

function resolveTodayReleaseRange(now) {
  const today = parseLocalDate(now || formatDateInReportTimezone(new Date()));
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const todayDate = formatDate(today);
  return {
    type: 'today-release',
    startMonth: formatMonth(today),
    endMonth: formatMonth(today),
    startDate: todayDate,
    endExclusiveDate: formatDate(tomorrow),
    label: `Today release · ${formatDayLabel(todayDate)}`,
  };
}

async function resolveLatestReleaseRange(repoPath) {
  const prodRef = await resolveProdRef(repoPath);
  const lines = await gitLines(repoPath, [
    'log',
    prodRef,
    '--first-parent',
    '--merges',
    '--format=%H\t%ad\t%s',
    '--date=format-local:%Y-%m-%d',
    '-n',
    '50',
  ]);

  for (const line of lines) {
    const [mergeSha, mergeDate, subject] = splitTabLine(line, 3);
    if (!mergeSha || !mergeDate || !subject) continue;
    const parsed = parseMergeSubject(subject);
    if (!parsed) continue;
    if (!isAggregateRef(parsed.ref)) continue;
    const mergeDateValue = parseLocalDate(mergeDate);
    const endExclusiveDate = new Date(mergeDateValue.getTime() + 24 * 60 * 60 * 1000);
    return {
      type: 'latest-release',
      mergeSha,
      mergeDate,
      startMonth: formatMonth(mergeDateValue),
      endMonth: formatMonth(mergeDateValue),
      startDate: mergeDate,
      endExclusiveDate: formatDate(endExclusiveDate),
      label: `Latest release · ${formatMonthLabel(formatMonth(mergeDateValue))} (${mergeDate})`,
    };
  }

  throw new Error(`Could not find a latest prod release on ${await resolveProdRef(repoPath)}`);
}

function buildRangeFromMonths(startMonth, endMonth) {
  const startDate = `${startMonth}-01`;
  const endExclusiveDate = formatDate(firstDayOfNextMonth(`${endMonth}-01`));
  return {
    type: 'month-range',
    startMonth,
    endMonth,
    startDate,
    endExclusiveDate,
    label: `${formatMonthLabel(startMonth)} - ${formatMonthLabel(endMonth)}`,
  };
}

async function rebuildProdPrMap(repoPath, range) {
  if (range.type === 'latest-release' && range.mergeSha) {
    const acc = new Map();
    await expandAggregate(repoPath, range.mergeSha, range.mergeDate, acc, new Set(), range.endExclusiveDate);
    return removeNestedPullRequests(repoPath, [...acc.values()]);
  }

  const { startDate, endExclusiveDate } = range;
  const prodRef = await resolveProdRef(repoPath);
  const lines = await gitLines(repoPath, [
    'log',
    prodRef,
    '--first-parent',
    `--since=${startDate}T00:00:00`,
    `--until=${endExclusiveDate}T00:00:00`,
    '--reverse',
    '--format=%H\t%ad\t%s',
    '--date=format-local:%Y-%m-%d',
  ]);
  const acc = new Map();

  for (const line of lines) {
    const [sha, mergeDate, subject] = splitTabLine(line, 3);
    if (!sha || !mergeDate || !subject) continue;
    if (mergeDate >= endExclusiveDate) continue;
    const parsed = parsePrSubject(subject);
    if (!parsed) continue;
    const { prNumber, ref } = parsed;
    if (isAggregateRef(ref)) {
      await expandAggregate(repoPath, sha, mergeDate, acc, new Set(), endExclusiveDate);
      continue;
    }
    const existing = acc.get(prNumber);
    if (!existing || mergeDate < existing.mergeDate) {
      acc.set(prNumber, { prNumber, mergeDate, mergeSha: sha });
    }
  }

  return removeNestedPullRequests(repoPath, [...acc.values()]);
}

async function removeNestedPullRequests(repoPath, items) {
  const nestedShas = new Set();
  for (const parent of items) {
    const branchSideShas = await listMergeBranchSideFirstParentShas(repoPath, parent.mergeSha);
    if (!branchSideShas.size) continue;
    for (const child of items) {
      if (child.prNumber === parent.prNumber) continue;
      if (branchSideShas.has(child.mergeSha)) {
        nestedShas.add(child.mergeSha);
      }
    }
  }
  return items.filter((item) => !nestedShas.has(item.mergeSha));
}

async function listMergeBranchSideFirstParentShas(repoPath, mergeSha) {
  try {
    const lines = await gitLines(repoPath, [
      'log',
      '--first-parent',
      `${mergeSha}^1..${mergeSha}^2`,
      '--format=%H',
    ]);
    return new Set(lines);
  } catch {
    return new Set();
  }
}

async function expandAggregate(repoPath, mergeSha, mergeDate, acc, expanding, endExclusiveDate) {
  if (expanding.has(mergeSha)) return;
  expanding.add(mergeSha);
  try {
    const lines = await gitLines(repoPath, [
      'log',
      `${mergeSha}^1..${mergeSha}^2`,
      '--reverse',
      '--format=%H\t%s',
    ]);

    for (const line of lines) {
      const [innerSha, subject] = splitTabLine(line, 2);
      if (!innerSha || !subject) continue;
      const parsed = parsePrSubject(subject);
      if (!parsed) continue;
      if (isAggregateRef(parsed.ref)) {
        await expandAggregate(repoPath, innerSha, mergeDate, acc, expanding, endExclusiveDate);
        continue;
      }
      if (mergeDate >= endExclusiveDate) continue;
      const existing = acc.get(parsed.prNumber);
      if (!existing || mergeDate < existing.mergeDate) {
        acc.set(parsed.prNumber, { prNumber: parsed.prNumber, mergeDate, mergeSha: innerSha });
      }
    }
  } finally {
    expanding.delete(mergeSha);
  }
}

function parseMergeSubject(subject) {
  const match = MERGE_PR_RE.exec(String(subject || '').trim());
  if (!match) return null;
  return { prNumber: Number(match[1]), ref: match[2] };
}

function parsePrSubject(subject) {
  const value = String(subject || '').trim();
  const merge = parseMergeSubject(value);
  if (merge) return merge;
  const squash = SQUASH_PR_RE.exec(value);
  if (!squash) return null;
  return {
    prNumber: Number(squash[2]),
    ref: '',
    title: normalizeHumanText(cleanupSentence(squash[1], 120)),
  };
}

/**
 * Aggregate refs are the branch-to-branch promotion merges that carry other
 * people's PRs, so they must not be counted as delivered work themselves.
 */
function isAggregateRef(ref) {
  const raw = String(ref || '').toLowerCase();
  const normalized = stripOwnerPrefix(raw);
  if (!normalized) return false;
  if (project.aggregateRefs.includes(raw) || project.aggregateRefs.includes(normalized)) return true;
  return /(promote-dev-to-staging|promote-staging-to-prod|clone-staging|merge-dev|merge-staging)/i.test(normalized);
}

/** Drops the "owner/" that git puts in front of merge refs. Preserves case. */
function stripOwnerPrefix(value) {
  const raw = String(value || '');
  const owner = project.owner;
  if (owner) return raw.replace(new RegExp(`^${escapeRegExp(owner)}/`, 'i'), '');
  return raw.replace(/^[^/]+\//, '');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readMergeMeta(repoPath, mergeSha) {
  const text = await gitText(repoPath, ['log', '-1', mergeSha, '--format=%s%n%b']);
  const lines = text.trim().split('\n');
  const subject = lines[0] || '';
  const body = lines.slice(1).join('\n').trim();
  const parsed = parseMergeSubject(subject);
  return {
    subject,
    body,
    ref: parsed?.ref || '',
  };
}

async function listDiffPaths(repoPath, mergeSha) {
  try {
    const mergeBase = (await gitText(repoPath, ['merge-base', `${mergeSha}^1`, `${mergeSha}^2`])).trim();
    const fromRef = mergeBase || `${mergeSha}^1`;
    const lines = await gitLines(repoPath, ['diff', '--name-only', fromRef, `${mergeSha}^2`]);
    return lines.map((line) => line.trim()).filter(Boolean);
  } catch {
    const lines = await gitLines(repoPath, ['show', '--format=', '--name-only', mergeSha]);
    return lines.map((line) => line.trim()).filter(Boolean);
  }
}

function categorizePlatform(diffPaths, ref) {
  return analyzePlatform(diffPaths, ref).platform;
}

function choosePlatform({ override, referencePlatform, diffPaths, ref }) {
  if (override.platform) {
    return {
      platform: override.platform,
      source: 'curated override',
      reason: 'Manual platform override for this PR.',
      confidence: 'high',
    };
  }

  const analyzed = analyzePlatform(diffPaths, ref);
  if (analyzed.platform !== 'Other') return analyzed;

  if (referencePlatform && platformOrder().includes(referencePlatform)) {
    return {
      platform: referencePlatform,
      source: 'saved reference',
      reason: 'No stronger file-path signal; reused saved platform.',
      confidence: 'medium',
    };
  }

  return analyzed;
}

function analyzePlatform(diffPaths, ref) {
  const counts = new Map();
  const evidence = new Map();
  let testOnlyCount = 0;
  let e2eCount = 0;
  let deploymentCount = 0;
  for (const diffPath of diffPaths) {
    if (isUnitTestPath(diffPath)) {
      testOnlyCount += 1;
      continue;
    }
    if (isE2ePath(diffPath)) {
      e2eCount += 1;
      addPlatformEvidence(evidence, 'E2E', diffPath);
      continue;
    }
    if (isDeploymentPath(diffPath)) {
      deploymentCount += 1;
      counts.set('Deployment', (counts.get('Deployment') || 0) + 1);
      addPlatformEvidence(evidence, 'Deployment', diffPath);
      continue;
    }
    for (const [prefix, label] of project.platforms.prefixes) {
      if (!diffPath.startsWith(prefix)) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
      addPlatformEvidence(evidence, label, diffPath);
      break;
    }
  }

  const productCounts = [...counts.entries()].filter(([platform]) =>
    productPlatforms().includes(platform),
  );
  if (productCounts.length) {
    const [platform, count] = productCounts.sort((a, b) => b[1] - a[1])[0];
    return {
      platform,
      source: 'file paths',
      reason: `Product files beat test files; ${count} ${platform} path${count === 1 ? '' : 's'} matched.`,
      confidence: e2eCount || testOnlyCount ? 'medium' : 'high',
      evidence: evidence.get(platform) || [],
    };
  }

  if (deploymentCount > 0 && counts.size === 1) {
    return {
      platform: 'Deployment',
      source: 'file paths',
      reason: `Deployment-only paths matched (${deploymentCount}).`,
      confidence: 'high',
      evidence: evidence.get('Deployment') || [],
    };
  }

  if (e2eCount > 0 && counts.size === 0) {
    return {
      platform: 'E2E',
      source: 'file paths',
      reason: `E2E-only paths matched (${e2eCount}).`,
      confidence: 'high',
      evidence: evidence.get('E2E') || [],
    };
  }

  if (testOnlyCount > 0 && counts.size === 0 && e2eCount === 0) {
    return {
      platform: 'Unit-test',
      source: 'file paths',
      reason: `Unit-test-only paths matched (${testOnlyCount}).`,
      confidence: 'high',
      evidence: [],
    };
  }

  if (counts.size) {
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [platform, count] = ordered[0];
    return {
      platform,
      source: 'file paths',
      reason: `Mixed non-product paths; selected largest path group (${count}).`,
      confidence: 'medium',
      evidence: evidence.get(platform) || [],
    };
  }

  const textPlatform = inferPlatformFromText(ref);
  if (textPlatform) {
    return {
      platform: textPlatform,
      source: 'branch text',
      reason: `No path match; inferred from source ref "${ref}".`,
      confidence: 'low',
      evidence: [],
    };
  }

  return {
    platform: 'Other',
    source: 'fallback',
    reason: 'No product, test, or deployment file-path signal matched.',
    confidence: 'low',
    evidence: [],
  };
}

function addPlatformEvidence(evidence, platform, diffPath) {
  const paths = evidence.get(platform) || [];
  if (paths.length < 3) paths.push(diffPath);
  evidence.set(platform, paths);
}

function isE2ePath(diffPath) {
  const value = String(diffPath || '');
  for (const [prefix, label] of project.platforms.prefixes) {
    if (label === 'E2E' && value.startsWith(prefix)) return true;
  }
  return /(^|\/)(e2e|load-test)\//i.test(value) || /playwright|codecept|cypress/i.test(value);
}

function isDeploymentPath(diffPath) {
  const value = String(diffPath || '');
  return value.startsWith('.github/workflows/') ||
    value.startsWith('.devcontainer/') ||
    value.startsWith('.exe/') ||
    /(^|\/)(Dockerfile|docker-compose\.ya?ml|wrangler\.jsonc?)$/i.test(value);
}

function buildReviewWarnings({
  platformChoice,
  descriptionChoice,
  body,
  diffPaths,
  referencePlatform,
  referenceDescription,
  override,
  parsedSubject,
}) {
  const warnings = [];
  if (platformChoice.confidence === 'low') {
    warnings.push(`Platform is low confidence: ${platformChoice.reason}`);
  }
  if (referencePlatform && referencePlatform !== platformChoice.platform && !override.platform) {
    warnings.push(`Saved platform "${referencePlatform}" disagrees with computed platform "${platformChoice.platform}".`);
  }
  if (descriptionChoice.confidence === 'low') {
    warnings.push(`Description is low confidence from ${descriptionChoice.source}.`);
  }
  if (referenceDescription && !override.description && !body) {
    warnings.push('Description came from saved reference, but PR body is empty.');
  }
  if (parsedSubject?.title && !body) {
    warnings.push('Squash-style PR commit with empty PR body; verify description if wording matters.');
  }
  if (hasMixedProductAndTestPaths(diffPaths)) {
    warnings.push('PR mixes product and test paths; platform uses product files by rule.');
  }
  return warnings;
}

function hasMixedProductAndTestPaths(diffPaths) {
  let hasProduct = false;
  let hasTest = false;
  for (const diffPath of diffPaths) {
    if (isE2ePath(diffPath) || isUnitTestPath(diffPath)) hasTest = true;
    const platform = matchProductPlatform(diffPath);
    if (platform) hasProduct = true;
  }
  return hasProduct && hasTest;
}

function matchProductPlatform(diffPath) {
  for (const [prefix, label] of project.platforms.prefixes) {
    if (INFRA_PLATFORMS.includes(label)) continue;
    if (String(diffPath || '').startsWith(prefix)) return label;
  }
  return '';
}

/**
 * Last-resort platform guess for PRs whose diff paths were inconclusive. Profile
 * keywords win; the patterns below are the generic fallback. Only platforms the
 * project actually declares can be returned.
 */
function inferPlatformFromText(value) {
  const text = String(value || '').toLowerCase();

  for (const [platform, keywords] of Object.entries(project.platformKeywords)) {
    if (!Array.isArray(keywords)) continue;
    if (keywords.some((keyword) => text.includes(String(keyword).toLowerCase()))) {
      return platformOrder().includes(platform) ? platform : '';
    }
  }

  const guess = /playwright|codecept|cypress|workflow_dispatch|\be2e\b/.test(text)
    ? 'E2E'
    : /deploy|deployment|vercel|wrangler|github\/workflows|docker/.test(text)
      ? 'Deployment'
      : /\b(ios|android|mobile)\b|react-native/.test(text)
        ? 'Mobile'
        : /\b(web|browser)\b|next\.js/.test(text)
          ? 'Web'
          : '';

  return guess && platformOrder().includes(guess) ? guess : '';
}

function isUnitTestPath(diffPath) {
  const value = String(diffPath || '');
  if (!value) return false;
  if (/(__tests__|__mocks__|__snapshots__)\//.test(value)) return true;
  if (/\.(test|spec)\.[a-z0-9]+$/i.test(value)) return true;
  if (/\.snap$/i.test(value)) return true;
  if (/jest(\.[a-z0-9-]+)?\.(config|setup)\.[a-z0-9]+$/i.test(value)) return true;
  if (/vitest(\.[a-z0-9-]+)?\.config\.[a-z0-9]+$/i.test(value)) return true;
  if (/playwright\.config\.[a-z0-9]+$/i.test(value)) return false;
  if (/codecept/i.test(value)) return false;
  if (/test-utils?|testing|mock(s)?\//i.test(value) && !isE2ePath(value)) return true;
  return false;
}

function derivePrTitle(body, ref, prNumber) {
  const lines = String(body || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (shouldSkipBodyLine(line)) continue;
    if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) continue;
    const cleaned = cleanupSentence(line, 120);
    if (!cleaned) continue;
    return normalizeHumanText(cleaned) || `PR #${prNumber}`;
  }
  return humanizeRef(ref);
}

async function derivePoDescription({ repoPath, prNumber, body, ref, title, diffPaths, platform, commitSubjects, referenceExamples }) {
  const aiDescription = await maybeGeneratePoDescriptionWithOpenAI({
    repoPath,
    prNumber,
    title,
    body,
    ref,
    platform,
    diffPaths,
    commitSubjects,
    referenceExamples,
  });
  if (aiDescription && !isLowQualityGeneratedCandidate(aiDescription, title)) return aiDescription;

  const prose = bodyToProse(body);
  const referencedDescription = inferReferencedPrDescription({ body, ref, title, referenceExamples, prNumber });
  const heuristicDescription = inferHeuristicDescription({ title, ref, diffPaths, platform, commitSubjects });
  const commitBased = summarizeCommitSubjects(commitSubjects);
  const inferred = inferSummaryFromRef(ref, platform);
  const titleBased = makeTitleSummary(title, platform);
  const fallbackDescription = makeFallbackPoDescription({ title, ref, platform, diffPaths, commitSubjects });

  const candidates = [
    prose,
    referencedDescription,
    heuristicDescription,
    commitBased,
    inferred,
    fallbackDescription,
    titleBased,
    ...commitSubjects,
  ]
    .map((value) => normalizeHumanText(cleanupSentence(value, 170)))
    .filter(Boolean)
    .filter((value) => !isMergeNoiseText(value))
    .filter((value) => !isLowQualityGeneratedCandidate(value, title))
    .filter((value, index, values) => values.indexOf(value) === index);

  return candidates[0] || makeFallbackPoDescription({ title, ref, platform, diffPaths, commitSubjects });
}

async function maybeGeneratePoDescriptionWithOpenAI({
  prNumber,
  title,
  body,
  ref,
  platform,
  diffPaths,
  commitSubjects,
  referenceExamples,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return '';

  const examples = selectReferenceExamples(referenceExamples, platform, prNumber);
  const prompt = buildDescriptionPrompt({
    prNumber,
    title,
    body,
    ref,
    platform,
    diffPaths,
    commitSubjects,
    examples,
  });

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: DESCRIPTION_MODEL,
      input: [
        { role: 'system', content: DESCRIPTION_PROMPT },
        { role: 'user', content: prompt },
      ],
    });
    return normalizeAiDescription(response.output_text || '');
  } catch {
    return '';
  }
}

async function maybeGeneratePlatformHighlightsWithOpenAI(platform, items) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !items.length) return null;

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });
    const response = await client.responses.create({
      model: PLATFORM_SUMMARY_MODEL,
      input: [
        { role: 'system', content: platformSummaryPrompt() },
        {
          role: 'user',
          content: buildPlatformSummaryPrompt(platform, items),
        },
      ],
    });

    const bullets = normalizePlatformSummaryOutput(response.output_text || '');
    return bullets.length ? bullets : null;
  } catch {
    return null;
  }
}

function buildPlatformSummaryPrompt(platform, items) {
  const maxBullets = Math.max(4, Math.min(8, Math.round(items.length / 10) + 3));
  return [
    `Platform: ${platform}`,
    `Desired bullets: ${maxBullets}`,
    '',
    'Pull requests:',
    ...items.map((item) =>
      [
        `- Date: ${item.date}`,
        `  PR: #${item.prNumber}`,
        `  Title: ${item.title}`,
        `  Description: ${item.description}`,
        `  Paths: ${item.paths.join(', ') || '(none)'}`,
      ].join('\n'),
    ),
    '',
    'Return only bullet lines beginning with "- ".',
  ].join('\n');
}

function normalizePlatformSummaryOutput(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- /, '').trim())
    .filter(Boolean);
}

function buildDescriptionPrompt({ prNumber, title, body, ref, platform, diffPaths, commitSubjects, examples }) {
  const parts = [
    'Reference examples in the target style:',
    ...examples.map((example, index) => [
      `Example ${index + 1}:`,
      `- PR: #${example.prNumber}`,
      `- Platform: ${example.platform}`,
      `- Title: ${example.title}`,
      `- Description: ${example.description}`,
    ].join('\n')),
    '',
    'Now write the production description for this PR:',
    `- PR: #${prNumber}`,
    `- Platform: ${platform}`,
    `- Source ref: ${ref || '(unknown)'}`,
    `- Title: ${title}`,
    `- Body: ${body || '(empty)'}`,
    `- Changed files: ${diffPaths.join(', ') || '(none)'}`,
    `- Commit subjects: ${commitSubjects.join(' | ') || '(none)'}`,
  ];
  return parts.join('\n');
}

function selectReferenceExamples(referenceExamples, platform, prNumber) {
  const samePlatform = referenceExamples.filter((example) => example.platform === platform && example.prNumber !== String(prNumber));
  const fallback = referenceExamples.filter((example) => example.prNumber !== String(prNumber));
  return [...samePlatform.slice(-4), ...fallback.slice(-2)].slice(0, 6);
}

function normalizeAiDescription(value) {
  return String(value || '')
    .replace(/^[-*]\s*/, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodyToProse(body) {
  const chunks = [];
  const seen = new Set();
  for (const rawLine of String(body || '').split('\n')) {
    let line = rawLine.trim();
    if (!line || shouldSkipBodyLine(line)) continue;
    if (line.startsWith('- ') || line.startsWith('* ') || line.startsWith('• ')) {
      line = line.slice(2).trim();
    }
    line = line.replace(/^#+\s*/, '').trim();
    if (!line) continue;
    if (isMergeNoiseText(line)) continue;
    const normalized = line.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    chunks.push(line);
  }
  if (!chunks.length) return '';
  return normalizeHumanText(chunks.join(' '));
}

function shouldSkipBodyLine(line) {
  const lower = String(line || '').toLowerCase().trim();
  return SKIP_BODY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isMergeNoiseText(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  return /^(merge pull request #\d+|merge branch |resolve merge conflict|merge dev\b|merge staging\b|revert "revert "merge branch)/i.test(text);
}

async function listBranchCommitSubjects(repoPath, mergeSha) {
  try {
    const lines = await gitLines(repoPath, [
      'log',
      `${mergeSha}^1..${mergeSha}^2`,
      '--reverse',
      '--no-merges',
      '--format=%s',
    ]);
    return lines
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !NOISY_SUBJECT_RE.test(line))
      .slice(0, 3);
  } catch {
    return [];
  }
}

function inferSummaryFromRef(ref, platform) {
  const normalized = stripOwnerPrefix(ref)
    .toLowerCase()
    .replaceAll('-', '')
    .replaceAll('_', '')
    .replaceAll('/', '');

  if (!normalized) return '';
  if (normalized.includes('livechat')) return `Adds or improves live chat on ${platform.toLowerCase()}.`;
  if (normalized.includes('slatetolexical') || normalized.includes('lexical')) return 'Migrates rich text editing to Lexical and updates affected screens.';
  if (normalized.includes('gifting') || normalized.includes('gift')) return 'Updates gifting behavior and related checkout handling.';
  if (normalized.includes('documentary')) return 'Refreshes the documentary browsing experience and related content blocks.';
  if (normalized.includes('appversion')) return 'Adds app-version support and related release controls.';
  if (normalized.includes('payloadlb') || normalized.includes('loadbalanc')) return 'Improves Payload deployment and load-balancer controls.';
  if (normalized.includes('notification')) return 'Updates notification handling and related delivery flows.';
  return '';
}

function makeTitleSummary(title, platform) {
  let cleanTitle = normalizeHumanText(cleanupSentence(title, 150));
  if (!cleanTitle) return '';
  if (isMergeNoiseText(cleanTitle)) return '';
  cleanTitle = cleanTitle.replace(/^Feature\s+/i, '').replace(/^Fix\s*:\s*/i, 'Fix ');
  const lower = cleanTitle.toLowerCase();
  if (lower.startsWith('fix ') || lower.startsWith('fix:')) return cleanTitle;
  if (lower.startsWith('add ') || lower.startsWith('adds ')) return cleanTitle;
  if (lower.startsWith('update ') || lower.startsWith('improve ') || lower.startsWith('remove ') || lower.startsWith('prevent ')) {
    return cleanTitle;
  }
  return `${capitalize(platform.toLowerCase())}: ${cleanTitle}`;
}

function makeFallbackPoDescription({ title, ref, platform, diffPaths, commitSubjects }) {
  const topic = extractFallbackTopic({ title, ref, diffPaths, commitSubjects });
  const surface = platformSurfaceName(platform);
  const lowerTopic = topic.toLowerCase();

  if (/^fix\b|^hotfix\b|^bugfix\b/.test(lowerTopic)) {
    return `${surface} ${stripLeadingAction(topic)} was fixed so the released flow behaves correctly.`;
  }
  if (/^add\b|^support\b|^enable\b|^create\b/.test(lowerTopic)) {
    return `${surface} ${stripLeadingAction(topic)} support was added for the release.`;
  }
  if (/^update\b|^improve\b|^optimi[sz]e\b|^refactor\b/.test(lowerTopic)) {
    return `${surface} ${stripLeadingAction(topic)} was updated for the production release.`;
  }
  if (/^docs?\b|readme|documentation/.test(lowerTopic)) {
    return `${surface} documentation was updated for ${stripLeadingAction(topic).toLowerCase()}.`;
  }

  return `${surface} ${topic} was included in the production release.`;
}

function extractFallbackTopic({ title, ref, diffPaths, commitSubjects }) {
  const candidates = [title, ...commitSubjects, humanizeRef(ref), inferTopicFromPaths(diffPaths)]
    .map((value) => normalizeHumanText(cleanupSentence(value, 120)))
    .filter(Boolean)
    .filter((value) => !isMergeNoiseText(value))
    .filter((value) => !isGenericDescription(value));
  return candidates[0] || 'release change';
}

function inferTopicFromPaths(diffPaths) {
  const files = diffPaths.map((item) => item.split('/').pop() || '').filter(Boolean);
  const interesting = files.find((file) => !/^(index|package|pnpm-lock|yarn.lock|next-env|eslintignore)$/i.test(file));
  return interesting ? interesting.replace(/\.[^.]+$/, '') : '';
}

function stripLeadingAction(value) {
  return String(value || '')
    .replace(/^(fix|hotfix|bugfix|add|adds|support|supports|enable|enables|create|creates|update|updates|improve|improves|optimi[sz]e|optimi[sz]es|refactor|refactors|docs?|documentation)\b[:/\s-]*/i, '')
    .trim();
}

function platformSurfaceName(platform) {
  if (platform === 'Payload') return 'Payload admin';
  if (platform === 'Mobile') return 'Mobile app';
  if (platform === 'TV') return 'TV platform';
  if (platform === 'E2E') return 'E2E automation';
  if (platform === 'Unit-test') return 'Unit test coverage';
  if (platform === 'Deployment') return 'Deployment workflow';
  if (platform === 'Web') return 'Web app';
  return 'Shared platform';
}

function summarizeCommitSubjects(commitSubjects) {
  const kept = commitSubjects
    .map((value) => normalizeHumanText(cleanupSentence(value, 160)))
    .filter(Boolean)
    .filter((value) => !isMergeNoiseText(value));
  return kept[0] || '';
}

function inferReferencedPrDescription({ body, ref, title, referenceExamples, prNumber }) {
  const candidates = extractReferencedPrNumbers(body, ref, title).filter((value) => value !== String(prNumber));
  if (!candidates.length) return '';
  for (const candidate of candidates) {
    const match = referenceExamples.find((example) => example.prNumber === candidate && example.description);
    if (match) return match.description;
  }
  const sourceRef = extractReferencedMergeRef(body);
  return sourceRef ? humanizeRef(sourceRef) : '';
}

function extractReferencedPrNumbers(body, ref, title) {
  const text = [body, ref, title].filter(Boolean).join('\n');
  const numbers = new Set();
  for (const match of text.matchAll(/backport-(\d+)/gi)) {
    numbers.add(match[1]);
  }
  for (const match of text.matchAll(/merge pull request #(\d+)/gi)) {
    numbers.add(match[1]);
  }
  return [...numbers];
}

function extractReferencedMergeRef(body) {
  const match = String(body || '').match(/merge pull request #\d+ from (\S+)/i);
  return match?.[1] || '';
}

/**
 * Non-LLM fallback description. Only rules that hold for any repo live here;
 * anything project-specific belongs in the profile's prOverrides, and everything
 * unmatched falls through to summarizePathScope().
 */
function inferHeuristicDescription({ title, ref, diffPaths, platform, commitSubjects }) {
  const lowerTitle = String(title || '').toLowerCase();
  const combined = [title, ref, ...commitSubjects, ...diffPaths].join(' ').toLowerCase();
  const paths = diffPaths.join(' ');

  if (/^revert/.test(lowerTitle)) {
    return `A previous ${platformSurfaceName(platform)} change was rolled back to restore the last known-good behaviour.`;
  }
  if (/lock(file)?|pnpm-lock|package-lock|yarn\.lock/.test(combined) && /update|refresh|bump|conflict/.test(lowerTitle)) {
    return 'Dependency lockfiles were refreshed so package resolution stays consistent across environments.';
  }
  if (/cve-\d{4}-\d+/.test(combined) || (/security/.test(combined) && /bump|upgrade|patch|update/.test(combined))) {
    return 'Dependencies were upgraded to pick up a security patch while keeping builds aligned.';
  }
  if (/\.github\/workflows|workflow_dispatch|ci pipeline/.test(combined)) {
    return 'CI and deployment workflows were updated so release pipelines run more reliably.';
  }
  if (/readme|docs|documentation/.test(combined)) {
    return `${platformSurfaceName(platform)} documentation was updated with clearer setup and release guidance.`;
  }
  if (/\.(test|spec)\.|__tests__|snapshot/.test(paths) && /fix|add|update/.test(lowerTitle)) {
    return `${platformSurfaceName(platform)} test coverage was updated so the suite passes reliably.`;
  }
  return '';
}

function summarizePathScope(diffPaths, platform) {
  const topFolders = [...new Set(diffPaths.map((item) => item.split('/').slice(0, 2).join('/')).filter(Boolean))].slice(0, 3);
  if (!topFolders.length) return '';
  if (topFolders.length === 1) return `Updates ${platform.toLowerCase()} code in \`${topFolders[0]}\`.`;
  return `Updates ${platform.toLowerCase()} code across ${topFolders.map((item) => `\`${item}\``).join(', ')}.`;
}

function buildPlatformHighlights(platform, items, options = {}) {
  const descriptions = items
    .map((item) => normalizeHumanText(cleanupSentence(item.description || item.title, 280)))
    .filter(Boolean)
    .filter((value) => !isGenericDescription(value))
    .filter((value, index, values) => values.indexOf(value) === index);

  if (!descriptions.length) return [];
  if (options.detailed) {
    return descriptions
      .flatMap((value) => splitLongSummaryText(value, 300))
      .slice(0, Math.max(8, descriptions.length));
  }
  if (descriptions.length <= 2) {
    return descriptions.map((value) => finalizePlatformBullet(value));
  }

  return buildRemainingPlatformBullets(items).slice(0, 8);
}

function summarizeRemainingItems(platform, items) {
  if (!items.length) return [];

  const ranked = items
    .map((item) => ({
      item,
      score: scoreSummaryRichness(item.description) + item.paths.length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(3, items.length))
    .map(({ item }) => normalizeHumanText(cleanupSentence(item.description || item.title, 180)))
    .filter(Boolean)
    .filter((value) => !isGenericDescription(value));

  if (!ranked.length) return [];
  if (ranked.length === 1) return [ranked[0]];
  return [`Other ${platform.toLowerCase()} rollout work included ${joinPhrases(ranked)}.`];
}

function scoreSummaryRichness(summary) {
  const text = String(summary || '').trim();
  if (!text) return 0;
  return Math.min(text.length, 180);
}

function joinPhrases(values) {
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function finalizePlatformBullet(value) {
  return normalizeHumanText(compactSummaryText(value, 300));
}

function buildRemainingPlatformBullets(items) {
  const descriptions = items
    .map((item) => normalizeHumanText(cleanupSentence(item.description || item.title, 220)))
    .filter(Boolean)
    .filter((value) => !isGenericDescription(value));

  if (!descriptions.length) return [];
  if (descriptions.length <= 2) {
    return descriptions.flatMap((value) => splitLongSummaryText(value, 300));
  }

  const bullets = [];
  for (let index = 0; index < descriptions.length; index += 2) {
    const chunk = descriptions.slice(index, index + 2);
    if (chunk.length === 1) {
      bullets.push(...splitLongSummaryText(chunk[0], 300));
      continue;
    }

    const merged = `${chunk[0].replace(/\.$/, '')}; ${chunk[1].replace(/\.$/, '')}.`;
    if (compactSummaryText(merged, 300).endsWith('…')) {
      bullets.push(...splitLongSummaryText(chunk[0], 300));
      bullets.push(...splitLongSummaryText(chunk[1], 300));
      continue;
    }

    bullets.push(finalizePlatformBullet(merged));
  }
  return bullets;
}


function collectFeaturePhrases(items, rules) {
  const text = items.map((item) => `${item.title} ${item.description}`).join(' ').toLowerCase();
  const features = [];
  for (const [pattern, phrase] of rules) {
    if (pattern.test(text)) features.push(phrase);
  }
  return features;
}

function sentenceWithFeatures(prefix, features, matchCount) {
  if (!features.length) {
    return compactSummaryText(`${prefix} across ${matchCount} PR${matchCount === 1 ? '' : 's'}.`, 300);
  }
  const intro = matchCount > 1 ? `${prefix}, including ` : `${prefix} with `;
  const kept = [];

  for (const feature of features) {
    const candidate = `${intro}${joinPhrases([...kept, feature])}.`;
    if (candidate.length > 300 && kept.length) break;
    if (candidate.length > 300) {
      return compactSummaryText(`${prefix}.`, 300);
    }
    kept.push(feature);
  }

  return compactSummaryText(`${intro}${joinPhrases(kept)}.`, 300);
}

function compactSummaryText(value, maxLength = 300) {
  let text = normalizeHumanText(cleanupSentence(value, maxLength * 2));
  if (!text) return '';
  if (text.length <= maxLength) return text;

  const variants = [
    text.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(),
    text.split(';').slice(0, 1).join(';').trim(),
    text.split(', and ').slice(0, 1).join(', and ').trim(),
    text.split(', ').slice(0, 2).join(', ').trim(),
  ]
    .map((item) => item.replace(/\s+/g, ' ').replace(/\.$/, '').trim())
    .filter(Boolean);

  for (const variant of variants) {
    if (variant.length <= maxLength) {
      return variant.endsWith('.') ? variant : `${variant}.`;
    }
  }

  const words = text.split(' ');
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (`${candidate}…`.length > maxLength) break;
    current = candidate;
  }

  return current ? `${current}…` : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function splitLongSummaryText(value, maxLength = 300) {
  const compact = compactSummaryText(value, maxLength);
  if (compact && !compact.endsWith('…')) return [compact];

  const text = normalizeHumanText(cleanupSentence(value, maxLength * 2));
  const separators = ['; ', ', so ', ', and ', ', with '];

  for (const separator of separators) {
    if (!text.includes(separator)) continue;
    const parts = text
      .split(separator)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 2) continue;

    const bullets = parts.map((part, index) => {
      const suffix = index === 0 ? '' : separator.trim();
      const next = index === 0 ? part : `${suffix} ${part}`;
      return compactSummaryText(next, maxLength);
    });

    if (bullets.every((item) => item && !item.endsWith('…'))) {
      return bullets;
    }
  }

  return [compact];
}

function cleanupSentence(value, maxLength) {
  let text = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[`*#]/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .trim();
  if (!text) return '';
  if (/^(feature|fix)\//i.test(text)) {
    text = text.replace(/^(feature|fix)\//i, '');
  }
  text = text.replace(/^Feature\s+/i, '').replace(/^Fix\s*:\s*/i, 'Fix ');
  text = text.replace(/\.$/, '');
  if (text.length > maxLength) {
    const truncated = text.slice(0, maxLength - 1).trimEnd();
    const safeCut = truncated.lastIndexOf(' ');
    text = `${(safeCut > Math.floor(maxLength * 0.65) ? truncated.slice(0, safeCut) : truncated).trimEnd()}…`;
  }
  return text;
}

function humanizeRef(ref) {
  const normalized = stripOwnerPrefix(ref);
  if (!normalized) return 'Untitled PR';
  const [, rawRest = normalized] = normalized.split('/', 2);
  return rawRest
    .replaceAll('/', ' ')
    .trim()
    .split(/\s+/)
    .map((part) => humanizeSlug(part))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitTabLine(line, expectedParts) {
  const parts = String(line || '').split('\t');
  if (parts.length < expectedParts) return [];
  if (expectedParts === 2) return [parts[0], parts.slice(1).join('\t')];
  return [parts[0], parts[1], parts.slice(2).join('\t')];
}

async function gitText(repoPath, args) {
  const { stdout } = await execFile('git', args, {
    cwd: repoPath,
    env: {
      ...process.env,
      TZ: REPORT_TIMEZONE,
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function gitLines(repoPath, args) {
  const stdout = await gitText(repoPath, args);
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function formatMonthLabel(month) {
  const [year, rawMonth] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: REPORT_TIMEZONE,
  }).format(new Date(Date.UTC(year, rawMonth - 1, 1)));
}

function formatDayLabel(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: REPORT_TIMEZONE,
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatGeneratedAt(value) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: REPORT_TIMEZONE,
  }).format(new Date(value));
  return `${formatted} ${REPORT_TIMEZONE_LABEL}`;
}

function firstDayOfNextMonth(isoDate) {
  const date = parseLocalDate(isoDate);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatDateInReportTimezone(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: REPORT_TIMEZONE,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = values.year;
  const month = values.month;
  const day = values.day;
  return `${year}-${month}-${day}`;
}

function formatMonth(date) {
  return date.toISOString().slice(0, 7);
}

function parseLocalDate(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function escapeMdTable(value) {
  return String(value || '').replaceAll('|', '\\|');
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

async function loadReferenceData(repoPath) {
  const filePath = path.join(repoPath, 'data', 'prod-delivery', 'prod-pr-merges-first-5-po-summaries.md');
  try {
    const raw = await readFile(filePath, 'utf8');
    const descriptions = new Map();
    const platforms = new Map();
    const examples = [];
    for (const line of raw.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = splitMarkdownTableRow(line);
      if (cells.length < 5) continue;
      const [mergeDate, prNumber, title, poDescription, platform] = cells;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(mergeDate)) continue;
      if (!/^\d+$/.test(prNumber)) continue;
      const cleanTitle = stripMarkdownFormatting(title);
      const description = stripMarkdownFormatting(poDescription);
      if (!isLowQualityStoredDescription(description, cleanTitle)) {
        descriptions.set(prNumber, description);
      }
      platforms.set(prNumber, stripMarkdownFormatting(platform));
      examples.push({
        mergeDate,
        prNumber,
        title: cleanTitle,
        description,
        platform: stripMarkdownFormatting(platform),
      });
    }
    return { descriptions, platforms, examples };
  } catch {
    return { descriptions: new Map(), platforms: new Map(), examples: [] };
  }
}

async function loadCuratedPlatformHighlights(repoPath, range) {
  const filePath = path.join(repoPath, 'tools', 'prod-delivery-summary', 'reference-platform-summaries.json');
  try {
    const raw = await readFile(filePath, 'utf8');
    const configs = JSON.parse(raw);
    const matched = configs.find(
      (item) => item.startMonth === range.startMonth && item.endMonth === range.endMonth,
    );
    return matched?.platformHighlights || {};
  } catch {
    return {};
  }
}

function stripMarkdownFormatting(value) {
  return String(value || '')
    .replace(/\\\|/g, '|')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLowQualityStoredDescription(description, title) {
  const cleanDescription = normalizeHumanText(stripMarkdownFormatting(description));
  const cleanTitle = normalizeHumanText(stripMarkdownFormatting(title));
  if (!cleanDescription) return true;
  if (isMergeNoiseText(cleanDescription)) return true;
  if (isGenericDescription(cleanDescription)) return true;
  if (cleanTitle && cleanDescription.toLowerCase() === cleanTitle.toLowerCase()) return true;
  if (/^(web|mobile|payload|other):\s+/i.test(cleanDescription) && cleanDescription.length < 90) return true;
  if (/^[a-z0-9'". -]{1,32}$/i.test(cleanDescription) && cleanDescription.split(/\s+/).length <= 4) return true;
  return false;
}

function isLowQualityGeneratedCandidate(description, title) {
  const cleanDescription = normalizeHumanText(description);
  const cleanTitle = normalizeHumanText(title);
  if (!cleanDescription) return true;
  if (isGenericDescription(cleanDescription)) return true;
  if (cleanTitle && cleanDescription.toLowerCase() === cleanTitle.toLowerCase()) return true;
  if (/^(web|mobile|payload|other):\s+/i.test(cleanDescription) && cleanDescription.length < 90) return true;
  if (/^[a-z0-9'". -]{1,40}$/i.test(cleanDescription) && cleanDescription.split(/\s+/).length <= 4) return true;
  return false;
}

function isGenericDescription(value) {
  const text = normalizeHumanText(stripMarkdownFormatting(value)).replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (GENERIC_DESCRIPTION_RE.test(text)) return true;
  if (PATH_ONLY_DESCRIPTION_RE.test(text)) return true;
  if (/^other\s+.+\s+rollout work included\s+/i.test(text)) return true;
  if (/^updates?\s+.+\s+across\s+\d+\s+prs?\.?$/i.test(text)) return true;
  return false;
}

function findTableEnd(lines, tableStart) {
  let index = tableStart + 2;
  while (index < lines.length && lines[index].trim().startsWith('|')) {
    index += 1;
  }
  return index;
}

function parseReferenceTableRow(line) {
  const cells = splitMarkdownTableRow(line);
  if (cells.length < 5) return null;
  const [mergeDate, prNumber] = cells;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mergeDate)) return null;
  if (!/^\d+$/.test(prNumber)) return null;
  return { mergeDate, prNumber };
}

function formatReferenceTableRow(pr) {
  const cells = [
    pr.date,
    pr.prNumber,
    escapeMdTable(pr.title),
    escapeMdTable(pr.description),
    pr.platform,
  ];
  return `| ${cells.join(' | ')} |`;
}

function splitMarkdownTableRow(line) {
  const cells = [];
  let current = '';
  let escaped = false;

  for (const char of String(line || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells.slice(1, -1);
}

function buildSortKey(date, prNumber) {
  return `${date}::${String(prNumber).padStart(8, '0')}`;
}

function normalizeHumanText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (looksLikeSlug(text)) return humanizeSlug(text);
  return text[0].toUpperCase() + text.slice(1);
}

function looksLikeSlug(value) {
  return /^[a-z0-9]+(?:[-_/][a-z0-9]+){1,}$/.test(value);
}

function humanizeSlug(value) {
  return String(value || '')
    .replaceAll('/', ' ')
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  });
}
