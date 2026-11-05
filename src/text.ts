/** 输出整形：所有工具共用的封顶、省略、行号与摘要格式。 */

export const MAX_BODY = 12_000;

/** UTF-8 字节数。 */
export function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** 按字符封顶，截断时明说剩多少，不静默丢内容。 */
export function clip(text: string, maxChars: number): { text: string; total: number; truncated: boolean } {
  const total = text.length;
  if (total <= maxChars) return { text, total, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n…（已截断：共 ${total} 字，只给了前 ${maxChars} 字）…`,
    total,
    truncated: true,
  };
}

/** 多行留头尾，中间说明省略多少行——报错信息通常在最后几行。 */
export function headTail(
  text: string,
  head = 80,
  tail = 30,
): { text: string; totalLines: number; omitted: number } {
  const normalized = (text ?? '').replace(/\r\n/g, '\n');
  if (!normalized) return { text: '', totalLines: 0, omitted: 0 };
  const lines = normalized.split('\n');
  const totalLines = lines.length;
  if (totalLines <= head + tail) return { text: normalized, totalLines, omitted: 0 };
  const omitted = totalLines - head - tail;
  return {
    text: [
      lines.slice(0, head).join('\n'),
      `…（中间省略 ${omitted} 行，共 ${totalLines} 行、${normalized.length} 字）…`,
      lines.slice(-tail).join('\n'),
    ].join('\n'),
    totalLines,
    omitted,
  };
}

/** `12| 内容` 形式，模型最容易定位回原文。 */
export function numbered(startLine: number, lines: string[]): string[] {
  return lines.map((line, i) => `${startLine + i}| ${line}`);
}

/** 单行摘要：压掉换行、超长截断。 */
export function oneLine(text: string, max = 120): string {
  const flat = String(text ?? '')
    .replace(/\s*\n+\s*/g, ' ⏎ ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 成功回执首行。 */
export function ok(op: string, summary: string): string {
  return `[ok ${op}] ${summary}`;
}

/** 失败回执：错误码 + 说明 + 下一步 + 副作用状态，永不抛给宿主。 */
export function err(code: string, message: string, next?: string, effect: 'none' | 'unknown' = 'none'): string {
  const parts = [`[err ${code}] ${message}`];
  if (effect === 'unknown') parts.push('[effect unknown] 这一步可能已经改动过目标，重试前先读一遍确认');
  if (next) parts.push(`[next] ${next}`);
  return parts.join('\n');
}

/** 12 位内容指纹，用来判断「文件没变」。 */
export function revision(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(c, 31)) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}
