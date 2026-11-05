# 本机操作 · cortico-world-ops

给 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 里的桌宠**一套会算账的工具**：读文件、改代码、找东西、看目录、看 git、跑命令——**输出永远封顶，失败给错误码，多件事能塞进一次调用**。

装上它之后，桌宠不用再「读一条 → 问一轮 → 再读一条」，也不用把 3 万字的文件整份吞进上下文。


---

## 为什么要它

桌宠的每一次工具调用都是**一轮模型请求**，而每一轮都要把**整段上下文重发一遍**。所以真正贵的不是单次输出多大，而是：

1. **轮次多**——读 6 个文件如果分 6 轮，等于把 6 万 token 的上下文发了 6 遍；
2. **输出不封顶**——一份 8 千行的日志、一个 3 万字符的文件，会永久留在上下文里，之后每一轮都要为它付钱。

这个扩展就是冲着这两件事来的：

- **`ops_batch`** 让你在一轮里读多个文件、改多个文件、跑多条命令——**省一轮，就省一整份上下文**；
- 所有输出都有**字符/行数上限**，被截断时明确写出「还剩多少、怎么续读」，不静默丢内容；
- 失败返回 `[err E_XXX]` + `[next]` 下一步，副作用不确定时标 `[effect unknown]`——**不鼓励模型原样重试**。

## 十个工具

| 工具 | 干什么 | 关键参数（默认 / 上限） |
|---|---|---|
| `ops_read` | 读文本文件，带行号；同范围未变只回 `unchanged` | `offset`（1 起，负数从末尾）`limit`（150 / 2000）`maxBytes`（12000 / 64000）`fresh` |
| `ops_write` | 写文件，自动建父目录；拒写系统目录 | `mode=overwrite\|append` |
| `ops_patch` | 用一段原文精确替换；**不唯一就拒绝**并报出现次数与行号 | `old` `new`（空串=删除）`all` |
| `ops_find` | `files` 按 glob 列文件 / `content` 按正则搜内容；分页 | `mode` `path` `globs`（`!` 排除）`ignoreCase` `maxResults`（60 / 500）`cursor` `context`（±行，0-10）`since`（`2h` / `1d` / ISO） |
| `ops_tree` | 按深度看目录结构，自动跳过依赖/缓存目录 | `depth`（2 / 6）`maxEntries`（200 / 1000） |
| `ops_git` | `status` / `diff` / `log` 只读；`add` / `commit` / `push` 写仓库 | `mode` `staged` `maxLines`（80 / 400）`paths` `all` `message` |
| `ops_fetch` | 抓网页或接口：HTML 剥成正文、JSON 自动格式化、按字符封顶 | `url` `maxChars`（6000 / 30000）`raw` `method` `body` `headers` |
| `ops_sh` | 跑 PowerShell 命令或 `.ps1`，返回 stdout/stderr/退出码 | `command` `scriptPath` `cwd` `timeoutMs`（60000 / 300000）`filter`（正则只留匹配行）`filterContext` |
| `ops_batch` | **一轮里顺序做多件事**：找 / 读 / 改 / 写 / 命令 | `reads[]`（可 `from` 引用 finds 结果）`patches[]` `writes[]` `finds[]` `shells[]` |
| `ops_result` | 取回被转存的长回执（按 `offset` 分页） | `ref` `offset` `maxChars`（3000 / 12000） |

### 改代码的标准姿势

```text
ops_tree                      → 摸清项目结构（比 glob 一屏文件便宜得多）
ops_find{mode:"content"}      → 定位到 文件:行号
ops_read{offset,limit}        → 只看要改的那几行，确认原文
ops_batch{patches:[…]}        → 多个文件一次改完
ops_git{mode:"diff"}          → 复查改了什么
```

`ops_patch` 的 `old` 必须**逐字一致且全文件唯一**；被拒（`E_AMBIGUOUS`）就从上面多带两行上下文，确认要全换才加 `all=true`。

`ops_find` 用 `context: 2` 就能直接把命中行前后两行一起看到，省掉「找到行号再读一轮」；`ops_batch` 里 `reads: [{ from: "1" }]` 可以把第 1 个 finds 找到的文件直接读掉，字符串参数还支持 `$1` / `$prev` 传单个路径。

### 长回执会自动压成摘要

任何工具回执超过 4000 字，会自动变成「头 1200 字 + 尾 400 字 + `[ref xxx]`」，全文留在扩展内存里。够用就别取；确实要中间那段再用 `ops_result{ref, offset}` 按偏移取。
这样历史里只留摘要，细节按需取——反复读全文是上下文膨胀的主因之一。

### 回执长什么样

```text
[ok read] D:\x\a.md 第 1-150 行 / 共 320 行，revision=4f2a9c1d8b03
1| # 标题
2| …
[next] 还有 170 行没给（本次 limit=150 到头了），接着读用 offset=151
```

```text
[err E_AMBIGUOUS] old 在 D:\x\a.md 里出现 2 次（行 12, 88）
[next] 多带几行上下文让它唯一，或加 all=true 全换
```

### 错误码

