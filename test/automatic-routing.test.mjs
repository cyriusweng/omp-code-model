import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  AUTOMATIC_ROUTING_STATE_TYPE,
  installAutomaticRouting,
} from '../src/automatic-routing.mjs';

const root = process.env.TEST_ROOT ?? tmpdir();

async function fixture({ mode = 'off', fallback = 'main_agent', minConfidence, recommendations = [] } = {}) {
  const dir = await mkdtemp(`${root}/automatic-routing-`);
  const configPath = `${dir}/config.json`;
  const routing = { mode, fallback };
  if (minConfidence !== undefined) routing.minConfidence = minConfidence;
  await writeFile(configPath, JSON.stringify({
    defaultProfile: 'current',
    profiles: { current: { provider: 'code', model: 'coder', reasoning: 'medium' } },
    routing,
  }));

  const handlers = new Map();
  const entries = [];
  const advisorCalls = [];
  const transitions = [];
  let active = false;
  const pi = {
    on(name, handler) {
      const group = handlers.get(name) ?? [];
      group.push(handler);
      handlers.set(name, group);
    },
    appendEntry(customType, data) {
      entries.push({ customType, data: structuredClone(data) });
    },
  };
  const advisor = {
    async recommend(input) {
      advisorCalls.push(structuredClone(input));
      return recommendations.shift() ?? {
        route: 'main_agent',
        effort: 'medium',
        judgment: {
          backend: 'deterministic',
          model: undefined,
          confidence: undefined,
          fallbackReason: 'typesafe_credential_unavailable',
        },
        quota: { state: 'unknown' },
      };
    },
  };
  const session = {
    isActive() { return active; },
    async run(action, _ctx, _signal, options) {
      transitions.push({ action, options });
      if (action === 'start') {
        const changed = !active;
        active = true;
        return { changed };
      }
      if (action === 'finish') {
        const changed = active;
        active = false;
        return { changed };
      }
      throw new Error(`Unexpected action: ${action}`);
    },
  };
  const ctx = { sessionManager: { getSessionId: () => 'session-one' } };
  const controller = installAutomaticRouting(pi, { advisor, session, configPath });
  async function emit(name, event = {}) {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx));
    return results;
  }
  return { advisorCalls, controller, emit, entries, transitions };
}

function choice(route, effort = 'medium') {
  return {
    route,
    effort,
    judgment: {
      backend: 'typesafe',
      model: 'jev-1.13.0',
      confidence: 0.8,
      fallbackReason: undefined,
    },
    quota: { state: 'available' },
  };
}

test('off mode leaves every prompt outside the automatic judgment path', async () => {
  const f = await fixture({ mode: 'off' });
  await f.emit('before_agent_start', { prompt: 'Implement a feature.' });
  assert.deepEqual(f.advisorCalls, []);
  assert.deepEqual(f.transitions, []);
  assert.deepEqual(f.entries, []);
});

test('observe mode judges once across hook re-entry and records a compact receipt', async () => {
  const f = await fixture({ mode: 'observe', recommendations: [choice('code_model', 'high')] });
  const event = { prompt: 'Implement a feature and targeted tests.' };
  await f.emit('before_agent_start', event);
  await f.emit('before_agent_start', event);

  assert.equal(f.advisorCalls.length, 1);
  assert.equal(f.advisorCalls[0].fallbackRoute, 'main_agent');
  assert.deepEqual(f.transitions, []);
  const receipt = f.entries.find(entry => entry.customType === AUTOMATIC_ROUTING_STATE_TYPE)?.data;
  assert.equal(receipt.mode, 'observe');
  assert.equal(receipt.route, 'code_model');
  assert.equal(receipt.action, 'observed');
  assert.equal(receipt.backend, 'typesafe');
  assert.equal(receipt.promptDigest.length, 16);
  assert.equal(JSON.stringify(receipt).includes(event.prompt), false);
});

