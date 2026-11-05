/** 可调参数：默认值、上下限、面板声明与提示词正文。cfg 是 worlds.ops 的活引用，改了即时生效。 */
import { readFileSync } from 'node:fs';

import type { ConfigGroup, ConfigProperty } from 'cortico/core/config-schema.ts';

export interface OpsConfig {
  enabled?: boolean;
  read?: { lines?: number; bytes?: number };
  find?: { maxResults?: number };
  sh?: { head?: number; tail?: number };
  fetch?: { chars?: number };
  result?: { stashAt?: number; page?: number };
  envPrompt?: 'full' | 'short' | 'off';
}

/** 解析后的生效值；缺项回落到默认。 */
export interface OpsLimits {
  readLines: number;
  readBytes: number;
  findResults: number;
  shHead: number;
  shTail: number;
  fetchChars: number;
  stashAt: number;
  resultPage: number;
}

export const OPS_DEFAULTS = {
  read: { lines: 100, bytes: 8_000 },
  find: { maxResults: 30 },
  sh: { head: 60, tail: 20 },
  fetch: { chars: 3_500 },
  result: { stashAt: 4_000, page: 3_000 },
  envPrompt: 'full' as const,
};

/** 深拷贝默认值：内核会把 defaults() 的返回值当活配置写，共享引用会被就地改掉。 */
export function cloneDefaults(): OpsConfig {
  return JSON.parse(JSON.stringify(OPS_DEFAULTS)) as OpsConfig;
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
};

/** 从活配置读出生效限制；越界一律夹紧，坏值回落默认。 */
export function resolveLimits(cfg: OpsConfig | undefined): OpsLimits {
  const c = cfg ?? {};
  const d = OPS_DEFAULTS;
  return {
    readLines: clamp(c.read?.lines, 20, 2_000, OPS_DEFAULTS.read.lines),
    readBytes: clamp(c.read?.bytes, 1_000, 64_000, OPS_DEFAULTS.read.bytes),
    findResults: clamp(c.find?.maxResults, 5, 500, OPS_DEFAULTS.find.maxResults),
    shHead: clamp(c.sh?.head, 10, 300, OPS_DEFAULTS.sh.head),
    shTail: clamp(c.sh?.tail, 5, 100, OPS_DEFAULTS.sh.tail),
    fetchChars: clamp(c.fetch?.chars, 500, 30_000, OPS_DEFAULTS.fetch.chars),
    stashAt: clamp(c.result?.stashAt, 1_000, 20_000, OPS_DEFAULTS.result.stashAt),
    resultPage: clamp(c.result?.page, 500, 12_000, OPS_DEFAULTS.result.page),
  };
}

/**
 * 面板里的「本机操作」一组。
 *
 * 键必须写成 **从配置根算起的完整点分路径**（`worlds.ops.read.lines`）：
 * WebUI 是按这些键在整份 config 上取值/写回的，写成 `read.lines` 会取到 undefined，
 * 面板就显示 0 / 空串。
 */
