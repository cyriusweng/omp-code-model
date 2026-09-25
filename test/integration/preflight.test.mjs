import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRoutingAdvisor } from '../../src/routing.mjs';
import { installAutomaticRouting } from '../../src/automatic-routing.mjs';
import { installJevGate } from '../../../omp-jev-gate/src/gate.mjs';
import { createJevClient } from '../../../omp-jev-gate/src/jev-client.mjs';

async function fixture({ order = 'route-first', routeMode = 'enforce', gateMode = 'guide', fallback = 'continue', status = 200, invalid, delay } = {}) {
  const root = await mkdtemp(`${process.env.TEST_ROOT ?? tmpdir()}/preflight-`);
  const routeConfig = `${root}/route.json`;
  const gateConfig = `${root}/gate.json`;
  await writeFile(routeConfig, JSON.stringify({
    defaultProfile: 'current', profiles: {
      current: { provider: 'code', model: 'coder', reasoning: 'high' },
    }, routing: { mode: routeMode, fallback: 'main_agent' }
  }));
  await writeFile(gateConfig, JSON.stringify({ mode: gateMode, fallback }));
  const handlers = new Map();
  const bus = new Map();
  const entries = [], requests = [], transitions = [];
  let active = false, aborts = 0, input;
  const pi = {
    on(name, fn) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    appendEntry(customType, data) { entries.push({ customType, data: structuredClone(data) }); },
    events: {
      on(name, fn) { bus.set(name, [...bus.get(name) ?? [], fn]); },
      emit(name, value) { for (const fn of bus.get(name) ?? []) fn(value); },
    },
  };
  const model = {
    provider: 'code', id: 'coder', input: ['text'], reasoning: true,
    thinking: { efforts: ['medium', 'high'] }
  };
  const ctx = {
    sessionManager: { getSessionId: () => 'integration-session' },
    models: { current: () => model, list: () => [model] },
    modelRegistry: { find: () => model },
    abort() { aborts++; }, hasUI: true,
    ui: { onTerminalInput(fn) { input = fn; return () => { input = undefined; }; } },
  };
  const exec = async (_command, args) => args[0] === 'token'
    ? { code: 0, stdout: 'ts_fixture_credential', stderr: '' }
    : { code: 0, stdout: JSON.stringify({ reports: [{ provider: 'code', limits: [], metadata: {} }] }), stderr: '' };
  const fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    if (delay) await delay(init.signal);
    const answers = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (id === invalid) continue;
      if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.1 };
      else if (question.type === 'score') answers[id] = {
        type: 'score', score: 1, confidence: 0.9,
        probabilities: Object.fromEntries(question.criteria.map((_, i) => [String(i), i === 1 ? 1 : 0]))
      };
      else {
        const labels = Object.keys(question.criteria);
        const choice = { execution_path: 'code_model', coding_effort: 'high', decision_mode: 'direct_action', verification_depth: 'targeted' }[id] ?? labels[0];
        answers[id] = {
          type: 'choice', choice, confidence: 0.9,
          probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? 1 : 0]))
        };
      }
    }
    return new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 100, output_tokens: 20 } }), { status });
  };
  const session = {
    isActive() { return active; },
    async run(action, _ctx, signal) {
      signal?.throwIfAborted();
      transitions.push(action);
      const changed = active !== (action === 'start');
      active = action === 'start';
      return { changed };
    },
  };
  let automatic, gate;
  const addRoute = () => {
    automatic = installAutomaticRouting(pi, {
      session, advisor: createRoutingAdvisor(pi, { configPath: routeConfig, exec, fetch }), configPath: routeConfig,
    });
  };
  const addGate = () => {
    gate = installJevGate(pi, {
      client: createJevClient(pi, { exec, fetch }), configPath: gateConfig,
    });
  };
  if (order === 'route-first') { addRoute(); addGate(); } else { addGate(); addRoute(); }
  pi.events.on('cyrius:chain-trace:v1', ({ accept }) => accept('fixture-chain-trace'));
  async function emit(name, event = {}) {
    const results = [];
    for (const handler of handlers.get(name) ?? []) {
      const value = await handler({ type: name, ...event }, ctx);
      results.push(value);
    }
    return results;
  }
  return {
    emit, entries, requests, transitions, ctx, automatic, gate, pi,
    aborts: () => aborts, input: value => input?.(value), hasInput: () => Boolean(input)
  };
}

