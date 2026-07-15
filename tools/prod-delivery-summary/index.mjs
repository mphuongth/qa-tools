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

// Which tool writes the descriptions. "auto" picks the first one this machine can actually use:
// the Claude CLI reuses an existing login, and OPENAI_API_KEY covers machines without it.
// Codex was evaluated and dropped: `codex exec -o` fails to write its output file once the
// prompt carries a real diff and calls run concurrently, and it is ~7x slower per PR.
const DESCRIPTION_WRITER = process.env.PROD_DELIVERY_WRITER || 'auto';
const CLAUDE_BIN = process.env.PROD_DELIVERY_CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = process.env.PROD_DELIVERY_CLAUDE_MODEL || 'sonnet';
const WRITER_TIMEOUT_MS = Number(process.env.PROD_DELIVERY_WRITER_TIMEOUT_MS || 120000);
const DESCRIPTION_CONCURRENCY = Math.max(1, Number(process.env.PROD_DELIVERY_CONCURRENCY || 4));
const MAX_DIFF_CHARS = Number(process.env.PROD_DELIVERY_MAX_DIFF_CHARS || 8000);

const LOCKFILE_RE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Podfile\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/i;
const MANIFEST_RE = /(^|\/)(package\.json|pnpm-workspace\.yaml|Podfile|Gemfile|pyproject\.toml|Cargo\.toml|go\.mod)$/i;
const DOC_RE = /\.(md|mdx|rst|txt)$/i;
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|mp4|woff2?|ttf|otf)$/i;
const MIGRATION_RE = /(^|\/)migrations?\//i;
const CONFIG_RE =
  /(^\.github\/|(^|\/)(Dockerfile|wrangler\.(jsonc?|toml)|tsconfig[\w.]*\.json|vercel\.json|\.env[\w.-]*|[\w.-]+\.config\.(ts|js|mjs|cjs))$|\.(ya?ml|tf)$)/i;
// Path segments that are scaffolding rather than the name of the thing that changed.
const SCAFFOLDING_SEGMENTS = new Set([
  'src', 'app', 'apps', 'api', 'lib', 'libs', 'utils', 'helpers', 'components', 'component',
  'pages', 'page', 'hooks', 'services', 'service', 'shared', 'packages', 'workers', 'worker',
  'server', 'client', 'common', 'core', 'index', 'main', 'types', 'constants', 'config', 'internal',
]);

