/** 本机操作 World 的定义：id / 默认配置 / 工具 / 面板配置 / 环境提示词。 */
import { fileURLToPath } from 'node:url';

import type { WorldDefinition } from 'cortico/world.ts';

import { cloneDefaults, missingDefaults, opsConfigGroups, resolveLimits, type OpsConfig } from './config.ts';
import { Ops, clearReadMemo } from './ops.ts';
import { seedConfigFile } from './seed.ts';
import { assertCoverage, buildTools, handlers, loadDescribe } from './tools.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

export type { OpsConfig } from './config.ts';

const DESCRIBE = loadDescribe();

/** 环境提示词模板：正文直接就是模板内容，本扩展不提供变量。 */
const ENV_PROMPT_PATH = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

export class OpsWorld implements World {
  readonly id = 'ops';
  private host: WorldHost | null = null;
  private readonly cfg: OpsConfig;
  private readonly ops: Ops;
  private readonly cache: ToolDef[];
  /** 补默认值的结果，留给 start() 记日志。 */
  private seedNote = '';

  constructor(opts: { cfg: OpsConfig; botDir?: string; persist?: (patch: unknown) => void }) {
    this.cfg = opts.cfg;
    this.ops = new Ops(() => resolveLimits(this.cfg));
    this.cache = buildTools(this.ops, DESCRIBE.tools, this.cfg);

    // 段已存在但缺项时自己补齐：内存立刻生效，文件也写回（内核只在整段缺失时种默认值）。
    const patch = missingDefaults(this.cfg);
    if (Object.keys(patch).length) {
      try {
        opts.persist?.(patch);
      } catch {
        /* 内核的 persist 在某些路径上只改内存，失败不影响内存对象本身 */
      }
      if (opts.botDir) {
        const seeded = seedConfigFile(opts.botDir, { worlds: { ops: patch } });
        this.seedNote = seeded.ok
          ? `补齐默认项：${seeded.added.join(', ') || '无'}`
          : `补齐默认项失败（${seeded.error ?? '未知原因'}），面板可能显示空值`;
      }
    }
  }

  /** 提示词正文直接来自 ENV_PROMPT.md，本扩展不提供变量。 */
  envPromptVars(): Record<string, string> | null {
    return {};
  }

  tools(): ToolDef[] {
    return this.cache;
  }

  webUi(_language: Language = 'zh'): WorldWebUiDecl {
    return {
      config: opsConfigGroups(),
      promptDocs: [
        {
          key: 'worlds.ops.envPrompt',
          title: '本机操作 · 环境提示词',
          description: '告诉 bot 什么时候用 ops_tree / ops_find / ops_patch / ops_batch，以及 [err E_XXX] 与 [effect unknown] 该怎么读。',
          path: ENV_PROMPT_PATH,
          role: 'envPrompt',
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
    if (this.seedNote) this.host?.log?.info?.(`本机操作：${this.seedNote}`);
    const limits = resolveLimits(this.cfg);
    this.host?.log?.info?.(
      `本机操作已就绪：${DESCRIBE.tools.length} 个工具；读 ${limits.readLines} 行 / 查 ${limits.findResults} 条`
        + ` / 命令 ${limits.shHead}+${limits.shTail} 行 / 抓取 ${limits.fetchChars} 字 / 转存阈值 ${limits.stashAt} 字`,
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
  create: (ctx) =>
    new OpsWorld({
      cfg: ctx.cfg as OpsConfig,
      botDir: ctx.botDir,
      persist: (patch) => ctx.persist(patch as never),
    }),
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
