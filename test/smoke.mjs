/**
 * 行为冒烟：每个工具至少一条「不回退就红」的断言。
 * 用临时目录，跑完自己清理；不碰用户真实文件。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ops } from '../src/ops.ts';
import { gitOp as git } from '../src/git.ts';
import { imageOp } from '../src/image.ts';
import { buildTools, loadDescribe } from '../src/tools.ts';
import { fetchUrl as fetchTool } from '../src/net.ts';
import { readStashed, summarizeIfLong } from '../src/results.ts';
import { resolveLimits, opsConfigGroups, missingDefaults, cloneDefaults, CONFIG_ITEMS } from '../src/config.ts';
import { seedConfigFile } from '../src/seed.ts';
import { OpsWorld } from '../src/definition.ts';

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
  const g1 = await git({ path: tmpdir() });
  check('git 非仓库路径回 E_GIT', g1.startsWith('[err E_GIT]'), g1);
  const selfRepo = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const g2 = await git({ path: selfRepo, mode: 'status' });
  check('git status 能在真实仓库上跑', g2.startsWith('[ok git status]'), g2);
  const g3 = await git({ path: selfRepo, mode: 'log', maxLines: 5 });
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
    const h = await fetchTool({ url: `${base}/html` });
    check(
      'fetch 剥标签、留标题、解实体',
      h.startsWith('[ok fetch]') && h.includes('测试页') && h.includes('正文 & 实体'),
      h,
    );
    check('fetch 丢掉 script/nav 里的内容', !h.includes('secret') && !h.includes('导航菜单'), h);

    const j = await fetchTool({ url: `${base}/json` });
    check('fetch JSON 自动格式化', j.includes('"a": 1'), j);

    const big = await fetchTool({ url: `${base}/big`, maxChars: 200 });
    check('fetch 正文按 maxChars 封顶并给 next', big.includes('[next]') && big.length < 600, `${big.length} 字符`);

    const missing = await fetchTool({ url: `${base}/nope` });
    check('fetch 4xx 明确标注', missing.includes('[note] HTTP 404'), missing);

    const badScheme = await fetchTool({ url: 'file:///C:/Windows/win.ini' });
    check('fetch 非 http(s) 回 E_INPUT', badScheme.startsWith('[err E_INPUT]'), badScheme);

    const rawHtml = await fetchTool({ url: `${base}/html`, raw: true });
    check('fetch raw=true 保留原始标签', rawHtml.includes('<h1>') && rawHtml.includes('<script>'), rawHtml.slice(0, 200));

    const dead = await fetchTool({ url: 'http://127.0.0.1:1/x' });
    check('fetch 连不上回 E_FETCH', dead.startsWith('[err E_FETCH]'), dead);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }


  // ── 新特性：find context / since ──────────────────────────────────────
  const ctxDir = join(root, 'ctx');
  mkdirSync(ctxDir, { recursive: true });
  const ctxFile = join(ctxDir, 'ctx.txt');
  writeFileSync(ctxFile, ['L1 前文', 'L2 前文', 'L3 命中标记', 'L4 后文', 'L5 后文'].join('\n'), 'utf8');
  const fc = ops.find({ pattern: '命中标记', path: ctxDir, mode: 'content', context: 1 });
  check(
    'find context 带前后各一行',
    fc.includes('ctx.txt:2') && fc.includes('ctx.txt:3>') && fc.includes('ctx.txt:4') && !fc.includes('ctx.txt:1 '),
    fc,
  );

  const sinceRecent = ops.find({ pattern: '**/*.txt', path: ctxDir, mode: 'files', since: '10m' });
  check('find since=10m 能看见刚写的文件', sinceRecent.includes('ctx.txt'), sinceRecent);
  const sinceOld = ops.find({ pattern: '**/*.txt', path: ctxDir, mode: 'files', since: '1s' });
  const sinceBad = ops.find({ pattern: 'x', path: ctxDir, mode: 'files', since: '一会儿以前' });
  check('find since 看不懂时回 E_INPUT', sinceBad.startsWith('[err E_INPUT]'), sinceBad);

  // ── 新特性：sh filter ─────────────────────────────────────────────────
  const scriptPath = join(root, 'noisy.ps1');
  writeFileSync(
    scriptPath,
    '1..400 | ForEach-Object { if ($_ -eq 200) { "ERROR key-line-200" } else { "noise line $_" } }',
    'utf8',
  );
  const noisy = await ops.sh({ scriptPath });
  check('sh 头尾截断会丢掉中间行', !noisy.includes('key-line-200'), '第 60 行不该出现（被截断）');
  const filtered = await ops.sh({ scriptPath, filter: 'ERROR' });
  check(
    'sh filter 只留匹配行并报命中数',
    filtered.includes('key-line-200') && filtered.includes('[filter] stdout 命中 1 行'),
    filtered,
  );
  const filteredCtx = await ops.sh({ scriptPath, filter: 'ERROR', filterContext: 1 });
  check('sh filterContext 带上相邻行', filteredCtx.includes('noise line 199') || filteredCtx.includes('noise line 201'), filteredCtx);
  const badFilter = await ops.sh({ command: 'Write-Output ok', filter: '[[' });
  check('sh filter 非法正则回 E_REGEX', badFilter.startsWith('[err E_REGEX]'), badFilter);

  // ── 新特性：fetch POST / headers ──────────────────────────────────────
  const postServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, auth: req.headers['x-token'] ?? '', body }));
    });
  });
  await new Promise((resolve) => postServer.listen(0, '127.0.0.1', resolve));
  const postPort = postServer.address().port;
  try {
    const posted = await fetchTool({
      url: `http://127.0.0.1:${postPort}/echo`,
      method: 'POST',
      body: '{"ping":1}',
      headers: ['X-Token: secret123'],
    });
    check('fetch POST 带 body 与自定义头', posted.includes('"method": "POST"') && posted.includes('secret123'), posted);
    const getWithBody = await fetchTool({ url: `http://127.0.0.1:${postPort}/echo`, body: 'x' });
    check('fetch GET 带 body 回 E_INPUT', getWithBody.startsWith('[err E_INPUT]'), getWithBody);
    const badHeader = await fetchTool({ url: `http://127.0.0.1:${postPort}/echo`, headers: ['没有冒号'] });
    check('fetch 请求头格式不对回 E_INPUT', badHeader.startsWith('[err E_INPUT]'), badHeader);
  } finally {
    await new Promise((resolve) => postServer.close(resolve));
  }

  // ── 新特性：batch from / $prev ────────────────────────────────────────
  const fromBatch = await ops.batch({
    finds: [{ pattern: '**/*.txt', path: ctxDir, mode: 'files' }],
    reads: [{ from: '1' }],
  });
  check(
    'batch 用 from 把 find 结果直接读掉',
    fromBatch.includes('由 from 展开 1 次读') && fromBatch.includes('命中标记'),
    fromBatch,
  );
  const prevBatch = await ops.batch({
    finds: [{ pattern: 'ctx.txt', path: ctxDir, mode: 'files' }],
    reads: [{ path: '$prev' }],
  });
  check('batch 用 $prev 传单个路径', prevBatch.includes('ctx.txt') && !prevBatch.includes('[err'), prevBatch);
  const missingRef = await ops.batch({ reads: [{ from: '1' }] });
  check('batch from 指向不存在的 finds 会报错', missingRef.includes('E_BATCH_REF'), missingRef);

  // ── 新特性：read 拒绝二进制 ───────────────────────────────────────────
  const binFile = join(root, 'blob.bin');
  writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]));
  const binRead = ops.read({ path: binFile });
  check('read 二进制文件直接拒绝', binRead.startsWith('[err E_BINARY]'), binRead);

  // ── ops_image：读图并随回执附字节 ────────────────────────────────────────
  // 1×1 真实 PNG（黑点），不是占位字节。
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const pngFile = join(root, 'pixel.png');
  writeFileSync(pngFile, PNG_1PX);

  const img1 = await imageOp({ path: pngFile });
  check(
    'ops_image 附上单张图片',
    typeof img1 === 'object' && img1.blobs?.length === 1
      && img1.blobs[0].mime === 'image/png' && img1.text.startsWith('[ok image]'),
    String(typeof img1 === 'object' ? img1.text : img1).slice(0, 120),
  );

  const img2 = await imageOp({ path: pngFile, paths: [pngFile, pngFile] });
  check('ops_image 多路径去重合并', typeof img2 === 'object' && img2.blobs?.length === 1, String(typeof img2 === 'object' ? img2.text : img2));

  const img3 = await imageOp({ path: join(root, 'missing.png') });
  check('ops_image 缺文件回 E_PATH', typeof img3 === 'string' && img3.startsWith('[err E_PATH]'), img3);

  const img4 = await imageOp({ path: join(root, 'blob.bin') });
  check('ops_image 不认的扩展名回 E_MIME', typeof img4 === 'string' && img4.startsWith('[err E_MIME]'), img4);

  const img5 = await imageOp({});
  check('ops_image 空参数回 E_INPUT', typeof img5 === 'string' && img5.startsWith('[err E_INPUT]'), img5);

  const img6 = await imageOp({ paths: [pngFile, join(root, 'missing.png')] });
  check(
    'ops_image 部分失败时好图照附、坏图说明',
    typeof img6 === 'object' && img6.blobs?.length === 1 && img6.text.includes('[err E_PATH]'),
    String(typeof img6 === 'object' ? img6.text : img6).slice(0, 120),
  );

  const pngA = join(root, 'a.png');
  const pngB = join(root, 'b.png');
  const pngC = join(root, 'c.png');
  const pngD = join(root, 'd.png');
  for (const p of [pngA, pngB, pngC, pngD]) writeFileSync(p, PNG_1PX);
  const img7 = await imageOp({ paths: [pngA, pngB, pngC, pngD] }, resolveLimits({ image: { maxFiles: 2 } }));
  check(
    'ops_image 张数上限听面板值',
    typeof img7 === 'string' && img7.includes('一次最多 2 张'),
    String(typeof img7 === 'string' ? img7 : JSON.stringify(img7).slice(0, 120)),
  );

  // buildTools 接线：blobs 必须原样透传到宿主回执。
  const wired = buildTools(new Ops(), loadDescribe().tools).find((t) => t.name === 'ops_image');
  const wiredOut = await wired.handler({ path: pngFile });
  check(
    'buildTools 透传 blobs 到回执',
    typeof wiredOut === 'object' && wiredOut.blobs?.length === 1 && typeof wiredOut.text === 'string',
    String(typeof wiredOut === 'object' ? wiredOut.text : wiredOut).slice(0, 120),
  );

  // ── ops_image 图生文：面板配了看图模型时回执带 [vision] 描述 ──────────────
  const visionSeen = { model: '', auth: '' };
  const visionServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let got = {};
      try { got = JSON.parse(body); } catch { /* 坏请求按无图处理 */ }
      const content = got?.messages?.[0]?.content;
      const hasImg = Array.isArray(content)
        && content.some((p) => p?.type === 'image_url' && String(p?.image_url?.url || '').startsWith('data:image/png;base64,'));
      visionSeen.model = String(got?.model ?? '');
      visionSeen.auth = String(req.headers.authorization ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: hasImg ? '测试描述：一张黑点图' : 'no image part' } }] }));
    });
  });
  await new Promise((resolve) => visionServer.listen(0, '127.0.0.1', resolve));
  const visionPort = visionServer.address().port;
  try {
    const vLimits = resolveLimits({
      image: { visionModel: 'test-vision', visionBaseUrl: `http://127.0.0.1:${visionPort}/v1`, visionKey: 'test-key' },
    });
    const imgV = await imageOp({ path: pngFile }, vLimits);
    check(
      'ops_image 配了看图模型回执带 [vision] 描述',
      typeof imgV === 'object' && imgV.text.includes('[vision]') && imgV.text.includes('测试描述'),
      String(typeof imgV === 'object' ? imgV.text : imgV).slice(0, 200),
    );
    check('看图请求带上模型名与密钥', visionSeen.model === 'test-vision' && visionSeen.auth === 'Bearer test-key', JSON.stringify(visionSeen));

    // 面板密钥留空时回退环境变量 OPS_VISION_KEY。
    process.env.OPS_VISION_KEY = 'env-key';
    try {
      const imgEnv = await imageOp(
        { path: pngFile },
        resolveLimits({ image: { visionModel: 'test-vision', visionBaseUrl: `http://127.0.0.1:${visionPort}/v1`, visionKey: '' } }),
      );
      check(
        '看图密钥留空回退环境变量 OPS_VISION_KEY',
        typeof imgEnv === 'object' && imgEnv.text.includes('[vision]') && visionSeen.auth === 'Bearer env-key',
        `auth=${visionSeen.auth}`,
      );
    } finally {
      delete process.env.OPS_VISION_KEY;
    }

    const imgNoV = await imageOp({ path: pngFile });
    check(
      'ops_image 没配看图模型不带 [vision]',
      typeof imgNoV === 'object' && !imgNoV.text.includes('[vision]'),
      String(typeof imgNoV === 'object' ? imgNoV.text : imgNoV).slice(0, 120),
    );
  } finally {
    visionServer.close();
  }

  // ── 新特性：git add / commit / push（本地裸库当远端）──────────────────
  const repoDir = join(root, 'gitcheck');
  const bareDir = join(root, 'bare.git');
  mkdirSync(repoDir, { recursive: true });
  await execFileAsync('git', ['init', '--bare', '-q', bareDir]);
  await execFileAsync('git', ['init', '-q'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: repoDir });
  await execFileAsync('git', ['remote', 'add', 'origin', bareDir], { cwd: repoDir });
  writeFileSync(join(repoDir, 'a.txt'), 'hello\n', 'utf8');

  const gAdd = await git({ path: repoDir, mode: 'add', all: true });
  check('git add -A 暂存成功', gAdd.startsWith('[ok git add]') && gAdd.includes('a.txt'), gAdd);
  const gCommitNoMsg = await git({ path: repoDir, mode: 'commit' });
  check('git commit 缺 message 被拒', gCommitNoMsg.startsWith('[err E_INPUT]'), gCommitNoMsg);
  const gCommit = await git({ path: repoDir, mode: 'commit', message: 'test: 首次提交' });
  check('git commit 带 message 成功', gCommit.startsWith('[ok git commit]'), gCommit);
  const gPush = await git({ path: repoDir, mode: 'push' });
  check('git push 先打印计划再推', gPush.includes('[plan] 将推送') && gPush.includes('[ok git push]'), gPush);
  const outside = await git({ path: repoDir, mode: 'add', paths: ['C:\\Windows\\win.ini'] });
  check('git add 仓库外路径被拒', outside.startsWith('[err E_OUTSIDE]'), outside);


  // ── 长回执转存 + ops_result 取回 ────────────────────────────────────────
  const bigRaw = await ops.sh({ command: '1..60 | ForEach-Object { ("x" * 200) + " line $_" }' });
  const bigOut = summarizeIfLong(bigRaw, 'ops_sh');
  check('超长回执被压成摘要（不再是全文）', bigOut.length < 4000, `${bigOut.length} 字符`);
  const refMatch = /\[ref (r[0-9a-z]+)\]/.exec(bigOut);
  check('摘要里给出 ref', Boolean(refMatch), bigOut.slice(0, 200));
  if (refMatch) {
    const fetched = readStashed({ ref: refMatch[1], offset: 0, maxChars: 200 });
    check('ops_result 能按 ref 取回', fetched.startsWith('[ok result]') && fetched.includes('line'), fetched.slice(0, 200));
    const paged = readStashed({ ref: refMatch[1], offset: 200, maxChars: 100 });
    check('ops_result 支持偏移分页', paged.includes('offset') || paged.includes('第 200-'), paged.slice(0, 120));
    const missing = readStashed({ ref: 'r-not-exist' });
    check('ops_result 引用不存在回 E_REF', missing.startsWith('[err E_REF]'), missing);
  }


  // ── 配置项：面板改完即时生效 ───────────────────────────────────────────
  const tight = resolveLimits({ read: { lines: 25 }, sh: { head: 12, tail: 6 }, fetch: { chars: 900 } });
  check('resolveLimits 读得到面板值', tight.readLines === 25 && tight.shHead === 12 && tight.fetchChars === 900, JSON.stringify(tight));
  const clamped = resolveLimits({ read: { lines: 999999 }, find: { maxResults: -5 } });
  check(
    'resolveLimits 越界会夹紧',
    clamped.readLines === 2000 && clamped.findResults === 5,
    JSON.stringify(clamped),
  );
  const imgLimits = resolveLimits({ image: { maxMb: 30, maxTotalMb: 0, maxFiles: 99 } });
  check(
    '看图上限听面板值且越界夹紧',
    imgLimits.imageMaxMb === 30 && imgLimits.imageMaxTotalMb === 1 && imgLimits.imageMaxFiles === 20,
    JSON.stringify(imgLimits),
  );
  check(
    '看图上限默认 15 MB / 40 MB / 6 张',
    (() => { const d = resolveLimits(undefined); return d.imageMaxMb === 15 && d.imageMaxTotalMb === 40 && d.imageMaxFiles === 6; })(),
    JSON.stringify(resolveLimits(undefined)),
  );

  const longFile = join(root, 'long.txt');
  writeFileSync(longFile, Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join('\n'), 'utf8');
  const tightOps = new Ops(() => resolveLimits({ read: { lines: 25 } }));
  const tightRead = tightOps.read({ path: longFile });
  const tightLines = tightRead.split('\n').filter((l) => /^\d+\| /.test(l)).length;
  check('ops_read 听从面板的默认行数', tightLines === 25, `给了 ${tightLines} 行`);

  const tightSum = summarizeIfLong('y'.repeat(3000), 'ops_sh', 1000);
  check('转存阈值可调（1000 就转）', tightSum.includes('[ref ') && tightSum.length < 2500, `${tightSum.length} 字符`);
  const looseSum = summarizeIfLong('y'.repeat(3000), 'ops_sh', 10000);
  check('阈值调大就不转存', !looseSum.includes('[ref ') && looseSum.length === 3000, `${looseSum.length} 字符`);

  // 环境提示词：模板直出，不经变量注入
  const cfg = new OpsWorld({ cfg: {} });
  check('环境提示词不注入变量', Object.keys(cfg.envPromptVars() ?? {}).length === 0, JSON.stringify(cfg.envPromptVars()));
  const promptFile = fileURLToPath(new URL('../src/ENV_PROMPT.md', import.meta.url));
  const promptText = readFileSync(promptFile, 'utf8');
  check('提示词模板正文包含 ops_batch', promptText.includes('ops_batch'), promptText.slice(0, 120));
  check('提示词模板不含占位符', !promptText.includes('{{'), promptText.slice(0, 120));

  const groups = opsConfigGroups();
  const byKey = new Map(groups.flatMap((g) => Object.keys(g.schema.properties).map((k) => [k, g.schema.properties[k]])));
  const props = [...byKey.keys()];
  check(
    '面板按工具分组且键带 worlds.ops 前缀',
    groups.length === 4
      && groups.every((g) => g.owner === 'world:ops' && typeof g.schema.title === 'string' && g.schema.title)
      && props.includes('worlds.ops.image.maxMb')
      && props.every((k) => k.startsWith('worlds.ops.')),
    props.join(','),
  );
  check(
    '每个面板项都有标题',
    props.every((k) => typeof byKey.get(k).title === 'string' && byKey.get(k).title.length > 0),
    props.join(','),
  );

  // 入口转发：宿主从 index.ts 导入，转发里出现悬空导出名会在加载期炸掉。
  const entry = await import('../src/index.ts');
  check(
    '入口 index.ts 可导入（转发导出名不悬空）',
    typeof entry.Ops === 'function' && typeof entry.opsConfigGroups === 'function' && Array.isArray(entry.CONFIG_ITEMS),
    Object.keys(entry).slice(0, 10).join(','),
  );

  // 已存在的段不会自动补默认（内核只用 ??=），所以要自己补：
  const needAll = missingDefaults({});
  check(
    '空配置时补丁覆盖全部项',
    Object.keys(needAll).length === 6 && Object.keys(needAll.read).length === 2 && needAll.result.page === 3000 && needAll.image?.visionModel === '',
    JSON.stringify(needAll),
  );
  const partial = missingDefaults({ read: { lines: 55 } });
  check(
    '只补缺失项，不覆盖用户已改的值',
    partial.read?.lines === undefined && partial.read?.bytes === 8000 && partial.sh?.head === 60,
    JSON.stringify(partial),
  );
  check('全部就位时补丁为空', Object.keys(missingDefaults({ ...needAll })).length === 0, '');

  // 用户改过的不许被覆盖：0 和显式 false 也算「已设置」
  const userSet = missingDefaults({ read: { lines: 0 }, sh: { head: 0, tail: 0 } });
  check(
    '用户设成 0 时不再补默认',
    userSet.read?.lines === undefined && userSet.sh === undefined,
    JSON.stringify(userSet),
  );

  // defaults() 必须是独立拷贝：内核会把返回值当活配置写
  const a = cloneDefaults();
  a.read.lines = 1;
  a.result.page = 1;
  const b = cloneDefaults();
  check('defaults 深拷贝互不影响', b.read.lines === 100 && b.result.page === 3000, JSON.stringify(b));


  // ── 新增配置项的自动覆盖（这次的重点）──────────────────────────────────
  // 单一来源 CONFIG_ITEMS：schema 里每一项都必须有默认值，且缺项补丁必须覆盖它。
  const allPatch = missingDefaults({});
  const missingInPatch = CONFIG_ITEMS
    .map((it) => it.path)
    .filter((path) => {
      let cur = allPatch;
      for (const seg of path.split('.')) {
        if (cur === null || typeof cur !== 'object') return true;
        cur = cur[seg];
      }
      return cur === undefined;
    });
  check('每个配置项都有默认值补丁（加新项自动覆盖）', missingInPatch.length === 0, missingInPatch.join(','));

  const unprefixed = CONFIG_ITEMS.filter((it) => !groups.some((g) => `worlds.ops.${it.path}` in g.schema.properties));
  check('每个配置项都在面板 schema 里', unprefixed.length === 0, unprefixed.map((i) => i.path).join(','));

  const badRange = CONFIG_ITEMS.filter((it) => typeof it.fallback === 'number'
    && (typeof it.schema.minimum === 'number' ? it.fallback < it.schema.minimum : false
      || typeof it.schema.maximum === 'number' ? it.fallback > it.schema.maximum : false));
  check('默认值落在面板范围里', badRange.length === 0, badRange.map((i) => i.path).join(','));

  // 落盘兜底：只补缺项，保留用户值与其它字段
  const seedDir = join(root, 'seedtest');
  mkdirSync(seedDir, { recursive: true });
  const seedFile = join(seedDir, 'config.json');
  writeFileSync(
    seedFile,
    JSON.stringify({ displayName: '测试', worlds: { ops: { enabled: true, read: { lines: 42 } } } }, null, 2),
    'utf8',
  );
  const seeded = seedConfigFile(seedDir, { worlds: { ops: missingDefaults({ read: { lines: 42 } }) } });
  const after = JSON.parse(readFileSync(seedFile, 'utf8'));
  check('seedConfigFile 写回成功', seeded.ok && seeded.added.length > 0, JSON.stringify(seeded));
  check('seed 保留用户已改的值', after.worlds.ops.read.lines === 42, JSON.stringify(after.worlds.ops.read));
  check('seed 补上缺的项', after.worlds.ops.fetch?.chars === 3500, JSON.stringify(after.worlds.ops));
  check('seed 不破坏其它字段', after.displayName === '测试' && after.worlds.ops.enabled === true, JSON.stringify(after).slice(0, 80));

  const noPatch = seedConfigFile(seedDir, { worlds: { ops: {} } });
  check('无缺项时不写文件', noPatch.ok && noPatch.added.length === 0, JSON.stringify(noPatch));

  // ── 安全边界 ───────────────────────────────────────────────────────────
  const d1 = ops.write({ path: 'C:\\Windows\\ops-should-not-write.txt', content: 'x' });
  check('write 拒绝写系统目录', d1.startsWith('[err E_DENY]'), d1);
} finally {
  // Windows 上刚退出的子进程/杀软可能短暂占着句柄，重试几次再放弃清理。
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (e) {
    console.warn(`\n[警告] 临时目录清理失败（断言结果不受影响）：${e?.code ?? e}`);
  }
}

if (failures) {
  console.error(`\n${failures} 条断言失败`);
  process.exit(1);
}
console.log('\n全部断言通过');