test('enforce mode enters the configured code model with the Jev-selected effort', async () => {
  const f = await fixture({ mode: 'enforce', recommendations: [choice('code_model', 'high')] });
  await f.emit('before_agent_start', { prompt: 'Implement a cross-file change.' });

  assert.deepEqual(f.transitions, [{ action: 'start', options: { effort: 'high' } }]);
  assert.equal(f.controller.automaticPhase, true);
  const receipt = f.entries.find(entry => entry.customType === AUTOMATIC_ROUTING_STATE_TYPE)?.data;
  assert.equal(receipt.action, 'entered_code_model');
  assert.equal(receipt.model, 'jev-1.13.0');
});

test('a later main-agent decision restores an automatically owned phase', async () => {
  const f = await fixture({
    mode: 'enforce',
    recommendations: [choice('code_model', 'medium'), choice('main_agent', 'low')],
  });
  await f.emit('before_agent_start', { prompt: 'Implement the code.' });
  await f.emit('before_agent_start', { prompt: 'Review the resulting design.' });

  assert.deepEqual(f.transitions, [
    { action: 'start', options: { effort: 'medium' } },
    { action: 'finish', options: undefined },
  ]);
  assert.equal(f.controller.automaticPhase, false);
  assert.equal(f.entries.at(-1).data.action, 'restored_main_agent');
});

test('sub-threshold confidence keeps the main agent and records the reason', async () => {
  const f = await fixture({
    mode: 'enforce',
    recommendations: [{ ...choice('code_model', 'high'), judgment: { ...choice().judgment, confidence: 0.02 } }],
  });
  await f.emit('before_agent_start', { prompt: 'Implement a cross-file change.' });

  assert.deepEqual(f.transitions, []);
  assert.equal(f.controller.automaticPhase, false);
  const receipt = f.entries.at(-1).data;
  assert.equal(receipt.action, 'kept_main_agent_low_confidence');
  assert.equal(receipt.confidence, 0.02);
});

test('a configured custom threshold decides the boundary inclusively', async () => {
  const f = await fixture(
    { mode: 'enforce', minConfidence: 0.8, recommendations: [{ ...choice('code_model', 'high'), judgment: { ...choice().judgment, confidence: 0.8 } }] },
  );
  await f.emit('before_agent_start', { prompt: 'Implement a cross-file change.' });
  assert.equal(f.entries.at(-1).data.action, 'entered_code_model');
  assert.equal(f.entries.at(-1).data.minConfidence, 0.8);

  const g = await fixture(
    { mode: 'enforce', minConfidence: 0.9, recommendations: [{ ...choice('code_model', 'high'), judgment: { ...choice().judgment, confidence: 0.8 } }] },
  );
  await g.emit('before_agent_start', { prompt: 'Implement a cross-file change.' });
  assert.equal(g.entries.at(-1).data.action, 'kept_main_agent_low_confidence');
});

test('out-of-range confidence is treated as below threshold', async () => {
  for (const confidence of [undefined, Number.NaN, 1.4, -0.2]) {
    const f = await fixture({
      mode: 'enforce',
      recommendations: [{ ...choice('code_model', 'high'), judgment: { ...choice().judgment, confidence } }],
    });
    await f.emit('before_agent_start', { prompt: 'Implement a cross-file change.' });
    assert.equal(f.entries.at(-1).data.action, 'kept_main_agent_low_confidence', `confidence=${confidence}`);
    assert.deepEqual(f.transitions, []);
  }
});

test('low confidence during an owned coding phase keeps the phase active', async () => {
  const f = await fixture({
    mode: 'enforce',
    recommendations: [
      choice('code_model', 'high'),
      { ...choice('code_model', 'high'), judgment: { ...choice().judgment, confidence: 0.02 } },
    ],
  });
  await f.emit('before_agent_start', { prompt: 'Implement the change.' });
  await f.emit('agent_end');
  await f.emit('before_agent_start', { prompt: 'Continue implementation.' });

  assert.deepEqual(f.transitions, [{ action: 'start', options: { effort: 'high' } }]);
  assert.equal(f.controller.automaticPhase, true);
  assert.equal(f.entries.at(-1).data.action, 'kept_code_model_low_confidence');
});

