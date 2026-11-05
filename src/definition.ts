/** 本机操作 World 的定义：id / 默认配置 / 工具 / 面板配置 / 环境提示词。 */
import { fileURLToPath } from 'node:url';

import type { WorldDefinition } from 'cortico/world.ts';

import { cloneDefaults, missingDefaults, opsConfigGroup, promptBody, resolveLimits, type OpsConfig } from './config.ts';
import { Ops, clearReadMemo } from './ops.ts';
import { assertCoverage, buildTools, handlers, loadDescribe } from './tools.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

export type { OpsConfig } from './config.ts';

const DESCRIBE = loadDescribe();

/** 环境提示词模板：正文由 envPromptVars() 按配置填进 {{ops.body}}。 */
const ENV_PROMPT_PATH = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export class OpsWorld implements World {
  readonly id = 'ops';
  private host: WorldHost | null = null;
  private readonly cfg: OpsConfig;
  private readonly ops: Ops;
  private readonly cache: ToolDef[];

  constructor(opts: { cfg: OpsConfig }) {
    this.cfg = opts.cfg;
    // 每次调用现读 cfg，面板改完即时生效。
    this.ops = new Ops(() => resolveLimits(this.cfg));
    this.cache = buildTools(this.ops, DESCRIBE.tools, this.cfg);
  }

  /** off 时返回 null：内核会把本 World 的环境段整段省掉。 */
  envPromptVars(): Record<string, string> | null {
    const mode = this.cfg.envPrompt ?? 'full';
    if (mode === 'off') return null;
    const body = promptBody(mode);
    return body ? { 'ops.body': body } : null;
  }

  tools(): ToolDef[] {
    return this.cache;
  }

  webUi(_language: Language = 'zh'): WorldWebUiDecl {
    return {
      config: [opsConfigGroup()],
      promptDocs: [
        {
          key: 'worlds.ops.envPrompt',
          title: '本机操作 · 环境提示词',
          description: '告诉 bot 什么时候用 ops_tree / ops_find / ops_patch / ops_batch，以及 [err E_XXX] 与 [effect unknown] 该怎么读。',
          path: ENV_PROMPT_PATH,
          role: 'envPrompt',
          vars: [
            {
              name: 'ops.body',
              description: '按「环境提示词」配置填进来的正文：full 完整版、short 精简版；off 时整段不注入。',
            },
          ],
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
    const limits = resolveLimits(this.cfg);
    this.host?.log?.info?.(
      `本机操作已就绪：${DESCRIBE.tools.length} 个工具；读 ${limits.readLines} 行 / 查 ${limits.findResults} 条`
        + ` / 命令 ${limits.shHead}+${limits.shTail} 行 / 抓取 ${limits.fetchChars} 字 / 转存阈值 ${limits.stashAt} 字`
        + ` / 提示词 ${this.cfg.envPrompt ?? 'full'}`,
    );
  }

  async stop(): Promise<void> {
    clearReadMemo();
    this.host = null;
  }
}

export const OPS: WorldDefinition<OpsConfig> = {
  id: 'ops',
  label: '本机操作',
  defaults: () => cloneDefaults(),
  create: (ctx) => {
    // 已存在的 worlds.ops 段不会被自动补 defaults（内核只对缺失整段用 ??=），
    // 这里补上缺的叶子项，否则面板一片空值。
    const patch = missingDefaults(ctx.cfg as OpsConfig);
    if (Object.keys(patch).length) ctx.persist(patch as never);
    return new OpsWorld({ cfg: ctx.cfg as OpsConfig });
  },
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
