# dsh-pdf2epub 设计说明

面向实现者。以代码为真相源：`src/pipeline.js`、`src/model/{prompt,gate,blocks,assemble}.js`、`src/host/server.js`。没核实的写「未验证」，不臆造。

## 1. 两段式：页缓存就是中间产物

一次转换其实是两个可以分开跑的阶段：

- **转写**：每页渲染成图、送视觉模型、过哨兵、必要时交叉复核，结果写 `<bookDir>/pages/<dpi>-<provider>_<model>/NNNNN.json`（载荷 `{ version, dpi, model, input, page, ledger, furniture }`）。页与页无依赖，所以这阶段可并发、可中断、可分批。
- **装配**：`flattenPages → buildChapters → renderChapterHtml → buildEpub`，写 EPUB、`book.json`、`report.json`。这一步只读页记录，`pages/` 里已有的页不再调模型。

因此大书的工作流是「分批转写 + 最后一次全量装配」：

```text
pages: "1-40"    # 40 次模型调用
pages: "41-80"   # 再来 40 次
…                # 失败页自动是下一批的重试点（失败页不缓存）
pages: "1-764"   # 全部命中：零模型调用，直接出书
```

为什么能这样：页选择（`pages` / `excludePages`）**不进缓存键**——条目含义是「这本书的第 N 页，用这套设置产出」，这与它来自 40 页批次还是全量运行无关；prompt 里报的也始终是全书页数，不是批次大小。全量装配仍不是完全零成本：插图会按缓存里的 bbox 从页图重裁一遍（确定性，保证产物可复现），封面若开启也会重渲染，但都不发模型请求。

**绝不能靠复制 / 改名 / 切片 PDF 来分批**：`inputFingerprint` 含绝对路径 + 文件大小 + mtime，任一项变化都会让整本缓存失效。

## 2. 缓存键与失效

| 组成 | 取值 | 存在哪 |
| --- | --- | --- |
| 输入指纹 | `sha256(绝对路径 \0 size \0 mtime)` 前 12 位 | 每条载荷的 `input`，读回时校验 |
| 设置指纹 | 生效 dpi + 主模型 `provider/model`（清洗成 `<dpi>-<provider>_<model>`） | 页缓存**目录名** |
| 提示词版本 | `PROMPT_VERSION`（当前 `4`） | 每条载荷的 `version`，读回时校验 |

`readCache()` 的校验顺序：JSON 可解析 → `version` → `model` → `dpi` → `input` → 有页记录且页号对得上 → 无 `error` → 块非空且格式正确（`blank: true` 的 `blocks: []` 是唯一例外）→ `pageHasBookText()`。**任何一项不符就 `unlink` 该条**再按未命中重转，所以一条坏记录只污染一次，不会每次重跑都被拒绝一遍。

- **「同名不同书」靠载荷校验，不靠目录名**：目录名是 PDF 文件名，两本同名文件共用一个目录；隔离只能由载荷里的 `input` 承担。代价是后跑的书会覆盖前一本的页缓存，前一本重转要重新付费——这是「目录必须人找得到」换来的取舍。
- **空白页例外**：只有 `blocks: [] + blank: true`（实测墨迹 < 0.5% 页面）可缓存；裸 `blocks: []`（旧版本留下的污染）仍删。
- **旧布局迁移**：首次建 `<bookDir>` 时把 `<outputDir>/.pdf2epub-<inputKey>/pages` 整目录搬进来（先 `rename`，跨卷退回 `cp` + `rm`），失败只产生一条 `warnings`。
- `bookId = sha256(绝对路径).slice(0,12)` 只用于 EPUB `dc:identifier` 与 fallback session id，与缓存无关。

## 3. 质量闸门（真实规则）

