/** ops_fetch：抓网页或接口。HTML 剥正文、JSON 格式化、支持自定义方法与请求头。 */
import { clip, err, ok, oneLine } from './text.ts';

const FETCH_DEFAULT_CHARS = 6_000;
const FETCH_MAX_CHARS = 30_000;
const FETCH_MAX_BYTES = 8 * 1024 * 1024;
const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** 从 content-type 或 HTML meta 里猜字符集，猜不到按 UTF-8。 */
function detectCharset(contentType: string, buf: Buffer): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType);
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  const fromMeta = /charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8';
}

function decodeBody(buf: Buffer, contentType: string): string {
  const charset = detectCharset(contentType, buf);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

/** 粗暴但够用的正文抽取：丢脚本/样式/导航/页脚，块标签转换行，解实体。 */
function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|section|article|h[1-6]|pre|blockquote|td|th)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? oneLine(htmlToText(m[1]), 120) : '';
}

/** 把 ["Name: value", …] 变成 Headers；格式不对的行直接报错，别静默丢。 */
function parseHeaders(raw: unknown): { headers: Record<string, string> } | { error: string } {
  const list = Array.isArray(raw) ? raw.map((v) => String(v)) : [];
  const headers: Record<string, string> = {};
  for (const item of list) {
    const at = item.indexOf(':');
    if (at <= 0) return { error: `请求头要写成 "Name: value"，这一条不行：${oneLine(item, 60)}` };
    headers[item.slice(0, at).trim()] = item.slice(at + 1).trim();
  }
  return { headers };
}

export async function fetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim();
  if (!url) return err('E_INPUT', 'url 不能为空', '带 http(s):// 的完整地址');
  if (!/^https?:\/\//i.test(url)) {
    return err('E_INPUT', `url 必须以 http(s):// 开头：${oneLine(url, 60)}`, '例如 https://example.com');
  }

  const method = String(args.method ?? 'GET').trim().toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return err('E_INPUT', `不支持的 method：${oneLine(method, 20)}`, 'GET / HEAD / POST / PUT / PATCH / DELETE');
  }
  const maxRaw = Number(args.maxChars ?? FETCH_DEFAULT_CHARS);
  const maxChars = Number.isFinite(maxRaw)
    ? Math.min(Math.max(Math.trunc(maxRaw), 400), FETCH_MAX_CHARS)
    : FETCH_DEFAULT_CHARS;

  const parsedHeaders = parseHeaders(args.headers);
  if ('error' in parsedHeaders) return err('E_INPUT', parsedHeaders.error, '用数组："Authorization: Bearer xxx"');

  const bodyArg = args.body === undefined ? '' : String(args.body);
  if ((method === 'GET' || method === 'HEAD') && bodyArg) {
    return err('E_INPUT', `${method} 请求不带 body`, '要提交表单或 JSON 就用 method=POST / PUT / PATCH');
  }

  const headers: Record<string, string> = {
    'user-agent': FETCH_UA,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    ...parsedHeaders.headers,
  };
  if (bodyArg && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    const looksJson = /^\s*[[{]/.test(bodyArg);
    headers['content-type'] = looksJson ? 'application/json' : 'text/plain; charset=utf-8';
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: bodyArg || undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    return err(
      'E_FETCH',
      `抓不到 ${oneLine(url, 80)}：${message}`,
      '检查网络/代理；本地接口请确认端口在监听；DNS 被劫持时也会失败',
    );
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return err('E_FETCH', `读响应体失败：${String((e as Error)?.message ?? e)}`);
  }
  if (buf.byteLength > FETCH_MAX_BYTES) {
    return err(
      'E_TOO_BIG',
      `${oneLine(url, 80)} 返回 ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB，超过 ${FETCH_MAX_BYTES / 1024 / 1024} MB 上限`,
      '用 ops_sh 的 curl 落到临时文件，再用 ops_read 分段读',
    );
  }

  const type = res.headers.get('content-type') ?? '';
  const body = decodeBody(buf, type);
  const isHtml = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body.slice(0, 200));
  const isJson = /json/i.test(type);
  const raw = args.raw === true;

  let text = body;
  let title = '';
  if (!raw && isHtml) {
    title = htmlTitle(body);
    text = htmlToText(body);
  } else if (!raw && isJson) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      /* 不是合法 JSON 就照原样给 */
    }
  }

  const { text: clipped, total, truncated } = clip(text, maxChars);
  const head = ok(
    'fetch',
    `${method} ${res.status} ${res.statusText || ''} ${type || '未知类型'} · 原始 ${(buf.byteLength / 1024).toFixed(1)} KB`
      + ` · 正文 ${total} 字${isHtml && !raw ? '（已剥标签）' : isJson && !raw ? '（已格式化）' : ''}`,
  );
  const notes: string[] = [];
  if (title) notes.push(`[title] ${title}`);
  if (!text.trim()) {
    notes.push('[note] 抽出来的正文是空的：可能要登录、全靠 JS 渲染，或返回的不是正文（可试 raw=true 看原始 HTML）');
  }
  if (res.status >= 400) notes.push(`[note] HTTP ${res.status}：这是错误页的正文，别当正常内容用`);
  const tail: string[] = [];
  if (truncated) {
    tail.push(`[next] 正文 ${total} 字只给了 ${maxChars} 字；调大 maxChars（上限 ${FETCH_MAX_CHARS}）`);
  }
  return [head, ...notes, clipped, ...tail].filter(Boolean).join('\n');
}
