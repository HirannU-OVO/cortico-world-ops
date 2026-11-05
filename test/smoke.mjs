/**
 * 行为冒烟：每个工具至少一条「不回退就红」的断言。
 * 用临时目录，跑完自己清理；不碰用户真实文件。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ops } from '../src/ops.ts';

const ops = new Ops();
const root = mkdtempSync(join(tmpdir(), 'ops-smoke-'));
let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

try {
  // ── ops_write ──────────────────────────────────────────────────────────
  const file = join(root, 'note.md', 'demo.txt');
  const w1 = ops.write({ path: file, content: 'alpha\nbeta\ngamma\n' });
  check('write 建目录并写盘', w1.startsWith('[ok write]') && readFileSync(file, 'utf8').includes('beta'), w1);

  const w2 = ops.write({ path: file, content: 'delta\n', mode: 'append' });
  check('write append 追加', w2.startsWith('[ok write]') && readFileSync(file, 'utf8').endsWith('delta\n'), w2);

  // ── ops_read ───────────────────────────────────────────────────────────
  const r1 = ops.read({ path: file });
  check('read 带行号', /^1\| alpha$/m.test(r1), r1);
  const r2 = ops.read({ path: file });
  check('read 未变时回 unchanged', r2.startsWith('[ok unchanged]'), r2);
  const r3 = ops.read({ path: file, fresh: true });
  check('read fresh 强制重发', r3.includes('1| alpha'), r3);
  const r4 = ops.read({ path: file, offset: 2, limit: 1 });
  check('read offset/limit 生效', r4.includes('2| beta') && !r4.includes('3| gamma'), r4);
  const r5 = ops.read({ path: join(root, 'nope.txt') });
  check('read 缺文件回 E_READ', r5.startsWith('[err E_READ]'), r5);

  // 大文件必须封顶
  const big = join(root, 'big.txt');
  writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `line ${i} `.repeat(6)).join('\n'), 'utf8');
  const rBig = ops.read({ path: big });
  check('read 大文件被截断并给续读指针', rBig.includes('[next]') && rBig.length < 20000, `${rBig.length} 字符`);

  // ── ops_patch ──────────────────────────────────────────────────────────
  const p1 = ops.patch({ path: file, old: 'gamma', new: 'GAMMA!' });
  check('patch 唯一匹配替换成功', p1.startsWith('[ok patch]') && readFileSync(file, 'utf8').includes('GAMMA!'), p1);

  const dup = join(root, 'dup.txt');
  writeFileSync(dup, 'same\nsame\n', 'utf8');
  const p2 = ops.patch({ path: dup, old: 'same', new: 'diff' });
  check('patch 多处匹配回 E_AMBIGUOUS', p2.startsWith('[err E_AMBIGUOUS]'), p2);

  const p3 = ops.patch({ path: dup, old: 'same', new: 'diff', all: true });
  check('patch all=true 全换', p3.startsWith('[ok patch]') && readFileSync(dup, 'utf8') === 'diff\ndiff\n', p3);

  const p4 = ops.patch({ path: file, old: '不存在的原文', new: 'x' });
  check('patch 找不到回 E_NOTFOUND', p4.startsWith('[err E_NOTFOUND]'), p4);

  // ── ops_find ───────────────────────────────────────────────────────────
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'sub', 'other.md'), 'TODO: 修一下\nnothing\n', 'utf8');
  const f1 = ops.find({ pattern: 'TODO', path: root, mode: 'content' });
  check('find content 命中并带行号', f1.includes('other.md:1') && f1.includes('TODO'), f1);
  const f2 = ops.find({ pattern: '**/*.md', path: root, mode: 'files' });
  check('find files 按 glob 列出', f2.includes('other.md'), f2);
  const f3 = ops.find({ pattern: '[[[', path: root, mode: 'content' });
  check('find 非法正则回 E_REGEX', f3.startsWith('[err E_REGEX]'), f3);
  const f4 = ops.find({ pattern: 'zzz-不存在', path: root, mode: 'content' });
  check('find 无命中时给下一步建议', f4.includes('[next]'), f4);

  // ── ops_sh ─────────────────────────────────────────────────────────────
  const s1 = await ops.sh({ command: 'Write-Output "你好 ops"' });
  check('sh 正常返回并保住中文', s1.startsWith('[ok sh]') && s1.includes('你好 ops'), s1);
  const s2 = await ops.sh({ command: 'no-such-cmd-xyz' });
  check('sh 失败回 E_EXIT 且标 effect unknown', s2.startsWith('[err E_EXIT]') && s2.includes('[effect unknown]'), s2);

  // ── ops_tree ───────────────────────────────────────────────────────────
  const t1 = ops.tree({ path: root, depth: 2 });
  check('tree 列出目录结构', t1.startsWith('[ok tree]') && t1.includes('sub') && t1.includes('big.txt'), t1);
  const t2 = ops.tree({ path: join(root, '不存在') });
  check('tree 不存在的目录回 E_PATH', t2.startsWith('[err E_PATH]'), t2);

  // ── ops_git ────────────────────────────────────────────────────────────
  const g1 = await ops.git({ path: tmpdir() });
  check('git 非仓库路径回 E_GIT', g1.startsWith('[err E_GIT]'), g1);
  const selfRepo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const g2 = await ops.git({ path: selfRepo, mode: 'status' });
  check('git status 能在真实仓库上跑', g2.startsWith('[ok git status]'), g2);
  const g3 = await ops.git({ path: selfRepo, mode: 'log', maxLines: 5 });
  check('git log 有界返回', g3.startsWith('[ok git log]') || g3.startsWith('[err E_GIT]'), g3);

  // ── ops_batch ──────────────────────────────────────────────────────────
  const b1 = await ops.batch({
    reads: [{ path: file }],
    finds: [{ pattern: 'TODO', path: root, mode: 'content' }],
    shells: [{ command: 'Write-Output batch-ok' }],
  });
  check('batch 一次跑三类且汇总', b1.startsWith('[ok batch]') && b1.includes('batch-ok') && b1.includes('— read #1'), b1);
  const b2 = await ops.batch({});
  check('batch 空参数回 E_INPUT', b2.startsWith('[err E_INPUT]'), b2);

  // batch 里批量改多个文件：这是「改代码」的主路径
  const fileA = join(root, 'code', 'a.ts');
  const fileB = join(root, 'code', 'b.ts');
  ops.write({ path: fileA, content: 'const a = 1;\nexport { a };\n' });
  ops.write({ path: fileB, content: 'const b = 1;\nexport { b };\n' });
  const b3 = await ops.batch({
    patches: [
      { path: fileA, old: 'const a = 1;', new: 'const a = 42;' },
      { path: fileB, old: 'const b = 1;', new: 'const b = 43;' },
    ],
  });
  const patched = readFileSync(fileA, 'utf8').includes('42') && readFileSync(fileB, 'utf8').includes('43');
  check('batch 批量打补丁（多文件一次改完）', b3.startsWith('[ok batch]') && b3.includes('改 2') && patched, b3);
  const b4 = await ops.batch({
    patches: [
      { path: fileA, old: '不存在的片段', new: 'x' },
      { path: fileB, old: 'const b = 43;', new: 'const b = 44;' },
    ],
  });
  check('batch 一条失败不影响后续', b4.includes('失败 1') && readFileSync(fileB, 'utf8').includes('44'), b4);

  // ── ops_fetch（本地假服务器，不依赖外网）─────────────────────────────
  const server = createServer((req, res) => {
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>测试页</title><style>.a{color:red}</style></head><body>'
          + '<script>var secret=1</script><nav>导航菜单</nav>'
          + '<h1>标题</h1><p>正文 &amp; 实体</p></body></html>',
      );
    } else if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a":1,"b":[2,3]}');
    } else if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('x'.repeat(5000));
    } else {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><p>没有这个页面</p></body></html>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const h = await ops.fetchUrl({ url: `${base}/html` });
    check(
      'fetch 剥标签、留标题、解实体',
      h.startsWith('[ok fetch]') && h.includes('测试页') && h.includes('正文 & 实体'),
      h,
    );
    check('fetch 丢掉 script/nav 里的内容', !h.includes('secret') && !h.includes('导航菜单'), h);

    const j = await ops.fetchUrl({ url: `${base}/json` });
    check('fetch JSON 自动格式化', j.includes('"a": 1'), j);

    const big = await ops.fetchUrl({ url: `${base}/big`, maxChars: 200 });
    check('fetch 正文按 maxChars 封顶并给 next', big.includes('[next]') && big.length < 600, `${big.length} 字符`);

    const missing = await ops.fetchUrl({ url: `${base}/nope` });
    check('fetch 4xx 明确标注', missing.includes('[note] HTTP 404'), missing);

    const badScheme = await ops.fetchUrl({ url: 'file:///C:/Windows/win.ini' });
    check('fetch 非 http(s) 回 E_INPUT', badScheme.startsWith('[err E_INPUT]'), badScheme);

    const rawHtml = await ops.fetchUrl({ url: `${base}/html`, raw: true });
    check('fetch raw=true 保留原始标签', rawHtml.includes('<h1>') && rawHtml.includes('<script>'), rawHtml.slice(0, 200));

    const dead = await ops.fetchUrl({ url: 'http://127.0.0.1:1/x' });
    check('fetch 连不上回 E_FETCH', dead.startsWith('[err E_FETCH]'), dead);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // ── 安全边界 ───────────────────────────────────────────────────────────
  const d1 = ops.write({ path: 'C:\\Windows\\ops-should-not-write.txt', content: 'x' });
  check('write 拒绝写系统目录', d1.startsWith('[err E_DENY]'), d1);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} 条断言失败`);
  process.exit(1);
}
console.log('\n全部断言通过');