| 闸门 | 规则 | 后果 |
| --- | --- | --- |
| 页级哨兵 | 空块 / `raw` 全空白 / 只剩家具 / 文本非字符串 / 单块 >12000 字符 / 控制字符；基线 ≥120 且有字数时 `\|ratio−1\|>0.15` | 不通过 → 主模型带问题重试一次 → 仍不过或无文本层则交叉复核 |
| 交叉复核 | `needsCrossReview = !ok \|\| !hasTextLayer`；每个 reviewer 同一 prompt 再跑一次；medoid 由去空白、截 6000 字符的 Levenshtein 相似度选出；`agreement` 取对 medoid 的**最小**相似度 | `agreement < 0.9` 或哨兵不过 → `degraded`，页仍进书 |
| 书眉逐页降级 | `h1`/`h2` 的 `headingKey`（空白折叠 + 全角折半角 + 去空格）与**同页**某个 `header` 相同 | 当作家具丢弃，计入 `stats.demotedHeadings`；其他页的 `header` 不参与，否则会误杀章首页真标题 |
| 叶码四护栏 | 形状 `\d{1,4}[ab]`；独立性（只有拉丁字母/数字粘连才放弃）；CJK 上下文（中文行里的半角逗号算中文）；引用护栏（`f.`/`ff.`/`f`/`叶`/`页`/`见`/`参看`/`本书` 强，`前`/`后` 须紧贴） | 四条全过才删；位置护栏（日期单位 `年月日…`、索引条目）只能否决删除 |
| 页码等值规则 | 与某页 `page-number` 块文本相同、且独立出现的 token | 删除；落在日期、列表标点、非边缘位置或索引行里则保留 |
| 标点归一化 | 中文上下文 3 字符内的半角 `, ; : ? !` → 全角；全角数字 → ASCII；URL 与数字之间的分隔符不动 | 纯幂等改写，不动措辞 |
| 标题 clamp | 不跳级（≤前一级 +1）；章内 ≥ 章标题级别 +1 且 ≥ `h2`；≤ `h6` | 修 `h1→h3` 这类大纲断点 |
| 括号配对 | 只补一个缺失的 `）`（深度恰为 1） | 两个以上缺视为真实内容，不动 |
| 跨页续接 | 只有 `p`/`verse`、页码相邻、前半未结句、后半不像列表/编号/新句首 | 否则保留 `continues` 并计入 `blocksRejectedJoins` |
| 跨家具续接 | 同页（或相邻页）两段 `p` 之间只隔着 `page-number`/`footer`/`header`，且前半未结句 | 缝合；标题、表格、图注、诗行、脚注都算段落边界 |
| 空章 | 无正文块的章丢弃；但 `h1` 开的部扉页保留，隐含首章保留 | 章 id 连续，不留空洞 |
| 目录 | `toc` 块解析成 `<nav epub:type="toc">`；带印刷页码的条目按最近章标题校正 | 距离 ≤2 且长度差 ≤3，等距并列不改 |

## 4. 版本戳与热重载

- **`LOCAL_MODULE_VERSION`**（`src/pipeline.js`，当前 `8`）：静态 import 的 `?v=` 戳。模块 URL 不含查询串时，ESM 缓存会把子模块永久钉在首次加载的版本上，插件 reload 只重算入口模块。**什么时候 +1**：`src/model/`、`src/epub/`、`src/pdf/`、`src/host/` 下任何文件改动（`pipeline.js` 自身除外）；同一次编辑里本文件每个 `?v=` 都要一起改，否则只有半张图被刷新。被间接 import 的模块（`model/blocks.js` 经 `gate.js`、`epub/css.js` 经 `build.js`）不在范围内。
- **`PIPELINE_API_VERSION`**（`src/host/server.js`，当前 `1`）：与上者同一次编辑一起 +1。原因：loader 用 `pipeline.js` 的 mtime 做查询串，只改子模块时该文件字节不变，URL 也不变，模块不会重新求值，新 `?v=` 永远解析不到。它是「子模块变了但入口没变」的另一半。
- 两者都是开发期便利，不是发布机制：每个 reload 过的版本都留在进程的 ESM 缓存里，发布仍需重启宿主后验证。

## 5. 进度与状态

pipeline 只发 4 个 `phase`：`start`（带 `pages`/`selectedPages`/`outputDir`/`bookDir`）、`page`（带页码、批次内位置 `position`/`selectedTotal`、`status`、`chars`/`ms`/`tokens`）、`assemble`、`done`。作业层另加 `queued`/`failed`/`cancelled`。页级 `status` 有 `cached`/`ok`/`reviewed`/`degraded`；宿主把它存进 `state.pageStatus`，但面板只按 `phase` 映徽标（`reviewing`、`cached`、`degraded` 三个 locale 键目前没有显示路径）。失败页不阻塞成书，作业状态仍是 `completed`——这是刻意的，代价见 §7。

## 6. 实测数据

一次真实的扫描书全量转换（原 PDF 765 页，末页是下载站生成页，实际计入 764 页正文）：

| 指标 | 实测 |
| --- | --- |
| 页数 | 764（原 PDF 765 页） |
| token | 约 435 万（本次消耗；缓存复用另记 `tokens.reused`） |
| 墙钟 | 约 2 小时 |
| 章 | 90（`buildChapters` 的产物，也是目录校正的参考列表长度） |
| 脚注 | 264 个 `footnote` 块 |

报告的 `book.pages` 记 PDF 页数，`book.pagesSelected` 记本次覆盖的页数，批次的报告靠这一对字段才不会被误读成「这本书只有 40 页」。该次运行的产物未随仓库保存；仓库里能复跑的是 9–11 页的抽样批次（`.out/pilot-1`、`.out/pilot-2`，`book.pages = 765`，`selection.pages` 可见批次表达式）。

## 7. 未解决

1. **失败页不阻塞成书**：`stats.pagesFailed`、`warnings`、逐页 `failure`/`error` 都如实记录，但转换本身成功、作业状态 `completed`；调用方不读这些字段就会把缺页的书当成完整结果。
2. **并发池里的页没有上文**：池内页拿不到上一页结尾（否则输出会依赖完成顺序），跨页断词只靠 `smartJoin` 补空格，换行处的连字符仍不合并。
3. **公式与整页图缺席**：没有 MathML/OMML 通道；插图只在模型给出可用 bbox 时裁切，否则只剩图注。
4. **目录校正依赖印刷页码**：条目没有页码就不参与校正，目录与章标题的分歧只能靠这一条窄规则兜住。
