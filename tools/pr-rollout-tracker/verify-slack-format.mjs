#!/usr/bin/env node
/**
 * Asserts generateSlackMessage matches the HTML "Slack Message" tab defaults
 * (Merged / Approved / Pending on, Hold off) for a fixed fixture.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSlackMessage } from './index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, '__fixtures__', 'slack-parity.json');
const expectedPath = path.join(__dirname, '__fixtures__', 'expected-slack.txt');

const fixed = new Date('2026-04-14T15:00:00.000Z');
const prs = JSON.parse(await readFile(fixturePath, 'utf8'));
const expected = (await readFile(expectedPath, 'utf8')).trimEnd();

const actual = generateSlackMessage(prs, fixed, {
  includeHold: false,
  reportTimeZone: 'UTC',
});

assert.equal(actual, expected);

const withHold = generateSlackMessage(prs, fixed, { includeHold: true, reportTimeZone: 'UTC' });
assert.ok(withHold.includes('⏸ HOLD'));
assert.ok(withHold.includes('T hold'));

process.stdout.write('verify-slack-format: ok\n');
