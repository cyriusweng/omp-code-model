import { createHash } from 'node:crypto';
import { getModelEfforts, getRouting, getSelection, loadConfig } from './configuration.mjs';

export const ROUTING_STATE_TYPE = 'omp-code-model-routing-v1';
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

const EFFORT_CRITERIA = {
  minimal: 'Mechanical changes with an explicit procedure and very small reasoning burden.',
  low: 'Small, local implementation with straightforward checks.',
  medium: 'Several connected edits requiring ordinary design and verification.',
  high: 'Cross-file implementation requiring careful design, edge cases and targeted tests.',
  xhigh: 'Complex or risky work requiring deep reasoning and extensive verification.',
  max: 'Exceptional complexity, ambiguity or risk where maximum reasoning is justified.',
  auto: 'Use the selected model provider default.',
};

const ROUTE_CRITERIA = {
  main_agent: 'Keep the current main model for tightly coupled, small or review-heavy work where switching adds little value.',
  code_model: 'Enter the configured same-conversation coding phase for sustained implementation and targeted checks.',
  subagent: 'Delegate a separable workstream only when the user has explicitly authorised subagent use.',
};

function currentModel(ctx) {
  return ctx.models?.current?.() ?? ctx.model;
}

function availableModels(ctx) {
  return ctx.models?.list?.() ?? ctx.modelRegistry?.getAvailable?.() ?? [];
}

function findModel(ctx, target) {
  return availableModels(ctx).find(model => model.provider === target.provider && model.id === target.model) ??
    ctx.modelRegistry?.find?.(target.provider, target.model);
}

function modelIsEligible(model) {
  return Boolean(model && model.input?.includes('text') !== false &&
    model.supportsTools !== false && model.toolUse !== false);
}

function modelFamily(modelId) {
  const id = modelId.toLowerCase();
  if (id.includes('gemini')) return 'google';
  if (id.includes('claude')) return 'anthropic';
  if (/^(gpt|o\d|chatgpt)/.test(id) || id.includes('openai')) return 'openai';
  return undefined;
}

function relevantLimits(report, modelId) {
  const limits = Array.isArray(report?.limits) ? report.limits : [];
  const family = modelFamily(modelId);
  if (!family) return limits;
  const matched = limits.filter(limit => String(limit?.id ?? '').includes(`:${family}:`));
  return matched.length ? matched : limits;
}

export function summarizeQuota(payload, provider, modelId) {
  const report = payload?.reports?.find?.(item => item?.provider === provider);
  if (!report) {
    return { state: 'unknown', source: 'omp-usage', reason: 'provider_report_absent', limits: [] };
  }

  const limits = relevantLimits(report, modelId).map(limit => ({
    id: typeof limit?.id === 'string' ? limit.id : undefined,
    label: typeof limit?.label === 'string' ? limit.label : undefined,
    window: typeof limit?.window?.id === 'string' ? limit.window.id : undefined,
    remainingFraction: Number.isFinite(limit?.amount?.remainingFraction)
      ? limit.amount.remainingFraction
      : undefined,
    status: typeof limit?.status === 'string' ? limit.status : undefined,
    resetsAt: Number.isFinite(limit?.window?.resetsAt) ? limit.window.resetsAt : undefined,
  }));
  const remaining = limits
    .map(limit => limit.remainingFraction)
    .filter(value => Number.isFinite(value));
  const minimumRemainingFraction = remaining.length ? Math.min(...remaining) : undefined;
  const blocked = report?.metadata?.allowed === false || report?.metadata?.limitReached === true ||
    (minimumRemainingFraction !== undefined && minimumRemainingFraction <= 0);
  const confirmed = minimumRemainingFraction !== undefined || report?.metadata?.allowed === true;

  return {
    state: blocked ? 'exhausted' : confirmed ? 'available' : 'unknown',
    source: 'omp-usage',
    minimumRemainingFraction,
    reason: blocked ? 'reported_capacity_exhausted' : confirmed ? 'reported_capacity_available' : 'capacity_fields_absent',
    limits,
  };
}

function unknownQuota(reason) {
  return { state: 'unknown', source: 'omp-usage', reason, limits: [] };
}

