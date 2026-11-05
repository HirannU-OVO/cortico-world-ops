/**
 * 六个工具的真实实现。
 *
 * 三条硬规则（照 dsh-ops 的思路来的）：
 * 1. 输出永远封顶，截断必须明说，并给出续读指针——不能静默丢内容；
 * 2. 失败返回结构化错误码，不抛异常；副作用不明的要标 effect unknown；
 * 3. 扫描类结果被截断时明说「不是全部」，别让模型以为扫完了。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename as pathBasename, dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { bytes, clip, err, headTail, numbered, ok, oneLine, revision } from './text.ts';

const execFileAsync = promisify(execFile);

const READ_DEFAULT_BYTES = 12_000;
const READ_MAX_BYTES = 64_000;
const READ_DEFAULT_LINES = 150;
const READ_MAX_LINES = 2_000;
const MEMO_MAX = 200;

const SCAN_MAX_FILES = 20_000;
const SCAN_MAX_DEPTH = 12;
const SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;
const FIND_DEFAULT_RESULTS = 60;
const FIND_MAX_RESULTS = 500;
const MATCHES_PER_FILE = 5;

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.next', 'target', '.pnpm', '.cache', 'coverage', '.idea', '.vs',
]);

const FETCH_DEFAULT_CHARS = 6_000;
const FETCH_MAX_CHARS = 30_000;
const FETCH_MAX_BYTES = 8 * 1024 * 1024;
const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** 拒绝改写系统目录：写到这些地方基本只会坏事。 */
function isDeniedWriteTarget(abs: string): boolean {
  const lower = abs.toLowerCase();
  const roots = [
    process.env.SystemRoot?.toLowerCase(),
    process.env.ProgramFiles?.toLowerCase(),
    process.env['ProgramFiles(x86)']?.toLowerCase(),
    'c:\\windows',
  ].filter((v): v is string => Boolean(v));
  return roots.some((root) => lower === root || lower.startsWith(`${root}${sep}`));
}

/** 展开 ~ 与 %VAR%，统一成绝对路径。 */
export function resolvePath(input: string): string {
  let p = String(input ?? '').trim();
  if (!p) return p;
  p = p.replace(/^~(?=$|[\\/])/, homedir());
  p = p.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
  return normalize(resolve(p));
}

