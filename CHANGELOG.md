# 更新日志

本文件记录 `cortico-world-ops` 的版本变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

开发中的下一版（`package.json` 里记为 `0.2.0-dev.1`）。按规范，正式发布打 Tag 时再把这里整合成 `0.2.0` 条目。

### 新增

- **`ops_tree`**：按深度列目录结构，跳过依赖/缓存目录，超出条目上限时明说还剩多少——用于低代价摸清一个项目。
- **`ops_git`**：只读的 `status` / `diff` / `log`，输出有界（`maxLines`），`diff` 先给 `--stat` 再给截断后的正文；非仓库路径返回 `E_GIT`。
- **`ops_fetch`**：抓网页或接口。HTML 剥成正文（丢 script/style/nav/footer、解实体、提取 `<title>`），JSON 自动格式化，按 `maxChars`（默认 6000，上限 30000）封顶；支持 `raw=true` 看原始 HTML；响应体超过 8 MB 回 `E_TOO_BIG` 并建议用 `ops_sh` + curl 落盘；4xx/5xx 会明确标注「这是错误页的正文」。
- **`ops_batch` 支持改代码**：除 `reads` / `finds` / `shells`，新增 `patches[]` 与 `writes[]`；逐条独立成败，一条失败不影响后续，汇总里给出「改 N / 写 M / 失败 K」。
- **环境提示词**（`src/ENV_PROMPT.md`，`worlds.ops.envPrompt`）：随扩展注入一段用法约定——先 `ops_tree` 摸结构、改代码用 `ops_patch`、多文件一次 `ops_batch`、`[err E_XXX]` 照 `[next]` 改而不是原样重试。

### 升级提示

- 新增工具会进 schema。如果旧版 `cortico-world-devtools` 还开着，请关掉它，避免 `sh` / `fs_read` / `fs_write` / `web_fetch` 重复占字节。

## [0.1.0] - 2026-11-06


首个版本：把「读、写、改、找、跑命令」做成一套有界、可批量、失败可判读的工具。

### 新增

- **`ops_read`**：带行号读取；按行数与字节双重封顶；同一范围且内容未变时只回 `[ok unchanged]`（`fresh` 可强制重发）；行数未到文件末尾时给出 `offset` 续读指针。
- **`ops_write`**：覆盖/追加两种模式，自动建父目录；拒绝写入 `%SystemRoot%`、`Program Files` 等系统目录（`E_DENY`）。
- **`ops_patch`**：以一段原文精确替换；原文不唯一时拒绝执行并报出出现次数与行号（`E_AMBIGUOUS`），确认后才可用 `all=true` 全换。
- **`ops_find`**：`files` 模式按 glob（支持 `**`、`?`、`!` 排除）列文件；`content` 模式按正则搜内容；两者都分页并给出 `cursor`；命中上限或扫描上限被触发时明确声明「不是全部」。
- **`ops_sh`**：跑 PowerShell 命令或 `.ps1`（`scriptPath`），统一 UTF-8 输出，留头 80 行 + 尾 30 行；非零退出返回 `E_EXIT` 并标 `[effect unknown]`。
- **`ops_batch`**：一次调用顺序执行多组读取/查找/命令，每条结果单独封顶（1200 字符），整批 14000 字符封顶——用来减少「读一条问一轮」造成的上下文重发。
- **一致性自检**：`describe.json` 是 schema 的唯一来源，启动时与实现比对，不一致会在日志里点名；`npm run check` / `npm test` 可离线验证。

### 设计取舍

- 不引入任何第三方依赖，只用 `node:fs`、`node:path`、`node:child_process`；
- 工具失败一律返回字符串回执，不向宿主抛异常，避免把主循环带崩；
- 宁可在回执里多写一行「截断了、还剩多少」，也不静默丢内容。
