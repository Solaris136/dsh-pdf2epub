# 发布前验收报告（VERIFICATION）

- 仓库：`dsh-pdf2epub`（`<repo>`），分支 `main`，**0 commit、0 remote**；Node v26.13.1 / Windows
- 方式：只读 + 跑测试。未改源码，未执行 `git add/commit/push`，未删除任何文件
- 结论：**11 条回归全绿，0 条不绿；发布阻断项 4 条**（见 §3）；4 条的处理结果见 §5

## 1. 全量回归

| # | 命令 | 结果 | 断言数 |
| --- | --- | --- | --- |
| 1 | `node src/model/test.mjs` | PASS exit 0 | 51 tests |
| 2 | `node src/epub/test.mjs` | PASS exit 0 | 30 checks / 0 fail |
| 3 | `node src/epub/hardening.test.mjs` | PASS exit 0 | 30 tests / 0 fail |
| 4 | `node test/e2e.mjs` | PASS exit 0 | 7 scenarios / 71 checks |
| 5 | `node test/harness/host-check.mjs` | PASS exit 0 | 34 assertions |
| 6 | `node test/harness/epub-route-check.mjs` | PASS exit 0 | 18 checks |
| 7 | `node test/harness/client-check.mjs` | PASS exit 0 | 16 assertions |
| 8 | `node test/harness/locale-check.mjs` | PASS exit 0 | 5 assertions |
| 9 | `node test/harness/preview-check.mjs` | PASS exit 0 | 11 checks |
| 10 | `node test/harness/route-path.mjs` | PASS exit 0 | 10 checks |
| 11 | `node test/harness/security-check.mjs` | PASS exit 0 | 76 checks（含 Edge 层） |

合计 **352** 条断言，0 失败。

- `node --check`：18 文件 0 失败（14 个指定 + 补查 `src/**/*.mjs` 4 个）。
- 顺序依赖：清缓存前直接二跑 `test/e2e.mjs`，输出**逐字节相同**（7/71/0）；`.out/e2e` 每轮自行重建，无残留。
- 环境敏感：`security-check.mjs` 浏览器层依赖本机 Edge/Chrome，缺失时打印 SKIP 并跳过（不报错），断言数会少于 76。

## 2. 仓库体检

### 2.1 待跟踪文件

`git status -uall` 共 **36** 个，`git add -A` 只收预期文件：`package.json`、`package-lock.json`、`cordis.patch.yml`、
`index.js`、`client.js`、`src/**`（15）、`test/e2e.mjs`、`locale/**`（2）、`docs/**`（9）、`icon.svg`、`LICENSE`、
`README.md`、`.gitignore`。**无 `.out/**`、无 `node_modules/**`、无 PDF/EPUB/产物**；`git diff --stat` 为空。

### 2.2 `.gitignore`

已正确覆盖 `.out/`（带斜杠）、`node_modules/`（带斜杠）、`*.epub`、`.work/`、`pdf2epub-out/`、`*.log`；
实测 `.out/e2e/*.epub|*.book.json|*.report.json`、`.out/test.pdf` 均 IGNORED。

**必须补**：`*.pdf`、`*.report.json`、`*.book.json`、`runs/` —— 实测 `sample.pdf`、`test-long.report.json`、
`book.book.json` 当前全部 **TRACKABLE**。`runs/` 根目录无规则（`.out/final-host/runs/` 靠 `.out/` 兜住）；
`!docs/*.epub` 反忽略当前无文件，属预留。

### 2.3 `package.json`

- `name` 与 `index.js` 的 `export const name`、`cordis.patch.yml` 的 `id` **三者一致**。
- `license=Apache-2.0` 且 `LICENSE` 为 Apache-2.0 正文 ✓；`exports` 四目标、`files` 八项**全部存在** ✓；
  `files` **未误列** `test/`/`.out/` ✓；`dependencies` 仅 `fflate`+`mupdf` ✓；`devDependencies` 含 `saxes` ✓。
- 待修：`private: true`（阻断 npm 发布）；`files` 收整个 `docs`（会发布内部审查报告）；缺 `scripts.test`、
  `repository`、`homepage`、`bugs`、`keywords`、`author`、`engines`。

