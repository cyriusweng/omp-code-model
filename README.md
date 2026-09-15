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

The recording and its machine-readable usage data remain in `demo/session-cost.json`.

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

OMP 18.2.0 is the compatibility target.

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

The extension records the original model and configured effort before entering a coding phase. A model or effort selected through another OMP control remains active when the phase ends. Retry fallback entries remain phase-owned so a repeated `start` keeps the original restoration target.

An interrupted switch stores a recoverable phase marker. Session lifecycle events restore recorded state, navigation waits for restoration, and the configuration writer uses an atomic rename with concurrent-update detection.

## Development

Requires Node.js 22 or later.

```sh
npm test
npm run check
```

The test suite covers configuration integrity, interactive menu flows, phase transitions, recovery, retry fallback, configured `auto`, extension registration and lifecycle completion.

## Licence

MIT
