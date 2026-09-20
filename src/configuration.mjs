import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent');

export const CONFIG_PATH = process.env.OMP_CODE_MODEL_CONFIG || join(agentDir, 'code-model.json');
export const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);
export const ROUTING_MODES = new Set(['off', 'observe', 'enforce']);
export const ROUTING_FALLBACKS = new Set(['main_agent', 'code_model']);

export function emptyConfig() {
 return { defaultProfile: 'current', profiles: {} };
}

export function validateConfig(config) {
 if (!config || typeof config !== 'object' || Array.isArray(config)) {
  throw new Error('Coding tool configuration must be an object.');
 }
 if (!config.profiles || typeof config.profiles !== 'object' || Array.isArray(config.profiles)) {
  throw new Error('profiles must contain model configurations.');
 }
 for (const [name, value] of Object.entries(config.profiles)) {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || !value || typeof value !== 'object' ||
   typeof value.provider !== 'string' || !value.provider.trim() ||
   typeof value.model !== 'string' || !value.model.trim() || !EFFORTS.has(value.reasoning)) {
   throw new Error(`Profile ${name} requires valid provider, model, and reasoning settings.`);
  }
 }
 if (config.routing !== undefined) {
  if (!config.routing || typeof config.routing !== 'object' || Array.isArray(config.routing) ||
   !ROUTING_MODES.has(config.routing.mode) ||
   !ROUTING_FALLBACKS.has(config.routing.fallback)) {
   throw new Error('routing requires valid mode and fallback settings.');
  }
 }
 if (Object.keys(config.profiles).length > 0 && !Object.hasOwn(config.profiles, config.defaultProfile)) {
  throw new Error('defaultProfile must point to a configuration in profiles.');
 }
 return config;
}

export async function loadConfig(path = CONFIG_PATH) {
 try {
  return validateConfig(JSON.parse(await readFile(path, 'utf8')));
 } catch (error) {
  if (error?.code === 'ENOENT') return emptyConfig();
  throw error;
 }
}

export function getSelection(config) {
 const selected = config.profiles[config.defaultProfile];
 if (!selected) return undefined;
 const { provider, model, reasoning } = selected;
 return { provider, model, reasoning };
}

export function getRouting(config) {
 return {
  mode: config.routing?.mode ?? 'off',
  fallback: config.routing?.fallback ?? 'main_agent',
 };
}

export function getModelEfforts(model) {
 const supported = model?.reasoning ? model.thinking?.efforts ?? [] : [];
 const efforts = [...EFFORTS].filter(value => value !== 'auto' && supported.includes(value));
 return efforts.length ? efforts : ['auto'];
}

async function saveConfig(config, path) {
 const validated = validateConfig(config);
 await mkdir(dirname(path), { recursive: true });
 const temporary = `${path}.${randomUUID()}.tmp`;
 await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
 await rename(temporary, path);
 return validated;
}

export async function updateSelection(selection, { path = CONFIG_PATH, expectedConfig } = {}) {
 const config = await loadConfig(path);
 if (expectedConfig &&
  (JSON.stringify(config.profiles) !== JSON.stringify(expectedConfig.profiles) ||
   config.defaultProfile !== expectedConfig.defaultProfile)) {
  throw new Error('Coding model configuration was updated in another session, please reopen the menu.');
 }
 const { provider, model, reasoning } = selection;
 if (!provider || typeof provider !== 'string' || !provider.trim() ||
  !model || typeof model !== 'string' || !model.trim() ||
  !EFFORTS.has(reasoning)) {
  throw new Error('Valid provider, model, and reasoning are required.');
 }
 return saveConfig({
  ...config,
  defaultProfile: 'current',
  profiles: { current: { provider, model, reasoning } },
 }, path);
}

export async function updateRouting(routing, { path = CONFIG_PATH, expectedConfig } = {}) {
 const config = await loadConfig(path);
 if (expectedConfig && JSON.stringify(config) !== JSON.stringify(expectedConfig)) {
  throw new Error('Coding model configuration was updated in another session, please retry.');
 }
 if (!routing || !ROUTING_MODES.has(routing.mode) || !ROUTING_FALLBACKS.has(routing.fallback)) {
  throw new Error('Valid automatic routing mode and fallback are required.');
 }
 return saveConfig({ ...config, routing: { mode: routing.mode, fallback: routing.fallback } }, path);
}