| 码 | 含义 |
|---|---|
| `E_INPUT` | 参数不对 |
| `E_READ` / `E_WRITE` | 读不到 / 写不进 |
| `E_DENY` | 拒写系统目录（`%SystemRoot%`、`Program Files`） |
| `E_NOTFOUND` / `E_AMBIGUOUS` | 原文找不到 / 原文不唯一 |
| `E_RANGE` / `E_PATH` | 行号越界 / 路径不存在 |
| `E_REGEX` / `E_CURSOR` | 正则不合法 / 游标解析失败 |
| `E_EXIT` / `E_GIT` | 命令非零退出 / 不是 git 仓库 |
| `E_FETCH` / `E_TOO_BIG` | 抓不到（网络/代理/超时）/ 响应体超过 8 MB |
| `E_INTERNAL` | 兜底异常（附 `[effect unknown]`） |

## ⚠️ 安全提醒

- 这些工具**以你自己的用户身份**在你机器上执行：**没有沙箱，没有审批弹窗**。`ops_sh` 能跑任何 PowerShell 命令，包括删文件、改注册表。
- **只装你信得过的扩展**；不想用了在 World 列表里关掉即可。
- 唯一的内置防线是：`ops_write` / `ops_patch` 拒绝写入 `%SystemRoot%`、`Program Files` 这类系统目录（`E_DENY`）；`ops_git` 只读，不会替你提交。
- 建议在人设/提示词里立规矩，例如「删东西、改系统设置、动别人文件之前先问人」。
- 本扩展**没有遥测、没有后台任务、不往外传任何东西**，工具调用之外不碰你的文件。

## 安装

### 方式一：扩展市场

Coopanion → 扩展页 → 搜 `cortico-world-ops`（关键词 `ops` / `terminal`）→ 安装 → 重启 → 在 World 列表里启用「本机操作」。

### 方式二：pnpm

在 Coopanion 的 `data/extensions/` 目录下：

```bash
pnpm add cortico-world-ops
```

### 方式三：本地开发

用目录联接把仓库挂进扩展目录，改代码即时生效：

```powershell
New-Item -ItemType Junction `
  -Path   'D:\Tools\Coopanion\data\extensions\local\cortico-world-ops' `
  -Target '<本仓库路径>'
```

再在 `data/extensions/package.json` 里加一行并安装：

```json
{ "dependencies": { "cortico-world-ops": "link:./local/cortico-world-ops" } }
```

```powershell
cd 'D:\Tools\Coopanion\data\extensions'
pnpm install
```




## 配置参数速查

**本扩展没有配置项**（`defaults()` 返回空对象）。所有行为由工具参数控制，不往面板里堆开关。

只有一段**环境提示词**随扩展注入（`src/ENV_PROMPT.md`，约 430 字）：约定先 `ops_tree` 摸结构、改代码用 `ops_patch`、多文件走 `ops_batch`、`[err]` 照 `[next]` 改。它会以「本机操作 · 环境提示词」出现在 Coopanion 的提示词页，可随时改或清空。

## 兼容性

- Extension API：`world@6`（Coopanion 0.2.x / Cortico 同代接口）
- Node 22+（开发机实测 Node 24 / 25）
- `ops_sh` 走 **PowerShell**，面向 Windows；其它平台需要改成 `sh -c`
- 无运行时依赖，只用 `node:fs` / `node:path` / `node:child_process`

## 常见排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 重启后日志没有「本机操作已就绪」 | 扩展没被加载 | 查 junction 是否指对、`package.json` 是否加进 `dependencies`、`pnpm install` 是否跑过 |
| 日志出现「describe.json 与实现不一致」 | 改了 schema 没补实现，或反之 | `npm run check` 看具体哪条 |
| 模型仍爱用 `read_file` / `fs_read` | 旧工具还开着 | 关掉 `worlds.devtools`，并确认环境提示词已注入 |
| `ops_sh` 中文乱码 | 输出编码不是 UTF-8 | 本包已内置 `[Console]::OutputEncoding=UTF8`；若脚本自己改了编码，在脚本里还原 |
| `ops_sh` 报 `E_EXIT` 但没有 stderr | 命令没跑起来（引号/路径/执行策略） | 先跑 `Write-Output ok` 验证通道；长命令先 `ops_write` 写成 `.ps1` 再用 `scriptPath` |
| `ops_patch` 老是被拒 | 原文不唯一或带了不可见空白 | 用 `ops_read` 复制原文；改不动就整段 `ops_write` |

## 开发与自检

```powershell
npm run check   # describe.json（schema 唯一来源）↔ 实现一致性、schema 形状
npm test        # 上面 + 36 条行为断言（临时目录，跑完自清理）
```

设计约定：

- `describe.json` 是 schema 的**唯一来源**，代码里不写第二份声明，启动时比对覆盖率，不一致会点名；
- 工具**永不抛异常**，所有失败都变成结构化回执，不把主循环带崩；
- 宁可在回执里多写一行「截断了、还剩多少」，也不静默丢内容。

## 鸣谢与生态参考

- [Coopanion](https://github.com/Pal-AI-Lab/Coopanion)：桌宠本体与 World API 6；
- [dsh-ops](https://github.com/T-Auto/dsh-ops)（MIT）：有界输出、结构化失败与分页契约的思路来源；
- [cortico-world-devtools](https://www.npmjs.com/package/cortico-world-devtools)（MIT，作者 luoluo）：PowerShell 输出编码与 `行号| 内容` 的写法约定；
- Node.js `fs` / `child_process` 文档，PowerShell `about_Execution_Policies`。

> 本包代码为独立实现，不包含上述项目的源码。

## 许可证

[MIT](LICENSE) © HirannU