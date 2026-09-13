import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { availableModels, resolveLang, runCodeModel } from '../src/model-menu.mjs';
import { getSelection, loadConfig, updateSelection } from '../src/configuration.mjs';

const root = process.env.TEST_ROOT;
if (!root?.startsWith('/Volumes/Cyrius-4T/10-Active/omp/')) throw new Error('Set TEST_ROOT to the external-drive test directory.');
const seed = {
  defaultProfile: 'current',
  preserved: { value: 'keep' },
  profiles: { current: { provider: 'google-antigravity', model: 'alpha', reasoning: 'medium' } },
};
const models = [
  { provider: 'google-antigravity', id: 'alpha', name: 'Alpha', input: ['text'], reasoning: true, thinking: { efforts: ['minimal', 'low', 'medium', 'high'] } },
  { provider: 'openai-codex', id: 'spark', input: ['text'], reasoning: true, thinking: { efforts: ['low', 'medium', 'high', 'xhigh'] } },
  { provider: 'openai-codex', id: 'luna', input: ['text'], reasoning: true, thinking: { efforts: ['low', 'high'] } },
  { provider: 'zai', id: 'glm-placeholder', input: ['text', 'image'], reasoning: true, thinking: { efforts: ['low', 'high', 'xhigh'] } },
  { provider: 'placeholder-local', id: 'plain', input: ['text'], reasoning: false },
  { provider: 'placeholder-notool', id: 'notool', input: ['text'], toolUse: false },
  { provider: 'placeholder-image', id: 'image', input: ['image'], reasoning: false },
];
async function fixture(steps = [], hasUI = true, initial = seed, lang = 'zh') {
  const dir = await mkdtemp(`${root}/menu-`);
  const path = `${dir}/config.json`;
  await writeFile(path, JSON.stringify(initial));
  const notices = [];
  const calls = [];
  const registry = {
    models: structuredClone(models),
    getAvailable() { return this.models; },
    find(provider, id) { return this.models.find(model => model.provider === provider && model.id === id); },
    async getApiKey() { return 'synthetic-key'; },
  };
  const ctx = { hasUI, modelRegistry: registry, ui: {
    notify(message, type) { notices.push({ message, type }); },
    async select(title, options, dialog) {
      calls.push({ title, options, dialog });
      assert.ok(steps.length, `Unexpected selector: ${title}`);
      const step = steps.shift();
      return typeof step === 'function' ? step({ title, options, dialog }) : step;
    },
  } };
  return { dir, path, ctx, notices, calls, steps,
    run: (args = '', opts = {}) => runCodeModel(args, ctx, { configPath: path, lang, ...opts }),
    read: () => loadConfig(path), bytes: () => readFile(path, 'utf8') };
}
function noErrors(f) {
  assert.deepEqual(f.notices.filter(notice => notice.type === 'error'), []);
  assert.equal(f.steps.length, 0);
}
function assertSingle(config, selected) {
  assert.equal(config.defaultProfile, 'current');
  assert.deepEqual(Object.keys(config.profiles), ['current']);
  assert.deepEqual(getSelection(config), selected);
}

test('English menu decouples provider, model, and effort tabs and saves correctly on Save and Apply', async () => {
  const f = await fixture([
    ({ options }) => {
      assert.deepEqual(options.map(option => option.label), ['Provider', 'Model', 'Effort', 'Save and Apply']);
      return 'Provider';
    },
    ({ options, dialog }) => {
      assert.deepEqual(options.map(o => o.label), ['google-antigravity', 'openai-codex', 'placeholder-local', 'zai']);
      assert.equal(options[dialog.initialIndex].label, 'google-antigravity');
      return 'openai-codex';
    },
    'Model',
    ({ title, options, dialog }) => {
      assert.equal(title, 'Select Model · openai-codex');
      assert.ok(options.every(o => o.label.startsWith('openai-codex/')));
      assert.equal(options.length, 2);
      return 'openai-codex/luna';
    },
    'Effort',
    ({ title, options }) => {
      assert.equal(title, 'Select Effort · openai-codex/luna');
      assert.deepEqual(options.map(o => o.label), ['low', 'high']);
      return 'high';
    },
    'Save and Apply',
  ], true, seed, 'en');
  await f.run();
  const config = await f.read();
  assertSingle(config, { provider: 'openai-codex', model: 'luna', reasoning: 'high' });
  assert.deepEqual(config.preserved, seed.preserved);
  noErrors(f);
});

