/** ops_image：读本机图片文件，字节随回执附上；配了看图模型时顺带生成文字描述。 */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import type { BlobInput, ToolOutcome } from 'cortico/core/types.ts';

import { resolveLimits, type OpsLimits } from './config.ts';
import { resolvePath } from './paths.ts';
import { clip, err, ok } from './text.ts';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};

const VISION_TIMEOUT_MS = 60_000;
const VISION_MAX_TOKENS = 600;
const VISION_DESC_CHARS = 400;
const VISION_PROMPT = '用中文简洁描述这张图片的内容，150 字以内，直接给描述正文。';

function mimeOf(abs: string): string | null {
  const dot = abs.lastIndexOf('.');
  const ext = dot >= 0 ? abs.slice(dot).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? null;
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Loaded {
  blob: BlobInput;
  info: string;
}

/** 读一张图；成功返回 blob 与摘要行，失败返回错误文案。 */
function loadOne(raw: string, limits: OpsLimits): { loaded?: Loaded; error?: string } {
  if (!raw.trim()) return { error: err('E_INPUT', 'path 不能为空', '给一个图片文件绝对路径') };
  const abs = resolvePath(raw);
  const mime = mimeOf(abs);
  if (!mime) {
    return {
      error: err('E_MIME', `${abs} 不是认识的图片扩展名`, `支持 ${Object.values(MIME_BY_EXT).join(' / ')}`),
    };
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch (e) {
    return { error: err('E_PATH', `${abs} 读不到：${String((e as Error).message ?? e)}`, '确认路径存在且是文件') };
  }
  if (!stat.isFile()) return { error: err('E_PATH', `${abs} 不是文件`, '给图片文件的完整路径') };
  if (stat.size > limits.imageMaxMb * 1024 * 1024) {
    return {
      error: err('E_BIG', `${abs} 是 ${mb(stat.size)}，超过单张上限 ${mb(limits.imageMaxMb * 1024 * 1024)}`, '先压缩或转成小图再给'),
    };
  }
  try {
    const data = readFileSync(abs);
    const kb = Math.round(data.byteLength / 1024);
    return {
      loaded: {
        blob: {
          bytes: data,
          mime,
          name: basename(abs),
          fallbackText: `附上本机图片 ${abs}（${kb} KB，${mime}）`,
        },
        info: `${abs}（${kb} KB，${mime}）`,
      },
    };
  } catch (e) {
    return { error: err('E_READ', `${abs} 读不进去：${String((e as Error).message ?? e)}`) };
  }
}

/** chat/completions 的 content 可能是字符串也可能是分段数组，统一拼成文本。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .join('')
      .trim();
  }
  return '';
}

/** 调看图模型给一张图生成描述；失败返回错误文案，不抛。 */
async function describeImage(blob: BlobInput, limits: OpsLimits): Promise<string> {
  // 密钥优先级：面板填的 > 环境变量 OPS_VISION_KEY；都不想落盘的话用环境变量。
  const key = limits.visionKey || process.env.OPS_VISION_KEY || '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const body = {
    model: limits.visionModel,
    max_tokens: VISION_MAX_TOKENS,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${blob.mime};base64,${Buffer.from(blob.bytes).toString('base64')}` } },
        ],
      },
    ],
  };
  try {
    const res = await fetch(`${limits.visionBaseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
    if (!res.ok) return `看图失败（HTTP ${res.status}）`;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = contentText(data.choices?.[0]?.message?.content);
    return text || '看图失败（返回里没有描述文本）';
  } catch (e) {
    return `看图失败（${String((e as Error).message ?? e).slice(0, 120)}）`;
  }
}

export async function imageOp(args: Record<string, unknown>, limits: OpsLimits = resolveLimits()): Promise<string | ToolOutcome> {
  const singles = Array.isArray(args.paths)
    ? (args.paths as unknown[]).map((p) => String(p)).filter((p) => p.trim())
    : [];
  const single = String(args.path ?? '').trim();
  const dedup = [...new Set(single ? [single, ...singles] : singles)];
  if (dedup.length === 0) {
    return err('E_INPUT', 'path 不能为空', '给一个图片文件绝对路径；多张可给 paths 数组');
  }
  if (dedup.length > limits.imageMaxFiles) {
    return err('E_INPUT', `一次最多 ${limits.imageMaxFiles} 张，收到 ${dedup.length}`, '分几次读，或挑重要的先看');
  }

  const loaded: Loaded[] = [];
  const failures: string[] = [];
  let total = 0;
  for (const raw of dedup) {
    const r = loadOne(raw, limits);
    if (r.error) {
      failures.push(r.error);
      continue;
    }
    const item = r.loaded!;
    const maxTotal = limits.imageMaxTotalMb * 1024 * 1024;
    if (total + item.blob.bytes.byteLength > maxTotal) {
      failures.push(err('E_BIG', `累计已带 ${mb(total)}，${raw} 没附上（总量上限 ${mb(maxTotal)}）`, '分几次读'));
      continue;
    }
    total += item.blob.bytes.byteLength;
    loaded.push(item);
  }

  const parts: string[] = [];
  if (loaded.length > 0) parts.push(ok('image', `附上 ${loaded.length} 张图片：\n${loaded.map((l) => l.info).join('\n')}`));
  if (failures.length > 0) parts.push(failures.join('\n'));

  // 配了看图模型（模型名 + 接口地址都非空）就逐张生成文字描述；失败不挡附图。
  if (loaded.length > 0 && limits.visionModel && limits.visionBaseUrl) {
    const descriptions = await Promise.all(loaded.map((l) => describeImage(l.blob, limits)));
    parts.push(...descriptions.map((d, i) => `[vision] ${loaded[i].info}：${clip(d, VISION_DESC_CHARS).text}`));
  }

  if (loaded.length === 0) return parts.join('\n');
  return { text: parts.join('\n'), blobs: loaded.map((l) => l.blob) };
}
