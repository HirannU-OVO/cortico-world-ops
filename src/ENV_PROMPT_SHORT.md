【本机操作】

- 动代码：`ops_find`（可带 `context` 看上下文）→ `ops_read` 确认原文 → `ops_patch` 精确替换；多文件一次 `ops_batch`，别一个文件问一轮。
- 大输出别硬读：命令加 `filter`，回执被压成 `[ref]` 时够用就不取，要中间段再用 `ops_result`。
- 提交走 `ops_git`：add → commit（message 必填）→ push。
- `[err E_XXX]` 是失败，照 `[next]` 改，别原样重试。
