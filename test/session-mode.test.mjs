import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  formatModelStringWithRouting,
  installSessionMode,
  STATE_TYPE,
} from '../src/session-mode.mjs';
import codeSession from '../src/index.mjs';

const root = process.env.TEST_ROOT ?? tmpdir();
const models = [
  { provider: 'main', id: 'reasoner', input: ['text'], reasoning: true, thinking: { efforts: ['medium', 'xhigh'] } },
  { provider: 'code', id: 'coder', input: ['text'], reasoning: true, thinking: { efforts: ['low', 'medium', 'high'] } },
  { provider: 'plain', id: 'simple', input: ['text'], reasoning: false },
];
const seed = { defaultProfile: 'current', profiles: { current: { provider: 'code', model: 'coder', reasoning: 'medium' } } };
async function fixture() {
  const dir = await mkdtemp(`${root}/stage-`);
  const configPath = `${dir}/config.json`;
  await writeFile(configPath, JSON.stringify(seed));
  const history = [{ type: 'message', message: { role: 'user', content: 'Preserve this exact conversation.' } }];
  const handlers = new Map(), tools = [], commands = new Map(), notices = [], changes = [];
  const f = { history, handlers, tools, commands, notices, changes, configPath, active: models[0], effort: 'xhigh', id: 'session-one', idle: true };
  const schema = { default() { return this; } };
  const pi = {
    zod: { enum: () => schema, object: () => schema },
    on(name, fn) { const group = handlers.get(name) ?? []; group.push(fn); handlers.set(name, group); },
    registerTool(definition) { tools.push(definition); },
    registerCommand(name, definition) { commands.set(name, definition); },
    appendEntry(customType, data) { history.push({ type: 'custom', customType, data: structuredClone(data) }); },
    getThinkingLevel() { return f.effort; },
    setThinkingLevel(effort) {
      if (f.failEffort?.(effort)) throw new Error('effort failure');
      f.effort = effort === 'auto' ? 'medium' : effort;
      history.push({ type: 'thinking_level_change', thinkingLevel: f.effort, configured: effort });
    },
    async setModel(model) {
      if (f.delay) await f.delay;
      if (f.failModel?.(model)) return false;
      f.active = model; changes.push(model.id);
      history.push({ type: 'model_change', model: `${model.provider}/${model.id}` });
      return true;
    },
  };
  const ctx = { get model() { return f.active; },
    models: { current: () => f.active },
    hasUI: true, isIdle: () => f.idle,
    sessionManager: { getSessionId: () => f.id, getBranch: () => history },
    modelRegistry: { find: (provider, id) => models.find(model => model.provider === provider && model.id === id) },
    ui: { notify(message, type) { notices.push({ message, type }); } },
  };
  f.pi = pi; f.ctx = ctx;
  f.mode = installSessionMode(pi, { configPath });
  f.run = (action, signal) => f.mode.run(action, ctx, signal);
  f.emit = async (event, details = {}) => {
    const result = [];
    for (const handler of handlers.get(event) ?? []) result.push(await handler({
      type: event, last_assistant_message: { role: 'assistant', stopReason: 'stop' }, ...details,
    }, ctx));
    return result;
  };
  f.state = () => history.findLast(entry => entry.customType === STATE_TYPE)?.data;
  return f;
}

test('start and finish preserve conversation identity and config while switching model and effort', async () => {
  const f = await fixture(), before = await readFile(f.configPath, 'utf8');
  const message = f.history[0];
  const startResult = await f.run('start');
  assert.equal(startResult.changed, true);
  assert.match(startResult.message, /Entered coding phase in the same conversation/);
  assert.equal(f.active.id, 'coder'); assert.equal(f.effort, 'medium');
  assert.equal(f.state().original.effort, 'xhigh');
  f.history.push({ type: 'message', message: { role: 'toolResult', content: 'targeted check passed' } });
  const finishResult = await f.run('finish');
  assert.match(finishResult.message, /Restored main conversation model/);
  assert.equal(f.active.id, 'reasoner'); assert.equal(f.effort, 'xhigh');
  assert.equal(f.id, 'session-one'); assert.equal(f.history[0], message);
  assert.ok(f.history.some(entry => entry.message?.content === 'targeted check passed'));
  assert.equal(f.state(), null); assert.equal(await readFile(f.configPath, 'utf8'), before);
});

