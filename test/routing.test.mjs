import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  ROUTING_STATE_TYPE,
  TYPESAFE_ENDPOINT,
  createRoutingAdvisor,
  summarizeQuota,
} from '../src/routing.mjs';

const root = process.env.TEST_ROOT ?? tmpdir();
const mainModel = {
  provider: 'main',
  id: 'reasoner',
  input: ['text'],
  reasoning: true,
  thinking: { efforts: ['medium', 'high', 'xhigh'] },
};
const codeModel = {
  provider: 'code',
  id: 'coder',
  input: ['text'],
  reasoning: true,
  thinking: { efforts: ['low', 'medium', 'high'] },
};

function usagePayload({ provider = 'code', remaining = 0.72 } = {}) {
  return {
    reports: [{
      provider,
      limits: [{
        id: `${provider}:primary`,
        label: 'Primary',
        window: { id: 'weekly', resetsAt: 1_800_000_000_000 },
        amount: { remainingFraction: remaining },
        status: remaining > 0 ? 'ok' : 'exhausted',
      }],
      metadata: { allowed: remaining > 0, limitReached: remaining <= 0 },
    }],
  };
}

async function fixture({
  remaining = 0.72,
  token = '',
  response,
  responseStatus = 200,
  selection = { provider: 'code', model: 'coder', reasoning: 'medium' },
  fallback = 'main_agent',
} = {}) {
  const dir = await mkdtemp(`${root}/routing-`);
  const configPath = `${dir}/config.json`;
  await writeFile(configPath, JSON.stringify({
    defaultProfile: 'current',
    profiles: { current: selection },
    routing: { mode: 'observe', fallback },
  }));
  const entries = [];
  const commands = [];
  const requests = [];
  const pi = {
    appendEntry(customType, data) { entries.push({ customType, data: structuredClone(data) }); },
  };
  const exec = async (_command, args) => {
    commands.push(args);
    if (args[0] === 'usage') {
      return { code: 0, stdout: JSON.stringify(usagePayload({ provider: selection.provider, remaining })), stderr: '', killed: false };
    }
    return { code: token ? 0 : 1, stdout: token, stderr: '', killed: false };
  };
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(response ?? {}), {
      status: responseStatus,
      headers: { 'content-type': 'application/json' },
    });
  };
  const models = [mainModel, codeModel];
  const ctx = {
    models: { current: () => mainModel, list: () => models },
    modelRegistry: { find: (provider, id) => models.find(model => model.provider === provider && model.id === id) },
  };
  const advisor = createRoutingAdvisor(pi, {
    configPath,
    exec,
    fetch,
    ompBin: 'omp-test',
    quotaCacheMs: 0,
  });
  return { advisor, commands, entries, requests, ctx };
}

test('quota summary selects the model family and excludes an exhausted unrelated pool', () => {
  const payload = {
    reports: [{
      provider: 'google-antigravity', limits: [
        { id: 'google-antigravity:google:default:weekly', amount: { remainingFraction: 0 }, status: 'exhausted' },
        { id: 'google-antigravity:openai:default:weekly', amount: { remainingFraction: 0.64 }, status: 'ok' },
      ], metadata: {}
    }],
  };
  const quota = summarizeQuota(payload, 'google-antigravity', 'gpt-6-astra');
  assert.equal(quota.state, 'available');
  assert.equal(quota.minimumRemainingFraction, 0.64);
  assert.equal(quota.limits.length, 1);
  assert.match(quota.limits[0].id, /openai/);
});

test('missing TypeSafe credential uses the configured deterministic recommendation', async () => {
  const f = await fixture();
  const result = await f.advisor.recommend({ task: 'Implement a cross-file parser change and targeted tests.' }, f.ctx);
  assert.equal(result.route, 'main_agent');
  assert.equal(result.effort, 'medium');
  assert.equal(result.quota.state, 'available');
  assert.equal(result.judgment.backend, 'deterministic');
  assert.equal(result.judgment.fallbackReason, 'typesafe_credential_unavailable');
  assert.equal(f.requests.length, 0);
  assert.ok(f.commands.some(args => args[0] === 'usage'));
  assert.ok(f.commands.some(args => args[0] === 'token'));
  assert.match(result.message, /advisory/);
  const audit = f.entries.at(-1);
  assert.equal(audit.customType, ROUTING_STATE_TYPE);
  assert.equal(audit.data.taskDigest.length, 16);
  assert.equal(JSON.stringify(audit).includes('cross-file parser'), false);
});

test('configured coding fallback remains available when Jev is unavailable', async () => {
  const f = await fixture({ fallback: 'code_model' });
  const result = await f.advisor.recommend({ task: 'Implement a cross-file parser change and targeted tests.' }, f.ctx);
  assert.equal(result.route, 'code_model');
  assert.equal(result.fallbackRoute, 'code_model');
});

test('TypeSafe choice selects an allowed route and supported coding effort', async () => {
  const f = await fixture({
    token: 'ts_test_secret_credential',
    response: {
      model: 'jev-1.13.0',
      answers: {
        execution_path: {
          type: 'choice', choice: 'main_agent', confidence: 0.73,
          probabilities: { main_agent: 0.79, code_model: 0.21 },
        },
        coding_effort: {
          type: 'choice', choice: 'low', confidence: 0.81,
          probabilities: { low: 0.84, medium: 0.12, high: 0.04 },
        },
      },
      usage: { input_tokens: 222, output_tokens: 44 },
    },
  });
  const result = await f.advisor.recommend({ task: 'Fix one local typo and run its focused test.' }, f.ctx);
  assert.equal(result.route, 'main_agent');
  assert.equal(result.effort, 'low');
  assert.equal(result.judgment.backend, 'typesafe');
  assert.equal(result.judgment.model, 'jev-1.13.0');
  assert.equal(result.judgment.confidence, 0.73);
  assert.deepEqual(result.judgment.usage, { inputTokens: 222, outputTokens: 44 });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.url, TYPESAFE_ENDPOINT);
  assert.equal(request.init.headers.authorization, 'Bearer ts_test_secret_credential');
  assert.deepEqual(Object.keys(request.body.questions.execution_path.criteria), ['main_agent', 'code_model']);
  assert.deepEqual(Object.keys(request.body.questions.coding_effort.criteria), ['low', 'medium', 'high']);
  assert.equal(request.body.state.subagentAuthorised, false);
  assert.equal(JSON.stringify(f.entries).includes('ts_test_secret_credential'), false);
});

