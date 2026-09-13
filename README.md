# OMP Code Model

`omp-code-model` adds same-conversation coding phases to [OMP](https://github.com/can1357/oh-my-pi). The main model defines requirements and interfaces, hands implementation to a configured coding model, and returns for final review with the full history and tool state intact.

![Code-model phase demonstration](demo/code-model-demo.gif)

[Watch the complete accelerated MP4 recording](demo/code-model-demo.mp4).

## Flow

```text
main model
  → code-model start
  → configured coding model and effort
  → implementation and targeted checks
  → code-model finish
  → original model review
```

## Recorded cost example

The current demo records one complete task launched with `omp`. GPT-6-Astra plans the work, Gemini 3.8 Flash implements it in the coding phase, and GPT-6-Astra returns to inspect the diff and correct three issues.

| Model and role | Input | Output | Cache read | Recorded cost |
| --- | ---: | ---: | ---: | ---: |
| GPT-6-Astra · planning and final review | 136,367 | 12,085 | 1,627,136 | $3.595056 |
| Gemini 3.8 Flash · coding phase | 360,267 | 42,471 | 4,200,137 | $0.744477 |
| **Complete conversation** | **496,634** | **54,556** | **5,827,273** | **$4.339533** |

Applying GPT-6-Astra's listed rates to every observed token produces a price-normalised estimate of **$13.521413**. The recorded model split is **$9.181880 lower**, a **67.9% reduction** for the complete conversation. The coding phase alone costs 92.5% less at the recorded Gemini rates. This comparison holds token counts constant; an all-GPT run can follow a different execution path and produce a different token count.

The final review passed 63 repository tests, including 12 focused tests for the new command. [Machine-readable usage, rates and verification data](demo/session-cost.json) accompany the recording.

For a Chinese social post, use the [portrait cost card](demo/moments-zh.png) with the [ready-to-post Moments copy](demo/moments-zh.txt).

The extension provides:

- an essential `code-model` tool with `start`, `finish` and `status` actions;
- a `/code-model` menu for Provider → Model → Effort → Save configuration;
- persistent phase state in the session tree;
- restoration after completion, cancellation, retry fallback, session navigation and shutdown;
- English and Simplified Chinese menus selected from the current locale.

## Install

Install directly from GitHub:

```sh
omp plugin install github:cyriusweng/omp-code-model
```

Restart OMP after installation. Local development can use a link:

```sh
git clone https://github.com/cyriusweng/omp-code-model.git
omp plugin link ./omp-code-model
```

OMP 18.1.19 is the compatibility floor. OMP versions containing [oh-my-pi PR #11997](https://github.com/can1357/oh-my-pi/pull/11997) provide the awaited `session_before_idle` hook and exact fresh-session `auto` selector. OMP 18.1.19 uses the established `session_stop` and `agent_end` lifecycle paths.

## Configure

Open the interactive selector:

```text
/code-model
```

The menu presents providers and models from the active OMP catalogue. Selection is stored at:

```text
~/.omp/agent/code-model.json
```

`PI_CODING_AGENT_DIR` changes the active agent directory. `OMP_CODE_MODEL_CONFIG` can name a dedicated configuration file.

Useful commands:

```text
/code-model show
/code-model models
/code-model status
/code-model start
/code-model finish
```

The main model usually calls the `code-model` tool itself. `start` is a standalone tool call before implementation. `finish` is a standalone tool call after targeted checks. The active OMP approval policy continues to govern tool use.

## Reliability behaviour

The extension records the original model, configured effort selector and coding target before switching. It restores that snapshot at phase completion. A model or effort selection made through another OMP control becomes the retained selection. Automatic retry fallback metadata keeps restoration tied to the recorded main model.

An interrupted switch stores a recoverable phase marker. Session start, switch, tree and branch events inspect this marker and restore the recorded model state. The configuration writer uses an atomic rename and detects a concurrent menu update before saving.

## Session-cost reporting

`omp-session-cost` reads an OMP session JSONL file and groups input, output, cache-read and cache-write tokens, plus recorded costs, by provider and model. It also prints a total row.

### Usage

After installation, run:

```sh
omp-session-cost path/to/session.jsonl
```

Local repository checkouts can run:

```sh
npm run session-cost -- path/to/session.jsonl
```

For standard input:

```sh
cat path/to/session.jsonl | omp-session-cost -
```

### Options

- `-j, --json`: Print model rows and totals as JSON.
- `-h, --help`: Print usage information and exit codes.
- `--`: Treat the next argument as the file path, including a name that starts with `-`.

### Output format

The table uses aligned columns:

- `Provider`: The AI provider identifier.
- `Model`: The model name or identifier.
- `Input`: Billable input tokens.
- `Output`: Output and thinking tokens.
- `Cache Read`: Tokens read from provider prompt cache.
- `Cache Write`: Tokens written to provider prompt cache.
- `Cost (USD)`: The sum of recorded `usage.cost.total` values, displayed to six decimal places.
- `TOTAL`: Summary row aggregating the four token categories and recorded costs.

### Accounting scope and validation

The report reads every assistant `message` entry that carries usage and every auxiliary `model_usage` entry in the file. It groups historical branches by each entry's recorded `provider` and `model`. Costs are the sum of `usage.cost.total`. JSON output keeps JavaScript numeric precision; the table rounds costs to six decimal places.

The parser skips user messages, tool results, extension metadata and assistant messages without usage. To report a subagent session, supply its JSONL file. A header-only session produces a zero total.

Input must be UTF-8 JSONL with a session header containing an `id`; one title slot may precede the header. Blank lines and CRLF line endings are accepted. Usage records require provider and model strings, four non-negative safe-integer token fields, and a finite non-negative `usage.cost.total`. Parse and accounting errors include the source line on standard error. Output is written after the complete file passes validation.

### Exit codes

- `0`: Successful execution.
- `1`: Invocation error, missing arguments, or file access failure.
- `2`: Malformed session input, including invalid JSON syntax, missing session header, or corrupted usage records.

## Development

Requires Node.js 22 or later.

```sh
npm test
npm run check
```

The test suite covers configuration integrity, full interactive menu flows, phase transitions, recovery, retry fallback, configured `auto`, extension registration, lifecycle completion and fixture-backed session-cost aggregation and CLI behaviour.

## Upstream

The built-in OMP implementation and runtime API additions are tracked in [can1357/oh-my-pi#11997](https://github.com/can1357/oh-my-pi/pull/11997). This repository keeps the feature installable as a focused extension and records the demonstration assets.

## Licence

MIT
