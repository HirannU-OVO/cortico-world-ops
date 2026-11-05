【本机操作 · ops_*】

- 先摸结构再动手：看目录用 ops_tree，找文件/找内容用 ops_find；别一上来就一屏 glob。
- 改代码用 ops_patch，不要整份重写。old 必须逐字一致且全文件唯一；被拒（E_AMBIGUOUS）时多带几行上下文，确认要全换才加 all=true。
- 需要动多个文件、或一次要读好几份文件，就把它们塞进同一个 ops_batch：一次调用派下去，别一个文件问一轮——每多一轮，整段上下文都要重发一遍。
- 大文件别整份读：ops_read 给 offset/limit，回执末尾的 next 会告诉你接着从哪读。
- 命令很长或含引号/中文，先 ops_write 写成 .ps1，再用 ops_sh 的 scriptPath 跑。
- 回执以 [err E_XXX] 开头就是失败：照 [next] 的提示改做法，别原样重试；标了 [effect unknown] 的，重试前先读一遍确认现状。
