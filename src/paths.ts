/** 路径工具：展开 ~ 与 %VAR%、判定系统目录。ops / git / net 共用。 */
import { homedir } from 'node:os';
import { normalize, resolve, sep } from 'node:path';

/** 展开 ~ 与 %VAR%，统一成绝对路径。 */
export function resolvePath(input: string): string {
  let p = String(input ?? '').trim();
  if (!p) return p;
  p = p.replace(/^~(?=$|[\\/])/, homedir());
  p = p.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
  return normalize(resolve(p));
}

/** 拒绝改写系统目录：写到这些地方基本只会坏事。 */
export function isDeniedWriteTarget(abs: string): boolean {
  const lower = abs.toLowerCase();
  const roots = [
    process.env.SystemRoot?.toLowerCase(),
    process.env.ProgramFiles?.toLowerCase(),
    process.env['ProgramFiles(x86)']?.toLowerCase(),
    'c:\\windows',
  ].filter((v): v is string => Boolean(v));
  return roots.some((root) => lower === root || lower.startsWith(`${root}${sep}`));
}

/** 判断 child 是否落在 parent 目录内（用路径比较，大小写在 Windows 上不敏感）。 */
export function isInside(parent: string, child: string): boolean {
  const norm = (v: string) => (process.platform === 'win32' ? v.toLowerCase() : v);
  const p = norm(normalize(parent)).replace(/[\\/]+$/, '');
  const c = norm(normalize(child));
  return c === p || c.startsWith(`${p}${sep}`);
}
