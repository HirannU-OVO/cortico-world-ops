【本机操作】

- `ops_tree` 按 `depth` 列目录结构；`ops_find` 按 `pattern` 找文件或搜内容。
- `ops_find` 带 `context` 时返回命中行的前后若干行；带 `since` 时只看该时间后改动过的文件。
- `ops_patch` 精确替换：`old` 需在文件内逐字一致且唯一；报 `E_AMBIGUOUS` 时加 `all=true` 全换。
- `ops_batch` 按 finds → reads → patches → writes → shells 顺序执行；`reads[].from` 可直接引用 finds 找到的路径。
- `ops_read` 用 `offset`/`limit` 分段读，回执末尾的 `next` 是续读位置；二进制文件返回 `E_BINARY`。
- 用户给本地图片路径时用 `ops_image` 读入并附上图片；多张用 `paths` 数组，张数与大小上限超了会被拒绝。回执里的 `[vision]` 行是看图模型对图片的文字描述，直接采信它来回答图片内容。
- `ops_sh` 带 `filter` 正则过滤输出，带 `filterContext` 时附上下文。
- 回执超过阈值自动压成「头尾摘要 + `[ref xxx]`」，`ops_result` 按 `offset` 取中间段。
- `ops_git` 支持 `add` / `commit` / `push`；`commit` 的 `message` 必填。
- 回执以 `[err E_XXX]` 开头表示失败，`[next]` 字段给出下一步；`[effect unknown]` 表示改动状态未知。
