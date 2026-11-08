/**
 * 本机文件工具的真实实现：读、写、改、找、目录树、跑命令、批量。
 *
 * 三条硬规则：
 * 1. 输出永远封顶，截断必须明说，并给出续读指针——不能静默丢内容；
 * 2. 失败返回结构化错误码，不抛异常；副作用不明的要标 effect unknown；
 * 3. 扫描类结果被截断时明说「不是全部」，别让模型以为扫完了。
 *
 * ops_fetch 在 net.ts，ops_git 在 git.ts。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename as pathBasename, dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import { resolveLimits, type OpsLimits } from './config.ts';
import { isDeniedWriteTarget, resolvePath } from './paths.ts';
import { bytes, clip, err, headTail, numbered, ok, oneLine, revision } from './text.ts';

export { resolvePath } from './paths.ts';

const execFileAsync = promisify(execFile);

const READ_DEFAULT_BYTES = 8_000;
const READ_MAX_BYTES = 64_000;
const READ_DEFAULT_LINES = 100;
const READ_MAX_LINES = 2_000;
const MEMO_MAX = 200;

const SCAN_MAX_FILES = 20_000;
const SCAN_MAX_DEPTH = 12;
const SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;
const FIND_DEFAULT_RESULTS = 30;
const FIND_MAX_RESULTS = 500;
const MATCHES_PER_FILE = 5;

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__',
  '.next', 'target', '.pnpm', '.cache', 'coverage', '.idea', '.vs',
]);

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

interface FindQuery {
  pattern: string;
  mode: FindMode;
  root: string;
  includes: RegExp[];
  excludes: RegExp[];
  ignoreCase: boolean;
  maxResults: number;
  skip: number;
  context: number;
  sinceMs: number;
}

/** 解析 30m / 2h / 1d / 7d 或 ISO 时间，得到「不早于」的时间戳。 */
function parseSince(raw: unknown): { ms: number } | { error: string } {
  const text = String(raw ?? '').trim();
  if (!text) return { ms: 0 };
  const rel = /^(\d+)\s*(s|m|h|d|w)$/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const factor: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
    return { ms: Date.now() - n * factor[unit] };
  }
  const abs = Date.parse(text);
  if (Number.isFinite(abs)) return { ms: abs };
  return { error: `since 看不懂：${oneLine(text, 40)}` };
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
  private readonly limits: () => OpsLimits;

  /** 每次调用现读限制，面板改完即时生效。 */
  constructor(limits: () => OpsLimits = () => resolveLimits(undefined)) {
    this.limits = limits;
  }

  // ── ops_read ────────────────────────────────────────────────────────────
  read(args: Record<string, unknown>): string {
    const L = this.limits();
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) return err('E_INPUT', 'path 不能为空', '给一个文件绝对路径');
    const abs = resolvePath(rawPath);
    const maxBytesRaw = Number(args.maxBytes ?? L.readBytes);
    const maxBytes = Number.isFinite(maxBytesRaw)
      ? Math.min(Math.max(maxBytesRaw, 400), READ_MAX_BYTES)
      : L.readBytes;
    const limitRaw = Number(args.limit ?? L.readLines);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.trunc(limitRaw), 1), READ_MAX_LINES)
      : L.readLines;
    const fresh = args.fresh === true;

    try {
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        const entries = readdirSync(abs, { withFileTypes: true }).slice(0, 200);
        const listing = entries.map((e) => `${e.isDirectory() ? 'dir ' : 'file'} ${e.name}`);
        return [ok('read', `这是目录，共 ${entries.length} 项（最多列 200）`), ...listing].join('\n');
      }
      const buf = readFileSync(abs);
      const probe = buf.subarray(0, 8192);
      if (probe.includes(0)) {
        return err(
          'E_BINARY',
          `${abs} 看起来是二进制文件（${(buf.byteLength / 1024).toFixed(1)} KB，前 8 KB 里含 0 字节）`,
          '文本工具读不了它；看图/PDF 请用支持多模态的工具，或先转成文本再读',
        );
      }
      const raw = buf.toString('utf8');
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
    return this.findCore(args).text;
  }

  /** 找文件/找内容，同时把命中的绝对路径带出来（batch 的 from 靠它）。 */
  findCore(args: Record<string, unknown>): { text: string; paths: string[] } {
    const L = this.limits();
    const pattern = String(args.pattern ?? '').trim();
    if (!pattern) {
      return { text: err('E_INPUT', 'pattern 不能为空', 'files 模式给 glob，content 模式给正则'), paths: [] };
    }
    const modeRaw = String(args.mode ?? 'content').toLowerCase();
    const mode: FindMode = modeRaw === 'files' ? 'files' : 'content';
    const root = resolvePath(String(args.path ?? '').trim() || homedir());
    if (!existsSync(root)) return { text: err('E_PATH', `搜索根目录不存在：${root}`), paths: [] };

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
        return {
          text: err('E_CURSOR', `cursor 解析不了：${oneLine(cursor, 40)}`, '不传 cursor 重新搜，或原样回传上一页的 nextCursor'),
          paths: [],
        };
      }
    }

    const maxRaw = Number(args.maxResults ?? L.findResults);
    const maxResults = Number.isFinite(maxRaw)
      ? Math.min(Math.max(Math.trunc(maxRaw), 1), FIND_MAX_RESULTS)
      : L.findResults;
    const ctxRaw = Number(args.context ?? 0);
    const context = Number.isFinite(ctxRaw) ? Math.min(Math.max(Math.trunc(ctxRaw), 0), 10) : 0;
    const sinceParsed = parseSince(args.since);
    if ('error' in sinceParsed) {
      return {
        text: err('E_INPUT', sinceParsed.error, '支持 30m / 2h / 1d / 7d，或 ISO 时间（2026-11-06T00:00:00）'),
        paths: [],
      };
    }

    const query: FindQuery = {
      pattern,
      mode,
      root,
      includes,
      excludes,
      ignoreCase: args.ignoreCase === true,
      maxResults,
      skip,
      context,
      sinceMs: sinceParsed.ms,
    };
    const files = this.walk(root);
    return mode === 'files' ? this.findFiles(files, query) : this.findContent(files, query);
  }

  private findFiles(files: WalkEntry[], q: FindQuery): { text: string; paths: string[] } {
    const matcher = q.includes[0] ?? globToRegExp(q.pattern);
    const hits = files.filter((f) => {
      const posix = f.rel.split(sep).join('/');
      if (!matcher.test(posix)) return false;
      if (q.excludes.some((re) => re.test(posix))) return false;
      if (!q.sinceMs) return true;
      try {
        return statSync(f.abs).mtimeMs >= q.sinceMs;
      } catch {
        return false;
      }
    });
    const page = hits.slice(q.skip, q.skip + q.maxResults);
    const sinceText = q.sinceMs ? `，只看 ${new Date(q.sinceMs).toLocaleString()} 之后的改动` : '';
    const head = ok(
      'find files',
      `${hits.length} 个文件匹配 ${oneLine(q.pattern, 40)}（扫描 ${files.length} 个条目，根 ${q.root}${sinceText}）`,
    );
    const tail: string[] = [];
    if (q.skip + page.length < hits.length) {
      const nextCursor = Buffer.from(JSON.stringify({ s: q.skip + page.length }), 'utf8').toString('base64');
      tail.push(`[next] 还有 ${hits.length - q.skip - page.length} 个，用 cursor=${nextCursor}`);
    }
    if (files.length >= SCAN_MAX_FILES) {
      tail.push(`[note] 扫描在 ${SCAN_MAX_FILES} 个条目处停了，结果不是全部；缩小 path 或加 globs 再搜`);
    }
    return {
      text: [head, ...page.map((h) => h.rel), ...tail].join('\n'),
      paths: page.map((h) => join(q.root, h.rel)),
    };
  }

  private findContent(files: WalkEntry[], q: FindQuery): { text: string; paths: string[] } {
    let re: RegExp;
    try {
      re = new RegExp(q.pattern, q.ignoreCase ? 'i' : '');
    } catch (e) {
      return {
        text: err('E_REGEX', `正则不合法：${String((e as Error).message)}`, '转义特殊字符，或先按 files 模式定位文件'),
        paths: [],
      };
    }

    const hits: string[] = [];
    const hitFiles: string[] = [];
    let scanned = 0;
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
        if (q.sinceMs && stat.mtimeMs < q.sinceMs) continue;
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
        if (q.context > 0) {
          const from = Math.max(0, i - q.context);
          const to = Math.min(lines.length - 1, i + q.context);
          for (let j = from; j <= to; j++) {
            hits.push(`${entry.rel}:${j + 1}${j === i ? '>' : ' '}${oneLine(lines[j], 160)}`);
          }
          hits.push('--');
        } else {
          hits.push(`${entry.rel}:${i + 1}: ${oneLine(lines[i], 160)}`);
        }
        if (inFile >= MATCHES_PER_FILE) break;
      }
      if (inFile > 0) hitFiles.push(entry.abs);
      if (capped) break;
    }

    const sinceText = q.sinceMs ? `，只看 ${new Date(q.sinceMs).toLocaleString()} 之后改动过的` : '';
    const head = ok(
      'find content',
      `${hits.length} 条命中 ${oneLine(q.pattern, 40)}（文件 ${new Set(hitFiles).size} 个，扫描 ${scanned} 个文件`
        + `${q.context ? `，每条带 ±${q.context} 行上下文` : ''}${sinceText}）`,
    );
    const tail: string[] = [];
    if (capped) {
      const nextCursor = Buffer.from(JSON.stringify({ s: q.skip + hits.length }), 'utf8').toString('base64');
      tail.push(`[next] 还有更多命中，用 cursor=${nextCursor} 接着翻`);
      tail.push(`[note] 结果是分页的，不是全部；每个文件最多给 ${MATCHES_PER_FILE} 条`);
    }
    if (files.length >= SCAN_MAX_FILES) {
      tail.push(`[note] 扫描在 ${SCAN_MAX_FILES} 个条目处停了，结果不是全部`);
    }
    const body = hits.length ? hits : [tail.join('\n') || '[next] 换个关键词，或把 mode 改成 files 先看目录里有什么'];
    return {
      text: [head, ...body, ...(hits.length ? tail : [])].join('\n'),
      paths: [...new Set(hitFiles)],
    };
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

    const L = this.limits();
    const limit = (s: string): string => {
      const { text, omitted } = headTail(s, L.shHead, L.shTail);
      return omitted ? text : clip(text, 6_000).text;
    };

    // filter：只留匹配行（可选带上下文），因为关键行常在头尾之外。
    const filterRaw = String(args.filter ?? '').trim();
    let filterRe: RegExp | null = null;
    if (filterRaw) {
      try {
        filterRe = new RegExp(filterRaw, 'i');
      } catch (e) {
        return err('E_REGEX', `filter 正则不合法：${String((e as Error).message)}`, '转义特殊字符，或先去掉 filter 看全量输出');
      }
    }
    const ctxRaw = Number(args.filterContext ?? 0);
    const filterContext = Number.isFinite(ctxRaw) ? Math.min(Math.max(Math.trunc(ctxRaw), 0), 20) : 0;
    const notes: string[] = [];

    const applyFilter = (raw: string, label: string): string => {
      if (!filterRe || !raw) return limit(raw);
      const lines = raw.replace(/\r\n/g, '\n').split('\n');
      const matched: number[] = [];
      for (let i = 0; i < lines.length; i++) if (filterRe.test(lines[i])) matched.push(i);
      if (!matched.length) {
        notes.push(`[filter] ${label} 没有一行匹配 /${filterRaw}/（共 ${lines.length} 行）；建议去掉 filter 再看`);
        return '';
      }
      const keep = new Set<number>();
      for (const i of matched) {
        for (let j = Math.max(0, i - filterContext); j <= Math.min(lines.length - 1, i + filterContext); j++) keep.add(j);
      }
      const picked = [...keep].sort((a, b) => a - b).map((i) => (matched.includes(i) ? '>' : ' ') + lines[i]);
      notes.push(`[filter] ${label} 命中 ${matched.length} 行 / 共 ${lines.length} 行`);
      return limit(picked.join('\n'));
    };

    try {
      const { stdout, stderr } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body],
        { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      const out = applyFilter(String(stdout ?? ''), 'stdout');
      const errText = applyFilter(String(stderr ?? ''), 'stderr');
      return [
        ok('sh', `退出码 0${scriptPath ? `（${pathBasename(scriptPath)}）` : ''}`),
        ...notes,
        out ? `[stdout]\n${out}` : '',
        errText ? `[stderr]\n${errText}` : '',
      ].filter(Boolean).join('\n');
    } catch (e) {
      const failure = e as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      const stderrText = String(failure.stderr ?? '');
      const errLines = stderrText.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim());
      const parts = [err('E_EXIT', `退出码 ${failure.code ?? '?'}`, undefined, 'unknown'), ...notes];
      if (errLines.length) parts.push(`[stderr 末尾]\n${errLines.slice(-3).join('\n')}`);
      if (failure.stdout) parts.push(`[stdout]\n${applyFilter(String(failure.stdout), 'stdout')}`);
      if (errLines.length > 3) parts.push(`[stderr 全文]\n${applyFilter(stderrText, 'stderr')}`);
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

  // ── ops_batch ───────────────────────────────────────────────────────────
  /**
   * 一轮里顺序做多件事。执行顺序：finds → reads → patches → writes → shells。
   *
   * 传值：
   * - `reads[i].from = 1`：把第 1 个 finds 找到的文件各读一次（`from: "prev"` = 上一个 finds）；
   * - 字符串里的 `$1` / `$prev`：替换成对应步骤产出的路径；不唯一就报错，不猜。
   */
  async batch(args: Record<string, unknown>): Promise<string> {
    const reads = Array.isArray(args.reads) ? (args.reads as Record<string, unknown>[]) : [];
    const patches = Array.isArray(args.patches) ? (args.patches as Record<string, unknown>[]) : [];
    const writes = Array.isArray(args.writes) ? (args.writes as Record<string, unknown>[]) : [];
    const finds = Array.isArray(args.finds) ? (args.finds as Record<string, unknown>[]) : [];
    const shells = Array.isArray(args.shells) ? (args.shells as Record<string, unknown>[]) : [];

    if (!reads.length && !patches.length && !writes.length && !finds.length && !shells.length) {
      return err('E_INPUT', 'reads / patches / writes / finds / shells 都是空的', '至少给一项；单件事直接用对应工具');
    }

    const sections: string[] = [];
    const counts = { read: 0, patch: 0, write: 0, find: 0, sh: 0, failed: 0, expanded: 0 };
    const perItem = 1_000;

    const push = (label: string, out: string): void => {
      if (out.startsWith('[err')) counts.failed += 1;
      sections.push(`— ${label}\n${clip(out, perItem).text}`);
    };

    const findPaths: string[][] = [];
    let lastPaths: string[] = [];

    /** 把 $N / $prev 换成路径；不唯一或没有就返回错误文案。 */
    const substitute = (value: string, label: string): { text: string } | { error: string } => {
      const m = /\$(prev|\d+)/.exec(value);
      if (!m) return { text: value };
      const key = m[1];
      const list = key === 'prev' ? lastPaths : (findPaths[Number(key) - 1] ?? []);
      if (!list.length) {
        return { error: `${label}：$${key} 没有可用路径（${key === 'prev' ? '上一步没产出路径' : `第 ${key} 个 finds 没找到文件`}）` };
      }
      if (list.length > 1) {
        return { error: `${label}：$${key} 产出 ${list.length} 个路径，单独引用不明确；用 reads.from 批量处理` };
      }
      return { text: value.replace(m[0], list[0]) };
    };

    const resolveItem = (item: Record<string, unknown>, label: string): Record<string, unknown> | string => {
      const out: Record<string, unknown> = { ...item };
      delete out.from;
      for (const field of ['path', 'cwd', 'pattern', 'command']) {
        const raw = out[field];
        if (typeof raw !== 'string') continue;
        const sub = substitute(raw, label);
        if ('error' in sub) return sub.error;
        out[field] = sub.text;
      }
      return out;
    };

    // 1) finds
    for (const [i, item] of finds.entries()) {
      const label = `find #${i + 1} ${oneLine(String(item.pattern ?? ''), 60)}`;
      const resolved = resolveItem(item, label);
      if (typeof resolved === 'string') {
        push(label, err('E_BATCH_REF', resolved));
        findPaths.push([]);
        lastPaths = [];
        continue;
      }
      counts.find += 1;
      const result = this.findCore(resolved);
      push(label, result.text);
      findPaths.push(result.paths);
      lastPaths = result.paths;
    }

    // 2) reads（支持 from）
    const planned: Array<{ item: Record<string, unknown>; label: string }> = [];
    for (const [i, item] of reads.entries()) {
      if (item.from === undefined) {
        planned.push({ item, label: `read #${i + 1} ${oneLine(String(item.path ?? ''), 60)}` });
        continue;
      }
      const ref = String(item.from).replace('$', '').trim();
      const list = ref === 'prev' ? lastPaths : (findPaths[Number(ref) - 1] ?? []);
      if (!list.length) {
        push(
          `read #${i + 1} from=${ref}`,
          err('E_BATCH_REF', `from=${item.from} 没有可用路径`, '确认那个 finds 找到了文件，或改成显式 path'),
        );
        continue;
      }
      for (const [j, pathValue] of list.slice(0, 20).entries()) {
        counts.expanded += 1;
        planned.push({ item: { ...item, path: pathValue, from: undefined }, label: `read #${i + 1}.${j + 1} ${pathValue}` });
      }
    }
    for (const step of planned) {
      counts.read += 1;
      const resolved = resolveItem(step.item, step.label);
      push(step.label, typeof resolved === 'string' ? err('E_BATCH_REF', resolved) : this.read(resolved));
    }

    // 3) patches / writes / shells
    for (const [i, item] of patches.entries()) {
      const label = `patch #${i + 1} ${oneLine(String(item.path ?? ''), 60)}`;
      const resolved = resolveItem(item, label);
      counts.patch += 1;
      push(label, typeof resolved === 'string' ? err('E_BATCH_REF', resolved) : this.patch(resolved));
    }
    for (const [i, item] of writes.entries()) {
      const label = `write #${i + 1} ${oneLine(String(item.path ?? ''), 60)}`;
      const resolved = resolveItem(item, label);
      counts.write += 1;
      push(label, typeof resolved === 'string' ? err('E_BATCH_REF', resolved) : this.write(resolved));
    }
    for (const [i, item] of shells.entries()) {
      const label = `sh #${i + 1} ${oneLine(String(item.command ?? ''), 60)}`;
      const resolved = resolveItem(item, label);
      counts.sh += 1;
      push(label, typeof resolved === 'string' ? err('E_BATCH_REF', resolved) : await this.sh(resolved));
    }

    const total = counts.read + counts.patch + counts.write + counts.find + counts.sh + counts.failed;
    const head = ok(
      'batch',
      `${total} 步：找 ${counts.find} · 读 ${counts.read} · 改 ${counts.patch} · 写 ${counts.write} · 命令 ${counts.sh}`
        + (counts.expanded ? ` · 由 from 展开 ${counts.expanded} 次读` : '')
        + (counts.failed ? ` · 失败 ${counts.failed}` : ''),
    );
    const merged = [head, ...sections].join('\n\n');
    const { text, truncated } = clip(merged, 10_000);
    return truncated ? `${text}\n[next] 批次输出被截断了：拆成两次 ops_batch，或用单工具缩小范围` : text;
  }

  private lineOf(text: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line += 1;
    return line;
  }
}
