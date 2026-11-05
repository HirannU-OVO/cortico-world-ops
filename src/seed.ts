/**
 * 配置落盘兜底。
 *
 * 事实：内核给 World 的 `ctx.persist()` 在当前启动路径上只改内存对象、不写 `config.json`
 * （实测：面板拿到 8000，文件里没有）。而内核只在 `worlds.<id>` 整段缺失时写 `defaults()`，
 * 段存在但缺项时不会补。于是新增配置项在老部署里会一直缺值——这里由扩展自己补：
 * 原子写回（临时文件 + rename），只合并缺失项，绝不动用户已改的值与其它字段。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SeedResult {
  ok: boolean;
  path: string;
  /** 实际写进去的键（点分），用于日志。 */
  added: string[];
  error?: string;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  const added: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
    const current = target[key];
    if (isObject) {
      const bucket = (current !== null && typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : ((target[key] = {}) as Record<string, unknown>));
      for (const sub of deepMerge(bucket, value as Record<string, unknown>)) added.push(`${key}.${sub}`);
      continue;
    }
    if (current === undefined || current === null) {
      target[key] = value;
      added.push(key);
    }
  }
  return added;
}

/**
 * 把缺项合并进 `botDir/config.json`。
 * patch 的形状与 config 根一致，例如 `{ worlds: { ops: { read: { lines: 100 } } } }`。
 */
export function seedConfigFile(botDir: string, patch: Record<string, unknown>): SeedResult {
  const path = join(botDir, 'config.json');
  if (!Object.keys(patch).length) return { ok: true, path, added: [] };
  if (!existsSync(path)) return { ok: false, path, added: [], error: '找不到 config.json' };

  let root: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, path, added: [], error: 'config.json 根不是对象，拒绝写回' };
    }
    root = parsed as Record<string, unknown>;
  } catch (e) {
    return { ok: false, path, added: [], error: `config.json 解析失败：${String((e as Error)?.message ?? e)}` };
  }

  const added = deepMerge(root, patch);
  if (!added.length) return { ok: true, path, added: [] };

  const tmp = `${path}.tmp-seed-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
    return { ok: true, path, added };
  } catch (e) {
    return { ok: false, path, added: [], error: `写回失败：${String((e as Error)?.message ?? e)}` };
  }
}