function safeUsage(usage) {
  return {
    inputTokens: Number.isInteger(usage?.input_tokens) ? usage.input_tokens : undefined,
    outputTokens: Number.isInteger(usage?.output_tokens) ? usage.output_tokens : undefined,
  };
}

function taskDigest(task) {
  return createHash('sha256').update(task).digest('hex').slice(0, 16);
}

function makeSignal(signal, timeout) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function fallbackReason(error, signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('Routing was cancelled.');
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'typesafe_timeout';
  return 'typesafe_request_failed';
}

function validChoice(answer, choices) {
  return answer?.type === 'choice' && choices.includes(answer.choice) ? answer.choice : undefined;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'unknown';
}

export function formatRoutingRecommendation(result) {
  const selected = result.codeModel
    ? `${result.codeModel.provider}/${result.codeModel.model} · ${result.effort}`
    : 'unconfigured';
  const confidence = Number.isFinite(result.judgment.confidence)
    ? ` · confidence ${Math.round(result.judgment.confidence * 100)}%`
    : '';
  return `Recommended execution: ${result.route}; coding target: ${selected}; quota: ${result.quota.state} (${formatPercent(result.quota.minimumRemainingFraction)} remaining); judgment: ${result.judgment.backend}${confidence}. This recommendation is advisory; code-model start performs the explicit phase switch.`;
}