### 2.4 `docs/` 清单与建议（只建议，未删改）

README **无任何 markdown 链接**，故「README 引用的文档是否存在」= 引用 0、无失效链接；反向问题是 9 个文档
全为孤儿。整理前 README:115 唯一指向 `.out/host-check.mjs`，README:117 又声明 `.out/` 不进仓库，自相矛盾（已在 §5 处理）。

| 文件 | 性质 | 建议 |
| --- | --- | --- |
| `DESIGN.md` | 设计说明 | **随仓库发布** |
| `epub-module.md` | EPUB 模块 API 文档 | **随仓库发布** |
| `e2e.md` | E2E 冒烟说明 | 发布，须先解决 `.out/` 依赖 |
| `api-contracts.md`（51 KB） | 本机发行包反查的宿主契约 | **移出**：含本机路径、随 DSH 版本过期 |
| `epub-in-dsh.md`（43 KB） | 调研/方案设计，自标「未验证」 | **移出** |
| `review-epub.md`、`review-final-client.md`、`review-final-host.md`、`review-model-layer.md`（4 份，132 KB） | 内部复审/终审/代码审查 | **移出或删除** |

### 2.5 敏感信息（排除 `node_modules`/`.out`/`.git`，扫 36 文件）

**无** 本机用户名或仓库绝对路径、**无** 任何密钥形态（API key、GitHub token、AWS access key、
Slack token）、**无**邮箱、**无**硬编码 `Bearer`。
绝对路径 **18 处**：`docs/api-contracts.md:7,894`；`docs/epub-in-dsh.md:11,12,15`；
`docs/review-final-client.md:3,14,18,19,26,92,321,411,426,427`；`docs/review-final-host.md:3`；
`docs/review-model-layer.md:32`；**`src/host/server.js:1688`**（唯一源码命中：注释里
`<workspace>`/`<workspace>` 的大小写示例，建议换中性路径）。
17 处在「建议移出」的 6 个文档里，移出后仅剩 `server.js:1688`。

### 2.6 可复现性

`npm ls --depth=0` 仅 `fflate@0.8.3`/`mupdf@1.28.6`/`saxes@6.0.0`，**无 extraneous、无 missing** ✓；
`npm ci --dry-run` → `up to date` exit 0 ✓（未删 `node_modules`）；`package-lock.json` **无** `file:`/`link:`/
本地路径/`../` 引用，全为 registry URL + integrity ✓。

## 3. 发布阻断项：**4 条**（处理结果见 §5）

1. **7 条回归命令随仓库丢失**（第 5–11 条全在 gitignore 的 `.out/`）。新克隆后它们不存在，README:115 却明文指向其中一条 —— 对外宣称的回归套件不可复现。需迁进 `test/` 并更新 README 测试表（现只列 5 条）。依赖链：`route-path.mjs`/`security-check.mjs` 需 `.out/sample.epub`（来自 `src/epub/test.mjs`）或 `.out/preview/sample.epub`（由 `epub-route-check.mjs` 自建），单独运行缺样本。
2. **敏感绝对路径 18 处**（含唯一源码命中 `src/host/server.js:1688`）公开前必须清掉或改占位符。
3. **`private: true` + `files` 收整个 `docs`**：`npm publish` 被 `private` 阻断；一旦放开，6 份内部审查报告连同本机路径一并公开。需改 `files` 白名单并决定是否保留 `private`。
4. **`mupdf` 为 AGPL-3.0-or-later**（`node_modules/mupdf/LICENSE` 为 AGPLv3 正文，官方 Artifex MuPDF.js），与 Apache-2.0 不同。需法务确认，并在 README/NOTICE 显式声明该 AGPL 运行时依赖（或替换实现）。

**非阻断但建议发布前修**：`.gitignore` 补 4 条（§2.2）；README 测试表补 `node src/pdf/smoke.mjs` 前置（`e2e.mjs` 缺 `.out/test*.pdf` 直接 FAIL）；补 `scripts.test`/`repository`/`engines`；README:66 原自述「未验证」已按 §4 活体验收对齐。

## 4. 真实 DSH GUI 活体验收（desktop profile，`http://127.0.0.1:53061`）

