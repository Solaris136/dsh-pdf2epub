# dsh-pdf2epub 设计说明

面向实现者。本文只依据仓库里的 `README.md`、`src/pipeline.js`、`src/model/gate.js`。涉及 `src/model/blocks.js`、`src/model/prompt.js`、`src/model/assemble.js` 的内部字段，只以 `pipeline.js` 的调用点为准；未核实的标「待核」，不臆造。

## 1. 数据契约

**Page** —— `transcribePage` 返回的页记录，字段与真实取值来源：

```text
page          1 起的页码
source        'vlm+text-layer'（该页有文本层）| 'vlm'
chars         countableCharacters(blocks)，可计数字符数
baselineChars 文本层去掉所有空白后的长度
ratio         chars / baselineChars；基线 <120 或 chars=0 时为 null
ok            verdict.ok && !degraded —— 仅报告字段，不参与组装过滤
reviewed      是否真的跑了交叉复核（候选多于 1 个）
agreement     各候选与 medoid 的最小相似度；未复核时 null
degraded      哨兵未通过，或复核后一致性不足
issues        哨兵问题描述数组
error         失败 / 取消时的错误文本，正常页为 null
notes         模型自带的一句可选说明
finishKind    模型返回的结束原因（如 stop）
truncated     是否因 maxTokens 被截断
image         送给模型的页图尺寸 { width, height, bytes }
models        参与该页的 provider/model 列表
blocks        plainBlock 处理后的块数组
ms            该页墙钟耗时
```

报告里的逐页记录投影其中大部分：去掉 `notes`、`blocks` 与 `raw`，保留 `error`、`finishKind`、`truncated`、`image`；`ratio`、`agreement` 保留三位小数。报告因此能区分「模型被限流」和「页面本来就空白」，但看不到原始模型输出。

**Block**：至少 `{ type, text }`。`gate.js` 只判 `typeof block.text === 'string'` 与 `DROP_TYPES.has(block.type)`（`DROP_TYPES` 在 `blocks.js`，待核）；`pipeline.js` 自己认的页眉页脚类型是 `header`、`footer`、`page-number`，README 另说明 `figure` 块只带图注。

**Chapter**：`buildChapters(flattened.blocks, { splitLevel, fallbackTitle })` 返回；`pipeline.js` 读 `chapter.id`/`title`/`level`，并把整个 chapter 交给 `renderChapterHtml`（故其内还含块信息，字段待核），真正交给 `buildEpub` 的是 `{ id, title, level, html }`。`flattenPages(pages)` 返回 `{ blocks, dropped, joined, rejectedJoins }`，`buildReport` 用这四个计数（`rejectedJoins` 是 `continues` 指向不可接续块、被拒绝合并的次数）。

## 2. 每页一次独立调用

`transcribePage` 的入参是 `{ host, pdf, pageIndex, totalPages, primary, reviews, dpi, maxTokens, furniture, previousTail, signal }`：只有可选的上一页结尾，没有全书摘要。

- **可并发**：页与页无依赖，`mapPool(items, concurrency)` 直接铺开；首 3 页（`seedCount`）按序跑只为采集页眉页脚，其余全部并发。
- **可重跑**：单页失败只污染该页，缓存粒度就是页。
- **上下文不爆**：单次输入 = 一张页图 + 固定 prompt + 页眉页脚提示，与全书页数无关。

**连续性靠提示补**：`transcriptionPrompt` 接 `previousTail` 与 `furnitureHint`。前 3 页顺序跑时，第 2、3 页会拿到上一页最后一个正文块的后 80 字符；并发池里的页拿不到「上一页」（完成顺序不确定，猜一个会让输出依赖调度顺序）。全书共享状态是 `furniture` —— 页记录里 `header`/`footer`/`page-number` 块的前 40 字符会加进提示；缓存条目也存了 `furniture`，命中时重新灌回，续跑与一次跑完的提示集合一致。块级 `continues` 由 `flattenPages` 消费：只有 `p`/`verse` 允许跨页合并，指向其它类型时拒绝合并并计入 `rejectedJoins`。

**代价**：跨页断词、断句、跨页删除号仍没有专门的修手（`joined` 只说明做了拼接，`smartJoin` 只按中英文决定是否补空格）；页眉页脚只从 ≤3 个种子页学到，样本不足时后续页可能漏标。

## 3. 哨兵规则表

常量取自 `gate.js`。后果统一：`issues` 非空 → `verdict.ok = false` → `degraded = !verdict.ok` → 先用主模型带 `retryNote` 重试一次 → 仍不过或该页无文本层 → 进交叉复核。