export function createRoutingAdvisor(pi, options = {}) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const ompBin = options.ompBin ?? process.env.OMP_BIN ?? 'omp';
  const requestTimeout = options.typesafeTimeout ?? 8_000;
  const commandTimeout = options.commandTimeout ?? 5_000;
  let cachedKey;
  const quotaCache = new Map();

  async function exec(args, signal) {
    if (typeof options.exec === 'function') return options.exec(ompBin, args, { signal, timeout: commandTimeout });
    if (typeof pi.exec === 'function') return pi.exec(ompBin, args, { signal, timeout: commandTimeout });
    return { code: 127, stdout: '', stderr: '', killed: false };
  }

  async function credential(signal) {
    const envKey = process.env.TYPESAFE_API_KEY?.trim();
    if (envKey) return { key: envKey, source: 'environment' };
    if (cachedKey) return { key: cachedKey, source: 'omp-token-store' };
    try {
      const result = await exec(['token', 'typesafe'], signal);
      const key = result.code === 0 ? result.stdout.trim() : '';
      if (key.length >= 10) {
        cachedKey = key;
        return { key, source: 'omp-token-store' };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return { key: undefined, source: 'absent' };
  }

  async function quota(provider, model, signal) {
    const cached = quotaCache.get(provider);
    const ttl = options.quotaCacheMs ?? 60_000;
    if (cached && Date.now() - cached.at < ttl) return cached.value;
    let value;
    try {
      const result = await exec(['usage', '--json', '--redact', '--provider', provider], signal);
      value = result.code === 0
        ? summarizeQuota(JSON.parse(result.stdout), provider, model)
        : unknownQuota('usage_command_failed');
    } catch (error) {
      if (signal?.aborted) throw error;
      value = unknownQuota(error instanceof SyntaxError ? 'usage_json_invalid' : 'usage_command_failed');
    }
    quotaCache.set(provider, { at: Date.now(), value });
    return value;
  }

  async function askJev(state, questions, key, signal) {
    const response = await fetchFn(TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
      signal: makeSignal(signal, requestTimeout),
    });
    if (!response.ok) {
      const error = new Error(`TypeSafe returned HTTP ${response.status}.`);
      error.code = `typesafe_http_${response.status}`;
      throw error;
    }
    const result = await response.json();
    if (!result || typeof result !== 'object' || !result.answers || typeof result.answers !== 'object') {
      throw new Error('TypeSafe returned an invalid response.');
    }
    return result;
  }

  async function recommend({
    task,
    allowSubagent = false,
    useJev = true,
    fallbackRoute,
  }, ctx, signal) {
    signal?.throwIfAborted();
    if (typeof task !== 'string' || !task.trim()) throw new Error('A task summary is required for routing.');
    const normalizedTask = task.trim().slice(0, 12_000);
    const config = await loadConfig(options.configPath);
    const configuredFallback = getRouting(config).fallback;
    const fallback = (fallbackRoute ?? configuredFallback) === 'code_model' ? 'code_model' : 'main_agent';
    const selected = getSelection(config);
    const configuredModel = selected ? findModel(ctx, selected) : undefined;
    const supportedEfforts = configuredModel ? getModelEfforts(configuredModel) : [];
    const codeModelEligible = Boolean(selected && modelIsEligible(configuredModel) &&
      supportedEfforts.includes(selected.reasoning));
    const quotaResult = selected
      ? await quota(selected.provider, selected.model, signal)
      : unknownQuota('coding_model_unconfigured');
    const routes = ['main_agent'];
    if (codeModelEligible && quotaResult.state !== 'exhausted') routes.push('code_model');
    if (allowSubagent) routes.push('subagent');

    let route = fallback === 'code_model' && routes.includes('code_model')
      ? 'code_model'
      : 'main_agent';
    let effort = selected?.reasoning;
    let judgment = {
      backend: 'deterministic',
      model: undefined,
      confidence: undefined,
      probabilities: undefined,
      usage: undefined,
      fallbackReason: useJev ? 'typesafe_credential_unavailable' : 'jev_disabled',
    };

    if (useJev && routes.length >= 2) {
      const auth = await credential(signal);
      if (auth.key) {
        const questions = {
          execution_path: {
            type: 'choice',
            instructions: 'Choose the execution path with the highest expected reliability per unit of total implementation, switching, checking and recovery cost.',
            criteria: Object.fromEntries(routes.map(value => [value, ROUTE_CRITERIA[value]])),
          },
        };
        if (routes.includes('code_model') && supportedEfforts.length >= 2) {
          questions.coding_effort = {
            type: 'choice',
            instructions: 'Choose the smallest supported effort that can reliably complete this coding task.',
            criteria: Object.fromEntries(supportedEfforts.map(value => [value, EFFORT_CRITERIA[value]])),
          };
        }
        const main = currentModel(ctx);
        const state = {
          task: normalizedTask,
          currentMainModel: main ? { provider: main.provider, model: main.id } : undefined,
          configuredCodeModel: selected,
          codeModelEligible,
          supportedEfforts,
          quota: quotaResult,
          subagentAuthorised: Boolean(allowSubagent),
          policy: 'The recommendation is advisory. A coding phase requires a later explicit code-model start call. Subagent use requires explicit user authorisation.',
        };
        try {
          const response = await askJev(state, questions, auth.key, signal);
          route = validChoice(response.answers.execution_path, routes) ?? route;
          effort = validChoice(response.answers.coding_effort, supportedEfforts) ?? effort;
          judgment = {
            backend: 'typesafe',
            model: typeof response.model === 'string' ? response.model : 'jev-latest',
            confidence: response.answers.execution_path?.confidence,
            probabilities: response.answers.execution_path?.probabilities,
            usage: safeUsage(response.usage),
            fallbackReason: undefined,
          };
        } catch (error) {
          judgment.fallbackReason = error?.code ?? fallbackReason(error, signal);
        }
      }
    } else if (useJev && routes.length < 2) {
      judgment.fallbackReason = quotaResult.state === 'exhausted'
        ? 'quota_exhausted'
        : codeModelEligible ? 'single_route_available' : 'coding_model_ineligible';
    }

    const result = {
      version: 1,
      route,
      effort,
      advisory: true,
      codeModel: selected,
      currentMainModel: currentModel(ctx)
        ? { provider: currentModel(ctx).provider, model: currentModel(ctx).id }
        : undefined,
      codeModelEligible,
      subagentAuthorised: Boolean(allowSubagent),
      fallbackRoute: fallback,
      quota: quotaResult,
      judgment,
    };
    const audit = {
      ...result,
      recordedAt: new Date().toISOString(),
      taskDigest: taskDigest(normalizedTask),
    };
    pi.appendEntry(ROUTING_STATE_TYPE, audit);
    return { ...result, message: formatRoutingRecommendation(result) };
  }

  return { recommend };
}
