import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  CONFIG_PATH,
  EFFORTS,
  getModelEfforts,
  getSelection,
  loadConfig,
  updateSelection,
  validateConfig,
} from '../src/configuration.mjs';

const root = process.env.TEST_ROOT ?? tmpdir();

async function fixture(initial) {
  const dir = await mkdtemp(`${root}/config-`);
  const path = `${dir}/config.json`;
  await writeFile(path, JSON.stringify(initial, null, 2));
  return { dir, path, read: () => loadConfig(path), raw: () => readFile(path, 'utf8') };
}

test('compact model configuration reads and writes its complete schema', async () => {
  const initial = {
    defaultProfile: 'current',
    profiles: {
      current: { provider: 'google-antigravity', model: 'gemini-3.8-flash', reasoning: 'high' },
    },
  };
  const f = await fixture(initial);
  const loaded = await f.read();
  assert.deepEqual(getSelection(loaded), {
    provider: 'google-antigravity',
    model: 'gemini-3.8-flash',
    reasoning: 'high',
  });

  const updated = await updateSelection(
    { provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'auto' },
    { path: f.path },
  );
  assert.equal(updated.defaultProfile, 'current');
  assert.deepEqual(getSelection(updated), {
    provider: 'openai-codex',
    model: 'gpt-6-astra',
    reasoning: 'auto',
  });
  const reloaded = await f.read();
  assert.deepEqual(getSelection(reloaded), {
    provider: 'openai-codex',
    model: 'gpt-6-astra',
    reasoning: 'auto',
  });
});


test('invalid selection is rejected before writing to disk', async () => {
  const initial = {
    defaultProfile: 'current',
    profiles: {
      current: { provider: 'test', model: 'model-a', reasoning: 'low' },
    },
  };
  const f = await fixture(initial);
  const before = await f.raw();

  await assert.rejects(
    updateSelection({ provider: '', model: 'model-a', reasoning: 'low' }, { path: f.path }),
    /Valid provider, model, and reasoning are required/,
  );
  await assert.rejects(
    updateSelection({ provider: 'test', model: '', reasoning: 'low' }, { path: f.path }),
    /Valid provider, model, and reasoning are required/,
  );
  await assert.rejects(
    updateSelection({ provider: 'test', model: 'model-a', reasoning: 'invalid-effort' }, { path: f.path }),
    /Valid provider, model, and reasoning are required/,
  );
  assert.equal(await f.raw(), before);
});

test('concurrent selection changes are preserved when expectedConfig conflicts', async () => {
  const initial = {
    defaultProfile: 'current',
    profiles: {
      current: { provider: 'test', model: 'model-a', reasoning: 'low' },
    },
  };
  const f = await fixture(initial);
  const expectedConfig = await f.read();

  // Simulate concurrent change in another session
  await writeFile(
    f.path,
    JSON.stringify({
      defaultProfile: 'current',
      profiles: {
        current: { provider: 'test', model: 'model-a', reasoning: 'xhigh' },
      },
    }),
  );

  await assert.rejects(
    updateSelection(
      { provider: 'test', model: 'model-a', reasoning: 'medium' },
      { path: f.path, expectedConfig },
    ),
    /Coding model configuration was updated in another session/,
  );

  const disk = await f.read();
  assert.equal(disk.profiles.current.reasoning, 'xhigh');
});

test('unrelated top-level settings are merged and preserved', async () => {
  const initial = {
    defaultProfile: 'current',
    customWorkspaceOption: 'retained',
    featureFlags: { fastSwitch: true, telemetry: false },
    arrayData: [1, 2, 3],
    profiles: {
      current: { provider: 'test', model: 'model-a', reasoning: 'medium' },
    },
  };
  const f = await fixture(initial);
  const updated = await updateSelection(
    { provider: 'test', model: 'model-b', reasoning: 'high' },
    { path: f.path },
  );

  assert.equal(updated.customWorkspaceOption, 'retained');
  assert.deepEqual(updated.featureFlags, { fastSwitch: true, telemetry: false });
  assert.deepEqual(updated.arrayData, [1, 2, 3]);
  assert.equal(updated.profiles.current.model, 'model-b');
  assert.equal(updated.profiles.current.reasoning, 'high');

  const reloaded = await f.read();
  assert.equal(reloaded.customWorkspaceOption, 'retained');
  assert.deepEqual(reloaded.featureFlags, { fastSwitch: true, telemetry: false });
});

test('getModelEfforts extracts supported efforts from thinking metadata', () => {
  const modelWithThinking = {
    reasoning: true,
    thinking: { efforts: ['minimal', 'low', 'medium', 'high'] },
  };
  assert.deepEqual(getModelEfforts(modelWithThinking), ['minimal', 'low', 'medium', 'high']);

  const modelWithoutReasoning = { reasoning: false };
  assert.deepEqual(getModelEfforts(modelWithoutReasoning), ['auto']);

  const modelWithEmptyEfforts = { reasoning: true, thinking: { efforts: [] } };
  assert.deepEqual(getModelEfforts(modelWithEmptyEfforts), ['auto']);
});

test('first selection creates a portable configuration file', async () => {
  const dir = await mkdtemp(`${root}/config-new-`);
  const path = `${dir}/nested/code-model.json`;
  const empty = await loadConfig(path);
  assert.equal(getSelection(empty), undefined);
  await updateSelection(
    { provider: 'openai-codex', model: 'gpt-6-astra', reasoning: 'high' },
    { path, expectedConfig: empty },
  );
  assert.deepEqual(getSelection(await loadConfig(path)), {
    provider: 'openai-codex',
    model: 'gpt-6-astra',
    reasoning: 'high',
  });
});
