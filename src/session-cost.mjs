const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite'];
const fields = [...tokenFields, 'cost'];
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isLabel = (value) => typeof value === 'string' && value.trim().length > 0 && !/\p{Cc}/u.test(value);
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export class MalformedSessionError extends Error {
  constructor(message, line) {
    super(`Line ${line}: ${message}`);
    this.name = 'MalformedSessionError';
    this.line = line;
  }
}

/** Aggregate recorded assistant and auxiliary usage across the complete JSONL file. */
export function aggregateSessionCost(text) {
  const groups = new Map();
  const total = zeroUsage();
  let headerSeen = false;
  let titleSeen = false;
  let lineNumber = 0;
  const fail = (message) => { throw new MalformedSessionError(message, lineNumber); };

  for (const line of text.split('\n')) {
    lineNumber += 1;
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      fail('invalid JSON syntax');
    }
    if (!isRecord(entry) || !isLabel(entry.type)) fail('expected an object with a non-empty type');

    if (entry.type === 'title') {
      if (headerSeen || titleSeen) fail('expected a single title slot before the session header');
      if (entry.v !== 1 || typeof entry.title !== 'string' || typeof entry.updatedAt !== 'string' ||
          typeof entry.pad !== 'string') fail('invalid title slot');
      titleSeen = true;
      continue;
    }
    if (!headerSeen) {
      if (entry.type !== 'session' || !isLabel(entry.id)) fail('expected a session header with an id');
      headerSeen = true;
      continue;
    }
    if (entry.type === 'session') fail('expected a single session header');

    let record;
    if (entry.type === 'message') {
      if (!isRecord(entry.message) || !isLabel(entry.message.role)) fail('expected a message object with a role');
      if (entry.message.role !== 'assistant' || entry.message.usage === undefined) continue;
      record = entry.message;
    } else if (entry.type === 'model_usage') {
      record = entry;
    } else {
      continue;
    }

    if (!isLabel(record.provider) || !isLabel(record.model)) fail('usage requires provider and model strings');
    const { usage } = record;
    if (!isRecord(usage)) fail('usage must be an object');
    for (const field of tokenFields) {
      if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) {
        fail(`usage.${field} must be a non-negative safe integer`);
      }
    }
    if (!isRecord(usage.cost) || !Number.isFinite(usage.cost.total) || usage.cost.total < 0) {
      fail('usage.cost.total must be a finite non-negative number');
    }

    const values = { ...usage, cost: usage.cost.total };
    const key = JSON.stringify([record.provider, record.model]);
    let row = groups.get(key);
    if (!row) {
      row = { provider: record.provider, model: record.model, ...zeroUsage() };
      groups.set(key, row);
    }
    for (const field of fields) {
      row[field] += values[field];
      total[field] += values[field];
      if (field === 'cost' ? !Number.isFinite(total[field]) : !Number.isSafeInteger(total[field])) {
        fail(`aggregate ${field} exceeds the supported numeric range`);
      }
    }
  }
  if (!headerSeen) fail('expected a session header with an id');

  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const rows = [...groups.values()].sort((a, b) => compare(a.provider, b.provider) || compare(a.model, b.model));
  return { rows, total };
}

/** Display token counts and recorded USD costs; rounding applies at presentation time. */
export function formatSessionCostTable({ rows, total }) {
  const headers = ['Provider', 'Model', 'Input', 'Output', 'Cache Read', 'Cache Write', 'Cost (USD)'];
  const cells = [...rows, { provider: 'TOTAL', model: '', ...total }].map((row) => [
    row.provider,
    row.model,
    ...tokenFields.map((field) => String(row[field])),
    row.cost.toFixed(6),
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...cells.map((row) => row[index].length)));
  const format = (row) => row.map((cell, i) => i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])).join('  ');
  return [format(headers), ...cells.map(format)].join('\n');
}
