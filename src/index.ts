/** 扩展入口：默认导出 WorldDefinition。 */
export { OPS as default } from './definition.ts';
export { OpsWorld, type OpsConfig } from './definition.ts';
export { loadDescribe, handlers, assertCoverage } from './tools.ts';
export { Ops, clearReadMemo } from './ops.ts';
export { CONFIG_ITEMS, cloneDefaults, opsConfigGroup, resolveLimits, missingDefaults } from './config.ts';
export { seedConfigFile } from './seed.ts';
export type { OpsConfig, OpsLimits } from './config.ts';
export { resolvePath, isDeniedWriteTarget, isInside } from './paths.ts';
export { gitOp } from './git.ts';
export { fetchUrl } from './net.ts';
export { readStashed, stash, summarizeIfLong, clearResultStore } from './results.ts';
