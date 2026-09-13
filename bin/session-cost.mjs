#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { aggregateSessionCost, formatSessionCostTable, MalformedSessionError } from '../src/session-cost.mjs';

const help = `Usage: omp-session-cost [--json] [--] <session.jsonl | ->

Report input, output, cache-read, cache-write tokens and recorded USD cost.
Use '-' to read standard input. Use '--' before a filename starting with '-'.

Options:
  -j, --json  Print rows and total as JSON
  -h, --help  Show this help

Exit codes:
  0  Success
  1  Invocation or file access error
  2  Malformed session input
`;

async function main(args) {
  let json = false;
  let positional = false;
  const paths = [];
  for (const arg of args) {
    if (!positional && arg === '--') positional = true;
    else if (!positional && (arg === '--help' || arg === '-h')) {
      process.stdout.write(help);
      return;
    } else if (!positional && (arg === '--json' || arg === '-j')) json = true;
    else if (!positional && arg.startsWith('-') && arg !== '-') throw new Error('Unknown option; use --help.');
    else paths.push(arg);
  }
  if (paths.length !== 1) throw new Error('Provide exactly one session file path or stdin marker (-); use --help.');

  let bytes;
  if (paths[0] === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    bytes = Buffer.concat(chunks);
  } else {
    bytes = await readFile(paths[0]);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    process.stderr.write('omp-session-cost: malformed input: expected UTF-8 text.\n');
    process.exitCode = 2;
    return;
  }
  const summary = aggregateSessionCost(text);
  process.stdout.write(`${json ? JSON.stringify(summary, null, 2) : formatSessionCostTable(summary)}\n`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const malformed = error instanceof MalformedSessionError;
  process.stderr.write(`omp-session-cost: ${malformed ? 'malformed input: ' : ''}${error.message}\n`);
  process.exitCode = malformed ? 2 : 1;
}