test('nested start is idempotent and a saved selection applies to the next phase', async () => {
  const f = await fixture(); await f.run('start');
  const next = structuredClone(seed); next.profiles.current.reasoning = 'low';
  await writeFile(f.configPath, JSON.stringify(next));
  assert.equal((await f.run('start')).changed, false);
  assert.equal(f.effort, 'medium'); assert.deepEqual(f.changes, ['coder']);
  await f.run('finish'); await f.run('start'); assert.equal(f.effort, 'low');
});

test('same-model lower effort avoids a model/auth reset and restores the original effort', async () => {
  const f = await fixture(); const config = structuredClone(seed);
  config.profiles.current = { provider: 'main', model: 'reasoner', reasoning: 'medium' };
  await writeFile(f.configPath, JSON.stringify(config));
  await f.run('start'); assert.equal(f.effort, 'medium'); assert.deepEqual(f.changes, []);
  await f.run('finish'); assert.equal(f.effort, 'xhigh');
});

test('plain auto uses the model default and restores a configured auto selector', async () => {
  const f = await fixture(); f.pi.setThinkingLevel('auto');
  const config = structuredClone(seed); config.profiles.current = { provider: 'plain', model: 'simple', reasoning: 'auto' };
  await writeFile(f.configPath, JSON.stringify(config));
  await f.run('start'); assert.equal(f.effort, 'medium');
  await f.run('finish');
  assert.equal(f.history.findLast(entry => entry.type === 'thinking_level_change').configured, 'auto');
});

test('auth failure and cancelled switches restore the original phase', async () => {
  const f = await fixture(); f.failModel = model => model.id === 'coder';
  await assert.rejects(f.run('start'), /authentication/i);
  assert.equal(f.active.id, 'reasoner'); assert.equal(f.state(), null);
  f.failModel = undefined;
  const controller = new AbortController();
  const originalSet = f.pi.setModel;
  f.pi.setModel = async model => { const result = await originalSet(model); if (model.id === 'coder') controller.abort(); return result; };
  await assert.rejects(f.run('start', controller.signal), /abort/i);
  assert.equal(f.active.id, 'reasoner'); assert.equal(f.effort, 'xhigh'); assert.equal(f.state(), null);
});

test('unsupported effort and missing model fail before mutation', async () => {
  for (const selection of [{ provider: 'code', model: 'missing', reasoning: 'medium' }, { provider: 'code', model: 'coder', reasoning: 'xhigh' }]) {
    const f = await fixture(); await writeFile(f.configPath, JSON.stringify({ ...seed, profiles: { current: selection } }));
    await assert.rejects(f.run('start'));
    assert.deepEqual(f.changes, []); assert.equal(f.state(), undefined);
  }
});

test('session stop automatically restores and requests exactly one main-model review', async () => {
  const f = await fixture(); await f.run('start'); const signal = new AbortController().signal;
  const [result] = await f.emit('session_stop', { signal });
  assert.equal(result.continue, true); assert.match(result.additionalContext, /Review the actual changes/);
  assert.equal(f.active.id, 'reasoner');
  assert.deepEqual(await f.emit('session_stop', { signal }), [undefined]);
});

test('cancel and terminal error restore while retries keep coding', async () => {
  const f = await fixture(); await f.run('start');
  await f.emit('agent_end', { willContinue: true }); assert.equal(f.active.id, 'coder');
  const controller = new AbortController(); controller.abort();
  await f.emit('session_stop', { signal: controller.signal }); assert.equal(f.active.id, 'coder');
  await f.emit('agent_end', { willContinue: false }); assert.equal(f.active.id, 'reasoner');
});

test('external model or effort selection takes precedence over automatic restore', async () => {
  const f = await fixture(); await f.run('start'); f.pi.setThinkingLevel('low');
  const [result] = await f.emit('session_stop', { signal: new AbortController().signal });
  assert.equal(result, undefined); assert.equal(f.active.id, 'coder'); assert.equal(f.effort, 'low'); assert.equal(f.state(), null);
});

