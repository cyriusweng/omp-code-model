import { createHash, randomUUID } from 'node:crypto';
import { CONFIG_PATH, getRouting, loadConfig } from './configuration.mjs';

export const AUTOMATIC_ROUTING_STATE_TYPE = 'omp-code-model-automatic-routing-v1';

function promptDigest(prompt) {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function sessionId(ctx) {
  return ctx.sessionManager?.getSessionId?.() ?? 'unknown-session';
}

export function installAutomaticRouting(pi, {
  advisor,
  session,
  configPath = CONFIG_PATH,
} = {}) {
  if (!advisor || !session) throw new Error('Automatic routing requires advisor and session services.');

  let prepared;
  let automaticPhase = false;

  function clearPreparation() {
    prepared?.controller.abort(new DOMException('Routing preparation ended.', 'AbortError'));
    prepared = undefined;
  }

  function assertCurrent(current, ctx) {
    if (current.wasBusy && ctx.isIdle()) {
      current.controller.abort(new DOMException('Routing preparation was cancelled.', 'AbortError'));
    }
    current.signal.throwIfAborted();
    if (prepared !== current || sessionId(ctx) !== current.sessionId) {
      throw new DOMException('Routing preparation belongs to an earlier session or prompt.', 'AbortError');
    }
  }

  async function applyRoute(event, ctx, routing, current) {
    assertCurrent(current, ctx);
    const task = event.prompt?.trim() || '[Image-only user prompt]';
    const recommendation = await advisor.recommend({
      task,
      allowSubagent: false,
      useJev: true,
      fallbackRoute: routing.fallback,
      automatic: true,
      traceId: current.id,
    }, ctx, current.signal);
    assertCurrent(current, ctx);

    const active = session.isActive(ctx);
    if (!active) automaticPhase = false;
    let action = routing.mode === 'observe' ? 'observed' : active ? 'kept_code_model' : 'kept_main_agent';
    const confidence = recommendation.judgment?.confidence;
    const confidenceValid = Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
    const belowThreshold = recommendation.judgment?.backend === 'typesafe' &&
      (!confidenceValid || confidence < routing.minConfidence);
    let decisionReason = routing.mode === 'observe' ? 'observe_mode' : 'recommendation_applied';
    if (routing.mode === 'enforce' && belowThreshold) {
      action = active ? 'kept_code_model_low_confidence' : 'kept_main_agent_low_confidence';
      decisionReason = confidenceValid ? 'confidence_below_threshold' : 'invalid_confidence';
    } else if (routing.mode === 'enforce') {
      if (recommendation.judgment?.backend === 'deterministic') decisionReason = 'configured_fallback';
      if (recommendation.route === 'code_model') {
        const transition = await session.run('start', ctx, current.signal, { effort: recommendation.effort });
        assertCurrent(current, ctx);
        automaticPhase = transition.changed || automaticPhase;
        action = transition.changed ? 'entered_code_model' : 'kept_code_model';
      } else if (automaticPhase && active) {
        await session.run('finish', ctx, current.signal);
        assertCurrent(current, ctx);
        automaticPhase = false;
        action = 'restored_main_agent';
      } else if (active) {
        decisionReason = 'manual_phase_preserved';
      }
    }

    const receipt = {
      version: 1,
      sessionId: current.sessionId,
      promptDigest: promptDigest(task),
      traceId: current.id,
      startedAt: current.startedAt,
      durationMs: Math.round(performance.now() - current.started),
      recordedAt: new Date().toISOString(),
      mode: routing.mode,
      fallback: routing.fallback,
      minConfidence: routing.minConfidence,
      route: recommendation.route,
      effectiveRoute: session.isActive(ctx) ? 'code_model' : 'main_agent',
      decisionReason,
      effort: recommendation.effort,
      backend: recommendation.judgment.backend,
      model: recommendation.judgment.model,
      confidence: recommendation.judgment.confidence,
      fallbackReason: recommendation.judgment.fallbackReason,
      quotaState: recommendation.quota.state,
      action,
    };
    assertCurrent(current, ctx);
    current.receipt = receipt;
    pi.appendEntry(AUTOMATIC_ROUTING_STATE_TYPE, receipt);
    return receipt;
  }

  function policyResult(event, ctx, current) {
    assertCurrent(current, ctx);
    if (!current.receipt) return undefined;
    const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt].filter(Boolean);
    return {
      systemPrompt: [...base, `Automatic execution routing receipt for this turn\n${JSON.stringify(current.receipt)}\nUse the effective route above. code-model status exposes this receipt. Request another recommendation when new evidence materially changes the execution choice. User permissions remain authoritative.`],
    };
  }

  async function prepareRouting(event, ctx) {
    event.signal?.throwIfAborted();
    if (ctx.isIdle?.()) { clearPreparation(); return undefined; }
    const digest = promptDigest(event.prompt?.trim() || '[Image-only user prompt]');
    const key = `${sessionId(ctx)}:${digest}`;
    if (prepared?.key === key && !prepared.signal.aborted) {
      const current = prepared;
      await current.promise;
      event.signal?.throwIfAborted();
      return policyResult(event, ctx, current);
    }

    clearPreparation();
    const controller = new AbortController();
    let traceId = randomUUID();
    pi.events?.emit('cyrius:chain-trace:v1', { ctx, prompt: event.prompt, accept(id) { traceId = id; } });
    const current = {
      id: traceId, started: performance.now(), startedAt: new Date().toISOString(),
      key, controller, sessionId: sessionId(ctx),
      wasBusy: ctx.isIdle?.() === false,
      signal: event.signal ? AbortSignal.any([controller.signal, event.signal]) : controller.signal,
    };
    prepared = current;
    const stopObserving = ctx.hasUI ? ctx.ui?.onTerminalInput?.(data => {
      if (['\x1b', '\x03', '\x1b[27u', '\x1b[99;5u'].includes(data)) {
        controller.abort(new DOMException('Routing preparation was cancelled.', 'AbortError'));
      }
      return undefined;
    }) : undefined;
    const idleTimer = current.wasBusy ? setInterval(() => {
      try { assertCurrent(current, ctx); } catch (error) { controller.abort(error); }
    }, 100) : undefined;
    idleTimer?.unref?.();
    current.promise = (async () => {
      const routing = getRouting(await loadConfig(configPath));
      assertCurrent(current, ctx);
      if (routing.mode === 'off') return;
      return applyRoute(event, ctx, routing, current);
    })();
    try {
      await current.promise;
      return policyResult(event, ctx, current);
    } catch (error) {
      if (prepared === current) clearPreparation();
      throw error;
    } finally {
      clearInterval(idleTimer);
      stopObserving?.();
    }
  }

  pi.on('before_agent_start', prepareRouting);
  pi.events?.on('cyrius:code-model:prepare:v1', offer => {
    offer.accept(prepareRouting(offer.event, offer.ctx));
  });

  pi.on('agent_end', (_event, ctx) => {
    clearPreparation();
    // The session service owns completion/retry restoration.
    automaticPhase = automaticPhase && session.isActive(ctx);
  });
  for (const event of ['session_start', 'session_before_switch', 'session_switch', 'session_before_tree',
    'session_tree', 'session_before_branch', 'session_branch', 'session_shutdown']) {
    pi.on(event, () => {
      clearPreparation();
      if (!event.startsWith('session_before_')) automaticPhase = false;
    });
  }

  return {
    clearPreparation,
    currentReceipt(ctx) {
      return prepared?.sessionId === sessionId(ctx) && !prepared.signal.aborted
        ? structuredClone(prepared.receipt) : undefined;
    },
    get automaticPhase() { return automaticPhase; },
  };
}