function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^(?:.*/)?${out}$`, 'i');
}

type FindMode = 'files' | 'content';

/** 从 content-type 或 HTML meta 里猜字符集，猜不到按 UTF-8。 */
function detectCharset(contentType: string, bytesBuf: Buffer): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType);
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = bytesBuf.subarray(0, 4096).toString('latin1');
  const fromMeta = /charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8';
}

/** 按检测到的字符集解码；解不了就退 UTF-8，别因为编码把整次抓取废掉。 */
function decodeBody(bytesBuf: Buffer, contentType: string): string {
  const charset = detectCharset(contentType, bytesBuf);
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytesBuf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytesBuf);
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

interface FindQuery {
  pattern: string;
  mode: FindMode;
  root: string;
  includes: RegExp[];
  excludes: RegExp[];
  ignoreCase: boolean;
  maxResults: number;
  skip: number;
}

interface WalkEntry {
  abs: string;
  rel: string;
}

/** 记忆上一次给过全文的范围：同一范围 + 同样内容就不再重发。 */
const readMemo = new Map<string, { rev: string; lines: number }>();

export function clearReadMemo(): void {
  readMemo.clear();
}

export class Ops {
  // ── ops_read ────────────────────────────────────────────────────────────
  read(args: Record<string, unknown>): string {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) return err('E_INPUT', 'path 不能为空', '给一个文件绝对路径');
    const abs = resolvePath(rawPath);
    const maxBytesRaw = Number(args.maxBytes ?? READ_DEFAULT_BYTES);
    const maxBytes = Number.isFinite(maxBytesRaw)
      ? Math.min(Math.max(maxBytesRaw, 400), READ_MAX_BYTES)
      : READ_DEFAULT_BYTES;
    const limitRaw = Number(args.limit ?? READ_DEFAULT_LINES);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), READ_MAX_LINES)
      : READ_DEFAULT_LINES;
    const fresh = args.fresh === true;

    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        const entries = readdirSync(abs, { withFileTypes: true }).slice(0, 200);
        const listing = entries.map((e) => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`);
        return [ok('read', `这是目录，共 ${entries.length} 项（最多列 200）`), ...listing].join('\n');
      }
      const raw = readFileSync(abs, 'utf8');
      const lines = raw.split(/\r?\n/);
      const total = lines.length;
      const rev = revision(raw);

      let offsetRaw = Number(args.offset ?? 1);
      if (!Number.isFinite(offsetRaw)) offsetRaw = 1;
      let offset = Math.trunc(offsetRaw);
      if (offset < 0) offset = Math.max(1, total + offset + 1);
      offset = Math.max(1, offset);
      if (offset > total) {
        return err('E_RANGE', `${abs} 只有 ${total} 行，offset=${offset} 超了`, `用 offset=1 或不超过 ${total}`);
      }

      const key = `${abs}|${offset}|${limit}`;
      const prev = readMemo.get(key);
      if (!fresh && prev && prev.rev === rev && prev.lines === total) {
        return ok('unchanged', `${abs} 第 ${offset} 行起，共 ${total} 行（revision=${rev}）——内容和上次给的一样，没重发。要再给一遍加 fresh=true`);
      }

      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const shown: string[] = [];
      let used = 0;
      for (let i = 0; i < slice.length; i++) {
        const line = numbered(offset + i, [slice[i]])[0];
        const size = bytes(line) + 1;
        if (shown.length > 0 && used + size > maxBytes) break;
        shown.push(line);
        used += size;
      }
      const last = offset + shown.length - 1;
      const complete = shown.length === slice.length;
      if (complete) {
        readMemo.set(key, { rev, lines: total });
        if (readMemo.size > MEMO_MAX) {
          const oldest = readMemo.keys().next();
          if (!oldest.done) readMemo.delete(oldest.value);
        }
      }
      const head = ok('read', `${abs} 第 ${offset}-${last} 行 / 共 ${total} 行，revision=${rev}`);
      const remaining = total - last;
      const tail = remaining > 0
        ? `[next] 还有 ${remaining} 行没给${complete ? `（本次 limit=${limit} 到头了）` : '（字节上限到了）'}，接着读用 offset=${last + 1}`
        : '';
      return [head, ...shown, tail].filter(Boolean).join('\n');
    } catch (e) {
      const message = String((e as Error).message ?? e);
      return err('E_READ', `${abs} 读不到：${message}`, '确认路径是否存在、是否是文本文件');
    }
  }

  // ── ops_write ───────────────────────────────────────────────────────────
  write(args: Record<string, unknown>): string {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) return err('E_INPUT', 'path 不能为空');
    const abs = resolvePath(rawPath);
    if (isDeniedWriteTarget(abs)) {
      return err('E_DENY', `拒绝写系统目录：${abs}`, '换到用户目录或项目目录下');
    }
    const content = String(args.content ?? '');
    const mode = String(args.mode ?? 'overwrite').toLowerCase() === 'append' ? 'append' : 'overwrite';
    try {
      mkdirSync(dirname(abs), { recursive: true });
      const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
      const after = mode === 'append' ? before + content : content;
      writeFileSync(abs, after, 'utf8');
      return ok(
        'write',
        `${mode === 'append' ? '追加' : '写入'} ${abs}：${bytes(content)} 字节 → 现在 ${bytes(after)} 字节，${after.split('\n').length} 行，revision=${revision(after)}`,
      );
    } catch (e) {
      return err('E_WRITE', `${abs} 写不进去：${String((e as Error).message ?? e)}`, undefined, 'unknown');
    }
  }

  // ── ops_patch ───────────────────────────────────────────────────────────
  patch(args: Record<string, unknown>): string {
    const rawPath = String(args.path ?? '').trim();
    const oldText = String(args.old ?? '');
    const newText = String(args.new ?? '');
    const all = args.all === true;
    if (!rawPath) return err('E_INPUT', 'path 不能为空');
    if (!oldText) return err('E_INPUT', 'old 不能为空', '要删一段就用 old 填那段、new 给空串');
    const abs = resolvePath(rawPath);
    if (isDeniedWriteTarget(abs)) return err('E_DENY', `拒绝写系统目录：${abs}`);

    let raw: string;
    try {
      raw = readFileSync(abs, 'utf8');
    } catch (e) {
      return err('E_READ', `${abs} 读不到：${String((e as Error).message ?? e)}`, '先用 ops_read 确认路径');
    }

    const positions: number[] = [];
    let from = 0;
    for (;;) {
      const at = raw.indexOf(oldText, from);
      if (at < 0) break;
      positions.push(at);
      from = at + oldText.length;
      if (positions.length > 200) break;
    }
    if (positions.length === 0) {
      return err(
        'E_NOTFOUND',
        `${abs} 里找不到 old 原文（${oneLine(oldText, 60)}）`,
        '用 ops_read 看原文，或 ops_find 搜关键词；old 必须逐字一致，含缩进与换行',
      );
    }
    if (positions.length > 1 && !all) {
      const where = positions.slice(0, 5).map((p) => this.lineOf(raw, p)).join(', ');
      return err(
        'E_AMBIGUOUS',
        `old 在 ${abs} 里出现 ${positions.length} 次（行 ${where}${positions.length > 5 ? ' …' : ''}）`,
        '多带几行上下文让它唯一，或加 all=true 全换',
      );
    }

    const next = all ? raw.split(oldText).join(newText) : raw.slice(0, positions[0]) + newText + raw.slice(positions[0] + oldText.length);
    try {
      writeFileSync(abs, next, 'utf8');
      const times = all ? positions.length : 1;
      return ok(
        'patch',
        `${abs} 替换 ${times} 处：${bytes(raw)} → ${bytes(next)} 字节，revision=${revision(next)}`,
      );
    } catch (e) {
      return err('E_WRITE', `${abs} 写不进去：${String((e as Error).message ?? e)}`, undefined, 'unknown');
    }
  }

  // ── ops_find ────────────────────────────────────────────────────────────
  find(args: Record<string, unknown>): string {
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) return err('E_INPUT', 'pattern 不能为空', 'files 模式给 glob，content 模式给正则');
    const modeRaw = String(args.mode ?? 'content').toLowerCase();
    const mode: FindMode = modeRaw === 'files' ? 'files' : 'content';
    const root = resolvePath(String(args.path ?? '').trim() || homedir());
    if (!existsSync(root)) return err('E_PATH', `搜索根目录不存在：${root}`);

    const globsRaw = Array.isArray(args.globs) ? (args.globs as unknown[]).map((g) => String(g)) : [];
    const includes = globsRaw.filter((g) => !g.startsWith('!')).map(globToRegExp);
    const excludes = globsRaw.filter((g) => g.startsWith('!')).map((g) => globToRegExp(g.slice(1)));
    if (mode === 'files' && includes.length === 0 && !pattern.startsWith('!')) {
      includes.push(globToRegExp(pattern));
    }

    let skip = 0;
    const cursor = String(args.cursor ?? '').trim();
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { s?: number };
        skip = Number(decoded.s ?? 0) || 0;
      } catch {
        return err('E_CURSOR', `cursor 解析不了：${oneLine(cursor, 40)}`, '不传 cursor 重新搜，或原样回传上一页的 nextCursor');
      }
    }

    const maxRaw = Number(args.maxResults ?? FIND_DEFAULT_RESULTS);
    const maxResults = Number.isFinite(maxRaw)
      ? Math.min(Math.max(Math.trunc(maxRaw), 1), FIND_MAX_RESULTS)
      : FIND_DEFAULT_RESULTS;
    const ignoreCase = args.ignoreCase === true;

    const files = this.walk(root);
    const query: FindQuery = {
      pattern,
      mode,
      root,
      includes,
      excludes,
      ignoreCase,
      maxResults,
      skip,
    };
    return mode === 'files'
      ? this.findFiles(files, query)
      : this.findContent(files, query);
  }

  private findFiles(files: WalkEntry[], q: FindQuery): string {
    const matcher = q.includes[0] ?? globToRegExp(q.pattern);
    const hits = files.filter((f) => {
      const posix = f.rel.split(sep).join('/');
      if (!matcher.test(posix)) return false;
      return !q.excludes.some((re) => re.test(posix));
    });
    const page = hits.slice(q.skip, q.skip + q.maxResults);
    const head = ok(
      'find files',
      `${hits.length} 个文件匹配 ${oneLine(q.pattern, 40)}（扫描 ${files.length} 个条目，根 ${q.root}）`,
    );
    const body = page.map((h) => h.rel);
    const more = q.skip + page.length < hits.length;
    const tail: string[] = [];
    if (more) {
      const nextCursor = Buffer.from(JSON.stringify({ s: q.skip + page.length }), 'utf8').toString('base64');
      tail.push(`[next] 还有 ${hits.length - q.skip - page.length} 个，用 cursor=${nextCursor}`);
    }
    if (files.length >= SCAN_MAX_FILES) {
      tail.push(`[note] 扫描在 ${SCAN_MAX_FILES} 个条目处停了，结果不是全部；缩小 path 或加 globs 再搜`);
    }
    return [head, ...body, ...tail].join('\n');
  }

  private findContent(files: WalkEntry[], q: FindQuery): string {
    let re: RegExp;
    try {
      re = new RegExp(q.pattern, q.ignoreCase ? 'i' : '');
    } catch (e) {
      return err('E_REGEX', `正则不合法：${String((e as Error).message)}`, '转义特殊字符，或先按 files 模式定位文件');
    }

    const hits: string[] = [];
    let scanned = 0;
    let filesWithHits = 0;
    let capped = false;
    for (const entry of files) {
      const posix = entry.rel.split(sep).join('/');
      if (q.excludes.some((x) => x.test(posix))) continue;
      if (q.includes.length && !q.includes.some((x) => x.test(posix))) continue;
      scanned += 1;
      let text: string;
      try {
        const stat = statSync(entry.abs);
        if (!stat.isFile() || stat.size > SCAN_MAX_FILE_BYTES) continue;
        const raw = readFileSync(entry.abs);
        if (raw.subarray(0, 8192).includes(0)) continue;
        text = raw.toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      let inFile = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        inFile += 1;
        if (hits.length >= q.skip + q.maxResults) {
          capped = true;
          break;
        }
        if (hits.length < q.skip) continue;
        hits.push(`${entry.rel}:${i + 1}: ${oneLine(lines[i], 160)}`);
        if (inFile >= MATCHES_PER_FILE) break;
      }
      if (inFile > 0) filesWithHits += 1;
      if (capped) break;
    }

    const head = ok(
      'find content',
      `${hits.length} 条命中 ${oneLine(q.pattern, 40)}（文件 ${filesWithHits} 个，扫描 ${scanned} 个文件）`,
    );
    const tail: string[] = [];
    if (capped) {
      const nextCursor = Buffer.from(JSON.stringify({ s: q.skip + hits.length }), 'utf8').toString('base64');
      tail.push(`[next] 还有更多命中，用 cursor=${nextCursor} 接着翻`);
      tail.push('[note] 结果是分页的，不是全部；每个文件最多给 ' + MATCHES_PER_FILE + ' 条');
    }
    if (files.length >= SCAN_MAX_FILES) {
      tail.push(`[note] 扫描在 ${SCAN_MAX_FILES} 个条目处停了，结果不是全部`);
    }
    if (hits.length === 0) {
      return [head, tail.join('\n') || '[next] 换个关键词，或把 mode 改成 files 先看目录里有什么'].join('\n');
    }
    return [head, ...hits, ...tail].join('\n');
  }

  private walk(root: string): WalkEntry[] {
    const out: WalkEntry[] = [];
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length && out.length < SCAN_MAX_FILES) {
      const { dir, depth } = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (out.length >= SCAN_MAX_FILES) break;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (DEFAULT_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
          if (depth + 1 > SCAN_MAX_DEPTH) continue;
          stack.push({ dir: abs, depth: depth + 1 });
        } else if (entry.isFile()) {
          out.push({ abs, rel: relative(root, abs) || pathBasename(abs) });
        }
      }
    }
    return out;
  }

  // ── ops_sh ──────────────────────────────────────────────────────────────
  async sh(args: Record<string, unknown>): Promise<string> {
    const command = String(args.command ?? '').trim();
    const scriptPath = String(args.scriptPath ?? '').trim();
    if (!command && !scriptPath) {
      return err('E_INPUT', 'command 和 scriptPath 至少给一个', '短命令用 command，长脚本先 ops_write 写成 .ps1 再给 scriptPath');
    }
    const cwd = String(args.cwd ?? '').trim() || undefined;
    const timeoutRaw = Number(args.timeoutMs ?? 60_000);
    const timeout = Number.isFinite(timeoutRaw) ? Math.min(Math.max(timeoutRaw, 1_000), 300_000) : 60_000;
    // 输出统一 UTF-8，否则中文回来全是乱码。
    const prelude = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ';
    const body = scriptPath
      ? prelude
        + `try { & '${scriptPath.replace(/'/g, "''")}'; `
        + 'if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 } } '
        + 'catch { Write-Error $_; exit 1 }'
      : prelude + command;

    const limit = (s: string): string => {
      const { text, omitted } = headTail(s, 80, 30);
      return omitted ? text : clip(text, 10_000).text;
    };

    try {
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body],
        { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      const out = limit(String(stdout ?? ''));
      const errText = limit(String(stderr ?? ''));
      return [
        ok('sh', `退出码 0${scriptPath ? `（${pathBasename(scriptPath)}）` : ''}`),
        out ? `[stdout]\n${out}` : '',
        errText ? `[stderr]\n${errText}` : '',
      ].filter(Boolean).join('\n');
    } catch (e) {
      const failure = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      const stderrText = String(failure.stderr ?? '');
      const errLines = stderrText.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
      const parts = [err('E_EXIT', `退出码 ${failure.code ?? '?'}`, undefined, 'unknown')];
      if (errLines.length) parts.push(`[stderr 末尾]\n${errLines.slice(-3).join('\n')}`);
      if (failure.stdout) parts.push(`[stdout]\n${limit(String(failure.stdout))}`);
      if (errLines.length > 3) parts.push(`[stderr 全文]\n${limit(stderrText)}`);
      if (!errLines.length && failure.message) parts.push(clip(String(failure.message), 400).text);
      if (!failure.stdout && !errLines.length) {
        parts.push('[next] 命令可能没跑起来（引号/路径/执行策略）；先跑一条 echo ok 验证通道');
      }
      return parts.join('\n');
    }
  }

  // ── ops_tree ────────────────────────────────────────────────────────────
  tree(args: Record<string, unknown>): string {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) return err('E_INPUT', 'path 不能为空', '给一个目录绝对路径');
    const root = resolvePath(rawPath);
    if (!existsSync(root)) return err('E_PATH', `目录不存在：${root}`);
    const depthRaw = Number(args.depth ?? 2);
    const depth = Number.isFinite(depthRaw) ? Math.min(Math.max(Math.trunc(depthRaw), 1), 6) : 2;
    const maxRaw = Number(args.maxEntries ?? 200);
    const maxEntries = Number.isFinite(maxRaw) ? Math.min(Math.max(Math.trunc(maxRaw), 10), 1000) : 200;

    const lines: string[] = [];
    let folded = 0;
    let dirs = 0;
    let files = 0;

    const walk = (dir: string, level: number, prefix: string): void => {
      if (lines.length >= maxEntries) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        lines.push(`${prefix}（读不到）`);
        return;
      }
      const visible = entries
        .filter((e) => !DEFAULT_SKIP_DIRS.has(e.name.toLowerCase()))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const hidden = entries.length - visible.length;
      for (const entry of visible) {
        if (lines.length >= maxEntries) {
          folded += 1;
          continue;
        }
        const isDir = entry.isDirectory();
        if (isDir) dirs += 1;
        else files += 1;
        lines.push(`${prefix}${isDir ? '📁' : '· '} ${entry.name}`);
        if (isDir && level < depth) walk(join(dir, entry.name), level + 1, `${prefix}  `);
      }
      if (hidden > 0) lines.push(`${prefix}（跳过 ${hidden} 个依赖/缓存目录）`);
    };

    walk(root, 1, '');
    const head = ok('tree', `${root}（深度 ${depth}，目录 ${dirs} / 文件 ${files}）`);
    const tail: string[] = [];
    if (folded > 0) tail.push(`[note] 还有 ${folded} 项没列（maxEntries=${maxEntries}）；加 depth 或直接 ops_find 定位`);
    return [head, ...lines, ...tail].join('\n');
  }

  // ── ops_git ─────────────────────────────────────────────────────────────
  async git(args: Record<string, unknown>): Promise<string> {
    const cwdRaw = String(args.path ?? '').trim();
    const cwd = cwdRaw ? resolvePath(cwdRaw) : process.cwd();
    if (!existsSync(cwd)) return err('E_PATH', `路径不存在：${cwd}`);
    const modeRaw = String(args.mode ?? 'status').toLowerCase();
    const mode = modeRaw === 'diff' || modeRaw === 'log' ? modeRaw : 'status';
    const maxRaw = Number(args.maxLines ?? 80);
    const maxLines = Number.isFinite(maxRaw) ? Math.min(Math.max(Math.trunc(maxRaw), 10), 400) : 80;

    const run = async (argv: string[]): Promise<{ code: number; out: string; errText: string }> => {
      try {
        const { stdout } = await execFileAsync('git', argv, {
          cwd,
          timeout: 20_000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        });
        return { code: 0, out: String(stdout ?? ''), errText: '' };
      } catch (e) {
        const failure = e as { code?: number; stdout?: string; stderr?: string; message?: string };
        return {
          code: typeof failure.code === 'number' ? failure.code : 1,
          out: String(failure.stdout ?? ''),
          errText: String(failure.stderr ?? failure.message ?? ''),
        };
      }
    };

    const inside = await run(['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || !inside.out.trim().startsWith('true')) {
      return err('E_GIT', `${cwd} 不在 git 仓库里`, '给一个仓库内路径，或先确认这里是不是代码目录');
    }

    if (mode === 'status') {
      const res = await run(['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=normal']);
      if (res.code !== 0) return err('E_GIT', `git status 失败：${oneLine(res.errText, 120)}`);
      const rows = res.out.split('\n').filter((l) => l.trim());
      if (!rows.length) return ok('git status', `${cwd} 干净，没有改动`);
      const bucket = { M: 0, A: 0, D: 0, '??': 0, other: 0 } as Record<string, number>;
      for (const row of rows) {
        const code = row.slice(0, 2).trim();
        if (code === 'M') bucket.M += 1;
        else if (code === 'A') bucket.A += 1;
        else if (code === 'D') bucket.D += 1;
        else if (code === '??') bucket['??'] += 1;
        else bucket.other += 1;
      }
      const limit = Math.min(rows.length, maxLines);
      const tail = rows.length > limit ? [`[next] 还有 ${rows.length - limit} 条没列，用 maxLines 放大`] : [];
      return [
        ok('git status', `${rows.length} 项改动：改 ${bucket.M} · 新增 ${bucket.A} · 删 ${bucket.D} · 未跟踪 ${bucket['??']}${bucket.other ? ` · 其它 ${bucket.other}` : ''}`),
        ...rows.slice(0, limit),
        ...tail,
      ].join('\n');
    }

    if (mode === 'log') {
      const res = await run(['log', `-n${Math.min(maxLines, 50)}`, '--oneline', '--decorate']);
      if (res.code !== 0) return err('E_GIT', `git log 失败：${oneLine(res.errText, 120)}`, '空仓库还没有提交');
      return [ok('git log', `最近 ${res.out.split('\n').filter(Boolean).length} 条提交`), res.out.trim()].join('\n');
    }

    // diff
    const staged = args.staged === true;
    const stat = await run(['diff', ...(staged ? ['--cached'] : []), '--stat=120']);
    const detail = await run(['diff', ...(staged ? ['--cached'] : []), '--no-color', '--unified=1']);
    if (stat.code !== 0) return err('E_GIT', `git diff 失败：${oneLine(stat.errText, 120)}`);
    const statLines = stat.out.trim() ? stat.out.trim().split('\n') : [];
    if (!statLines.length) {
      return ok('git diff', `${staged ? '暂存区' : '工作区'}没有文本改动（可能是新文件，用 mode=status 看）`);
    }
    const { text: body, omitted } = headTail(detail.out, Math.floor(maxLines / 2), Math.floor(maxLines / 2));
    const tail: string[] = [];
    if (omitted > 0) tail.push(`[note] diff 正文省略 ${omitted} 行，只看摘要就用这几行 stat`);
    return [ok('git diff', `${staged ? '暂存区' : '工作区'}改动`), ...statLines, '', body, ...tail]
      .filter((v) => v !== undefined)
      .join('\n');
  }

  // ── ops_fetch ───────────────────────────────────────────────────────────
  async fetchUrl(args: Record<string, unknown>): Promise<string> {
    const url = String(args.url ?? '').trim();
    if (!url) return err('E_INPUT', 'url 不能为空', '带 http(s):// 的完整地址');
    if (!/^https?:\/\//i.test(url)) {
      return err('E_INPUT', `url 必须以 http(s):// 开头：${oneLine(url, 60)}`, '例如 https://example.com');
    }
    const maxRaw = Number(args.maxChars ?? FETCH_DEFAULT_CHARS);
    const maxChars = Number.isFinite(maxRaw)
      ? Math.min(Math.max(Math.trunc(maxRaw), 400), FETCH_MAX_CHARS)
      : FETCH_DEFAULT_CHARS;

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
        headers: {
          'user-agent': FETCH_UA,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        },
      });
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      return err(
        'E_FETCH',
        `抓不到 ${oneLine(url, 80)}：${message}`,
        '检查网络/代理；GitHub 这类站可能需要代理，DNS 被劫持时也会失败',
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

    let text = body;
    let title = '';
    const raw = args.raw === true;
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
      `${res.status} ${res.statusText || ''} ${type || '未知类型'} · 原始 ${(buf.byteLength / 1024).toFixed(1)} KB`
        + ` · 正文 ${total} 字${isHtml ? '（已剥标签）' : isJson ? '（已格式化）' : ''}`,
    );
    const notes: string[] = [];
    if (title) notes.push(`[title] ${title}`);
    if (!text.trim()) {
      notes.push('[note] 抽出来的正文是空的：可能要登录、全靠 JS 渲染，或返回的不是正文（可试 raw=true 看原始 HTML）');
    }
    if (res.status >= 400) {
      notes.push(`[note] HTTP ${res.status}：这是错误页的正文，别当正常内容用`);
    }
    const tail: string[] = [];
    if (truncated) {
      tail.push(`[next] 正文 ${total} 字只给了 ${maxChars} 字；调大 maxChars（上限 ${FETCH_MAX_CHARS}），或换更具体的页面/接口`);
    }
    return [head, ...notes, clipped, ...tail].filter(Boolean).join('\n');
  }

  // ── ops_batch ───────────────────────────────────────────────────────────
  async batch(args: Record<string, unknown>): Promise<string> {
    const reads = Array.isArray(args.reads) ? (args.reads as Record<string, unknown>[]) : [];
    const patches = Array.isArray(args.patches) ? (args.patches as Record<string, unknown>[]) : [];
    const writes = Array.isArray(args.writes) ? (args.writes as Record<string, unknown>[]) : [];
    const finds = Array.isArray(args.finds) ? (args.finds as Record<string, unknown>[]) : [];
    const shells = Array.isArray(args.shells) ? (args.shells as Record<string, unknown>[]) : [];
    const total = reads.length + patches.length + writes.length + finds.length + shells.length;
    if (!total) {
      return err(
        'E_INPUT',
        'reads / patches / writes / finds / shells 都是空的',
        '至少给一项；单件事就直接用对应工具',
      );
    }

    const sections: string[] = [];
    const counts = { read: 0, patch: 0, write: 0, find: 0, sh: 0, failed: 0 };
    const perItem = 1_200;

    const push = (label: string, out: string): void => {
      if (out.startsWith('[err')) counts.failed += 1;
      sections.push(`— ${label}\n${clip(out, perItem).text}`);
    };

    for (const [i, item] of reads.entries()) {
      counts.read += 1;
      push(`read #${i + 1} ${oneLine(String(item.path ?? ''), 80)}`, this.read(item));
    }
    for (const [i, item] of patches.entries()) {
      counts.patch += 1;
      push(`patch #${i + 1} ${oneLine(String(item.path ?? ''), 80)}`, this.patch(item));
    }
    for (const [i, item] of writes.entries()) {
      counts.write += 1;
      push(`write #${i + 1} ${oneLine(String(item.path ?? ''), 80)}`, this.write(item));
    }
    for (const [i, item] of finds.entries()) {
      counts.find += 1;
      push(`find #${i + 1} ${oneLine(String(item.pattern ?? ''), 80)}`, this.find(item));
    }
    for (const [i, item] of shells.entries()) {
      counts.sh += 1;
      push(`sh #${i + 1} ${oneLine(String(item.command ?? ''), 80)}`, await this.sh(item));
    }

    const head = ok(
      'batch',
      `${total} 步：读 ${counts.read} · 改 ${counts.patch} · 写 ${counts.write} · 找 ${counts.find} · 命令 ${counts.sh}`
        + (counts.failed ? ` · 失败 ${counts.failed}` : ''),
    );
    const merged = [head, ...sections].join('\n\n');
    const { text, truncated } = clip(merged, 14_000);
    return truncated
      ? `${text}\n[next] 批次输出被截断了：拆成两次 ops_batch，或用单工具缩小范围`
      : text;
  }

  private lineOf(text: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line += 1;
    return line;
  }
}
