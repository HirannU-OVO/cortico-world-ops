/**
 * 可调参数：面板声明、默认值、生效值解析与「缺失项自愈」。
 *
 * **唯一的定义来源是 `CONFIG_ITEMS`**：加一个配置项只改这张表，schema、默认值、
 * `defaults()`、缺失项补齐会一起跟上，不会再出现「加了项但面板没值」。
 *
 * 两条内核事实（决定了这里的写法）：
 * 1. 面板的键必须是**从 config 根算起的完整点分路径**（`worlds.ops.read.lines`），
 *    写成 `read.lines` 会取到 undefined，面板显示 0 / 空串（`build/cortico/src/world.ts` 的取值路径）。
 * 2. 内核只在 `worlds.<id>` **整段不存在**时才写 `defaults()`（`world.ts:128` 用 `??=`），
 *    段存在但缺项时不会补——所以要自己补（`missingDefaults` + `seedConfigFile`）。
 */
import type { ConfigGroup, ConfigProperty } from 'cortico/core/config-schema.ts';

export interface OpsConfig {
  enabled?: boolean;
  read?: { lines?: number; bytes?: number };
  find?: { maxResults?: number };
  sh?: { head?: number; tail?: number };
  fetch?: { chars?: number };
  result?: { stashAt?: number; page?: number };
  image?: {
    visionModel?: string;
    visionBaseUrl?: string;
    visionKey?: string;
    maxMb?: number;
    maxTotalMb?: number;
    maxFiles?: number;
  };
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
  visionModel: string;
  visionBaseUrl: string;
  visionKey: string;
  imageMaxMb: number;
  imageMaxTotalMb: number;
  imageMaxFiles: number;
}

interface ItemDef {
  /** `worlds.ops` 下的相对点分路径。 */
  path: string;
  /** 缺省值。 */
  fallback: number | string;
  /** 面板声明（键会自动补上 `worlds.ops.` 前缀）。 */
  schema: ConfigProperty;
}

const hot = { 'x-hot': true } as const;