test('Chinese menu decouples provider, model, and effort tabs and saves correctly on Save and Apply', async () => {
  const f = await fixture([
    ({ options }) => {
      assert.deepEqual(options.map(option => option.label), ['提供商', '模型', 'effort', '保存并使用']);
      return '提供商';
    },
    'zai',
    '模型',
    ({ title, options }) => {
      assert.equal(title, '选择模型 · zai');
      assert.equal(options.length, 1);
      assert.equal(options[0].label, 'zai/glm-placeholder');
      return 'zai/glm-placeholder';
    },
    'effort',
    ({ title, options }) => {
      assert.equal(title, '选择 effort · zai/glm-placeholder');
      assert.deepEqual(options.map(o => o.label), ['low', 'high', 'xhigh']);
      return 'low';
    },
    '保存并使用',
  ], true, seed, 'zh');
  await f.run();
  const config = await f.read();
  assertSingle(config, { provider: 'zai', model: 'glm-placeholder', reasoning: 'low' });
  assert.deepEqual(config.preserved, seed.preserved);
  noErrors(f);
});

test('incomplete save prompts an error and keeps the menu open', async () => {
  const f = await fixture([
    '提供商', 'openai-codex',
    '保存并使用',
    ({ options }) => {
      assert.equal(options[0].description, 'openai-codex');
      assert.equal(options[1].description, '待选择');
      assert.equal(options[2].description, '待选择');
      return '模型';
    },
    'openai-codex/luna',
    '保存并使用',
    ({ options }) => {
      assert.equal(options[0].description, 'openai-codex');
      assert.equal(options[1].description, 'openai-codex/luna');
      assert.equal(options[2].description, '待选择');
      return 'effort';
    },
    'high',
    '保存并使用',
  ], true, seed, 'zh');
  await f.run();
  assertSingle(await f.read(), { provider: 'openai-codex', model: 'luna', reasoning: 'high' });
  const errors = f.notices.filter(n => n.type === 'error');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].message, '请先选择提供商和模型。');
  assert.equal(errors[1].message, '请选择当前模型支持的 effort。');
  assert.equal(f.steps.length, 0);
});

test('English incomplete save prompts error and continues in menu', async () => {
  const f = await fixture([
    'Provider', 'openai-codex',
    'Save and Apply',
    ({ options }) => {
      assert.equal(options[0].description, 'openai-codex');
      assert.equal(options[1].description, 'Not selected');
      assert.equal(options[2].description, 'Not selected');
      return 'Model';
    },
    'openai-codex/luna',
    'Save and Apply',
    'Effort',
    'low',
    'Save and Apply',
  ], true, seed, 'en');
  await f.run();
  assertSingle(await f.read(), { provider: 'openai-codex', model: 'luna', reasoning: 'low' });
  const errors = f.notices.filter(n => n.type === 'error');
  assert.equal(errors.length, 2);
  assert.equal(errors[0].message, 'Please select a provider and model first.');
  assert.equal(errors[1].message, 'Please select an effort supported by the current model.');
  assert.equal(f.steps.length, 0);
});

test('successive provider choices replace the same setting', async () => {
  const f = await fixture([
    '提供商', 'openai-codex',
    '模型', 'openai-codex/luna',
    'effort', 'high',
    '保存并使用',
  ], true, seed, 'zh');
  await f.run();
  assertSingle(await f.read(), { provider: 'openai-codex', model: 'luna', reasoning: 'high' });
  f.steps.push(
    '提供商', 'zai',
    '模型', 'zai/glm-placeholder',
    'effort', 'high',
    '保存并使用',
  );
  await f.run();
  assertSingle(await f.read(), { provider: 'zai', model: 'glm-placeholder', reasoning: 'high' });
  noErrors(f);
});

test('legacy active selection is migrated by its actual provider, model and effort', async () => {
  const selected = { provider: 'zai', model: 'glm-placeholder', reasoning: 'xhigh' };
  const legacy = { ...seed, defaultProfile: 'spark', profiles: {
    agy: seed.profiles.current, spark: selected,
    luna: { provider: 'openai-codex', model: 'luna', reasoning: 'high' },
  } };
  const f = await fixture(['保存并使用'], true, legacy, 'zh');
  const before = await f.bytes();
  assert.deepEqual(getSelection(await f.read()), selected);
  assert.equal(await f.bytes(), before);
  await f.run();
  const saved = await f.read();
  assertSingle(saved, selected);
  assert.deepEqual(saved.preserved, legacy.preserved);
  noErrors(f);
});

