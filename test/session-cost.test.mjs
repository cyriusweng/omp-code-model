import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateSessionCost, formatSessionCostTable, MalformedSessionError } from '../src/session-cost.mjs';

const fixture = fileURLToPath(new URL('./fixtures/mixed-session.jsonl', import.meta.url));
const cli = fileURLToPath(new URL('../bin/session-cost.mjs', import.meta.url));
const content = await readFile(fixture, 'utf8');
const header = { type: 'session', id: 'test-session' };
const usage = { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.01 } };
const assistant = () => ({
  type: 'message',
  message: { role: 'assistant', provider: 'provider', model: 'model', usage: structuredClone(usage) },
});
const jsonl = (...entries) => entries.map((entry) => JSON.stringify(entry)).join('\n');
const run = (args, input, command = cli) => {
  const result = spawnSync(process.execPath, [command, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
};
const checkCost = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ~= ${expected}`);

test('mixed fixture aggregates repeated models, auxiliary usage and all branches', () => {
  const { rows, total } = aggregateSessionCost(content);
  const expected = [
    ['anthropic', 'claude-opus-4-5', 5500, 500, 1700, 1000, 0.0454],
    ['anthropic', 'claude-sonnet-4-2', 1200, 150, 300, 0, 0.00615],
    ['google-antigravity', 'gemini-3.8-flash', 1800, 400, 200, 0, 0.0031],
    ['openai-codex', 'gpt-6-astra', 800, 50, 100, 0, 0.003],
  ];
  assert.equal(rows.length, expected.length);
  rows.forEach((row, i) => {
    const { cost, ...tokens } = row;
    const [provider, model, input, output, cacheRead, cacheWrite, expectedCost] = expected[i];
    assert.deepEqual(tokens, { provider, model, input, output, cacheRead, cacheWrite });
    checkCost(cost, expectedCost);
  });
  const { cost, ...tokens } = total;
  assert.deepEqual(tokens, { input: 9300, output: 1100, cacheRead: 2300, cacheWrite: 1000 });
  checkCost(cost, 0.05765);
});

test('provider and model jointly identify rows and recorded costs retain their precision', () => {
  const first = assistant();
  first.message.usage.cost = { input: 100, total: 1e-10 };
  const second = structuredClone(first);
  second.message.provider = 'another-provider';
  const auxiliary = { type: 'model_usage', ...first.message };
  const { rows, total } = aggregateSessionCost(jsonl(header, first, second, auxiliary));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'another-provider');
  assert.equal(rows[1].cost, 2e-10);
  assert.equal(total.cost, 3e-10);
  assert.equal(total.input, 30);
});

test('zero-usage headers and legacy messages produce a zero total', () => {
  const summary = aggregateSessionCost(jsonl(header, { type: 'message', message: { role: 'assistant' } }));
  assert.deepEqual(summary, { rows: [], total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  assert.match(formatSessionCostTable(summary), /TOTAL\s+0\s+0\s+0\s+0\s+0\.000000$/);
});

test('blank lines, CRLF and final unterminated records retain the same totals', () => {
  const modified = `\r\n${content.trim().split('\n').join('\r\n\r\n')}`;
  assert.deepEqual(aggregateSessionCost(modified), aggregateSessionCost(content));
});

test('CLI table contains ordered model rows and the complete total', () => {
  const result = run([fixture]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 6);
  assert.match(lines[0], /Provider\s+Model\s+Input\s+Output\s+Cache Read\s+Cache Write\s+Cost \(USD\)/);
  assert.match(lines[1], /anthropic\s+claude-opus-4-5\s+5500\s+500\s+1700\s+1000\s+0\.045400$/);
  assert.match(lines[5], /^TOTAL\s+9300\s+1100\s+2300\s+1000\s+0\.057650$/);
});

test('CLI JSON and explicit stdin produce the same summary as file input', () => {
  const file = run(['--json', fixture]);
  const stdin = run(['-j', '-'], content);
  assert.equal(file.status, 0);
  assert.equal(stdin.status, 0);
  assert.equal(file.stderr, '');
  assert.equal(stdin.stderr, '');
  assert.deepEqual(JSON.parse(file.stdout), aggregateSessionCost(content));
  assert.equal(stdin.stdout, file.stdout);
});

test('invalid record structure returns code 2, a line number and empty stdout', () => {
  const cases = [
    ['', 1],
    ['{}', 1],
    [jsonl({ type: 'message', message: { role: 'assistant' } }), 1],
    [`${jsonl(header)}\n\n{broken`, 3],
    [jsonl(header, null), 2],
    [jsonl(header, []), 2],
    [jsonl(header, 12), 2],
    [jsonl(header, {}), 2],
    [jsonl(header, header), 2],
    [jsonl(header, { type: 'message' }), 2],
    [jsonl(header, { type: 'message', message: {} }), 2],
    [jsonl({ type: 'title' }, header), 1],
    [jsonl(header, { type: 'model_usage' }), 2],
  ];
  for (const [input, line] of cases) {
    const result = run(['-'], input);
    assert.equal(result.status, 2, input);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`malformed input: Line ${line}:`));
  }
});

test('invalid usage fields and identities raise line-specific validation errors', () => {
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    for (const value of [undefined, null, '10', -1, 0.5, 1e100]) {
      const entry = assistant();
      entry.message.usage[field] = value;
      assert.throws(() => aggregateSessionCost(jsonl(header, entry)), (error) => {
        assert.ok(error instanceof MalformedSessionError);
        assert.equal(error.line, 2);
        assert.match(error.message, new RegExp(`usage\\.${field}`));
        return true;
      });
    }
  }
  for (const value of [undefined, null, 0.01, {}, { total: '0.1' }, { total: -1 }, { total: null }]) {
    const entry = assistant();
    entry.message.usage.cost = value;
    assert.throws(() => aggregateSessionCost(jsonl(header, entry)), /usage.cost.total/);
  }
  for (const field of ['provider', 'model']) {
    for (const value of [undefined, null, {}, '', ' ', 'name\tvalue', 'name\u001bvalue']) {
      const entry = assistant();
      entry.message[field] = value;
      assert.throws(() => aggregateSessionCost(jsonl(header, entry)), /provider and model strings/);
    }
  }
  const entry = assistant();
  entry.message.usage = null;
  assert.throws(() => aggregateSessionCost(jsonl(header, entry)), /usage must be an object/);
});

test('malformed late usage and numeric overflow suppress the complete report', () => {
  const partial = assistant();
  partial.message.usage = {};
  const result = run(['--json', '-'], `${content}${JSON.stringify(partial)}\n`);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage.input/);

  const entry = assistant();
  entry.message.usage.input = Number.MAX_SAFE_INTEGER;
  assert.throws(() => aggregateSessionCost(jsonl(header, entry, entry)), /aggregate input/);
  entry.message.usage.input = 1;
  entry.message.usage.cost.total = 1e308;
  assert.throws(() => aggregateSessionCost(jsonl(header, entry, entry)), /aggregate cost/);
  const infiniteCost = jsonl(header, assistant()).replace('"total":0.01', '"total":1e999');
  assert.throws(() => aggregateSessionCost(infiniteCost), /usage.cost.total/);
});

test('CLI rejects invalid UTF-8 with code 2 and empty stdout', () => {
  const result = run(['-'], Buffer.from([0xc3, 0x28]));
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /expected UTF-8/);
});

test('help succeeds and invocation or file access errors use code 1', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /Usage: omp-session-cost/);
  assert.match(help.stdout, /2  Malformed session input/);
  for (const args of [[], ['--unknown'], [fixture, fixture], [`${fixture}.missing`]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /omp-session-cost:/);
  }
});

test('package executable works through a symlink in a path containing spaces', async (t) => {
  const directory = await mkdtemp(join(process.env.TEST_ROOT ?? tmpdir(), 'session cost '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const linked = join(directory, 'omp-session-cost');
  await symlink(cli, linked);
  const result = run(['--json', fixture], undefined, linked);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), aggregateSessionCost(content));

  const local = join(directory, 'sample session.jsonl');
  await writeFile(local, content);
  const file = run(['--', local]);
  assert.equal(file.status, 0);
  assert.match(file.stdout, /^Provider/);
});
