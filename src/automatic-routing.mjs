import { createHash } from 'node:crypto';
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
    prepared = undefined;
  }

  async function applyRoute(event, ctx, routing) {
    const task = event.prompt?.trim() || '[Image-only user prompt]';
    const recommendation = await advisor.recommend({
      task,
      allowSubagent: false,
      useJev: true,
      fallbackRoute: routing.fallback,
    }, ctx);

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
        const transition = await session.run('start', ctx, undefined, { effort: recommendation.effort });
        automaticPhase = transition.changed || automaticPhase;
        action = transition.changed ? 'entered_code_model' : 'kept_code_model';
      } else if (automaticPhase && active) {
        await session.run('finish', ctx);
        automaticPhase = false;
        action = 'restored_main_agent';
      } else if (active) {
        decisionReason = 'manual_phase_preserved';
      }
    }

    const receipt = {
      version: 1,
      sessionId: sessionId(ctx),
      promptDigest: promptDigest(task),
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
    pi.appendEntry(AUTOMATIC_ROUTING_STATE_TYPE, receipt);
    return receipt;
  }

  pi.on('before_agent_start', async (event, ctx) => {
    const routing = getRouting(await loadConfig(configPath));
    if (routing.mode === 'off') return undefined;

    const digest = promptDigest(event.prompt?.trim() || '[Image-only user prompt]');
    const key = `${sessionId(ctx)}:${digest}:${routing.mode}:${routing.fallback}:${routing.minConfidence}`;
    if (prepared?.key === key) {
      await prepared.promise;
      return undefined;
    }

    const promise = applyRoute(event, ctx, routing);
    prepared = { key, promise };
    try {
      await promise;
      return undefined;
    } catch (error) {
      if (prepared?.key === key) prepared = undefined;
      throw error;
    }
  });

  pi.on('agent_end', (_event, ctx) => {
    clearPreparation();
    // The session service owns completion/retry restoration.
    automaticPhase = automaticPhase && session.isActive(ctx);
  });
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_branch', 'session_shutdown']) {
    pi.on(event, () => {
      clearPreparation();
      automaticPhase = false;
    });
  }

  return {
    clearPreparation,
    get automaticPhase() { return automaticPhase; },
  };
}