test('root, nested and staged cancellation leave configuration bytes intact', async () => {
  for (const steps of [
    [undefined],
    ['模型', undefined, undefined],
    ['提供商', undefined, undefined],
    ['提供商', 'google-antigravity', undefined],
    ['effort', 'high', undefined],
  ]) {
    const f = await fixture(steps, true, seed, 'zh');
    const before = await f.bytes();
    await f.run();
    assert.equal(await f.bytes(), before);
    noErrors(f);
  }
});

test('cancelling an incompatible effort choice retains the staged selection', async () => {
  const f = await fixture([
    '提供商', 'zai',
    '模型', 'zai/glm-placeholder',
    'effort', undefined,
    ({ options }) => {
      assert.equal(options[0].description, 'zai');
      assert.equal(options[1].description, 'zai/glm-placeholder');
      assert.equal(options[2].description, '待选择');
      return undefined;
    },
  ], true, seed, 'zh');
  const before = await f.bytes();
  await f.run();
  assert.equal(await f.bytes(), before);
  noErrors(f);
});

test('effort-only save keeps the model and follows supported metadata', async () => {
  const f = await fixture(['effort', ({ options, dialog }) => {
    assert.equal(options[dialog.initialIndex].label, 'medium');
    assert.deepEqual(options.map(option => option.label), ['minimal', 'low', 'medium', 'high']);
    return 'minimal';
  }, '保存并使用'], true, seed, 'zh');
  await f.run();
  assertSingle(await f.read(), { ...seed.profiles.current, reasoning: 'minimal' });
  noErrors(f);
});

test('models command opens all models and enters root menu to select effort and save', async () => {
  const f = await fixture([
    ({ title, options }) => {
      assert.equal(title, '选择模型 · OMP 全部可选模型');
      assert.equal(options.length, availableModels(f.ctx).length);
      return 'openai-codex/luna';
    },
    ({ options }) => {
      assert.equal(options[0].description, 'openai-codex');
      assert.equal(options[1].description, 'openai-codex/luna');
      return 'effort';
    },
    'high',
    '保存并使用',
  ], true, seed, 'zh');
  await f.run('models');
  assertSingle(await f.read(), { provider: 'openai-codex', model: 'luna', reasoning: 'high' });
  noErrors(f);
});

test('cancelling provider picker retains previous staged provider', async () => {
  const f = await fixture([
    '提供商', undefined,
    ({ options }) => {
      assert.equal(options[0].description, 'google-antigravity');
      assert.equal(options[1].description, 'google-antigravity/alpha');
      assert.equal(options[2].description, 'medium');
      return undefined;
    },
  ], true, seed, 'zh');
  await f.run();
  assertSingle(await f.read(), seed.profiles.current);
  noErrors(f);
});

test('changing provider then cancelling model picker retains the staged provider', async () => {
  const f = await fixture([
    '提供商', 'openai-codex',
    '模型', undefined,
    ({ options }) => {
      assert.equal(options[0].description, 'openai-codex');
      assert.equal(options[1].description, '待选择');
      assert.equal(options[2].description, '待选择');
      return undefined;
    },
  ], true, seed, 'zh');
  await f.run();
  assertSingle(await f.read(), seed.profiles.current);
  noErrors(f);
});

test('English menu requests model completion for a provider-only staged selection', async () => {
  const f = await fixture([
    'Provider', 'openai-codex',
    'Effort',
    ({ options }) => {
      assert.equal(options[0].description, 'openai-codex');
      assert.equal(options[1].description, 'Not selected');
      assert.equal(options[2].description, 'Not selected');
      return undefined;
    },
  ], true, seed, 'en');
  await f.run();
  assertSingle(await f.read(), seed.profiles.current);
  assert.equal(f.notices.filter(n => n.type === 'error').length, 1);
  assert.equal(f.notices.find(n => n.type === 'error').message, 'Please select a provider and model first.');
  assert.equal(f.steps.length, 0);
});