/** 配置项总表：加项只改这里。 */
export const CONFIG_ITEMS: readonly ItemDef[] = [
  {
    path: 'read.lines',
    fallback: 100,
    schema: {
      type: 'integer',
      title: '默认读多少行',
      description: 'ops_read 不给 limit 时用这个；上限仍是 2000。',
      minimum: 20,
      maximum: 2_000,
      'x-suffix': '行',
      ...hot,
    },
  },
  {
    path: 'read.bytes',
    fallback: 8_000,
    schema: {
      type: 'integer',
      title: '单次读多少字节',
      description: 'ops_read 不给 maxBytes 时用这个；到上限就截断并给 next 指针。',
      minimum: 1_000,
      maximum: 64_000,
      'x-suffix': 'B',
      ...hot,
    },
  },
  {
    path: 'find.maxResults',
    fallback: 30,
    schema: {
      type: 'integer',
      title: '查找默认条数',
      description: 'ops_find 不给 maxResults 时用这个；分页靠 cursor 继续。',
      minimum: 5,
      maximum: 500,
      'x-suffix': '条',
      ...hot,
    },
  },
  {
    path: 'sh.head',
    fallback: 60,
    schema: {
      type: 'integer',
      title: '命令输出留头',
      description: 'ops_sh 保留开头多少行；中间省略的部分可以用 filter 捞。',
      minimum: 10,
      maximum: 300,
      'x-suffix': '行',
      ...hot,
    },
  },
  {
    path: 'sh.tail',
    fallback: 20,
    schema: {
      type: 'integer',
      title: '命令输出留尾',
      description: 'ops_sh 保留末尾多少行；报错信息通常在这里。',
      minimum: 5,
      maximum: 100,
      'x-suffix': '行',
      ...hot,
    },
  },
  {
    path: 'fetch.chars',
    fallback: 3_500,
    schema: {
      type: 'integer',
      title: '抓网页默认字数',
      description: 'ops_fetch 不给 maxChars 时用这个；网页正文通常几千字就够读。',
      minimum: 500,
      maximum: 30_000,
      'x-suffix': '字',
      ...hot,
    },
  },
  {
    path: 'result.stashAt',
    fallback: 4_000,
    schema: {
      type: 'integer',
      title: '超过多少字转存',
      description:
        '回执超过这个长度就压成「头尾摘要 + [ref]」，全文留在扩展内存里，用 ops_result 取回。调大＝更多内容直进上下文。',
      minimum: 1_000,
      maximum: 20_000,
      'x-suffix': '字',
      ...hot,
    },
  },
  {
    path: 'result.page',
    fallback: 3_000,
    schema: {
      type: 'integer',
      title: 'ops_result 单次取多少字',
      description: '按 ref 取回长回执时默认给多少字；分页用 offset。',
      minimum: 500,
      maximum: 12_000,
      'x-suffix': '字',
      ...hot,
    },
  },
  {
    path: 'image.visionModel',
    fallback: '',
    schema: {
      type: 'string',
      title: '看图模型',
      description:
        '留空＝不启用图生文。填 OpenAI 兼容接口的模型名（如 gpt-4o-mini）；启用后 ops_image 会把图片发给它，回执附带文字描述，主脑不支持视觉也能看图。',
    },
  },
  {
    path: 'image.visionBaseUrl',
    fallback: '',
    schema: {
      type: 'string',
      title: '看图接口地址',
      description: 'OpenAI 兼容接口的根地址（到 /v1 为止，如 https://api.openai.com/v1）；与看图模型同时填才生效。',
    },
  },
  {
    path: 'image.visionKey',
    fallback: '',
    schema: {
      type: 'string',
      title: '看图密钥',
      description: '看图接口的 API 密钥，以 Bearer 方式携带；不想把密钥写进配置文件就留空，改用环境变量 OPS_VISION_KEY。本地服务可不填。',
    },
  },
  {
    path: 'image.maxMb',
    fallback: 15,
    schema: {
      type: 'integer',
      title: '单张图片上限',
      description: 'ops_image 单张图最大多少 MB，超了直接拒绝。',
      minimum: 1,
      maximum: 100,
      'x-suffix': 'MB',
      ...hot,
    },
  },
  {
    path: 'image.maxTotalMb',
    fallback: 40,
    schema: {
      type: 'integer',
      title: '一次读图总量上限',
      description: 'ops_image 一次最多带多少 MB 的图，几张加起来超了就拒绝。',
      minimum: 1,
      maximum: 200,
      'x-suffix': 'MB',
      ...hot,
    },
  },
  {
    path: 'image.maxFiles',
    fallback: 6,
    schema: {
      type: 'integer',
      title: '一次读几张图',
      description: 'ops_image 的 paths 最多给几个，超了拒绝。',
      minimum: 1,
      maximum: 20,
      'x-suffix': '张',
      ...hot,
    },
  },
];

/** 按路径取叶子值（同内核 getByPath 语义）。 */
function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 按路径写叶子值，父对象不存在就建。 */
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  const leaf = segs.pop()!;
  let cur: Record<string, unknown> = root;
  for (const seg of segs) {
    const next = cur[seg];
    if (next === null || typeof next !== 'object') cur[seg] = {};
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[leaf] = value;
}

/** 某个配置项的默认值。 */
function defaultOf(path: string): number {
  const item = CONFIG_ITEMS.find((i) => i.path === path);
  return typeof item?.fallback === 'number' ? item.fallback : Number.NaN;
}

/** 深拷贝默认值：内核会把 defaults() 的返回值当活配置写，共享引用会被就地改掉。 */
export function cloneDefaults(): OpsConfig {
  const out: Record<string, unknown> = {};
  for (const item of CONFIG_ITEMS) setPath(out, item.path, item.fallback);
  return out as OpsConfig;
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), lo), hi);
};