test('a confident main_agent recommendation restores an owned phase', async () => {
  const f = await fixture({
    mode: 'enforce',
    recommendations: [choice('code_model', 'medium'), choice('main_agent', 'low')],
  });
  await f.emit('before_agent_start', { prompt: 'Implement the code.' });
  await f.emit('before_agent_start', { prompt: 'Review the design.' });
  assert.equal(f.entries.at(-1).data.action, 'restored_main_agent');
});

test('configured deterministic code-model fallback remains explicit and actionable', async () => {
  const f = await fixture({
    mode: 'enforce',
    fallback: 'code_model',
    recommendations: [{
      route: 'code_model',
      effort: 'high',
      judgment: { backend: 'deterministic', confidence: undefined, fallbackReason: 'typesafe_credential_unavailable' },
      quota: { state: 'available' },
    }],
  });
  await f.emit('before_agent_start', { prompt: 'Implement a cross-file change.' });

  assert.deepEqual(f.transitions, [{ action: 'start', options: { effort: 'high' } }]);
  assert.equal(f.entries.at(-1).data.action, 'entered_code_model');
  assert.equal(f.entries.at(-1).data.decisionReason, 'configured_fallback');
});

test('agent completion clears the prompt cache for a later identical prompt', async () => {
  const f = await fixture({
    mode: 'observe',
    recommendations: [choice('main_agent'), choice('main_agent')],
  });
  const event = { prompt: 'Explain this function.' };
  await f.emit('before_agent_start', event);
  await f.emit('agent_end');
  await f.emit('before_agent_start', event);
  assert.equal(f.advisorCalls.length, 2);
});

test('configured code-model fallback is passed to the advisor', async () => {
  const f = await fixture({ mode: 'observe', fallback: 'code_model' });
  await f.emit('before_agent_start', { prompt: 'Implement the change.' });
  assert.equal(f.advisorCalls[0].fallbackRoute, 'code_model');
});

test('low-confidence main-agent recommendations preserve the active coding phase', async () => {
  for (const confidence of [0.02, undefined, Number.NaN, -0.1, 1.1]) {
    const f = await fixture({
      mode: 'enforce',
      recommendations: [
        choice('code_model'),
        { ...choice('main_agent'), judgment: { ...choice().judgment, confidence } },
      ],
    });
    await f.emit('before_agent_start', { prompt: 'Implement the change.' });
    await f.emit('before_agent_start', { prompt: 'Inspect the evidence.' });
    assert.equal(f.transitions.length, 1);
    assert.equal(f.controller.automaticPhase, true);
    assert.equal(f.entries.at(-1).data.action, 'kept_code_model_low_confidence');
    assert.equal(f.entries.at(-1).data.route, 'main_agent');
    assert.equal(f.entries.at(-1).data.effectiveRoute, 'code_model');
  }
});

test('threshold boundary and configured main-agent fallback retain truthful routes', async () => {
  const f = await fixture({
    mode: 'enforce', fallback: 'main_agent',
    recommendations: [
      { ...choice('code_model'), judgment: { ...choice().judgment, confidence: 0.5 } },
      { ...choice('main_agent'), judgment: { backend: 'deterministic', fallbackReason: 'typesafe_timeout' } },
    ],
  });
  await f.emit('before_agent_start', { prompt: 'Implement.' });
  assert.equal(f.entries.at(-1).data.effectiveRoute, 'code_model');
  await f.emit('before_agent_start', { prompt: 'Review.' });
  assert.equal(f.entries.at(-1).data.effectiveRoute, 'main_agent');
  assert.equal(f.entries.at(-1).data.action, 'restored_main_agent');
  assert.equal(f.entries.at(-1).data.decisionReason, 'configured_fallback');
});