function piTrace(f, accept) {
  f.pi.events.emit('cyrius:chain-trace:v1', { ctx: f.ctx, accept });
}

for (const order of ['route-first', 'gate-first']) {
  test(`${order} uses one request and correlated, reusable policy receipts`, async () => {
    const f = await fixture({ order });
    const event = { prompt: `  Implement ${'x'.repeat(13000)}\n`, systemPrompt: ['base policy'] };
    const result = await f.emit('before_agent_start', event);
    await f.emit('before_agent_start', event);
    assert.equal(f.requests.length, 1);
    assert.equal(Object.keys(f.requests[0].questions).length, 6);
    assert.deepEqual(f.transitions, ['start']);
    const receipts = f.entries.filter(e => ['omp-code-model-automatic-routing-v1', 'omp-jev-gate-preflight-v1'].includes(e.customType));
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0].data.traceId, receipts[1].data.traceId);
    assert.ok(receipts.every(e => Number.isFinite(e.data.durationMs)));
    const routed = f.entries.find(e => e.customType === 'omp-code-model-routing-v1').data;
    const preflight = f.entries.find(e => e.customType === 'omp-jev-gate-preflight-v1').data;
    assert.equal(routed.judgmentId, preflight.judgmentId);
    let traceId;
    piTrace(f, id => { traceId = id; });
    assert.equal(routed.traceId, traceId);
    assert.match(JSON.stringify(result), /Automatic execution routing receipt/);
    assert.match(JSON.stringify(result), /Jev judgment policy/);
    assert.equal(f.automatic.currentReceipt(f.ctx).effectiveRoute, 'code_model');
    assert.equal(f.hasInput(), false);
  });
}

for (const [routeMode, gateMode, requests] of [['off', 'guide', 1], ['enforce', 'off', 1], ['off', 'off', 0]]) {
  test(`independent settings ${routeMode}/${gateMode} preserve standalone operation`, async () => {
    const f = await fixture({ routeMode, gateMode });
    await f.emit('before_agent_start', { prompt: 'Implement.' });
    assert.equal(f.requests.length, requests);
  });
}

test('shared HTTP failure keeps each configured continue fallback', async () => {
  const f = await fixture({ status: 503 });
  await f.emit('before_agent_start', { prompt: 'Implement.' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.transitions.length, 0);
  assert.equal(f.automatic.currentReceipt(f.ctx).backend, 'deterministic');
  assert.equal(f.entries.find(e => e.customType === 'omp-jev-gate-preflight-v1').data.action, 'unavailable_continue');
});

test('the gate block fallback aborts before a routing transition', async () => {
  const f = await fixture({ status: 503, gateMode: 'enforce', fallback: 'block' });
  await assert.rejects(f.emit('before_agent_start', { prompt: 'Implement.' }));
  assert.equal(f.aborts(), 1);
  assert.equal(f.transitions.length, 0);
});

test('a malformed gate answer follows its own guide fallback while routing remains valid', async () => {
  const f = await fixture({ invalid: 'decision_mode' });
  await f.emit('before_agent_start', { prompt: 'Implement.' });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.transitions, ['start']);
  assert.equal(f.entries.find(e => e.customType === 'omp-jev-gate-preflight-v1').data.backend, 'fallback');
});

test('terminal cancellation aborts the shared request and releases the input observer', async () => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture({
    delay: signal => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started();
    })
  });
  const pending = f.emit('before_agent_start', { prompt: 'Implement.' });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered;
  assert.equal(f.input('\x1b'), undefined);
  await rejected;
  assert.equal(f.transitions.length, 0);
  assert.equal(f.hasInput(), false);
});

test('image-only input shares a single preflight trace', async () => {
  const f = await fixture();
  await f.emit('before_agent_start', { prompt: '', systemPrompt: ['base policy'] });
  const routed = f.entries.find(e => e.customType === 'omp-code-model-routing-v1').data;
  let traceId;
  piTrace(f, id => { traceId = id; });
  assert.equal(f.requests.length, 1);
  assert.equal(routed.traceId, traceId);
});