test('subagent becomes a route only with explicit authorisation', async () => {
  const f = await fixture({
    token: 'ts_test_secret_credential',
    response: {
      model: 'jev-1.13.0',
      answers: {
        execution_path: {
          type: 'choice', choice: 'subagent', confidence: 0.67,
          probabilities: { main_agent: 0.12, code_model: 0.18, subagent: 0.7 },
        },
        coding_effort: {
          type: 'choice', choice: 'high', confidence: 0.7,
          probabilities: { low: 0.1, medium: 0.2, high: 0.7 },
        },
      },
      usage: { input_tokens: 200, output_tokens: 30 },
    },
  });
  const result = await f.advisor.recommend({
    task: 'Implement an independent package with its focused tests.',
    allowSubagent: true,
  }, f.ctx);
  assert.equal(result.route, 'subagent');
  assert.equal(result.subagentAuthorised, true);
  assert.deepEqual(Object.keys(f.requests[0].body.questions.execution_path.criteria), [
    'main_agent', 'code_model', 'subagent',
  ]);
});

test('exhausted quota removes the coding route before judgment', async () => {
  const f = await fixture({ remaining: 0, token: 'ts_test_secret_credential' });
  const result = await f.advisor.recommend({ task: 'Implement a feature.' }, f.ctx);
  assert.equal(result.route, 'main_agent');
  assert.equal(result.quota.state, 'exhausted');
  assert.equal(result.judgment.backend, 'deterministic');
  assert.equal(result.judgment.fallbackReason, 'quota_exhausted');
  assert.equal(f.requests.length, 0);
  assert.equal(f.commands.some(args => args[0] === 'token'), false);
});

test('an API failure preserves a useful deterministic recommendation', async () => {
  const f = await fixture({ token: 'ts_test_secret_credential', responseStatus: 503 });
  const result = await f.advisor.recommend({ task: 'Implement the feature and focused tests.' }, f.ctx);
  assert.equal(result.route, 'main_agent');
  assert.equal(result.effort, 'medium');
  assert.equal(result.judgment.backend, 'deterministic');
  assert.equal(result.judgment.fallbackReason, 'typesafe_http_503');
  assert.equal(f.requests.length, 1);
  assert.equal(f.entries.at(-1).customType, ROUTING_STATE_TYPE);
});

test('Jev can be disabled while quota facts and audit recording remain active', async () => {
  const f = await fixture({ token: 'ts_test_secret_credential' });
  const result = await f.advisor.recommend({ task: 'Implement the feature.', useJev: false }, f.ctx);
  assert.equal(result.route, 'main_agent');
  assert.equal(result.judgment.backend, 'deterministic');
  assert.equal(result.judgment.fallbackReason, 'jev_disabled');
  assert.equal(f.requests.length, 0);
  assert.equal(f.commands.some(args => args[0] === 'token'), false);
  assert.equal(f.entries.at(-1).customType, ROUTING_STATE_TYPE);
});

test('a provider cache retains independent model-family quota pools', async () => {
  const dir = await mkdtemp(`${root}/routing-pools-`);
  const configPath = `${dir}/config.json`;
  const provider = 'google-antigravity';
  const models = ['gpt-6-astra', 'gemini-3.8-flash'].map(id => ({
    ...codeModel, provider, id,
  }));
  const ctx = {
    models: { current: () => mainModel, list: () => models },
    modelRegistry: { find: (p, id) => models.find(model => model.provider === p && model.id === id) },
  };
  let usageCalls = 0;
  const advisor = createRoutingAdvisor({ appendEntry() { } }, {
    configPath,
    exec: async (_command, args) => {
      assert.equal(args[0], 'usage');
      usageCalls++;
      return {
        code: 0, stdout: JSON.stringify({
          reports: [{
            provider, limits: [
              { id: `${provider}:openai:weekly`, amount: { remainingFraction: 0.7 }, status: 'ok' },
              { id: `${provider}:google:weekly`, amount: { remainingFraction: 0 }, status: 'exhausted' },
            ], metadata: {},
          }]
        })
      };
    },
  });
  async function select(model) {
    await writeFile(configPath, JSON.stringify({
      defaultProfile: 'current', profiles: { current: { provider, model, reasoning: 'medium' } },
    }));
    return advisor.recommend({ task: 'Implement.', useJev: false }, ctx);
  }
  assert.equal((await select('gpt-6-astra')).quota.state, 'available');
  assert.equal((await select('gemini-3.8-flash')).quota.state, 'exhausted');
  assert.equal((await select('gpt-6-astra')).quota.minimumRemainingFraction, 0.7);
  assert.equal(usageCalls, 1);
});

test('a pre-aborted recommendation performs zero commands or requests', async () => {
  const f = await fixture({ token: 'ts_test_secret_credential' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.advisor.recommend({ task: 'Implement.' }, f.ctx, controller.signal), { name: 'AbortError' });
  assert.equal(f.commands.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.entries.length, 0);
});
