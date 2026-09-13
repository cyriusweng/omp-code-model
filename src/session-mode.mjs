import { EFFORTS, getModelEfforts, getSelection, loadConfig } from './configuration.mjs';
import codeModelReviewPrompt from '../prompts/code-model-review.md' with { type: 'text' };

export const STATE_TYPE = 'omp-code-model-phase-v1';
export const REVIEW = codeModelReviewPrompt.trim();

const sameModel = (model, state) => model?.provider === state.provider && model.id === state.id;
const describe = state => `${state.provider}/${state.id} · ${state.effort ?? 'default'}`;
const validEffort = value => value === undefined || EFFORTS.has(value);

function validModelState(value) {
  return value && typeof value === 'object' && typeof value.provider === 'string' &&
    typeof value.id === 'string' && validEffort(value.effort);
}

function validPhaseState(value) {
  return value && typeof value === 'object' && value.version === 1 &&
    typeof value.sessionId === 'string' &&
    ['switching', 'coding', 'restoring'].includes(value.phase) &&
    validModelState(value.original) && validModelState(value.coding);
}

export function installSessionMode(pi, { configPath } = {}) {
  let state;
  let busy = false;

  const sessionId = ctx => ctx.sessionManager.getSessionId();
  const branch = ctx => ctx.sessionManager.getBranch();
  const currentModel = ctx => ctx.models?.current?.() ?? ctx.model;
  const findModel = (ctx, provider, id) =>
    ctx.models?.list?.().find(model => model.provider === provider && model.id === id) ??
    ctx.modelRegistry?.find?.(provider, id);

  function configuredThinking(ctx) {
    if (typeof pi.getConfiguredThinkingLevel === 'function') {
      return pi.getConfiguredThinkingLevel();
    }
    const latest = branch(ctx).findLast(entry => entry.type === 'thinking_level_change');
    const recorded = latest?.configured ?? latest?.thinkingLevel;
    return EFFORTS.has(recorded) ? recorded : pi.getThinkingLevel();
  }

  function snapshot(ctx) {
    const model = currentModel(ctx);
    if (!model) throw new Error('The current session requires a valid model.');
    return { provider: model.provider, id: model.id, effort: configuredThinking(ctx) };
  }

  function currentMatches(ctx, target) {
    return sameModel(currentModel(ctx), target) && configuredThinking(ctx) === target.effort;
  }

  function retryFallbackIsActive(ctx) {
    const latest = branch(ctx).findLast(entry => entry.type === 'model_change');
    return latest?.resolvedModelIsFallback === true;
  }

  function save(next) {
    pi.appendEntry(STATE_TYPE, next);
    state = next;
  }

  async function guarded(operation) {
    if (busy) throw new Error('A code-model phase switch is already in progress.');
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }

  async function apply(ctx, target) {
    const model = findModel(ctx, target.provider, target.id);
    if (!model) throw new Error(`The available model catalogue must contain ${target.provider}/${target.id}.`);
    if (!sameModel(currentModel(ctx), target) && !(await pi.setModel(model))) {
      throw new Error(`Check the existing authentication for ${target.provider}/${target.id}.`);
    }
    pi.setThinkingLevel(target.effort);
    if (!currentMatches(ctx, target)) {
      throw new Error(`The session did not reach the requested model state: ${describe(target)}.`);
    }
  }

  async function restore(ctx, { force = false } = {}) {
    if (!state || state.sessionId !== sessionId(ctx)) {
      return { changed: false, message: 'Currently in main conversation phase.' };
    }
    const previous = state;
    const active = currentModel(ctx);
    const interrupted = previous.phase !== 'coding' &&
      (sameModel(active, previous.original) || sameModel(active, previous.coding));
    if (!force && !interrupted && !retryFallbackIsActive(ctx) &&
        !currentMatches(ctx, previous.coding) && !currentMatches(ctx, previous.original)) {
      save(null);
      return {
        changed: false,
        message: 'Preserved the model and effort selected outside code-model and ended the coding phase.',
      };
    }
    save({ ...previous, phase: 'restoring' });
    await apply(ctx, previous.original);
    save(null);
    return { changed: true, message: `Restored main conversation model: ${describe(previous.original)}.` };
  }

  async function start(ctx, signal) {
    if (state?.sessionId === sessionId(ctx)) {
      if (state.phase !== 'coding') {
        throw new Error('The previous model switch still needs restoration. Run code-model finish first.');
      }
      if (currentMatches(ctx, state.coding)) {
        return {
          changed: false,
          phase: state.phase,
          message: `Coding phase is active: ${describe(state.coding)}. Call code-model finish alone after implementation and targeted checks.`,
        };
      }
      save(null);
    }

    signal?.throwIfAborted();
    const selected = getSelection(await loadConfig(configPath));
    if (!selected) throw new Error('Configure a coding model with /code-model.');
    const model = findModel(ctx, selected.provider, selected.model);
    if (!model || model.input?.includes('text') === false ||
        model.supportsTools === false || model.toolUse === false) {
      throw new Error('The coding model must support text and tool calling and appear in the current model catalogue.');
    }
    if (!getModelEfforts(model).includes(selected.reasoning)) {
      throw new Error('Select an effort supported by the current model in /code-model.');
    }

    const original = snapshot(ctx);
    const coding = { provider: model.provider, id: model.id, effort: selected.reasoning };
    const id = sessionId(ctx);
    signal?.throwIfAborted();
    save({ version: 1, sessionId: id, phase: 'switching', original, coding });
    try {
      await apply(ctx, coding);
      signal?.throwIfAborted();
      if (sessionId(ctx) !== id) throw new Error('The session changed during the model switch.');
      if (!state) throw new Error('The coding phase state was cleared during the model switch.');
      save({ ...state, phase: 'coding' });
    } catch (error) {
      if (sessionId(ctx) === id) {
        try {
          await restore(ctx, { force: true });
        } catch (recoveryError) {
          const primary = error instanceof Error ? error.message : String(error);
          const recovery = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
          throw new Error(`${primary} Original model restoration also failed: ${recovery}`);
        }
      }
      throw error;
    }

    ctx.ui.notify(`Coding phase: ${describe(coding)}; completion restores ${describe(original)}.`, 'info');
    return {
      changed: true,
      phase: 'coding',
      message: `Entered coding phase in the same conversation: ${describe(coding)}. Existing history, tools and permissions remain active. Implement and run targeted checks, then call code-model finish alone for original-model review.`,
    };
  }

  async function run(action, ctx, signal) {
    if (action === 'status') {
      const selected = getSelection(await loadConfig(configPath));
      const configured = selected
        ? `${selected.provider}/${selected.model} · ${selected.reasoning}`
        : 'unconfigured';
      return {
        changed: false,
        phase: state?.phase,
        message: `Coding model setting: ${configured}. ${state
          ? `Current phase: ${state.phase}; restore target: ${describe(state.original)}.`
          : 'Currently in main conversation phase.'}`,
      };
    }
    return guarded(async () => {
      if (action === 'start') return start(ctx, signal);
      if (action !== 'finish') throw new Error('action must be start, finish or status.');
      const result = await restore(ctx);
      ctx.ui.notify(result.message, 'info');
      return { ...result, message: result.changed ? `${result.message} ${REVIEW}` : result.message };
    });
  }

  async function recover(_event, ctx) {
    const entry = branch(ctx).findLast(item => item.type === 'custom' && item.customType === STATE_TYPE);
    const saved = entry?.type === 'custom' ? entry.data : undefined;
    state = validPhaseState(saved) ? { ...saved, sessionId: sessionId(ctx) } : undefined;
    if (!state) return;
    try {
      const result = await guarded(() => restore(ctx));
      ctx.ui.notify(`Resuming session: ${result.message}`, 'info');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Coding phase recovery failed: ${message} Run /code-model finish to retry.`, 'error');
    }
  }

  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_branch']) {
    pi.on(event, recover);
  }
  for (const event of ['session_before_switch', 'session_before_tree', 'session_before_branch']) {
    pi.on(event, () => busy ? { cancel: true } : undefined);
  }
  pi.on('session_stop', async (event, ctx) => {
    if (!state || busy || event.signal.aborted) return;
    const result = await guarded(() => restore(ctx));
    ctx.ui.notify(result.message, 'info');
    const last = event.last_assistant_message ?? event.messages?.findLast(message => message.role === 'assistant');
    if (result.changed && last?.stopReason === 'stop' && !event.signal.aborted) {
      return { continue: true, additionalContext: REVIEW };
    }
  });

  const restoreBeforeIdle = async (event, ctx) => {
    if (!state || busy || event.willContinue) return;
    try {
      const result = await guarded(() => restore(ctx));
      ctx.ui.notify(result.message, 'info');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Coding phase recovery failed: ${message} Run /code-model finish to retry.`, 'error');
    }
  };
  pi.on('session_before_idle', restoreBeforeIdle);
  pi.on('agent_end', restoreBeforeIdle);

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!state || busy) return;
    try {
      await guarded(() => restore(ctx));
    } catch {
      // Persisted phase state is restored when this session resumes.
    }
  });

  return { run };
}