/** 从活配置读出生效限制；越界一律夹紧，坏值回落默认。 */
export function resolveLimits(cfg: OpsConfig | undefined): OpsLimits {
  const c = cfg ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return {
    readLines: clamp(c.read?.lines, 20, 2_000, defaultOf('read.lines')),
    readBytes: clamp(c.read?.bytes, 1_000, 64_000, defaultOf('read.bytes')),
    findResults: clamp(c.find?.maxResults, 5, 500, defaultOf('find.maxResults')),
    shHead: clamp(c.sh?.head, 10, 300, defaultOf('sh.head')),
    shTail: clamp(c.sh?.tail, 5, 100, defaultOf('sh.tail')),
    fetchChars: clamp(c.fetch?.chars, 500, 30_000, defaultOf('fetch.chars')),
    stashAt: clamp(c.result?.stashAt, 1_000, 20_000, defaultOf('result.stashAt')),
    resultPage: clamp(c.result?.page, 500, 12_000, defaultOf('result.page')),
    visionModel: str(c.image?.visionModel),
    visionBaseUrl: str(c.image?.visionBaseUrl).replace(/\/+$/, ''),
    visionKey: str(c.image?.visionKey),
    imageMaxMb: clamp(c.image?.maxMb, 1, 100, defaultOf('image.maxMb')),
    imageMaxTotalMb: clamp(c.image?.maxTotalMb, 1, 200, defaultOf('image.maxTotalMb')),
    imageMaxFiles: clamp(c.image?.maxFiles, 1, 20, defaultOf('image.maxFiles')),
  };
}

/**
 * 面板配置组：按工具分成小组，键自动带上 `worlds.ops.` 前缀。
 * 分组是为了让普通用户扫一眼就知道每组管什么，不用在十几项里翻。
 */
export function opsConfigGroups(): ConfigGroup[] {
  const prop = (path: string): ConfigProperty => {
    const item = CONFIG_ITEMS.find((i) => i.path === path);
    if (!item) throw new Error(`CONFIG_ITEMS 里没有 ${path}`);
    return item.schema;
  };
  const group = (id: string, title: string, description: string, paths: string[]): ConfigGroup => {
    const properties: Record<string, ConfigProperty> = {};
    for (const path of paths) properties[`worlds.ops.${path}`] = prop(path);
    return {
      id,
      owner: 'world:ops',
      schema: { type: 'object', title, description, properties },
    };
  };
  return [
    group(
      'ops-read',
      '读文件与查找',
      '控制 ops_read / ops_find 每次吐多少内容：调小省上下文，调大一次看更多。',
      ['read.lines', 'read.bytes', 'find.maxResults'],
    ),
    group(
      'ops-shell',
      '命令与抓网页',
      '控制 ops_sh / ops_fetch 的输出长度：报错信息通常在末尾，留尾太小会看不到。',
      ['sh.head', 'sh.tail', 'fetch.chars'],
    ),
    group(
      'ops-result',
      '长回执转存',
      '工具回执太长时会自动压成「头尾摘要 + 引用」，这两项决定多长算长、取回时一次给多少。',
      ['result.stashAt', 'result.page'],
    ),
    group(
      'ops-image',
      '看图（ops_image）',
      '「看图模型」三项填了才会启用图生文（把图片发给它换文字描述）；下面三项决定一次能读多大的图。',
      ['image.visionModel', 'image.visionBaseUrl', 'image.visionKey', 'image.maxMb', 'image.maxTotalMb', 'image.maxFiles'],
    ),
  ];
}

/**
 * 挑出配置里缺的项，拼成补丁（形状是 `worlds.ops` 段内的相对结构）。
 *
 * 数字项只补 `undefined` / `null` / 空串（`0`、`false` 都算用户已设置，不覆盖）；
 * 字符串项以空串为合法值（如「看图模型」留空＝关闭），只有缺键才补。
 */
export function missingDefaults(cfg: OpsConfig | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const item of CONFIG_ITEMS) {
    const current = getPath(cfg ?? {}, item.path);
    const absent = current === undefined || current === null
      || (typeof item.fallback === 'number' && current === '');
    if (absent) setPath(patch, item.path, item.fallback);
  }
  return patch;
}