test('show and headless status preserve the setting; models opens the same list', async () => {
  for (const args of ['', 'show']) {
    const f = await fixture([], false, seed, 'zh');
    const before = await f.bytes();
    await f.run(args);
    assert.equal(await f.bytes(), before);
    assert.match(f.notices[0].message, /当前代码模型/);
    noErrors(f);
  }
  const f = await fixture([({ title, options }) => {
    assert.equal(title, '选择模型 · OMP 全部可选模型');
    assert.equal(options.length, availableModels(f.ctx).length);
    return undefined;
  }], true, seed, 'zh');
  await f.run('models');
  noErrors(f);
});

test('retired preset commands give the unified entry point and preserve settings', async () => {
  for (const args of ['edit spark', 'edit', 'spark', 'agy', 'agv', 'luna', 'glm', 'current']) {
    const f = await fixture([], true, seed, 'zh');
    const before = await f.bytes();
    await f.run(args);
    assert.equal(await f.bytes(), before);
    assert.match(f.notices.at(-1).message, /请用 \/code-model 设置当前模型/);
    assert.equal(f.calls.length, 0);
  }
});

test('forged choices and missing catalogue access preserve settings', async () => {
  for (const [steps, clearModels] of [
    [['模型', 'unknown/model'], false],
    [['模型'], true],
    [['effort', 'max'], false],
    [['提供商', 'unknown-provider'], false],
  ]) {
    const f = await fixture(steps, true, seed, 'zh');
    if (clearModels) f.ctx.modelRegistry.models = [];
    const before = await f.bytes();
    await f.run();
    assert.equal(await f.bytes(), before);
    assert.equal(f.notices.at(-1).type, 'error');
  }
});

test('unrelated concurrent settings survive a save', async () => {
  const f = await fixture(['effort', 'high', async () => {
    const concurrent = JSON.parse(await f.bytes());
    concurrent.displayWidth = 96;
    concurrent.newFlag = 'preserve';
    await writeFile(f.path, JSON.stringify(concurrent));
    return '保存并使用';
  }], true, seed, 'zh');
  await f.run();
  const config = await f.read();
  assertSingle(config, { ...seed.profiles.current, reasoning: 'high' });
  assert.equal(config.displayWidth, 96);
  assert.equal(config.newFlag, 'preserve');
  noErrors(f);
});

test('concurrent changes to active or retiring presets require reopening', async () => {
  for (const active of [true, false]) {
    const f = await fixture(['effort', 'high', async () => {
      const concurrent = JSON.parse(await f.bytes());
      if (active) concurrent.profiles.current.reasoning = 'low';
      else concurrent.profiles.late = { provider: 'placeholder', model: 'added', reasoning: 'high' };
      await writeFile(f.path, JSON.stringify(concurrent));
      return '保存并使用';
    }], true, seed, 'zh');
    await f.run();
    const config = await f.read();
    assert.match(f.notices.at(-1).message, /another session/i);
    if (active) assert.equal(config.profiles.current.reasoning, 'low');
    else assert.equal(config.profiles.late.model, 'added');
  }
});

test('invalid new selection is rejected before persistence', async () => {
  const f = await fixture([], true, seed, 'zh');
  const before = await f.bytes();
  await assert.rejects(updateSelection({ ...seed.profiles.current, reasoning: 'invalid' }, { path: f.path }));
  assert.equal(await f.bytes(), before);
});

test('Esc in sub-menus keeps root focus on the same tab and storage bytes intact', async () => {
  for (const lang of ['en', 'zh']) {
    const f = await fixture([
      ({ dialog }) => {
        assert.equal(dialog?.initialIndex, 0);
        return lang === 'en' ? 'Provider' : '提供商';
      },
      () => undefined,
      ({ dialog }) => {
        assert.equal(dialog?.initialIndex, 0);
        return lang === 'en' ? 'Model' : '模型';
      },
      () => undefined,
      ({ dialog }) => {
        assert.equal(dialog?.initialIndex, 1);
        return lang === 'en' ? 'Effort' : 'effort';
      },
      () => undefined,
      ({ dialog }) => {
        assert.equal(dialog?.initialIndex, 2);
        return undefined;
      },
    ], true, seed, lang);

    const before = await f.bytes();
    await f.run();
    assert.equal(await f.bytes(), before);
    noErrors(f);
  }
});

