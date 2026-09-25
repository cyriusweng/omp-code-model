import codeModelToolPrompt from '../prompts/code-model-tool.md' with { type: 'text' };
import { runCodeModel } from './model-menu.mjs';
import { installSessionMode } from './session-mode.mjs';
import { createRoutingAdvisor } from './routing.mjs';
import { installAutomaticRouting } from './automatic-routing.mjs';

export default function codeModelExtension(pi, options = {}) {
  const session = installSessionMode(pi, options);
  const advisor = createRoutingAdvisor(pi, options);
  const automatic = installAutomaticRouting(pi, {
    advisor,
    session,
    configPath: options.configPath,
  });

  pi.registerTool({
    name: 'code-model',
    label: 'Code Phase Model',
    loadMode: 'essential',
    approval: 'exec',
    description: codeModelToolPrompt.trim(),
    parameters: pi.zod.object({
      action: pi.zod.enum(['recommend', 'start', 'finish', 'status']).default('status'),
      task: pi.zod.string().optional(),
      allowSubagent: pi.zod.boolean().default(false),
      useJev: pi.zod.boolean().default(true),
      effort: pi.zod.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']).optional(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const action = ['recommend', 'start', 'finish', 'status'].includes(params?.action)
        ? params.action
        : 'status';
      const result = action === 'recommend'
        ? await advisor.recommend({
          task: params?.task,
          allowSubagent: params?.allowSubagent === true,
          useJev: params?.useJev !== false,
        }, ctx, signal)
        : await session.run(action, ctx, signal, { effort: params?.effort });
      if (action === 'status') {
        result.automaticRouting = automatic.currentReceipt(ctx);
        if (result.automaticRouting) {
          result.message += `\nCurrent turn automatic routing receipt\n${JSON.stringify(result.automaticRouting)}`;
        }
      }
      return { content: [{ type: 'text', text: result.message }], details: result };
    },
  });

  pi.registerCommand('code-model', {
    description: 'Configure the coding provider, model, effort and automatic Jev routing; use recommend, start, finish or status for phase control.',
    async handler(args, ctx) {
      const action = args.trim();
      try {
        if (action === 'recommend' || action.startsWith('recommend ')) {
          const task = action.slice('recommend'.length).trim();
          const result = await advisor.recommend({ task, allowSubagent: false, useJev: true }, ctx);
          ctx.ui.notify(result.message, 'info');
          return;
        }
        if (action !== 'start' && action !== 'finish' && action !== 'status') {
          await runCodeModel(args, ctx, options);
          return;
        }
        if (action !== 'status' && !ctx.isIdle()) {
          throw new Error('Wait for the active model call to settle; in-flight phase switches use the code-model tool.');
        }
        const result = await session.run(action, ctx);
        if (action !== 'finish') ctx.ui.notify(result.message, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
