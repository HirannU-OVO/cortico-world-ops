/**
 * 工具声明与派发。
 *
 * 唯一的事实来源是 describe.json：发给模型的 schema 和这里派发的名字必须完全一致，
 * 所以不手写第二份声明，改为启动时校验覆盖率（见 assertCoverage）。
 */
import { readFileSync } from 'node:fs';

import type { ToolDef, ToolSpec } from 'cortico/core/types.ts';

import { gitOp } from './git.ts';
import { fetchUrl } from './net.ts';
import { Ops } from './ops.ts';
import { clearResultStore, readStashed, summarizeIfLong } from './results.ts';

export interface OpsDescribe {
  tools: ToolSpec[];
  events: unknown[];
}

/** 从包根读 describe.json（不依赖 import 断言，任何宿主都能跑）。 */
export function loadDescribe(): OpsDescribe {
  const file = new URL('../describe.json', import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as OpsDescribe;
}

type Handler = (args: Record<string, unknown>) => Promise<string> | string;

/** 工具名 → 实现。加工具时先改 describe.json，再在这里补一行。 */
export function handlers(ops: Ops): Record<string, Handler> {
  return {
    ops_read: (args) => ops.read(args),
    ops_write: (args) => ops.write(args),
    ops_patch: (args) => ops.patch(args),
    ops_find: (args) => ops.find(args),
    ops_tree: (args) => ops.tree(args),
    ops_git: (args) => gitOp(args),
    ops_fetch: (args) => fetchUrl(args),
    ops_sh: (args) => ops.sh(args),
    ops_batch: (args) => ops.batch(args),
    ops_result: (args) => readStashed(args),
  };
}

/** 校验 describe.json 与实现是否一一对应；返回不匹配描述，空数组表示一致。 */
export function assertCoverage(decls: readonly ToolSpec[], table: Record<string, Handler>): string[] {
  const declared = new Set(decls.map((d) => d.name));
  const implemented = new Set(Object.keys(table));
  const problems: string[] = [];
  for (const name of declared) if (!implemented.has(name)) problems.push(`describe 里有 ${name}，但没有实现`);
  for (const name of implemented) if (!declared.has(name)) problems.push(`实现了 ${name}，但 describe 里没有`);
  return problems;
}

/** 组装 ToolDef 列表。 */
export function buildTools(ops: Ops, decls: readonly ToolSpec[]): ToolDef[] {
  const table = handlers(ops);
  return decls.map((decl) => {
    const handler = table[decl.name];
    return {
      name: decl.name,
      description: decl.description,
      tags: decl.tags,
      parameters: decl.parameters,
      handler: async (args: Record<string, unknown>) => {
        if (!handler) return `[err E_UNWIRED] ${decl.name} 没有实现`;
        try {
          const out = await handler(args ?? {});
          // 长回执转存 + 摘要：历史里只留头尾，细节按需用 ops_result 取。
          return summarizeIfLong(String(out ?? ''), decl.name);
        } catch (e) {
          // 兜底：任何未预期异常都变成结构化回执，别把主循环带崩。
          const message = String((e as Error)?.message ?? e);
          return `[err E_INTERNAL] ${decl.name} 处理失败：${message}\n[effect unknown] 不确定有没有改动，重试前先读一遍确认`;
        }
      },
    } as ToolDef;
  });
}
