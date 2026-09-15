import { EFFORTS, getModelEfforts, getSelection, loadConfig } from './configuration.mjs';
import codeModelReviewPrompt from '../prompts/code-model-review.md' with { type: 'text' };

export const STATE_TYPE = 'omp-code-model-phase-v1';
export const REVIEW = codeModelReviewPrompt.trim();

export const EPHEMERAL_MODEL_CHANGE_ROLE = 'fallback';

function getSingleRoutingOnly(routing) {
  if (!routing || typeof routing !== 'object' || !Array.isArray(routing.only)) return undefined;
  if (routing.only.length !== 1) return undefined;
  const upstream = routing.only[0];
  return typeof upstream === 'string' && upstream ? upstream : undefined;
}

function getSingleUpstreamRoute(model) {
  const compat = model?.compat;
  if (!compat || typeof compat !== 'object') return undefined;
  const provider = model.provider;
  const baseUrl = typeof model.baseUrl === 'string' ? model.baseUrl.toLowerCase() : '';
  const isVercelGateway = provider === 'vercel-ai-gateway' || baseUrl.includes('ai-gateway.vercel.sh');
  const isOpenRouter = provider === 'openrouter' || baseUrl.includes('openrouter.ai');
  if (isVercelGateway) return getSingleRoutingOnly(compat.vercelGatewayRouting);
  if (isOpenRouter) return getSingleRoutingOnly(compat.openRouterRouting);
  return undefined;
}

export function formatModelStringWithRouting(model) {
  if (!model) return '';
  const selector = `${model.provider}/${model.id}`;
  const upstream = getSingleUpstreamRoute(model);
  return upstream ? `${selector}@${upstream}` : selector;
}

function parseModelString(selector) {
  if (typeof selector !== 'string') return undefined;
  const slash = selector.indexOf('/');
  if (slash <= 0 || slash === selector.length - 1) return undefined;
  const provider = selector.slice(0, slash);
  const id = selector.slice(slash + 1);
  return { provider, id };
}

function splitThinkingSuffix(selector) {
  const colon = selector.lastIndexOf(':');
  if (colon > 0) {
    const level = selector.slice(colon + 1);
    if (EFFORTS.has(level)) {
      return { base: selector.slice(0, colon), level };
    }
  }
  return { base: selector, level: undefined };
}

const sameModel = (model, state) => {
  if (!model || !state) return false;
  if (state.selector) {
    return formatModelStringWithRouting(model) === state.selector;
  }
  return model.provider === state.provider && model.id === state.id;
};

const describe = state => {
  const name = state.selector ?? `${state.provider}/${state.id}`;
  return `${name} · ${state.effort ?? 'default'}`;
};

const validEffort = value => value === undefined || EFFORTS.has(value);

function validModelState(value) {
  return value && typeof value === 'object' && typeof value.provider === 'string' &&
    typeof value.id === 'string' &&
    (value.selector === undefined || typeof value.selector === 'string') &&
    (value.role === undefined || typeof value.role === 'string') &&
    validEffort(value.effort);
}

function validPhaseState(value) {
  return value && typeof value === 'object' && value.version === 1 &&
    typeof value.sessionId === 'string' &&
    ['switching', 'coding', 'restoring'].includes(value.phase) &&
    validModelState(value.original) && validModelState(value.coding);
}

