# E2E 冒烟（无真实 API、无 DSH 运行时）

`node test/e2e.mjs`：假宿主 + 真 pipeline，产物落在 `.out/e2e/`，结尾打印 `E2E OK` / `E2E FAILED`（失败时 exit 1）。
前置：`.out/test.pdf`、`.out/test-long.pdf` 已存在；缺失时先跑 `node src/pdf/smoke.mjs` 重新生成。
只依赖 node 内置模块与 `fflate`，不改 `src/`；直接 `import('./src/pipeline.js')`，模块加载失败即整轮失败（不做任何修补、不走 data: URL）。

## 五个场景各自证明什么

| 场景 | 证明 |
| --- | --- |
| (a) happy path | 1 页 PDF → EPUB 与 report 都落盘；`fflate` 能解包；`OEBPS/text/ch001.xhtml` 含「第1章」，且正文里的字面量 `<p>` 被转义为 `&lt;p&gt;`；report 的 `tokens.input > 0`、`stats.blocks > 0`、`stats.blocksDropped >= 1`（footer 被剔除）、有文本层的页 `source === 'vlm+text-layer'`。 |
| (b) 坏页走交叉复核 | 主模型输出带控制字符 → 哨兵不通过 → 重试后进 `fake/a`、`fake/b` 复核（三份正文长度各异）→ `pages[0].reviewed === true`、`tokens.calls >= 3` 且 `tokens.input/output > 0`、`degraded` 是布尔值，整次转换不抛错、仍产出正文。 |
| (c) 模型不吃图 | `resolveModelInfo` 返回 `inputModalities:['text']` 时 `runConversion` 立即 reject，错误信息含 `image`，且一次模型调用都没发出。 |
| (d) 缓存可复用 | 用 (a) 的完全相同参数再跑：`status:'cached'` 事件出现、宿主零调用、`tokens.calls` 不再增加，且重建的 EPUB 与首次逐字节一致。 |
| (e) 表格与列表 | 一页含 3 行管道表（表头/分隔/1 行数据）和 3 项列表：解压后的章节必须是 `<table>` + `<tbody>` + 1 个 `<td>`、1 个 `<th>`、3 个 `<li>`，且不残留 `---`；塌成一行会立刻失败。 |

## 覆盖盲区（3 条）

1. **只有 1 页**：`concurrency` 并发池、首 3 页种子、跨页 `continues` 合并、多章 `splitLevel` 都没被真正跑到；两个样例 PDF 都有文本层，扫描页分支（`hasText === false` 触发的复核）无覆盖。
2. **验结构不验质量**：断言的是路径、字段、转义，不是 EPUB 排版正确性或块语义；`figure`/`footnote`/`verse` 没有样本。
3. **假宿主太宽容**：从不返回流错误、限流、`finish.failure`、坏 JSON 或缺失 usage，所以 `estimated` 兜底、错误页降级、`signal` 取消三条路径未验证，也没校验真实 provider 的 usage 字段拼写。

断言失败时会逐条打印 `cause：src/...`，指向具体 file:line；**不要为了让日志变绿去改软断言**。
