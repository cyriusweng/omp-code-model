import {
  CONFIG_PATH,
  ROUTING_FALLBACKS,
  ROUTING_MODES,
  getModelEfforts,
  getRouting,
  getSelection,
  loadConfig,
  updateRouting,
  updateSelection,
} from './configuration.mjs';

export const MESSAGES = {
  en: {
    help: 'Use arrow keys to navigate, Enter to select, Escape to cancel. Usage limits depend on account provider.',
    menuTitle: 'Code Model Configuration',
    tabProvider: 'Provider',
    tabModel: 'Model',
    tabEffort: 'Effort',
    tabSave: 'Save and Apply',
    selectProviderTitle: 'Select Provider · OMP Available Providers',
    selectModelTitleAll: 'Select Model · All Available Models',
    selectModelTitleProvider: provider => `Select Model · ${provider}`,
    selectEffortTitle: (provider, id) => `Select Effort · ${provider}/${id}`,
    effortAuto: 'Model default',
    effortLevel: label => `${label} reasoning level`,
    modelsCount: count => `${count} models`,
    routingNotice: (mode, fallback, configPath) =>
      `Automatic routing: ${mode}; fallback: ${fallback}. Config: ${configPath}`,
    routingSaved: (mode, fallback) =>
      `Saved automatic routing: ${mode}; fallback: ${fallback}.`,
    notSelected: 'Not selected',
    pendingSelection: 'Pending selection',
    showNotice: (provider, model, reasoning, configPath) =>
      `Current coding model: ${provider}/${model} · ${reasoning}. Used during the coding phase in the same conversation; run /code-model start to enter, finish to restore, status to check. Config: ${configPath}`,
    savedNotice: (provider, model, reasoning) =>
      `Saved coding model: ${provider}/${model} · ${reasoning}. Takes effect on next coding phase; the active phase keeps its current selection.`,
    errCheckProvider: 'Please check authentication and model catalogue for this provider.',
    errSelectProvider: 'Please select a provider from the catalogue.',
    errSelectModel: 'Please select a model from the catalogue.',
    errSelectEffort: 'Please select an effort supported by the current model.',
    errRoutingUsage: 'Use /code-model routing [off|observe|enforce] [main_agent|code_model].',
    errSelectFirst: 'Please select a provider and model first.',
    errInteractiveOnly: 'Please open the settings menu in interactive OMP mode.',
    errUsage: 'Use /code-model to configure model and effort; /code-model show to view, /code-model models to browse models.',
    errInvalidOption: 'Please select a valid option from the menu.',
  },
  zh: {
    help: '上下方向键选择，Enter 确认，Escape 返回。额度以账户服务为准。',
    menuTitle: '同会话编码模型设置',
    tabProvider: '提供商',
    tabModel: '模型',
    tabEffort: 'effort',
    tabSave: '保存并使用',
    selectProviderTitle: '选择提供商 · OMP 全部可选提供商',
    selectModelTitleAll: '选择模型 · OMP 全部可选模型',
    selectModelTitleProvider: provider => `选择模型 · ${provider}`,
    selectEffortTitle: (provider, id) => `选择 effort · ${provider}/${id}`,
    effortAuto: '模型默认',
    effortLevel: label => `${label} 推理等级`,
    modelsCount: count => `${count} 个模型`,
    notSelected: '待选择',
    pendingSelection: '待完成选择',
    routingNotice: (mode, fallback, configPath) =>
      `自动路由：${mode}；fallback：${fallback}。配置：${configPath}`,
    routingSaved: (mode, fallback) =>
      `已保存自动路由：${mode}；fallback：${fallback}。`,
    showNotice: (provider, model, reasoning, configPath) =>
      `当前代码模型：${provider}/${model} · ${reasoning}。用于同一主会话的编码阶段；/code-model start 切入，finish 恢复原模型，status 查看阶段。配置：${configPath}`,
    savedNotice: (provider, model, reasoning) =>
      `已保存当前代码模型：${provider}/${model} · ${reasoning}。下一次进入编码阶段时生效，当前阶段保持原选择。`,
    errCheckProvider: '请检查该提供商的认证和模型目录。',
    errSelectProvider: '请选择目录中的提供商。',
    errSelectModel: '请选择模型目录中的选项。',
    errSelectEffort: '请选择当前模型支持的 effort。',
    errSelectFirst: '请先选择提供商和模型。',
    errInteractiveOnly: '请在交互式 OMP 中打开设置菜单。',
    errRoutingUsage: '请使用 /code-model routing [off|observe|enforce] [main_agent|code_model]。',
    errUsage: '请用 /code-model 设置当前模型和 effort；/code-model show 查看设置，/code-model models 打开模型列表。',
    errInvalidOption: '请选择菜单中的选项。',
  },
};