export function installSessionMode(pi, { configPath, getRetryFallbackPrimary, registerBeforeIdle, registerBeforeNavigation, registerAfterNavigation } = {}) {
  let state;
  let busy = false;
  let inFlight;
  let phaseSwitchEntry;
  let reviewPending = false;
  const usesInternalFinalizer = typeof registerBeforeIdle === 'function';
  const supportsSetModelOptions = pi.setModel.length >= 2;

  const sessionId = ctx => ctx.sessionManager.getSessionId();
  const branch = ctx => ctx.sessionManager.getBranch();
  const currentModel = ctx => ctx.models?.current?.() ?? ctx.model;
  const findModel = (ctx, target) => {
    const list = ctx.models?.list?.() ?? ctx.modelRegistry?.getAvailable?.() ?? [];
    if (target.selector) {
      const resolved = ctx.models?.resolve?.(target.selector);
      if (resolved && sameModel(resolved, target)) return resolved;
      const matched = list.find(model => sameModel(model, target));
      if (matched) return matched;
    }
    return list.find(model => model.provider === target.provider && model.id === target.id) ??
      ctx.modelRegistry?.find?.(target.provider, target.id);
  };

  function configuredThinking(ctx) {
    if (typeof pi.getConfiguredThinkingLevel === 'function') {
      return pi.getConfiguredThinkingLevel();
    }
    const latest = branch(ctx).findLast(entry => entry.type === 'thinking_level_change');
    const recorded = latest?.configured ?? latest?.thinkingLevel;
    return EFFORTS.has(recorded) ? recorded : pi.getThinkingLevel();
  }

  function getActiveRole(ctx, selector) {
    const entries = branch(ctx);
    const entry = entries.findLast(
      item => item.type === 'model_change' && item.model === selector && !item.resolvedModelIsFallback,
    );
    return entry ? (entry.role ?? 'default') : entries.some(item => item.type === 'model_change') ? 'temporary' : 'default';
  }

  function resolvePersistedModel(ctx, selector) {
    const list = ctx.models?.list?.() ?? ctx.modelRegistry?.getAvailable?.() ?? [];
    const literal = list.find(
      model => `${model.provider}/${model.id}` === selector || formatModelStringWithRouting(model) === selector,
    );
    if (literal) return { model: literal, selector };

    const base = splitThinkingSuffix(selector).base;
    const parsed = parseModelString(base);
    const routeSeparator = parsed?.id.lastIndexOf('@') ?? -1;
    const id = parsed && routeSeparator > 0 ? parsed.id.slice(0, routeSeparator) : parsed?.id;
    const target = { provider: parsed?.provider ?? '', id: id ?? '', selector: base };
    return { model: findModel(ctx, target), selector: base };
  }

  function matchesRetryPrimary(retrySelector, coding, ctx) {
    if (!retrySelector) return false;
    const resolved = resolvePersistedModel(ctx, retrySelector);
    if (resolved.model) return sameModel(resolved.model, coding);
    const parsed = parseModelString(resolved.selector);
    if (!parsed) return false;
    if (coding.selector !== undefined) {
      return coding.selector === `${parsed.provider}/${parsed.id}`;
    }
    return coding.provider === parsed.provider && coding.id === parsed.id;
  }

  function snapshot(ctx) {
    const fallbackPrimary = typeof getRetryFallbackPrimary === 'function' ? getRetryFallbackPrimary() : undefined;
    const resolved = fallbackPrimary?.selector
      ? resolvePersistedModel(ctx, fallbackPrimary.selector)
      : undefined;
    const model = resolved ? resolved.model : currentModel(ctx);
    const effort = fallbackPrimary?.selector ? fallbackPrimary.effort : configuredThinking(ctx);
    if (!model) {
      const identifier = fallbackPrimary?.selector ?? 'the current session model';
      throw new Error(`The available model catalogue must contain ${identifier}.`);
    }
    const selector = supportsSetModelOptions
      ? formatModelStringWithRouting(model)
      : `${model.provider}/${model.id}`;
    return {
      provider: model.provider,
      id: model.id,
      selector,
      role: getActiveRole(ctx, selector),
      effort,
    };
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
    if (!next) phaseSwitchEntry = undefined;
  }

  async function guarded(operation) {
    if (busy) throw new Error('A code-model phase switch is already in progress.');
    busy = true;
    const pending = operation();
    inFlight = pending;
    try {
      return await pending;
    } finally {
      if (inFlight === pending) inFlight = undefined;
      busy = false;
    }
  }

  async function apply(ctx, target, options = {}) {
    const model = findModel(ctx, target);
    const identifier = target.selector ?? `${target.provider}/${target.id}`;
    if (!model || !sameModel(model, target)) {
      throw new Error(`The available model catalogue must contain ${identifier}.`);
    }
    const setModelOptions = options.ephemeral
      ? { ephemeral: true }
      : { role: options.role ?? target.role ?? 'default' };
    const latest = branch(ctx).findLast(entry => entry.type === 'model_change');
    const restoreRole = supportsSetModelOptions &&
      !options.ephemeral &&
      latest?.role === EPHEMERAL_MODEL_CHANGE_ROLE &&
      setModelOptions.role !== EPHEMERAL_MODEL_CHANGE_ROLE;
    const claimEphemeralRole = supportsSetModelOptions &&
      options.ephemeral &&
      latest?.role !== EPHEMERAL_MODEL_CHANGE_ROLE;
    if (!sameModel(currentModel(ctx), target) || restoreRole || claimEphemeralRole) {
      const switched = await pi.setModel(model, setModelOptions);
      if (switched === false) {
        throw new Error(`Check the existing authentication for ${identifier}.`);
      }
    }
    pi.setThinkingLevel(target.effort);
    if (!currentMatches(ctx, target)) {
      throw new Error(`The session did not reach the requested model state: ${describe(target)}.`);
    }
  }
  async function restore(ctx, { force = false } = {}) {
    if (!state || state.sessionId !== sessionId(ctx)) {
      return { changed: false, message: 'Main conversation phase is active.' };
    }
    const previous = state;
    const active = currentModel(ctx);
    const interrupted = previous.phase !== 'coding' &&
      (sameModel(active, previous.original) || sameModel(active, previous.coding));
    const effort = configuredThinking(ctx);
    const retryFallback = typeof getRetryFallbackPrimary === 'function' ? getRetryFallbackPrimary() : undefined;
    const fallbackEffort = retryFallback && 'fallbackEffort' in retryFallback
      ? retryFallback.fallbackEffort
      : previous.coding.effort;
    const latest = branch(ctx).findLast(entry => entry.type === 'model_change');
    // Hosts whose extension setModel action drops the ephemeral option
    // serialize the phase's own switch as a plain role change; while that
    // exact entry is still the newest model change, no user switch has
    // superseded it and the phase keeps ownership.
    const latestMatchesCoding = phaseSwitchEntry !== undefined && latest === phaseSwitchEntry;
    const codingRoleMatches = previous.original.role === undefined ||
      latest?.role === undefined ||
      latest?.role === EPHEMERAL_MODEL_CHANGE_ROLE ||
      latestMatchesCoding;
    const retryPrimaryMatchesCoding = retryFallback === undefined || matchesRetryPrimary(retryFallback.selector, previous.coding, ctx);
    const codingStateMatches =
      (codingRoleMatches && sameModel(active, previous.coding) && effort === previous.coding.effort) ||
      (retryPrimaryMatchesCoding && retryFallbackIsActive(ctx) && effort === fallbackEffort);

    if (!force && !interrupted && !codingStateMatches && !currentMatches(ctx, previous.original)) {
      save(null);
      return {
        changed: false,
        message: 'Preserved the model and effort selected outside code-model and ended the coding phase.',
      };
    }
    save({ ...previous, phase: 'restoring' });
    await apply(ctx, previous.original, { role: previous.original.role ?? 'default' });
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
    const model = findModel(ctx, { provider: selected.provider, id: selected.model });
    if (!model || model.input?.includes('text') === false ||
        model.supportsTools === false || model.toolUse === false) {
      throw new Error('The coding model must support text and tool calling and appear in the current model catalogue.');
    }
    if (!getModelEfforts(model).includes(selected.reasoning)) {
      throw new Error('Select an effort supported by the current model in /code-model.');
    }

    const original = snapshot(ctx);
    const codingSelector = supportsSetModelOptions
      ? formatModelStringWithRouting(model)
      : `${model.provider}/${model.id}`;
    const coding = {
      provider: model.provider,
      id: model.id,
      selector: codingSelector,
      effort: selected.reasoning,
    };
    const id = sessionId(ctx);
    signal?.throwIfAborted();
    save({ version: 1, sessionId: id, phase: 'switching', original, coding });
    try {
      await apply(ctx, coding, { ephemeral: true });
      signal?.throwIfAborted();
      if (sessionId(ctx) !== id) throw new Error('The session changed during the model switch.');
      if (!state) throw new Error('The coding phase state was cleared during the model switch.');
      save({ ...state, phase: 'coding' });
      phaseSwitchEntry = branch(ctx).findLast(entry => entry.type === 'model_change');
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
      reviewPending = false;
      ctx.ui.notify(result.message, 'info');
      return { ...result, message: result.changed ? `${result.message} ${REVIEW}` : result.message };
    });
  }

  async function prepareNavigation(ctx) {
    if (busy) return { cancel: true };
    const previousState = state ? { ...state } : undefined;
    const previousReviewPending = reviewPending;
    const rollback = () => {
      state = previousState;
      reviewPending = previousReviewPending;
    };
    if (!state) {
      reviewPending = false;
      return { rollback };
    }
    try {
      await guarded(() => restore(ctx));
      reviewPending = false;
      return { rollback };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Coding phase recovery failed: ${message} Resolve it before navigating the session.`, 'error');
      return { cancel: true, rollback };
    }
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

  if (typeof registerAfterNavigation === 'function') {
    registerAfterNavigation(ctx => recover(undefined, ctx));
  } else {
    for (const event of ['session_start', 'session_switch', 'session_tree', 'session_branch']) {
      pi.on(event, recover);
    }
  }

  if (typeof registerBeforeNavigation === 'function') {
    registerBeforeNavigation(prepareNavigation);
  } else {
    for (const event of ['session_before_switch', 'session_before_tree', 'session_before_branch']) {
      pi.on(event, (_event, ctx) => prepareNavigation(ctx));
    }
  }

  pi.on('session_stop', async (event, ctx) => {
    if (!state || busy || event.signal.aborted) return;
    const last = event.last_assistant_message ?? event.messages?.findLast(message => message.role === 'assistant');
    const shouldReview = last?.role === 'assistant' && last.stopReason === 'stop';
    if (usesInternalFinalizer && shouldReview) reviewPending = true;
    const result = await guarded(() => restore(ctx));
    ctx.ui.notify(result.message, 'info');
    if (usesInternalFinalizer && (!result.changed || event.signal.aborted)) reviewPending = false;
    if (result.changed && shouldReview && !event.signal.aborted && !usesInternalFinalizer) {
      return { continue: true, additionalContext: REVIEW };
    }
  });

  const restoreBeforeIdle = async (event, ctx) => {
    if (event.willContinue) return;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // restoration below retries from persisted state
      }
    }
    if (!state) {
      if (reviewPending) {
        reviewPending = false;
        return { continue: true, additionalContext: REVIEW };
      }
      return;
    }
    try {
      const result = await guarded(() => restore(ctx));
      ctx.ui.notify(result.message, 'info');
      if (reviewPending) {
        reviewPending = false;
        if (result.changed) {
          return { continue: true, additionalContext: REVIEW };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Coding phase recovery failed: ${message} Run /code-model finish to retry.`, 'error');
    }
  };

  if (typeof registerBeforeIdle === 'function') {
    registerBeforeIdle(restoreBeforeIdle);
  } else {
    pi.on('session_before_idle', restoreBeforeIdle);
    pi.on('agent_end', restoreBeforeIdle);
  }

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