test('failed restoration retains recovery data and finish can be retried', async () => {
  const f = await fixture(); await f.run('start'); f.failModel = model => model.id === 'reasoner';
  await assert.rejects(f.run('finish'), /authentication/i); assert.equal(f.state().phase, 'restoring');
  f.failModel = undefined; await f.run('finish');
  assert.equal(f.active.id, 'reasoner'); assert.equal(f.state(), null);
});

test('resume and branch navigation recover persisted phase state in the same transcript', async () => {
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_branch']) {
    const f = await fixture(); await f.run('start');
    f.handlers.clear(); f.id = 'resumed-session';
    f.mode = installSessionMode(f.pi, { configPath: f.configPath });
    await f.emit(event);
    assert.equal(f.active.id, 'reasoner'); assert.equal(f.effort, 'xhigh'); assert.equal(f.state(), null);
  }
});

test('concurrent transitions and navigation while switching are refused', async () => {
  const f = await fixture(); let release; f.delay = new Promise(resolve => { release = resolve; });
  const pending = f.run('start');
  while (!f.state()) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(f.run('finish'), /in progress/i);
  assert.deepEqual(await f.emit('session_before_switch'), [{ cancel: true }]);
  release(); await pending;
  assert.equal(f.active.id, 'coder');
});

test('extension registers the phase tool and its configuration command', async () => {
  const f = await fixture(); f.handlers.clear(); codeSession(f.pi, { configPath: f.configPath });
  assert.deepEqual(f.tools.map(tool => tool.name), ['code-model']);
  const tool = f.tools[0];
  const result = await tool.execute('test', { action: 'start' }, undefined, undefined, f.ctx);
  assert.equal(result.details.changed, true); assert.equal(f.active.id, 'coder');
  await tool.execute('test2', { action: 'finish' }, undefined, undefined, f.ctx);
  assert.equal(f.active.id, 'reasoner');
  await f.commands.get('code-model').handler('status', f.ctx);
  assert.match(f.notices.at(-1).message, /Currently in main conversation phase/i);
  f.idle = false; await f.commands.get('code-model').handler('start', f.ctx);
  assert.equal(f.notices.at(-1).type, 'error'); assert.equal(f.active.id, 'reasoner');
});

test('partial effort restoration retains the original snapshot for retry', async () => {
  const f = await fixture(); await f.run('start'); f.failEffort = effort => effort === 'xhigh';
  await assert.rejects(f.run('finish'), /effort failure/);
  assert.equal(f.active.id, 'reasoner'); assert.equal(f.effort, 'medium');
  assert.equal(f.state().phase, 'restoring');
  f.failEffort = undefined; await f.run('finish');
  assert.equal(f.effort, 'xhigh'); assert.equal(f.state(), null);
});

test('finish remains available after the external selection file becomes invalid', async () => {
  const f = await fixture(); await f.run('start');
  await writeFile(f.configPath, 'invalid');
  await f.run('finish'); assert.equal(f.active.id, 'reasoner'); assert.equal(f.effort, 'xhigh');
});

test('a terminal error through session_stop restores and ends the turn', async () => {
  const f = await fixture(); await f.run('start');
  const [result] = await f.emit('session_stop', {
    signal: new AbortController().signal, last_assistant_message: { role: 'assistant', stopReason: 'error' },
  });
  assert.equal(result, undefined); assert.equal(f.active.id, 'reasoner'); assert.equal(f.state(), null);
});

test('automatic retry fallback restores the main model snapshot', async () => {
  const f = await fixture();
  await f.run('start');
  f.active = models[2];
  f.effort = undefined;
  f.history.push({ type: 'model_change', model: 'plain/simple', resolvedModelIsFallback: true });
  const result = await f.run('finish');
  assert.equal(result.changed, true);
  assert.equal(f.active.id, 'reasoner');
  assert.equal(f.effort, 'xhigh');
});