export function resolveLang(options = {}) {
  if (options.lang === 'zh' || options.lang === 'en') return options.lang;
  const env = process.env.CODE_MODEL_LANG || process.env.LC_ALL || process.env.LANG || '';
  return env.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function availableModels(ctx) {
  const models = ctx.models?.list?.() ?? ctx.modelRegistry?.getAvailable?.() ?? [];
  return [...new Map(
    models
      .filter(model => model.input?.includes('text') !== false)
      .filter(model => model.supportsTools !== false && model.toolUse !== false)
      .map(model => [`${model.provider}/${model.id}`, model]),
  ).values()].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}

async function pickEffort(ctx, model, current, t) {
  const efforts = getModelEfforts(model);
  const selected = await ctx.ui.select(
    t.selectEffortTitle(model.provider, model.id),
    efforts.map(label => ({
      label,
      description: label === 'auto' ? t.effortAuto : t.effortLevel(label),
    })),
    { initialIndex: Math.max(0, efforts.indexOf(current)), helpText: t.help },
  );
  if (selected !== undefined && !efforts.includes(selected)) throw new Error(t.errSelectEffort);
  return selected;
}

async function pickProvider(ctx, current, t) {
  const models = availableModels(ctx);
  if (!models.length) throw new Error(t.errCheckProvider);
  const providers = [...new Set(models.map(model => model.provider))].sort();
  const provider = await ctx.ui.select(
    t.selectProviderTitle,
    providers.map(p => ({
      label: p,
      description: t.modelsCount(models.filter(m => m.provider === p).length),
    })),
    { initialIndex: Math.max(0, providers.indexOf(current?.provider)), helpText: t.help },
  );
  if (provider === undefined) return undefined;
  if (!providers.includes(provider)) throw new Error(t.errSelectProvider);
  return provider;
}

async function pickModel(ctx, current, t, { all = false } = {}) {
  const allAvailable = availableModels(ctx);
  if (!allAvailable.length) throw new Error(t.errCheckProvider);
  const provider = current?.provider;
  const models = all || !provider
    ? allAvailable
    : allAvailable.filter(m => m.provider === provider);
  if (!models.length) throw new Error(t.errCheckProvider);
  const labels = models.map(m => `${m.provider}/${m.id}`);
  const title = all || !provider
    ? t.selectModelTitleAll
    : t.selectModelTitleProvider(provider);
  const initialIndex = Math.max(
    0,
    models.findIndex(m => m.provider === current?.provider && m.id === current?.model),
  );
  const selected = await ctx.ui.select(
    title,
    models.map((m, i) => ({
      label: labels[i],
      description: m.name ?? m.id,
    })),
    { initialIndex, helpText: t.help },
  );
  if (selected === undefined) return undefined;
  const model = models[labels.indexOf(selected)];
  if (!model) throw new Error(t.errSelectModel);
  return model;
}

function showCurrent(config, ctx, configPath, t) {
  const selected = getSelection(config);
  if (!selected) {
    ctx.ui.notify(t.errSelectFirst, 'error');
    return;
  }
  ctx.ui.notify(t.showNotice(selected.provider, selected.model, selected.reasoning, configPath), 'info');
}

export async function runCodeModel(args, ctx, { configPath = CONFIG_PATH, lang: langOption } = {}) {
  const lang = resolveLang({ lang: langOption });
  const t = MESSAGES[lang] || MESSAGES.en;
  try {
    const words = args.trim().split(/\s+/).filter(Boolean);
    const config = await loadConfig(configPath);
    if (words[0] === 'routing') {
      const current = getRouting(config);
      if (words.length === 1) {
        ctx.ui.notify(t.routingNotice(current.mode, current.fallback, configPath), 'info');
        return config;
      }
      if (words.length > 3) throw new Error(t.errRoutingUsage);
      const routing = {
        mode: words[1],
        fallback: words[2] ?? current.fallback,
      };
      if (!ROUTING_MODES.has(routing.mode) || !ROUTING_FALLBACKS.has(routing.fallback)) {
        throw new Error(t.errRoutingUsage);
      }
      const updated = await updateRouting(routing, { path: configPath, expectedConfig: config });
      ctx.ui.notify(t.routingSaved(routing.mode, routing.fallback), 'info');
      return updated;
    }
    if (words[0] === 'show' && words.length === 1) {
      showCurrent(config, ctx, configPath, t);
      return config;
    }
    const allModels = words[0] === 'models' && words.length === 1;
    if (words.length > 1 || (words.length && !allModels)) {
      throw new Error(t.errUsage);
    }
    if (!ctx.hasUI) {
      if (allModels) throw new Error(t.errInteractiveOnly);
      showCurrent(config, ctx, configPath, t);
      return config;
    }
    let staged = getSelection(config) ?? { provider: undefined, model: undefined, reasoning: undefined };
    let menuIndex = 0;
    if (allModels) {
      const picked = await pickModel(ctx, staged, t, { all: true });
      if (!picked) return undefined;
      const efforts = getModelEfforts(picked);
      const reasoning = efforts.includes(staged?.reasoning) ? staged.reasoning : undefined;
      staged = { provider: picked.provider, model: picked.id, reasoning };
      menuIndex = 2;
    }
    while (true) {
      const modelDesc = staged.model ? `${staged.provider}/${staged.model}` : t.notSelected;
      const effortDesc = staged.reasoning ?? t.notSelected;
      const saveDesc = staged.model && staged.reasoning
        ? `${staged.provider}/${staged.model} · ${staged.reasoning}`
        : t.pendingSelection;

      const action = await ctx.ui.select(
        t.menuTitle,
        [
          { label: t.tabProvider, description: staged.provider ?? t.notSelected },
          { label: t.tabModel, description: modelDesc },
          { label: t.tabEffort, description: effortDesc },
          { label: t.tabSave, description: saveDesc },
        ],
        { initialIndex: menuIndex, helpText: t.help },
      );
      if (action === undefined) return undefined;

      const isProvider = action === t.tabProvider;
      const isModel = action === t.tabModel;
      const isEffort = action === t.tabEffort;
      const isSave = action === t.tabSave;

      if (isProvider) {
        menuIndex = 0;
        const pickedProvider = await pickProvider(ctx, staged, t);
        if (pickedProvider !== undefined) {
          if (pickedProvider !== staged.provider) {
            staged = { provider: pickedProvider, model: undefined, reasoning: undefined };
          }
          menuIndex = 1;
        }
      } else if (isModel) {
        menuIndex = 1;
        if (!staged.provider) {
          ctx.ui.notify(t.errSelectFirst, 'error');
          menuIndex = 0;
          continue;
        }
        const picked = await pickModel(ctx, staged, t);
        if (picked !== undefined) {
          const efforts = getModelEfforts(picked);
          const reasoning = efforts.includes(staged.reasoning) ? staged.reasoning : undefined;
          staged = { provider: picked.provider, model: picked.id, reasoning };
          menuIndex = 2;
        }
      } else if (isEffort) {
        menuIndex = 2;
        if (!staged.provider) {
          ctx.ui.notify(t.errSelectFirst, 'error');
          menuIndex = 0;
          continue;
        }
        if (!staged.model) {
          ctx.ui.notify(t.errSelectFirst, 'error');
          menuIndex = 1;
          continue;
        }
        const model = availableModels(ctx).find(item => item.provider === staged.provider && item.id === staged.model);
        if (!model) throw new Error(t.errCheckProvider);
        const reasoning = await pickEffort(ctx, model, staged.reasoning, t);
        if (reasoning !== undefined) {
          staged = { ...staged, reasoning };
          menuIndex = 3;
        }
      } else if (isSave) {
        menuIndex = 3;
        if (!staged.provider) {
          ctx.ui.notify(t.errSelectFirst, 'error');
          menuIndex = 0;
          continue;
        }
        if (!staged.model) {
          ctx.ui.notify(t.errSelectFirst, 'error');
          menuIndex = 1;
          continue;
        }
        const model = availableModels(ctx).find(item => item.provider === staged.provider && item.id === staged.model);
        if (!model) throw new Error(t.errCheckProvider);
        if (!staged.reasoning || !getModelEfforts(model).includes(staged.reasoning)) {
          ctx.ui.notify(t.errSelectEffort, 'error');
          menuIndex = 2;
          continue;
        }
        const saved = await updateSelection(staged, { path: configPath, expectedConfig: config });
        ctx.ui.notify(t.savedNotice(staged.provider, staged.model, staged.reasoning), 'info');
        return saved;
      } else {
        throw new Error(t.errInvalidOption);
      }
    }
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
    return undefined;
  }
}
