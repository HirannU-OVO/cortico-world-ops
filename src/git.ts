/** ops_git：仓库状态与提交操作。读的部分只读；写操作（add/commit/push）逐条把关。 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { isInside, resolvePath } from './paths.ts';
import { err, headTail, ok, oneLine } from './text.ts';

const execFileAsync = promisify(execFile);

const READ_MODES = new Set(['status', 'diff', 'log']);
const WRITE_MODES = new Set(['add', 'commit', 'push']);
const MAX_ADD_PATHS = 200;

interface GitRun {
  code: number;
  out: string;
  errText: string;
}

export async function gitOp(args: Record<string, unknown>): Promise<string> {
  const cwdRaw = String(args.path ?? '').trim();
  const cwd = cwdRaw ? resolvePath(cwdRaw) : process.cwd();
  if (!existsSync(cwd)) return err('E_PATH', `路径不存在：${cwd}`);

  const modeRaw = String(args.mode ?? 'status').toLowerCase();
  const mode = READ_MODES.has(modeRaw) || WRITE_MODES.has(modeRaw) ? modeRaw : 'status';
  const maxRaw = Number(args.maxLines ?? 80);
  const maxLines = Number.isFinite(maxRaw) ? Math.min(Math.max(Math.trunc(maxRaw), 10), 400) : 80;

  const run = async (argv: string[]): Promise<GitRun> => {
    try {
      const { stdout } = await execFileAsync('git', argv, {
        cwd,
        timeout: 30_000,
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
  const topRes = await run(['rev-parse', '--show-toplevel']);
  const repoRoot = topRes.code === 0 ? topRes.out.trim() : cwd;

  // ── 读模式 ──────────────────────────────────────────────────────────────
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
      ok(
        'git status',
        `${rows.length} 项改动：改 ${bucket.M} · 新增 ${bucket.A} · 删 ${bucket.D} · 未跟踪 ${bucket['??']}`
          + (bucket.other ? ` · 其它 ${bucket.other}` : ''),
      ),
      ...rows.slice(0, limit),
      ...tail,
    ].join('\n');
  }

  if (mode === 'log') {
    const res = await run(['log', `-n${Math.min(maxLines, 50)}`, '--oneline', '--decorate']);
    if (res.code !== 0) return err('E_GIT', `git log 失败：${oneLine(res.errText, 120)}`, '空仓库还没有提交');
    return [ok('git log', `最近 ${res.out.split('\n').filter(Boolean).length} 条提交`), res.out.trim()].join('\n');
  }

  if (mode === 'diff') {
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
    return [ok('git diff', `${staged ? '暂存区' : '工作区'}改动`), ...statLines, '', body, ...tail].join('\n');
  }

  // ── add ────────────────────────────────────────────────────────────────
  if (mode === 'add') {
    const rawPaths = Array.isArray(args.paths) ? (args.paths as unknown[]).map((p) => String(p)) : [];
    const all = args.all === true || rawPaths.length === 0;
    if (!all && rawPaths.length > MAX_ADD_PATHS) {
      return err('E_INPUT', `一次最多 add ${MAX_ADD_PATHS} 个路径`, '要给全部就传 all=true');
    }
    if (!all) {
      const outside: string[] = [];
      for (const raw of rawPaths) {
        const abs = resolvePath(raw);
        if (!isInside(repoRoot, abs)) outside.push(abs);
      }
      if (outside.length) {
        return err(
          'E_OUTSIDE',
          `这些路径不在仓库 ${repoRoot} 内：${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ' …' : ''}`,
          '只 add 仓库内的文件；其它文件请先移进来',
        );
      }
    }
    const res = await run(all ? ['add', '-A'] : ['add', '--', ...rawPaths]);
    if (res.code !== 0) return err('E_GIT', `git add 失败：${oneLine(res.errText, 160)}`);
    const staged = await run(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only']);
    const files = staged.out.split('\n').filter(Boolean);
    return ok(
      'git add',
      `已暂存 ${files.length} 个文件${all ? '（add -A）' : ''}`
        + (files.length ? `\n${files.slice(0, Math.min(files.length, maxLines)).join('\n')}` : ''),
    );
  }

  // ── commit ─────────────────────────────────────────────────────────────
  if (mode === 'commit') {
    const message = String(args.message ?? '').trim();
    if (!message) {
      return err('E_INPUT', 'commit message 必填', '写清楚这次改了什么；空的提交说明一律拒绝');
    }
    const staged = await run(['diff', '--cached', '--name-only']);
    if (!staged.out.trim()) {
      return err('E_NOTHING', '暂存区是空的，没东西可提交', '先 mode=add（all=true 或给 paths），再 commit');
    }
    const res = await run(['commit', '-m', message]);
    if (res.code !== 0) {
      const hint = /nothing to commit|no changes added/i.test(res.errText + res.out)
        ? '暂存区没有有效改动'
        : '检查 git 身份配置（user.name / user.email）';
      return err('E_GIT', `git commit 失败：${oneLine(res.errText || res.out, 160)}`, hint);
    }
    const head = await run(['log', '-1', '--oneline']);
    return ok('git commit', oneLine(head.out.trim() || message, 160));
  }

  // ── push ───────────────────────────────────────────────────────────────
  const branchRes = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.out.trim() || '(未知分支)';
  const remoteRes = await run(['remote']);
  const remotes = remoteRes.out.split('\n').map((v) => v.trim()).filter(Boolean);
  if (!remotes.length) {
    return err('E_GIT', '这个仓库没有配置远端', '先 git remote add origin <url>，再 push');
  }
  const remote = remotes.includes('origin') ? 'origin' : remotes[0];
  const aheadRes = await run(['rev-list', '--count', `@{u}..HEAD`]);
  const ahead = aheadRes.code === 0 ? Number(aheadRes.out.trim() || 0) : NaN;
  const plan =
    `[plan] 将推送 分支=${branch} → ${remote}/${branch}`
    + (Number.isFinite(ahead) ? `，本地领先 ${ahead} 个提交` : '（没有上游，首次推送会建立跟踪）');

  const pushRes = aheadRes.code === 0
    ? await run(['push'])
    : await run(['push', '-u', remote, branch]);
  if (pushRes.code !== 0) {
    return [
      plan,
      err('E_GIT', `push 失败：${oneLine(pushRes.errText || pushRes.out, 200)}`, '检查权限/网络；被拒就先 pull --rebase'),
    ].join('\n');
  }
  const summary = oneLine((pushRes.out || pushRes.errText || 'ok').trim(), 300);
  return [plan, ok('git push', summary)].join('\n');
}