const DESCRIPTION_WRITER_PROMPT = `You write one-line release descriptions for a Product Owner reading a production delivery report.

PR titles, branch names, and commit messages are frequently vague, wrong, or misleading, and PR bodies are often empty. The changed files and the diff are the source of truth. When the title conflicts with the diff, trust the diff and ignore the title.

Rules:
- Exactly one sentence, 15 to 35 words, plain English that a non-engineer can follow.
- Describe what changed for users, admins, or operations.
- Open with the feature, system, or area that changed. Never open with "This PR", "This change", "The change", "The fix", or "The security fix".
- Never mention line counts, file names, file paths, function names, class names, or component names.
- Never claim an outcome the diff does not actually show. If the diff only proves an area changed, say that plainly rather than inventing a benefit.
- No markdown, no bullets, no quotes, no PR numbers.
- Do not explain your reasoning and do not mention the diff, the files, the title, or the change type.
- Output ONLY the sentence, nothing else.`;
const REPORT_TIMEZONE = process.env.PROD_DELIVERY_REPORT_TIMEZONE || 'Asia/Ho_Chi_Minh';
const REPORT_TIMEZONE_LABEL = process.env.PROD_DELIVERY_REPORT_TIMEZONE_LABEL || 'VNT';
// Highlights summarize the already-written per-PR descriptions into a few grouped bullets. The
// descriptions are the source of truth here, so the writer must not add anything they do not say.
const PLATFORM_HIGHLIGHTS_PROMPT = `You group a platform's shipped pull requests into a few highlight bullets for a Product Owner reading a production delivery report.

You are given one numbered plain-English description per PR. Those descriptions are the source of truth. Summarize and group them — do not add facts they do not contain, and do not invent benefits.

Return ONLY a JSON object, with no prose and no markdown fences, shaped exactly:
{"bullets":[{"text":"<one sentence>","ids":[<description numbers>]}]}

Rules:
- At most ${'${count}'} bullets.
- Every description number must appear in the "ids" of at least one bullet — cover all of them, drop none.
- Group descriptions that are genuinely related into one bullet; keep unrelated work as its own bullet rather than forcing a merge.
- Each "text" is one sentence, plain English a non-engineer can follow, at most 300 characters (about 50 words). Write it concise from the start — do not rely on trimming.
- Lead with the most user-facing or impactful work. Start each sentence with the feature, system, or area — not a verb.
- No marketing language, no line counts, no file names, no PR numbers, and no markdown inside "text".`;

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
  const prepared = [];

  for (const item of prodPrs) {
    const mergeMeta = await readMergeMeta(repoPath, item.mergeSha);
    const diffPaths = await listDiffPaths(repoPath, item.mergeSha);
    const override = project.prOverrides[String(item.prNumber)] || {};
    const parsedSubject = parsePrSubject(mergeMeta.subject);
    const title = parsedSubject?.title || derivePrTitle(mergeMeta.body, mergeMeta.ref, item.prNumber);
    const platformChoice = choosePlatform({
      override,
      referencePlatform: referencePlatforms.get(String(item.prNumber)),
      diffPaths,
      ref: mergeMeta.ref,
      title,
    });
    const platform = platformChoice.platform;
    const commitSubjects = await listBranchCommitSubjects(repoPath, item.mergeSha);
    const referenceDescription = referenceDescriptions.get(String(item.prNumber));

    let descriptionChoice = null;
    if (override.description) {
      descriptionChoice = { description: override.description, source: 'curated override', confidence: 'high' };
    } else if (referenceDescription) {
      descriptionChoice = {
        description: referenceDescription,
        source: 'saved reference',
        confidence: mergeMeta.body ? 'medium' : 'low',
      };
    }

    prepared.push({
      item, mergeMeta, diffPaths, override, parsedSubject, platformChoice,
      platform, title, commitSubjects, referenceDescription, descriptionChoice,
    });
  }

  // Only PRs without a curated or saved description need the writer, and each call costs seconds,
  // so run the remainder in parallel rather than one at a time.
  const needsDescription = prepared.filter((entry) => !entry.descriptionChoice);
  await runWithConcurrency(needsDescription, DESCRIPTION_CONCURRENCY, async (entry) => {
    const evidence = await collectDiffEvidence(repoPath, entry.item.mergeSha, entry.diffPaths);
    entry.descriptionChoice = await derivePoDescription({
      prNumber: entry.item.prNumber,
      body: entry.mergeMeta.body,
      ref: entry.mergeMeta.ref,
      title: entry.title,
      platform: entry.platform,
      evidence,
      commitSubjects: entry.commitSubjects,
    });
  });

  for (const entry of prepared) {
    const { item, mergeMeta, diffPaths, override, parsedSubject, platformChoice, platform, title, referenceDescription, descriptionChoice } = entry;
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
    highlightsMode: 'grouped',
  })).filter((group) => group.count > 0);

  await runWithConcurrency(platformGroups, DESCRIPTION_CONCURRENCY, async (group) => {
    const curated = curatedPlatformHighlights[group.platform];
    const result = curated
      ? { bullets: curated, mode: 'grouped' }
      : await buildPlatformHighlights(group.platform, group.items);
    group.highlights = result.bullets;
    group.highlightsMode = result.mode;
  });

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
  const skipped = [];
  for (const pr of report.prs) {
    // Fallback text is deliberately plain. Persisting it would freeze it in as a "saved
    // reference" and it would never be regenerated once a writer is available again.
    if (pr.descriptionSource === 'evidence fallback') {
      skipped.push(pr.prNumber);
      continue;
    }
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
    return { updated: false, appendedPrNumbers: [], rewrittenPrNumbers: [], skippedPrNumbers: skipped, filePath };
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
    skippedPrNumbers: skipped,
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
    if (group.highlightsMode === 'fallback' && group.highlights.length) {
      lines.push(
        '_Highlights unavailable — no summarizer was configured, so each PR description is listed as-is rather than grouped._',
        '',
      );
    }
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

// Merge commits diff the branch side against the merge base; a squashed PR has no second parent
// and diffs against its own parent instead.
async function resolveDiffRange(repoPath, mergeSha) {
  try {
    const mergeBase = (await gitText(repoPath, ['merge-base', `${mergeSha}^1`, `${mergeSha}^2`])).trim();
    return { fromRef: mergeBase || `${mergeSha}^1`, toRef: `${mergeSha}^2` };
  } catch {
    return { fromRef: `${mergeSha}^`, toRef: mergeSha };
  }
}

function classifyDiffFile(diffPath) {
  if (isUnitTestPath(diffPath) || isE2ePath(diffPath)) return 'test';
  if (LOCKFILE_RE.test(diffPath)) return 'lockfile';
  if (MANIFEST_RE.test(diffPath)) return 'manifest';
  if (MIGRATION_RE.test(diffPath)) return 'migration';
  if (DOC_RE.test(diffPath)) return 'docs';
  if (ASSET_RE.test(diffPath)) return 'asset';
  if (CONFIG_RE.test(diffPath)) return 'config';
  return 'source';
}

// Groups by the repo's own top-level layout rather than a hardcoded app list, so this works on
// any project shape.
function workspaceOf(diffPath) {
  const parts = String(diffPath || '').split('/');
  if (parts[0] === '.github') return '.github';
  if (parts.length > 2 && ['apps', 'packages', 'services', 'workers', 'shared', 'libs', 'modules'].includes(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  if (parts.length > 1) return parts[0];
  return 'root';
}

function workspaceLabel(workspace) {
  if (workspace === '.github') return 'CI workflows';
  if (workspace === 'root') return 'the repository root';
  const [group, name] = String(workspace).split('/');
  if (!name) return humanizeAreaName(group);
  const human = humanizeAreaName(name);
  if (group === 'workers') return `the ${human} worker`;
  if (group === 'packages' || group === 'libs' || group === 'modules') return `the ${human} package`;
  if (group === 'services') return `the ${human} service`;
  if (group === 'shared') return `shared ${human}`;
  if (group === 'apps') return `the ${human} app`;
  return human;
}

// Pulls "next": "1.2.3" -> "1.2.4" pairs straight out of the manifest diff. In a dependency bump
// this is the only real signal, and it is exact.
function parsePackageVersionChanges(manifestDiff) {
  const before = new Map();
  const after = new Map();
  for (const line of String(manifestDiff || '').split('\n')) {
    const match = /^([+-])\s*"?([\w@/.-]+)"?\s*[:=]\s*"?([\w.^~>=< -]+?)"?,?\s*$/.exec(line);
    if (!match) continue;
    const [, sign, name, version] = match;
    if (!/\d/.test(version)) continue;
    (sign === '-' ? before : after).set(name, version.replace(/^[\^~]/, '').trim());
  }

  const changes = [];
  for (const [name, to] of after) {
    const from = before.get(name);
    if (!from || from === to) continue;
    changes.push({ name, from, to });
  }
  return changes;
}

async function collectDiffEvidence(repoPath, mergeSha, diffPaths) {
  const { fromRef, toRef } = await resolveDiffRange(repoPath, mergeSha);
  const files = [];

  try {
    const lines = await gitLines(repoPath, ['diff', '--numstat', fromRef, toRef]);
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [added, deleted, diffPath] = parts;
      if (!diffPath) continue;
      files.push({
        path: diffPath,
        added: Number(added) || 0,
        deleted: Number(deleted) || 0,
        kind: classifyDiffFile(diffPath),
        workspace: workspaceOf(diffPath),
      });
    }
  } catch {
    for (const diffPath of diffPaths) {
      files.push({ path: diffPath, added: 0, deleted: 0, kind: classifyDiffFile(diffPath), workspace: workspaceOf(diffPath) });
    }
  }

  const counts = {};
  for (const file of files) counts[file.kind] = (counts[file.kind] || 0) + 1;
  const substantive = files.filter((file) => !['lockfile', 'asset'].includes(file.kind));
  const workspaces = [...new Set(substantive.map((file) => file.workspace))];

  let packageChanges = [];
  if (counts.manifest) {
    try {
      // Pathspecs resolve relative to the git cwd, so :(top) anchors them at the repo root.
      const manifestDiff = await gitText(repoPath, [
        'diff',
        fromRef,
        toRef,
        '--',
        ...files.filter((file) => file.kind === 'manifest').map((file) => `:(top)${file.path}`),
      ]);
      packageChanges = parsePackageVersionChanges(manifestDiff);
    } catch {
      packageChanges = [];
    }
  }

  const codeFiles = files.filter((file) => ['source', 'migration'].includes(file.kind));
  let hunks = '';
  if (codeFiles.length) {
    try {
      const raw = await gitText(repoPath, [
        'diff',
        '-U2',
        fromRef,
        toRef,
        '--',
        ...codeFiles.slice(0, 20).map((file) => `:(top)${file.path}`),
      ]);
      hunks = raw.length > MAX_DIFF_CHARS ? `${raw.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : raw;
    } catch {
      hunks = '';
    }
  }

  return { files, counts, workspaces, packageChanges, hunks, archetype: detectArchetype(counts) };
}

// Any real code change outranks everything else. Otherwise the dominant non-code kind wins, so a
// docs PR that also nudges one config value is still a docs PR.
function detectArchetype(counts) {
  if ((counts.source || 0) || (counts.migration || 0)) return 'code';

  const test = counts.test || 0;
  const docs = counts.docs || 0;
  const config = counts.config || 0;
  const deps = (counts.manifest || 0) + (counts.lockfile || 0);

  if (test) return 'tests';
  if (docs && docs >= config) return 'docs';
  if (deps) return 'dependency-bump';
  if (config) return 'config';
  return 'code';
}

function categorizePlatform(diffPaths, ref) {
  return analyzePlatform(diffPaths, ref).platform;
}

// Priority: curated override, then a reviewed platform saved in the markdown table, then the
// file-path/keyword analysis. A specific saved platform is a human decision and must not be
// overwritten by the algorithm; "Other" is the uncategorized catch-all, not a decision, so it
// falls through to analysis.
function choosePlatform({ override, referencePlatform, diffPaths, ref, title }) {
  if (override.platform) {
    return {
      platform: override.platform,
      source: 'curated override',
      reason: 'Manual platform override for this PR.',
      confidence: 'high',
    };
  }

  const analyzed = analyzePlatform(diffPaths, ref, title);

  if (referencePlatform && referencePlatform !== 'Other' && platformOrder().includes(referencePlatform)) {
    const disagrees = analyzed.platform !== 'Other' && analyzed.platform !== referencePlatform;
    return {
      platform: referencePlatform,
      source: 'saved reference',
      reason: disagrees
        ? `Kept reviewed platform "${referencePlatform}"; changed files look like "${analyzed.platform}".`
        : 'Reviewed platform from the saved reference table.',
      confidence: 'high',
      fileHint: disagrees ? analyzed.platform : '',
      crossPlatform: analyzed.crossPlatform || [],
    };
  }

  return analyzed;
}

function analyzePlatform(diffPaths, ref, title = '') {
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

  const productCounts = [...counts.entries()]
    .filter(([platform]) => productPlatforms().includes(platform))
    .sort((a, b) => b[1] - a[1]);
  if (productCounts.length) {
    const [platform, count] = productCounts[0];
    const crossPlatform = productCounts.length > 1 ? productCounts.map(([name]) => name) : [];
    return {
      platform,
      source: 'file paths',
      reason: crossPlatform.length
        ? `Multiple product platforms touched (${crossPlatform.join(', ')}); "${platform}" has the most files (${count}).`
        : `Product files beat test files; ${count} ${platform} path${count === 1 ? '' : 's'} matched.`,
      confidence: e2eCount || testOnlyCount ? 'medium' : 'high',
      evidence: evidence.get(platform) || [],
      crossPlatform,
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

  const textPlatform = inferPlatformFromText(`${ref} ${title}`);
  if (textPlatform) {
    return {
      platform: textPlatform,
      source: 'title/branch text',
      reason: `No product-file signal; inferred "${textPlatform}" from the title and branch.`,
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
  if (platformChoice.fileHint) {
    warnings.push(`Kept saved platform "${platformChoice.platform}", but changed files look like "${platformChoice.fileHint}"; verify.`);
  }
  if (platformChoice.crossPlatform && platformChoice.crossPlatform.length > 1) {
    const spanned = platformChoice.crossPlatform.join(', ');
    warnings.push(platformChoice.source === 'saved reference'
      ? `PR spans multiple product platforms (${spanned}); kept the reviewed platform "${platformChoice.platform}".`
      : `PR spans multiple product platforms (${spanned}); primary "${platformChoice.platform}" chosen by file count.`);
  }
  // A specific saved platform wins outright, so a leftover disagreement here means the saved value
  // is malformed (not in the known set) and was skipped.
  if (referencePlatform && referencePlatform !== 'Other' && referencePlatform !== platformChoice.platform
    && !override.platform && !platformOrder().includes(referencePlatform)) {
    warnings.push(`Saved platform "${referencePlatform}" is not a known platform; used "${platformChoice.platform}" instead.`);
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

// Titles, branch names, commit subjects, and PR bodies are unreliable, so every path below is
// driven by the diff instead.
async function derivePoDescription({ prNumber, body, ref, title, platform, evidence, commitSubjects }) {
  const writer = await resolveDescriptionWriter();
  if (writer) {
    const prompt = buildEvidencePrompt({ prNumber, title, ref, body, platform, evidence, commitSubjects });
    const written = normalizeAiDescription(await writer.write(prompt));
    if (written && !isLowQualityGeneratedCandidate(written, title)) {
      return { description: written, source: `ai (${writer.name})`, confidence: 'medium' };
    }
  }

  return {
    description: describeFromEvidence({ evidence, platform }),
    source: 'evidence fallback',
    confidence: 'low',
  };
}

// Each writer returns raw model text. Callers normalize it: descriptions collapse to one sentence,
// highlights parse the multi-line bullet list, so normalization cannot live in here.
const DESCRIPTION_WRITERS = {
  // The Claude CLI reuses an existing login, so it needs no API key.
  claude: {
    name: 'claude',
    available: () => canRunBinary(CLAUDE_BIN, ['--version']),
    async write(prompt) {
      const { stdout } = await execFile(
        CLAUDE_BIN,
        ['-p', prompt, '--model', CLAUDE_MODEL, '--allowed-tools', ''],
        { timeout: WRITER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
      return stdout;
    },
  },
  openai: {
    name: 'openai',
    available: async () => Boolean(process.env.OPENAI_API_KEY),
    async write(prompt) {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const response = await client.responses.create({
        model: DESCRIPTION_MODEL,
        input: [
          { role: 'system', content: DESCRIPTION_WRITER_PROMPT },
          { role: 'user', content: prompt },
        ],
      });
      return response.output_text || '';
    },
  },
};

let resolvedWriter;

async function resolveDescriptionWriter() {
  if (resolvedWriter !== undefined) return resolvedWriter;

  if (DESCRIPTION_WRITER === 'none') {
    resolvedWriter = null;
    return resolvedWriter;
  }

  const order = DESCRIPTION_WRITER === 'auto' ? ['claude', 'openai'] : [DESCRIPTION_WRITER];
  for (const name of order) {
    const writer = DESCRIPTION_WRITERS[name];
    if (writer && (await writer.available())) {
      resolvedWriter = wrapWriter(writer);
      return resolvedWriter;
    }
  }

  // Degrading silently is what made the old descriptions quietly wrong, so say it once.
  process.stderr.write(
    `[prod-delivery] No description writer available (tried: ${order.join(', ')}). Falling back to plain `
    + 'diff-derived descriptions; they are marked low confidence and are not saved to the reference file. '
    + 'Install the Claude or Codex CLI, or set OPENAI_API_KEY. Set PROD_DELIVERY_WRITER=none to silence this.\n',
  );
  resolvedWriter = null;
  return resolvedWriter;
}

function wrapWriter(writer) {
  let failureWarned = false;
  return {
    name: writer.name,
    async write(prompt) {
      try {
        return await writer.write(prompt);
      } catch (error) {
        if (!failureWarned) {
          failureWarned = true;
          process.stderr.write(`[prod-delivery] ${writer.name} writer failed: ${error?.message || error}\n`);
        }
        return '';
      }
    },
  };
}

async function canRunBinary(bin, args) {
  try {
    await execFile(bin, args, { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

async function runWithConcurrency(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

function buildEvidencePrompt({ prNumber, title, ref, body, platform, evidence, commitSubjects }) {
  const grouped = new Map();
  for (const file of evidence.files) {
    if (file.kind === 'lockfile') continue;
    if (!grouped.has(file.workspace)) grouped.set(file.workspace, []);
    grouped.get(file.workspace).push(`${file.path} (${file.kind}, +${file.added}/-${file.deleted})`);
  }

  const sections = [
    DESCRIPTION_WRITER_PROMPT,
    '',
    `PR #${prNumber}`,
    `Platform: ${platform}`,
    `Title (unreliable): ${title || '(none)'}`,
    `Branch (unreliable): ${ref || '(none)'}`,
    `PR body: ${body ? String(body).slice(0, 600) : '(empty)'}`,
    `Commit subjects (unreliable): ${commitSubjects.join(' | ') || '(none)'}`,
    `Change type detected from the diff: ${evidence.archetype}`,
    `Areas touched: ${evidence.workspaces.map(workspaceLabel).join(', ') || '(none)'}`,
  ];

  if (evidence.packageChanges.length) {
    sections.push(
      '',
      'Dependency version changes:',
      ...evidence.packageChanges.slice(0, 12).map((change) => `- ${change.name}: ${change.from} -> ${change.to}`),
    );
  }

  if (grouped.size) {
    sections.push('', 'Changed files (lockfiles omitted):');
    for (const [workspace, list] of grouped) {
      sections.push(`  ${workspaceLabel(workspace)}:`, ...list.slice(0, 12).map((entry) => `    - ${entry}`));
    }
  }

  if (evidence.hunks) {
    sections.push('', 'Diff of the changed code:', evidence.hunks);
  }

  return sections.join('\n');
}

// Plain but true. Used only when no writer is available; it never asserts an outcome the diff
// does not show, which is the failure mode the old canned-sentence rules had.
function describeFromEvidence({ evidence, platform }) {
  const places = evidence.workspaces.length
    ? joinPhrases(evidence.workspaces.map(workspaceLabel))
    : platformSurfaceName(platform);

  if (evidence.archetype === 'dependency-bump') {
    const names = evidence.packageChanges.slice(0, 3).map((change) => change.name);
    const subject = names.length ? `${joinPhrases(names)} and related packages` : 'Project dependencies';
    return `${subject} were updated to newer versions across ${places}.`;
  }
  if (evidence.archetype === 'docs') return `Setup and release documentation was refreshed for ${places}.`;
  if (evidence.archetype === 'tests') return `Automated test coverage was extended for ${places}.`;
  if (evidence.archetype === 'config') return `Deployment and configuration settings were adjusted for ${places}.`;

  const areas = featureAreasFromEvidence(evidence);
  const [singular, plural] = actionVerbFromEvidence(evidence);
  if (!areas.length) return `Part of ${places} ${singular} in this release.`;
  const noun = areas.length > 1 ? 'flows' : 'flow';
  return `The ${joinPhrases(areas)} ${noun} in ${places} ${areas.length > 1 ? plural : singular}.`;
}

function featureAreasFromEvidence(evidence) {
  const areas = [];
  for (const file of evidence.files) {
    if (!['source', 'migration'].includes(file.kind)) continue;
    const relative = file.workspace === 'root' || !file.path.startsWith(`${file.workspace}/`)
      ? file.path
      : file.path.slice(file.workspace.length + 1);
    const segments = relative.split('/');
    const stem = (segments.pop() || '').replace(/\.[^.]+$/, '');
    const meaningful = [...segments]
      .reverse()
      .find((segment) => segment && !segment.startsWith('[') && !SCAFFOLDING_SEGMENTS.has(segment.toLowerCase()));
    const picked = meaningful || (SCAFFOLDING_SEGMENTS.has(stem.toLowerCase()) ? '' : stem);
    if (!picked) continue;
    const human = humanizeAreaName(picked);
    if (human && !areas.includes(human)) areas.push(human);
  }
  return areas.slice(0, 3);
}

function humanizeAreaName(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Deliberately ignores the title and branch name: those are the unreliable inputs this path
// exists to work around. Whether code was added or edited is visible in the diff itself.
function actionVerbFromEvidence(evidence) {
  const codeFiles = evidence.files.filter((file) => ['source', 'migration'].includes(file.kind));
  if (!codeFiles.length) return ['was updated', 'were updated'];
  if (codeFiles.every((file) => file.deleted === 0 && file.added > 0)) return ['was added', 'were added'];
  if (codeFiles.every((file) => file.added === 0 && file.deleted > 0)) return ['was removed', 'were removed'];
  return ['was updated', 'were updated'];
}

function normalizeAiDescription(value) {
  const text = String(value || '')
    .replace(/^[-*]\s*/, '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  // Models sometimes prefix the answer with reasoning about the diff. Keep the sentence that
  // actually describes the change, and drop the commentary about how it was worked out.
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length <= 1) return text;
  const described = sentences.filter((sentence) => !META_SENTENCE_RE.test(sentence));
  return (described[0] || sentences[sentences.length - 1]).trim();
}

const META_SENTENCE_RE = /\b(diffs?|changed files?|commit|pr title|the title|change type|this (is|appears)|based on)\b/i;

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

// Summarizes a platform's PRs into a few highlight bullets. The per-PR descriptions are already
// accurate, so with a writer available we group them; without one we just list them. Neither path
// invents content the descriptions do not contain.
// Returns { bullets, mode }. mode is 'grouped' when a writer summarized the descriptions into the
// target bullet count with verified coverage, or 'fallback' when no writer was available and the
// descriptions could only be packed verbatim (complete coverage, but not a real summary — the
// renderer labels it so a reader is not shown a wall of bullets as if it were a grouped summary).
async function buildPlatformHighlights(platform, items) {
  const descriptions = items
    .map((item) => normalizeHumanText(cleanupSentence(item.description || item.title, 300)))
    .filter(Boolean)
    .filter((value) => !isGenericDescription(value))
    .filter((value, index, values) => values.indexOf(value) === index);

  if (!descriptions.length) return { bullets: [], mode: 'grouped' };

  // 1–3 PRs: each description is itself a highlight; grouping would only lose detail.
  if (descriptions.length <= 3) {
    return { bullets: descriptions.map((value) => finalizePlatformBullet(value)), mode: 'grouped' };
  }

  const target = highlightBulletTarget(descriptions.length);

  const writer = await resolveDescriptionWriter();
  if (writer) {
    const grouped = await generatePlatformHighlights(writer, platform, descriptions, target);
    if (grouped && grouped.length) return { bullets: grouped, mode: 'grouped' };
  }

  // No writer (or the writer failed): the descriptions cannot be summarized without an LLM, so
  // every one is packed verbatim into as few bullets as fit. Coverage is complete, but the bullet
  // count is not the grouped target — mode 'fallback' tells the renderer to say so.
  return { bullets: packDescriptions(descriptions), mode: 'fallback' };
}

// 4–19 PRs: up to one bullet per PR (cap 8), so only genuinely related work gets grouped.
// 20+ PRs: 4–8 grouped bullets, fewer as volume grows so the section stays scannable.
function highlightBulletTarget(count) {
  if (count < 20) return Math.min(8, Math.max(4, count));
  return Math.max(4, Math.min(8, Math.round(count / 8)));
}

// Concatenates descriptions into as few bullets as fit within maxLen. Loses nothing — every
// description ends up in some bullet — while roughly halving the bullet count versus one-per-PR.
function packDescriptions(descriptions, maxLen = 280) {
  const bullets = [];
  let current = '';
  for (const description of descriptions) {
    const piece = String(description).replace(/\.$/, '').trim();
    if (!piece) continue;
    const candidate = current ? `${current}; ${piece}` : piece;
    if (current && candidate.length > maxLen) {
      bullets.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current) bullets.push(current);
  return bullets.map((value) => finalizePlatformBullet(value));
}

// Structured grouping with verified coverage. The model returns bullets tagged with the numbers of
// the descriptions each one covers, so the code can check that every PR is actually represented and
// retry for any that were missed — coverage is validated, not merely requested in the prompt. Any
// description the model still never tags is appended (packed) so full coverage is guaranteed.
async function generatePlatformHighlights(writer, platform, descriptions, target) {
  const total = descriptions.length;
  const allIds = new Set(descriptions.map((_, index) => index + 1));
  const numbered = descriptions.map((value, index) => `${index + 1}. ${value}`);
  let best = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const missing = best ? missingIds(best.covered, allIds) : [];
    const prompt = attempt === 0
      ? [
          PLATFORM_HIGHLIGHTS_PROMPT.replace('${count}', String(target)),
          '',
          `Platform: ${platform}`,
          '',
          'Descriptions:',
          ...numbered,
        ].join('\n')
      : [
          `Revise the highlight bullets for platform ${platform}. Return the same JSON object shape:`,
          '{"bullets":[{"text":"<one sentence>","ids":[<description numbers>]}]}',
          `Use at most ${target} bullets. These description numbers were not covered and must each`,
          `appear in some bullet's "ids": ${missing.join(', ')}. Fold them into the most related`,
          'existing bullet where possible rather than adding new bullets. Same rules as before.',
          '',
          'Descriptions:',
          ...numbered,
        ].join('\n');

    const groups = await writerHighlightGroups(writer, prompt);
    if (!groups.length) continue;

    const covered = new Set();
    for (const group of groups) {
      for (const id of group.ids) if (allIds.has(id)) covered.add(id);
    }
    if (!best || covered.size > best.covered.size) best = { groups, covered };
    if (covered.size === total) break;
  }

  if (!best) return null;

  const bullets = best.groups.map((group) => group.text).filter(Boolean);
  const missing = missingIds(best.covered, allIds);
  if (missing.length) {
    bullets.push(...packDescriptions(missing.map((id) => descriptions[id - 1])));
  }
  return bullets;
}

function missingIds(covered, allIds) {
  const missing = [];
  for (const id of allIds) if (!covered.has(id)) missing.push(id);
  return missing;
}

// Parses the model's JSON grouping into { text, ids } bullets. Tolerates markdown fences or stray
// prose around the object. Returns [] if nothing parseable came back.
async function writerHighlightGroups(writer, prompt) {
  const raw = await writer.write(prompt);
  const parsed = parseJsonObject(raw);
  const bullets = Array.isArray(parsed?.bullets) ? parsed.bullets : [];
  return bullets
    .map((bullet) => ({
      text: finalizePlatformBullet(String(bullet?.text || '')),
      ids: Array.isArray(bullet?.ids)
        ? bullet.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id))
        : [],
    }))
    .filter((bullet) => bullet.text);
}

function parseJsonObject(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function joinPhrases(values) {
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function finalizePlatformBullet(value) {
  const text = normalizeHumanText(compactSummaryText(value, 300));
  if (!text || /[.!?…]$/.test(text)) return text;
  return `${text}.`;
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