1. **插件加载**：`plugin_manager` 的 `install_bundle` 返回 `application: applied`，profile 内以符号链接装为 `dsh-pdf2epub@0.1.0`。
2. **路由注册**：命令行请求 `/dsh-pdf2epub/state`、`/epub`、`/book`、`/run` 均由 404 变为 **403**：路由已注册，鉴权栅栏按设计拒绝未授权请求。
3. **侧边栏入口**：「全局面板」导航出现「PDF 转 EPUB」条目，带图钉按钮，位于「自动化任务」与「指引使用统计」之间。
4. **面板渲染**：标题、副标题「逐页转录，弱页交叉复核，产出可重排 EPUB 3」、PDF 路径输入框、「开始转换」按钮（路径为空时禁用）、可折叠「高级」、阅读区空态「转换完成后，可在这里直接阅读成书」。
5. **UI→宿主链路**：填入路径后点「开始转换」，状态栏先显示「等待中 · Token 用量 0 · 耗时 —」，随后转为红字 `400 Bad Request — dsh-pdf2epub: primaryModel is not configured; set it to provider/model in the plugin settings` 与「重试」按钮。即面板 → `POST /run` → 同源请求通过鉴权栅栏 → 参数校验 → 可读错误 → 客户端呈现，整条链路成立。
6. **`.epub` 在 DSH 内打开**：经 `present` 交付 `sample.epub` 后点击交付物卡片，右侧文档预览由本插件渲染器接管：左侧为 nav 层级目录（`第一章 起航` / `第一节 细节`（二级缩进）/ `第二章 归途`），顶部显示书名 `测试书目：PDF 转 EPUB` 与作者，右上角页码 `3 / 4`（spine 共 4 个文档，第 1 个是封面）；点目录切到 `第一节 细节` 后正文标题与段落正常、加粗样式保留、目录高亮同步；首次打开正文区空白，经确认是停在封面页（样例 cover 为 1×1 像素图），不是渲染失败。

仍未验证：真实视觉模型跑完整转换（需先把 `primaryModel` 配成支持图片输入的路由）；侧边栏面板内嵌阅读区加载真实成书；Electron `file://` 部署形态与非 Windows 平台。未覆盖：`npm pack` 清单实测；未执行任何写操作或 git 提交。

## 5. 发布前整理（release-prep）后的现状

本节只记录 4 条阻断的处理结果与重跑证据，没有重做 §1–§4 的完整审计。

| 阻断 | 处理 |
| --- | --- |
| 1. 7 条回归命令随仓库丢失 | 全部迁入 `test/harness/`（原文件名不变），自测产物仍写 `.out/`；`route-path.mjs`、`security-check.mjs` 改为运行时用 `src/epub/build.js` 自建 EPUB，不再依赖 `.out/sample.epub`；`host-check.mjs` 也自建其「外来 EPUB」样本，并自行 `mkdir .out` |
| 2. 敏感绝对路径 18 处 | 6 份内部产物移入 `notes/`（已 gitignore），`docs/` 只留 4 份；`src/host/server.js:1688` 注释里的本机路径示例换成 `<workspace>`；全仓库（排除 `node_modules`/`.out`/`notes`/`.git`）重扫：本机用户名、仓库绝对路径、密钥形态命中 **0** |
| 3. `private: true` + `files` 收整个 `docs` | 去掉 `private`；`files` 保留 `docs` 目录但内部件已移出，另补 `repository`/`engines`/`scripts` |
| 4. `mupdf` 是 AGPL-3.0-or-later | 新增 `NOTICE` 声明第三方组件许可；README「许可证」写明核心依赖是 AGPL-3.0-or-later、再分发含该依赖的产物须遵守 AGPL、渲染后端可用 `src/pdf/index.js` 单点替换 |

`npm test` 4 套 + `npm run test:harness` 7 套全绿，断言数与 §1 一致（51 / 30 / 30 / 7 场景 71 检查；34 / 18 / 16 / 5 / 11 / 10 / 76）。

仍未覆盖：`npm pack` 清单实测（同 §4）；`npm test` 里的 `test/e2e.mjs` 仍要求 `.out/test*.pdf` 已存在，首次跑之前需先执行 `node src/pdf/smoke.mjs`。
