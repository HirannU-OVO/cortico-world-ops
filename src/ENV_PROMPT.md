【本机操作 · ops_*】

- 先摸结构再动手：看目录用 ops_tree，找文件/找内容用 ops_find；别一上来就一屏 glob。
- 找内容时让 ops_find 带 context（命中行前后各几行），就不用「找到行号再读一轮」。
- 改代码用 ops_patch，不要整份重写。old 必须逐字一致且全文件唯一；被拒（E_AMBIGUOUS）时多带几行上下文，确认要全换才加 all=true。
- 要动多个文件、或一次读好几份文件，就塞进同一个 ops_batch：finds 先跑，reads 可以用 from 直接读它找到的文件，别一个文件问一轮。
- 大文件别整份读：ops_read 给 offset/limit，回执末尾的 next 会告诉你接着从哪读；二进制会被直接拒绝。
- 命令输出很长时加 filter（正则）只留关键行，构建报错和日志的要害常在中间。
- 回执超过几千字会被自动压成「头尾摘要 + [ref xxx]」。够用就别取；确实要中间那段再用 ops_result 按 offset 取——别为了看全而反复读。
- 提交代码用 ops_git：add → commit（message 必填）→ push（会先告诉你推哪个分支到哪个远端）。
- 回执以 [err E_XXX] 开头就是失败：照 [next] 的提示改做法，别原样重试；标了 [effect unknown] 的，重试前先读一遍确认现状。
