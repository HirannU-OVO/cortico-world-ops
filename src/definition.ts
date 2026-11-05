/** 本机操作 World 的定义：id / 默认配置 / 工具描述 / 环境提示词。 */
import { fileURLToPath } from 'node:url';

import type { WorldDefinition } from 'cortico/world.ts';

import { Ops, clearReadMemo } from './ops.ts';
import { assertCoverage, buildTools, handlers, loadDescribe } from './tools.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

export type OpsConfig = Record<string, never>;

const DESCRIBE = loadDescribe();

/** 告诉 bot 怎么用这几把工具的那段环境提示词；放在包里随版本走。 */
const ENV_PROMPT_PATH = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export class OpsWorld implements World {
  readonly id = 'ops';
  private host: WorldHost | null = null;
  private readonly ops = new Ops();
  private readonly cache: ToolDef[];

  constructor(readonly opts: { dataDir: string; timezone: string }) {
    this.cache = buildTools(this.ops, DESCRIBE.tools);
  }

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return this.cache;
  }

  webUi(_language: Language = 'zh'): WorldWebUiDecl {
    return {
      config: [],
      promptDocs: [
        {
          key: 'worlds.ops.envPrompt',
          title: '本机操作 · 环境提示词',
          description: '告诉 bot 什么时候用 ops_tree / ops_find / ops_patch / ops_batch，以及回执里 [err E_XXX] 与 [effect unknown] 该怎么读。',
          path: ENV_PROMPT_PATH,
          role: 'envPrompt',
          vars: [],
        },
      ],
    } as WorldWebUiDecl;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    clearReadMemo();
    const problems = assertCoverage(DESCRIBE.tools, handlers(this.ops));
    if (problems.length) {
      this.host?.log?.warn?.(`本机操作：describe.json 与实现不一致 —— ${problems.join('；')}`);
    }
    this.host?.log?.info?.(`本机操作已就绪：${DESCRIBE.tools.map((t) => t.name).join(' / ')}`);
  }

  async stop(): Promise<void> {
    clearReadMemo();
    this.host = null;
  }
}

export const OPS: WorldDefinition<OpsConfig> = {
  id: 'ops',
  label: '本机操作',
  defaults: () => ({} as OpsConfig),
  create: (ctx) => new OpsWorld({ dataDir: ctx.dataDir, timezone: ctx.timezone }),
  describe: {
    // describe.json 就是发给模型的 schema，原样透传，不再二次加工。
    tools: DESCRIBE.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      tags: t.tags,
    })),
    events: [],
  },
};
