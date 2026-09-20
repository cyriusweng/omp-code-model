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

    let action = routing.mode === 'observe' ? 'observed' : 'kept_main_agent';
    if (routing.mode === 'enforce' && recommendation.route === 'code_model') {
      const transition = await session.run('start', ctx, undefined, { effort: recommendation.effort });
      automaticPhase = transition.changed || automaticPhase;
      action = transition.changed ? 'entered_code_model' : 'kept_code_model';
    } else if (routing.mode === 'enforce' && automaticPhase && session.isActive(ctx)) {
      await session.run('finish', ctx);
      automaticPhase = false;
      action = 'restored_main_agent';
    }

    const receipt = {
      version: 1,
      sessionId: sessionId(ctx),
      promptDigest: promptDigest(task),
      recordedAt: new Date().toISOString(),
      mode: routing.mode,
      fallback: routing.fallback,
      route: recommendation.route,
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
    const key = `${sessionId(ctx)}:${digest}:${routing.mode}:${routing.fallback}`;
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

  pi.on('agent_end', () => {
    clearPreparation();
    automaticPhase = false;
  });
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_branch', 'session_shutdown']) {
    pi.on(event, clearPreparation);
  }

  return {
    clearPreparation,
    get automaticPhase() { return automaticPhase; },
  };
}