test('fresh configured auto selector survives a complete coding phase', async () => {
  const f = await fixture();
  f.configured = 'auto';
  const setThinkingLevel = f.pi.setThinkingLevel;
  f.pi.getConfiguredThinkingLevel = () => f.configured;
  f.pi.setThinkingLevel = effort => {
    f.configured = effort;
    setThinkingLevel(effort);
  };
  await f.run('start');
  assert.equal(f.configured, 'medium');
  await f.run('finish');
  assert.equal(f.configured, 'auto');
  assert.equal(f.effort, 'medium');
});

test('session_before_idle restores immediately before terminal idle', async () => {
  const f = await fixture();
  await f.run('start');
  await f.emit('session_before_idle', { willContinue: true });
  assert.equal(f.active.id, 'coder');
  await f.emit('session_before_idle', { willContinue: false });
  assert.equal(f.active.id, 'reasoner');
  assert.equal(f.state(), null);
});

test('command context with spread frozen model switches and restores via live models query', async () => {
  const f = await fixture();
  // Simulate runner.ts createCommandContext spreading ctx into a frozen object
  const startCommandCtx = { ...f.ctx };
  assert.equal(startCommandCtx.model.id, 'reasoner');

  const startResult = await f.mode.run('start', startCommandCtx);
  assert.equal(startResult.changed, true);
  assert.equal(f.active.id, 'coder');
  assert.equal(f.effort, 'medium');

  const finishCommandCtx = { ...f.ctx };
  assert.equal(finishCommandCtx.model.id, 'coder');
  const finishResult = await f.mode.run('finish', finishCommandCtx);
  assert.equal(finishResult.changed, true);
  assert.equal(f.active.id, 'reasoner');
  assert.equal(f.effort, 'xhigh');
  assert.equal(f.state(), null);

  // Switching then aborting with frozen context also restores cleanly
  const frozenCtx2 = { ...f.ctx };
  const controller = new AbortController();
  const originalSetModel = f.pi.setModel;
  f.pi.setModel = async model => {
    const res = await originalSetModel(model);
    if (model.id === 'coder') controller.abort();
    return res;
  };
  await assert.rejects(f.mode.run('start', frozenCtx2, controller.signal), /abort/i);
  assert.equal(f.active.id, 'reasoner');
  assert.equal(f.state(), null);
});

test('preserves routed model identity across coding phase and restoration', async () => {
  const routedModel = {
    provider: 'openrouter',
    id: 'routed-reasoner',
    compat: { openRouterRouting: { only: ['cerebras'] } },
  };
  const f = await fixture();
  f.active = routedModel;
  f.history[0].message = { role: 'user', content: 'Preserve route.' };
  models.push(routedModel);
  const originalSetModel = f.pi.setModel;
  f.pi.setModel = async (model, options) => originalSetModel(model, options);
  const mode = installSessionMode(f.pi, { configPath: f.configPath });

  try {
    const startResult = await mode.run('start', f.ctx);
    assert.equal(startResult.changed, true);
    assert.equal(f.active.id, 'coder');
    assert.equal(f.state().original.selector, 'openrouter/routed-reasoner@cerebras');

    const finishResult = await mode.run('finish', f.ctx);
    assert.equal(finishResult.changed, true);
    assert.equal(f.active.id, 'routed-reasoner');
    assert.equal(f.active.compat.openRouterRouting.only[0], 'cerebras');
    assert.equal(f.state(), null);
  } finally {
    const index = models.indexOf(routedModel);
    if (index !== -1) models.splice(index, 1);
  }
});

test('preserves active role across coding phase switches and restores original role', async () => {
  const f = await fixture();
  f.history.push({
    type: 'model_change',
    model: `${models[0].provider}/${models[0].id}`,
    role: 'slow',
  });
  const setModelCalls = [];
  const originalSetModel = f.pi.setModel;
  f.pi.setModel = async (model, options) => {
    setModelCalls.push({ model: model.id, options });
    return originalSetModel(model);
  };
  const mode = installSessionMode(f.pi, { configPath: f.configPath });

  await mode.run('start', f.ctx);
  assert.equal(f.state().original.role, 'slow');
  assert.deepEqual(setModelCalls[0], { model: 'coder', options: { ephemeral: true } });

  await mode.run('finish', f.ctx);
  assert.deepEqual(setModelCalls[1], { model: 'reasoner', options: { role: 'slow' } });
  assert.equal(f.state(), null);
});

