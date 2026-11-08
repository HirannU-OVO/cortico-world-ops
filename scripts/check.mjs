/**
 * 静态自检：describe.json 与本包实现必须一致，schema 必须是能发出去的形状。
 * 任何一项不过就以非零码退出。
 */
import { readFileSync } from 'node:fs';

import { handlers } from '../src/tools.ts';
import { Ops } from '../src/ops.ts';

const problems = [];

const describe = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (pkg.cortico?.kind !== 'world') problems.push('package.json cortico.kind 不是 world');
if (pkg.cortico?.api !== 6) problems.push('package.json cortico.api 不是 6');
if (pkg.cortico?.describe !== 'describe.json') problems.push('package.json cortico.describe 没指向 describe.json');

const decls = Array.isArray(describe.tools) ? describe.tools : [];
if (!decls.length) problems.push('describe.json 没有 tools');

const table = handlers(new Ops());
const declared = new Set();
for (const decl of decls) {
  const name = decl?.name;
  if (typeof name !== 'string' || !name) {
    problems.push('有一个工具没写 name');
    continue;
  }
  if (declared.has(name)) problems.push(`工具名重复：${name}`);
  declared.add(name);
  if (!table[name]) problems.push(`describe 里有 ${name}，但没有实现`);
  if (typeof decl.description !== 'string' || !decl.description) problems.push(`${name} 缺 description`);
  if (!Array.isArray(decl.tags) || !decl.tags.length) problems.push(`${name} 缺 tags`);
  const params = decl.parameters;
  if (!params || params.type !== 'object') {
    problems.push(`${name}.parameters 必须是 type=object`);
    continue;
  }
  const props = params.properties ?? {};
  for (const key of params.required ?? []) {
    if (!(key in props)) problems.push(`${name} 的 required 里有 ${key}，但 properties 里没有`);
  }
  for (const [key, spec] of Object.entries(props)) {
    if (!spec || typeof spec !== 'object' || !spec.type) problems.push(`${name}.${key} 缺少 type`);
  }
}
for (const name of Object.keys(table)) {
  if (!declared.has(name)) problems.push(`实现了 ${name}，但 describe.json 里没有`);
}

if (problems.length) {
  console.error('自检失败：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`自检通过：${decls.length} 个工具（${decls.map((d) => d.name).join(' / ')}）`);