| 规则 | 触发条件 | 后果 |
| --- | --- | --- |
| `MAX_BLOCK_CHARS = 12000` | 任一块 `text.length > 12000` | 判 runaway 生成，该页不通过 |
| `CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/` | 任一块文本命中控制字符 | 该页不通过（`\t`/`\n`/`\r` 在豁免区间，不触发） |
| `MIN_BASELINE = 120` | 文本层去空白长度 < 120 | 不算 `ratio`（保持 `null`），字数比哨兵失效；扫描页只能靠 `needsCrossReview` 的「无文本层」分支兜底 |
| `RATIO_TOLERANCE = 0.15` | 基线 ≥ 120 且 `chars > 0`，且 `abs(ratio − 1) > 0.15` | 判转录字数与文本层不符，该页不通过 |
| 结构检查（无常量） | `blocks` 为空 / `raw` 全空白 / 只剩 `DROP_TYPES` 块 / 块 `text` 非字符串 | 分别报 `no blocks produced`、`empty model output`、`only page furniture`、`non-string text` |

## 4. 交叉复核

- **触发**：`needsCrossReview(verdict, hasTextLayer)` = `!verdict.ok || !hasTextLayer`。扫描页即使解析干净也复核，因为没有字数比这道保险。
- **候选**：主模型当前 `attempt` + 每个 `reviewModels` 用同一 `prompt`（不带 `retryNote`）各跑一次。
- **medoid**：`pickMedoid` 选与其他候选相似度之和最大者；相似度为 `1 − Levenshtein/最长串长`，两侧先去所有空白、各截前 6000 字符。
- **agreement**：各候选对 medoid 相似度的**最小值**（不是平均），一个跑偏的复核模型就能把整页拉低。
- **degraded**：`agreement < 0.9`。`reviewModels` 为空时候选只有 1 个，`reviewed` 保持 `false`，`degraded` 就是 `!verdict.ok`。
- **为什么不阻塞**：组装只做 `pages.filter(Boolean)`，不按 `ok`/`degraded` 过滤，复核结论只落进 `stats.pagesDegraded` 与逐页 `agreement`（README「已知限制」同样声明）。取舍是「少一页正文比多一处存疑更糟」，代价见 §7。

## 5. 缓存与断点续跑

- 位置：`<outputDir>/.pdf2epub-<inputKey>/pages/<dpi>-<model>/NNNNN.json`（五位补零页码）。`inputKey = sha256(绝对路径 + 文件大小 + mtime).slice(0, 12)`：换路径、改文件、改 dpi 或换主模型都会落到不同目录，不会复用别处的页。
- 载荷：`{ version, dpi, model, input, page, ledger, furniture }`。
- 失效：`readCache` 逐项校验 `version`（`PROMPT_VERSION`，当前 `2`）、`dpi`、`model`、`input`、页号，以及 `page.blocks` 非空、无 `error`、至少一个正文块；不符即删除该条并按未命中重转（自愈）。`spec.force === true` 直接跳过读取。
- 命中行为：页记录直接复用，该条 `ledger` 合进 `tokens.reused`（不是本次 `ledger`），打 `status: 'cached'`，并把 `furniture` 灌回提示集合。
- 写入条件：只有 `pageHasBookText(page)` 为真（非空块、无 `error`、至少一个非页眉页脚块）才写；失败页不写缓存，重跑自动重试。
- `bookId = sha256(绝对输入路径).slice(0, 12)` 仍只用于 EPUB 的 `dc:identifier`，与缓存目录无关。

## 6. 进度事件

`emit` 给每个事件补 `at: Date.now()`。实际只发出 4 个 `phase` 值：

| phase | 何时发出 | 携带字段 |
| --- | --- | --- |
| `start` | 校验参数、建目录、打开 PDF 之后 | `input` `pages` `outputDir` |
| `page` | 单页完成（缓存命中在 `transcribePage` 之前） | `page` `total` `status`，新转另带 `chars` `ms` `tokens` |
| `assemble` | 全部页转录完、拼章节之前 | `pages` |
| `done` | `epub` 与 `report` 都写盘之后 | `epubPath` `reportPath` `tokens` `pagesFailed` |

`page` 的 `status` 取值：`cached`、`ok`、`reviewed`、`degraded`（`degraded` 优先于 `reviewed`）。**没有** `error`/`failed`/`cancelled` 事件：`PDF not found`、`cancelled`、`no chapters produced` 都是直接 `throw`，面板得自己从异常映射状态。服务端的 `applyProgress` 只保留 phase/页码/token，不保留逐页 `status`；locale 里的 `status.idle`、`status.reviewing`、`status.cached`、`status.degraded` 因此没有显示路径，面板只映射 phase。

## 7. 未解决的设计问题

1. **图片与公式缺席**：`report.limitations.images` 承认 `figure` 块只有图注，插图既无字节也无 bbox；公式同样没有 MathML/OMML 通道，只能靠纯文本近似，EPUB 3 的 `<img>`/`<math>` 能力完全没用上。
2. **并发页没有上下文**：池里的页拿不到上一页结尾（这是故意的，否则输出会依赖完成顺序），跨页断词仍只靠 `smartJoin` 补空格，换行处的连字符不会合并。
3. **失败页不阻塞成书**：`stats.pagesFailed`、`warnings`、逐页 `error` 都会如实记录，但转换本身仍返回成功、作业状态仍是 `completed`，也没有 `phase: 'error'` 事件；调用方不读这些字段，就会把缺页的书当成完整结果。