test('navigation preparation returns rollback and retains coding phase upon cancellation', async () => {
  const f = await fixture();
  let beforeNavHandler;
  const mode = installSessionMode(f.pi, {
    configPath: f.configPath,
    registerBeforeNavigation: handler => { beforeNavHandler = handler; },
  });
  await mode.run('start', f.ctx);
  assert.equal(typeof beforeNavHandler, 'function');

  const preparation = await beforeNavHandler(f.ctx);
  assert.equal(typeof preparation?.rollback, 'function');
  assert.equal(f.active.id, 'reasoner');
  assert.equal(f.state(), null);

  preparation.rollback();
  const status = await mode.run('status', f.ctx);
  assert.match(status.message, /Current phase: coding/);
});

test('awaits in-flight stop restoration before idle when internal finalizer is registered', async () => {
  const f = await fixture();
  let beforeIdleHandler;
  const mode = installSessionMode(f.pi, {
    configPath: f.configPath,
    registerBeforeIdle: handler => { beforeIdleHandler = handler; },
  });
  await mode.run('start', f.ctx);
  assert.equal(typeof beforeIdleHandler, 'function');

  let resolveSetModel;
  f.pi.setModel = async model => {
    if (model.id === 'reasoner') {
      await new Promise(resolve => { resolveSetModel = resolve; });
    }
    f.active = model;
    return true;
  };

  const stopHandlers = f.handlers.get('session_stop') ?? [];
  const stopPromise = Promise.all(stopHandlers.map(h => h({
    type: 'session_stop',
    last_assistant_message: { role: 'assistant', stopReason: 'stop' },
    signal: new AbortController().signal,
  }, f.ctx)));

  let idleSettled = false;
  const idlePromise = beforeIdleHandler({ type: 'session_before_idle', willContinue: false }, f.ctx).then(res => {
    idleSettled = true;
    return res;
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(idleSettled, false);

  resolveSetModel();
  const stopResults = await stopPromise;
  assert.equal(stopResults[0], undefined);

  const idleResult = await idlePromise;
  assert.equal(idleSettled, true);
  assert.equal(idleResult?.continue, true);
  assert.match(idleResult?.additionalContext ?? '', /Review the actual changes and recorded checks/);
  assert.equal(f.active.id, 'reasoner');
});

test('restores retry primary when a fallback starts the coding phase', async () => {
  const f = await fixture();
  f.active = models[2]; // plain/simple
  f.history.push({ type: 'model_change', model: 'plain/simple', resolvedModelIsFallback: true });

  const mode = installSessionMode(f.pi, {
    configPath: f.configPath,
    getRetryFallbackPrimary: () => ({
      selector: `${models[0].provider}/${models[0].id}`,
      effort: 'xhigh',
      fallbackEffort: 'low',
    }),
  });

  await mode.run('start', f.ctx);
  assert.equal(f.active.id, 'coder');
  assert.equal(f.state().original.id, 'reasoner');
  assert.equal(f.state().original.effort, 'xhigh');

  const finished = await mode.run('finish', f.ctx);
  assert.equal(finished.changed, true);
  assert.equal(f.active.id, 'reasoner');
  assert.equal(f.effort, 'xhigh');
});

test('modern host records phase ownership when only effort changes', async () => {
  const f = await fixture();
  await writeFile(f.configPath, JSON.stringify({
    defaultProfile: 'current',
    profiles: { current: { provider: 'main', model: 'reasoner', reasoning: 'medium' } },
  }));
  const calls = [];
  f.pi.setModel = async (model, options) => {
    calls.push({ model: model.id, options });
    f.active = model;
    f.history.push({
      type: 'model_change',
      model: `${model.provider}/${model.id}`,
      role: options?.ephemeral ? 'fallback' : options?.role,
    });
    return true;
  };
  const mode = installSessionMode(f.pi, { configPath: f.configPath });

  await mode.run('start', f.ctx);
  assert.equal(f.active.id, 'reasoner');
  assert.equal(f.effort, 'medium');
  assert.deepEqual(calls[0], { model: 'reasoner', options: { ephemeral: true } });

  await mode.run('finish', f.ctx);
  assert.equal(f.active.id, 'reasoner');
  assert.equal(f.effort, 'xhigh');
  assert.deepEqual(calls[1], { model: 'reasoner', options: { role: 'default' } });
});

test('retry primary must resolve to the exact recorded model', async () => {
  const f = await fixture();
  const sibling = { ...models[0], id: 'reasoner-new' };
  f.active = models[2];
  f.history.push({ type: 'model_change', model: 'plain/simple', resolvedModelIsFallback: true });
  f.ctx.models.list = () => [models[1], models[2], sibling];
  f.ctx.models.resolve = selector => selector === 'main/reasoner' ? sibling : undefined;
  f.ctx.modelRegistry.find = (provider, id) =>
    f.ctx.models.list().find(model => model.provider === provider && model.id === id);
  const mode = installSessionMode(f.pi, {
    configPath: f.configPath,
    getRetryFallbackPrimary: () => ({ selector: 'main/reasoner', effort: 'xhigh' }),
  });

  await assert.rejects(mode.run('start', f.ctx), /catalogue must contain main\/reasoner/);
  assert.equal(f.active.id, 'simple');
  assert.equal(f.state(), undefined);
});

test('route formatter limits compat routing to aggregator hosts', () => {
  const compat = { openRouterRouting: { only: ['cerebras'] } };
  assert.equal(formatModelStringWithRouting({
    provider: 'openrouter',
    id: 'routed',
    compat,
  }), 'openrouter/routed@cerebras');
  assert.equal(formatModelStringWithRouting({
    provider: 'custom',
    id: 'native',
    compat,
  }), 'custom/native');
});


test('literal model ID ending in an effort name wins over suffix parsing', async () => {
  const f = await fixture();
  const literal = { ...models[0], id: 'reasoner:max' };
  f.active = models[2];
  f.history.push({ type: 'model_change', model: 'plain/simple', resolvedModelIsFallback: true });
  f.ctx.models.list = () => [models[1], models[2], literal];
  f.ctx.models.resolve = selector => selector === 'main/reasoner' ? models[0] : undefined;
  f.ctx.modelRegistry.find = (provider, id) =>
    f.ctx.models.list().find(model => model.provider === provider && model.id === id);
  const mode = installSessionMode(f.pi, {
    configPath: f.configPath,
    getRetryFallbackPrimary: () => ({ selector: 'main/reasoner:max', effort: 'xhigh' }),
  });

  await mode.run('start', f.ctx);
  assert.equal(f.state().original.id, 'reasoner:max');

  await mode.run('finish', f.ctx);
  assert.equal(f.active.id, 'reasoner:max');
  assert.equal(f.effort, 'xhigh');
});

test('restores when the host serializes the ephemeral switch with a default role', async () => {
  const f = await fixture();
  const originalSetModel = f.pi.setModel;
  f.pi.setModel = async (model, options) => {
    const result = await originalSetModel(model);
    if (result !== false) {
      const entry = f.history[f.history.length - 1];
      if (entry?.type === 'model_change') entry.role = options?.role ?? 'default';
    }
    return result;
  };
  const mode = installSessionMode(f.pi, { configPath: f.configPath });

  const startResult = await mode.run('start', f.ctx);
  assert.equal(startResult.changed, true);
  assert.equal(f.active.id, 'coder');

  const finishResult = await mode.run('finish', f.ctx);
  assert.equal(finishResult.changed, true);
  assert.equal(f.active.id, models[0].id);
  assert.equal(f.state(), null);
});

test('preserves a role selection of the coding model made during the phase', async () => {
  const f = await fixture();
  const mode = installSessionMode(f.pi, { configPath: f.configPath });
  await mode.run('start', f.ctx);
  f.history.push({
    type: 'model_change',
    model: `${models[1].provider}/${models[1].id}`,
    role: 'slow',
  });

  const finishResult = await mode.run('finish', f.ctx);
  assert.equal(finishResult.changed, false);
  assert.equal(f.active.id, 'coder');
  assert.equal(f.state(), null);
});