test('Enter in sub-menus advances root menu focus: Provider -> Model -> Effort -> Save and Apply', async () => {
  for (const lang of ['en', 'zh']) {
    const beforeBytes = JSON.stringify(seed);
    const f = await fixture([
      ({ dialog }) => {
        assert.equal(dialog?.initialIndex, 0);
        return lang === 'en' ? 'Provider' : '提供商';
      },
      () => 'openai-codex',
      ({ dialog }) => {
        assert.equal(dialog?.initialIndex, 1);
        return lang === 'en' ? 'Model' : '模型';
      },
      () => 'openai-codex/spark',
      ({ dialog }) => {
        assert.equal(dialog?.initialIndex, 2);
        return lang === 'en' ? 'Effort' : 'effort';
      },
      () => 'high',
      async ({ dialog }) => {
        assert.equal(dialog?.initialIndex, 3);
        assert.equal(await f.bytes(), beforeBytes);
        return lang === 'en' ? 'Save and Apply' : '保存并使用';
      },
    ], true, seed, lang);

    await f.run();
    const config = await f.read();
    assert.equal(config.profiles.current.provider, 'openai-codex');
    assert.equal(config.profiles.current.model, 'spark');
    assert.equal(config.profiles.current.reasoning, 'high');
    noErrors(f);
  }
});

test('models command entry sets root menu focus on Effort tab', async () => {
  const f = await fixture([
    () => 'openai-codex/luna',
    ({ dialog }) => {
      assert.equal(dialog?.initialIndex, 2);
      return 'Effort';
    },
    () => 'low',
    ({ dialog }) => {
      assert.equal(dialog?.initialIndex, 3);
      return 'Save and Apply';
    },
  ], true, seed, 'en');

  await f.run('models');
  const config = await f.read();
  assert.equal(config.profiles.current.provider, 'openai-codex');
  assert.equal(config.profiles.current.model, 'luna');
  assert.equal(config.profiles.current.reasoning, 'low');
  noErrors(f);
});

test('missing items in incomplete save or selections move focus to the missing item', async () => {
  const f = await fixture([
    'Provider',
    () => 'placeholder-local',
    ({ dialog }) => {
      assert.equal(dialog?.initialIndex, 1);
      return 'Save and Apply';
    },
    ({ dialog }) => {
      assert.equal(dialog?.initialIndex, 1);
      return 'Model';
    },
    () => 'placeholder-local/plain',
    ({ dialog }) => {
      assert.equal(dialog?.initialIndex, 2);
      return 'Save and Apply';
    },
    ({ dialog }) => {
      assert.equal(dialog?.initialIndex, 2);
      return undefined;
    },
  ], true, seed, 'en');

  await f.run();
  assert.equal(f.notices.filter(n => n.type === 'error').length, 2);
});

test('menu includes models with text input and tool calling', async () => {
  const f = await fixture([], false);
  const available = availableModels(f.ctx);
  assert.equal(available.some(m => m.id === 'notool'), false);
  assert.equal(available.some(m => m.id === 'image'), false);
  assert.equal(available.some(m => m.id === 'alpha'), true);
  assert.equal(available.some(m => m.id === 'plain'), true);
});

test('resolveLang follows option, CODE_MODEL_LANG, LC_ALL, and LANG precedence', () => {
  const original = { CODE_MODEL_LANG: process.env.CODE_MODEL_LANG, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };
  try {
    process.env.CODE_MODEL_LANG = 'zh'; process.env.LC_ALL = 'en_US.UTF-8'; process.env.LANG = 'en_US.UTF-8';
    assert.equal(resolveLang(), 'zh');
    assert.equal(resolveLang({ lang: 'en' }), 'en');

    delete process.env.CODE_MODEL_LANG;
    process.env.LC_ALL = 'zh_CN.UTF-8'; process.env.LANG = 'en_US.UTF-8';
    assert.equal(resolveLang(), 'zh');

    delete process.env.LC_ALL;
    process.env.LANG = 'zh_CN.UTF-8';
    assert.equal(resolveLang(), 'zh');

    process.env.LANG = 'en_US.UTF-8';
    assert.equal(resolveLang(), 'en');

    delete process.env.LANG;
    assert.equal(resolveLang(), 'en');
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
