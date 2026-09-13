# OMP Code Model

`omp-code-model` adds same-conversation coding phases to [OMP](https://github.com/can1357/oh-my-pi). The main model can hand implementation to a configured coding model, keep the complete conversation and tool state, then restore the original model for review.

![Code-model phase demonstration](demo/code-model-demo.gif)

## Flow

```text
main model
  → code-model start
  → configured coding model and effort
  → implementation and targeted checks
  → code-model finish
  → original model review
```

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

The model normally calls the `code-model` tool itself. `start` is a standalone tool call before implementation. `finish` is a standalone tool call after targeted checks. Tool approval remains governed by the active OMP approval policy.

## Reliability behaviour

The extension records the original model, configured effort selector and coding target before switching. It restores that snapshot at phase completion. A model or effort selection made through another OMP control becomes the retained selection. Automatic retry fallback metadata keeps restoration tied to the recorded main model.

An interrupted switch stores a recoverable phase marker. Session start, switch, tree and branch events inspect this marker and restore the recorded model state. The configuration writer uses an atomic rename and detects a concurrent menu update before saving.

## Development

Requires Node.js 22 or later.

```sh
npm test
npm run check
```

The test suite covers configuration integrity, full interactive menu flows, phase transitions, recovery, retry fallback, configured `auto`, extension registration and lifecycle completion.

## Upstream

The built-in OMP implementation and runtime API additions are tracked in [can1357/oh-my-pi#11997](https://github.com/can1357/oh-my-pi/pull/11997). This repository keeps the feature installable as a focused extension and records the demonstration assets.

## Licence

MIT
