/** ops_result：把超长回执存到扩展侧，只把摘要塞进上下文，需要细节时再按偏移取。 */

/** 存起来的原文；上限 20 条、单条 200k 字符，超出丢最旧的。 */
const STORE_MAX = 20;
const STORE_MAX_CHARS = 200_000;

interface Stored {
  text: string;
  label: string;
  createdAt: number;
}

const store = new Map<string, Stored>();
let seq = 0;

export function clearResultStore(): void {
  store.clear();
  seq = 0;
}

/** 存一份原文，返回短引用（形如 r3f9）。 */
export function stash(text: string, label: string): string {
  if (text.length > STORE_MAX_CHARS) text = text.slice(0, STORE_MAX_CHARS);
  seq += 1;
  const ref = `r${seq.toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  store.set(ref, { text, label, createdAt: Date.now() });
  while (store.size > STORE_MAX) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
  return ref;
}

/** 取出引用内容的一段；找不到引用就回错误串。 */
export function readStashed(args: Record<string, unknown>): string {
  const ref = String(args.ref ?? '').trim().replace(/^\[?ref\s*/i, '').replace(/\]$/, '');
  if (!ref) return errText('E_INPUT', 'ref 不能为空', '回执里 [ref xxx] 就是它');
  const hit = store.get(ref);
  if (!hit) {
    return errText(
      'E_REF',
      `没有这个引用：${ref}（已过期或被挤出，最多留 ${STORE_MAX} 条）`,
      '重新跑那一步工具；引用只在本次进程内有效',
    );
  }
  const maxRaw = Number(args.maxChars ?? 3_000);
  const maxChars = Number.isFinite(maxRaw) ? Math.min(Math.max(Math.trunc(maxRaw), 400), 12_000) : 3_000;
  let offset = Number(args.offset ?? 0);
  if (!Number.isFinite(offset)) offset = 0;
  offset = Math.max(0, Math.trunc(offset));
  if (offset >= hit.text.length) {
    return errText('E_RANGE', `offset=${offset} 超过该引用长度 ${hit.text.length}`, 'offset 从 0 起');
  }
  const slice = hit.text.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  const head = `[ok result] ${ref}（${hit.label}）第 ${offset}-${end} 字 / 共 ${hit.text.length} 字`;
  const tail = end < hit.text.length ? `[next] 还有 ${hit.text.length - end} 字，用 offset=${end}` : '';
  return [head, slice, tail].filter(Boolean).join('\n');
}

function errText(code: string, message: string, next?: string): string {
  return [`[err ${code}] ${message}`, next ? `[next] ${next}` : ''].filter(Boolean).join('\n');
}

/** 超过这个长度的回执就转存，只回摘要。 */
export const STASH_THRESHOLD = 4_000;
/** 摘要里保留的头尾字数。 */
const HEAD_CHARS = 1_200;
const TAIL_CHARS = 400;

/** 长回执 → 摘要 + 引用；短回执原样返回。 */
export function summarizeIfLong(text: string, tool: string): string {
  if (text.length <= STASH_THRESHOLD || text.startsWith('[err')) return text;
  const ref = stash(text, tool);
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  return [
    `[ok ${tool}] 回执 ${text.length} 字，全文已存为 [ref ${ref}]`,
    head,
    `…（中间省略 ${text.length - HEAD_CHARS - TAIL_CHARS} 字）…`,
    tail,
    `[next] 要中间部分就 ops_result{ref:"${ref}", offset:${HEAD_CHARS}}；不取也不影响继续干活`,
  ].join('\n');
}