export function opsConfigGroup(): ConfigGroup {
  return {
    id: 'ops',
    owner: 'world:ops',
    schema: {
      type: 'object',
      title: '本机操作',
      description: '这些数字决定每次工具调用吐多少字。调小能省上下文，调大能一次看更多；改完即时生效。',
      properties: withWorldPrefix({
        'read.lines': {
          type: 'integer',
          title: '默认读多少行',
          description: 'ops_read 不给 limit 时用这个；上限仍是 2000。',
          minimum: 20,
          maximum: 2_000,
          'x-suffix': '行',
          'x-hot': true,
        },
        'read.bytes': {
          type: 'integer',
          title: '单次读多少字节',
          description: 'ops_read 不给 maxBytes 时用这个；到上限就截断并给 next 指针。',
          minimum: 1_000,
          maximum: 64_000,
          'x-suffix': 'B',
          'x-hot': true,
        },
        'find.maxResults': {
          type: 'integer',
          title: '查找默认条数',
          description: 'ops_find 不给 maxResults 时用这个；分页靠 cursor 继续。',
          minimum: 5,
          maximum: 500,
          'x-suffix': '条',
          'x-hot': true,
        },
        'sh.head': {
          type: 'integer',
          title: '命令输出留头',
          description: 'ops_sh 保留开头多少行；中间省略的部分可以用 filter 捞。',
          minimum: 10,
          maximum: 300,
          'x-suffix': '行',
          'x-hot': true,
        },
        'sh.tail': {
          type: 'integer',
          title: '命令输出留尾',
          description: 'ops_sh 保留末尾多少行；报错信息通常在这里。',
          minimum: 5,
          maximum: 100,
          'x-suffix': '行',
          'x-hot': true,
        },
        'fetch.chars': {
          type: 'integer',
          title: '抓网页默认字数',
          description: 'ops_fetch 不给 maxChars 时用这个；网页正文通常几千字就够读。',
          minimum: 500,
          maximum: 30_000,
          'x-suffix': '字',
          'x-hot': true,
        },
        'result.stashAt': {
          type: 'integer',
          title: '超过多少字转存',
          description: '回执超过这个长度就压成「头尾摘要 + [ref]」，全文留在扩展内存里，用 ops_result 取回。调大＝更多内容直进上下文。',
          minimum: 1_000,
          maximum: 20_000,
          'x-suffix': '字',
          'x-hot': true,
        },
        'result.page': {
          type: 'integer',
          title: 'ops_result 单次取多少字',
          description: '按 ref 取回长回执时默认给多少字；分页用 offset。',
          minimum: 500,
          maximum: 12_000,
          'x-suffix': '字',
          'x-hot': true,
        },
        envPrompt: {
          type: 'string',
          title: '环境提示词',
          description:
            'full＝完整用法约定；short＝只留几条要点；off＝整段不注入（省 token，但模型可能不知道优先用 ops_batch）。',
          enum: ['full', 'short', 'off'],
          'x-hot': true,
        },
        }),
    },
  };
}

/** 给每个键加上 `worlds.ops.` 前缀：面板是按完整路径取值与写回的。 */
function withWorldPrefix(props: Record<string, ConfigProperty>): Record<string, ConfigProperty> {
  const out: Record<string, ConfigProperty> = {};
  for (const [key, value] of Object.entries(props)) out[`worlds.ops.${key}`] = value;
  return out;
}

/** 提示词正文：按配置选完整版或精简版。 */
export function promptBody(mode: OpsConfig['envPrompt']): string {
  const file = mode === 'short' ? 'ENV_PROMPT_SHORT.md' : 'ENV_PROMPT_FULL.md';
  try {
    return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 只挑出配置里缺的叶子项，拼成一份补丁。
 *
 * 为什么需要：内核 `world.ts:128` 用的是 `worlds[def.id] ??= {...def.defaults()}`，
 * 只对「整段不存在」补默认值；已经写成 `{"enabled": true}` 的段不会补，于是面板一片空。
 * 激活时由 World 自己把缺的补上（`ctx.persist`），老部署也能自愈。
 */
export function missingDefaults(cfg: OpsConfig | undefined): Record<string, unknown> {
  const c = cfg ?? {};
  const patch: Record<string, unknown> = {};

  const put = (group: string, key: string, value: unknown, current: unknown): void => {
    if (current === undefined || current === null) {
      const bucket = (patch[group] ??= {}) as Record<string, unknown>;
      bucket[key] = value;
    }
  };

  put('read', 'lines', OPS_DEFAULTS.read.lines, c.read?.lines);
  put('read', 'bytes', OPS_DEFAULTS.read.bytes, c.read?.bytes);
  put('find', 'maxResults', OPS_DEFAULTS.find.maxResults, c.find?.maxResults);
  put('sh', 'head', OPS_DEFAULTS.sh.head, c.sh?.head);
  put('sh', 'tail', OPS_DEFAULTS.sh.tail, c.sh?.tail);
  put('fetch', 'chars', OPS_DEFAULTS.fetch.chars, c.fetch?.chars);
  put('result', 'stashAt', OPS_DEFAULTS.result.stashAt, c.result?.stashAt);
  put('result', 'page', OPS_DEFAULTS.result.page, c.result?.page);

  if (c.envPrompt === undefined || c.envPrompt === null || (c.envPrompt as string) === '') {
    patch.envPrompt = OPS_DEFAULTS.envPrompt;
  }
  return patch;
}
