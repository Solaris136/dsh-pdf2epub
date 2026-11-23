# 持续集成与合并门禁（CI）

`main` 只接受通过 CI 的 PR。工作流在 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)，
门禁规则在 GitHub 仓库设置里，两边必须一起看。

## 1. 什么时候跑

| 事件 | 说明 |
| --- | --- |
| `pull_request` → `main` | 每次推送新提交都会重跑；同一 PR 的新运行会取消旧运行（`concurrency`） |
| `push` → `main` | 合入后确认 `main` 本身是绿的，也是分支保护要求的检查来源 |
| `workflow_dispatch` | 手动重跑 |

工作流只申请 `contents: read`，不写仓库、不发布、不跑模型。

## 2. 三个 job

| job | 内容 | 平台 |
| --- | --- | --- |
| `static` | `npm ci` → `npm run check:syntax` → `npm run check:package` | ubuntu-latest / Node 24 |
| `test` | `npm ci` → `npm test` → `npm run test:harness` | ubuntu-latest × Node 20/22/24，windows-latest × Node 24 |
| `ci-ok` | 等前两个 job 结束，任一不是 `success` 就失败 | ubuntu-latest |

`ci-ok` 用 `if: always()` + `toJSON(needs)` 实现：上游失败或被取消时它也会运行并**报失败**，
不会让必选检查永远卡在 pending。它是分支保护里唯一被要求的检查，其他 job 的名字可以自由改，
**`ci-ok` 的名字不能改**（改了必须同步改分支保护规则）。

Node 版本矩阵对应 `package.json` 的 `engines.node: ">=20"`：20 是声明的最低版本，22/24 是当前
LTS 线，Windows 只跑 24 是因为 Windows 相关代码（路径折叠、平台分支）不随 Node 版本变化，
但整套测试必须证明它在非 POSIX 路径上也成立。

## 3. `static` 检查什么

`npm run check` = `check:syntax` + `check:package`，都是确定性的、不联网、不发模型调用的检查：

`test/ci/check-static.mjs`

- `node --check` 解析仓库内全部 `.js` / `.mjs`（跳过 `node_modules`、`.out`、`notes`、`runs`）。
- `package.json` 与两个 locale JSON 能解析；locale 无空字符串。
- `locale/zh-CN.json` 与 `locale/en-US.json` 键集合一致，逐键 `{placeholder}` 集合一致。
- 插件身份四处一致：`package.json` 的 `name`、`index.js` 的 `export const name`、
  `cordis.patch.yml` 的 `id`、`package-lock.json` 的版本与 `package.json` 版本。
- `exports` 每个目标、`files` 每个条目都真实存在；`files` 不允许点名 `test/`、`notes/`、
  `.out/`、`node_modules/`。
- `dsh.bundle.patch` 指向存在的文件，`dsh.client.platform` 为 `web` 且 `inject` 非空。

`test/ci/check-package.mjs`

- 跑 `npm pack --dry-run --json`（不生成 tarball），读真实清单。
- 17 个运行时条目必须在包里（`index.js`、`client.js`、`src/**` 关键文件、locale、图标、`NOTICE` 等）。
- 不允许混入 `notes/`、`test/`、`.github/`、`.out/`、`node_modules/`、`package-lock.json`、
  PDF / EPUB / `.report.json` / `.book.json` / `.tgz`。
- 包名版本与 `package.json` 一致，`src/` 至少 10 个文件，清单里每个路径在工作树中存在。

## 4. `test` 检查什么

`npm test`（4 套，含 `pretest` 生成 PDF）与 `npm run test:harness`（9 套），断言数见 README 的
「测试」一节。两套命令与本地开发完全一致，CI 不做任何裁剪——唯一的环境差异是浏览器层：

### 浏览器层

`test/harness/security-check.mjs` 的「真浏览器解析」层需要 Chrome / Chromium / Edge：

- 候选顺序：`PDF2EPUB_CHROMIUM` 环境变量 → Windows 的 Edge/Chrome 安装路径 → Linux 的
  `/usr/bin/google-chrome`、`/opt/google/chrome/chrome`、`/usr/bin/chromium*` → macOS 的
  Chrome/Edge `.app`。
- 找不到时本地默认**跳过**该层（打印 SKIP，断言数变少，退出码仍为 0）。
- CI 设置 `PDF2EPUB_REQUIRE_BROWSER=1`，找不到浏览器直接**失败**，避免这一层悄悄从门禁里消失。
  GitHub 托管镜像自带 Chrome（Linux）与 Edge（Windows），所以矩阵里两个平台都能跑满 76 条断言。
- 本机验证这一层：`PDF2EPUB_REQUIRE_BROWSER=1 node test/harness/security-check.mjs`。

## 5. 分支保护（合并门禁）

`main` 上的规则（GitHub → Settings → Branches / Rules）：

- **Require a pull request before merging**：不允许直接 push `main`，必须走 PR。
- **Require status checks to pass**：必选检查 `ci-ok`，并勾选 **Require branches to be up to date
  before merging**（strict）——分支落后于 `main` 时要先 rebase/merge 再等一轮 CI。
- **Do not allow bypassing**（`enforce_admins: true`）：管理员同样受约束。
- 禁止 force push、禁止删除 `main`；要求 PR 对话全部已解决。
- 不要求 reviewer 批准（单人仓库无法给自己批准），门禁是**绿色 `ci-ok` + 最新基线**。

代价很明确：CI 挂了或 Actions 故障期间，`main` 上什么也合不进去。紧急绕过只能由管理员进
Settings 临时关掉规则、合入、立即恢复——不要把「删掉检查」当成常规操作。

### 改 CI 时注意

1. 新增 job 必须写进 `ci-ok` 的 `needs`，否则它不会挡合并。
2. `ci-ok` 改名后，分支保护里的必选检查会匹配不上而永远 pending；改名和改设置要同一次操作。
3. 改 `package.json` 的 `files` / `exports` / 名称 / 版本时，`static` 会先失败——这是有意的，
   发布清单和插件身份都是发布阻断项。

## 6. 本地复现

```bash
npm ci                 # 与 CI 相同的锁文件安装
npm run check          # 静态 + 打包清单
npm test               # 逻辑层 / EPUB / 加固 / e2e
npm run test:harness   # 宿主 / 客户端 / 预览 / 路由 / 安全 / 模型选择 / 选择器
npm run ci             # 以上三步串起来，就是 CI 的全部断言
```

单套运行：`node test/e2e.mjs`、`node test/harness/security-check.mjs` 等，脚本都接受直接
`node` 运行；产物写 `.out/`（已 gitignore）。`pretest`（`node src/pdf/smoke.mjs`）负责生成
e2e 需要的 `.out/test.pdf` 与 `.out/test-long.pdf`，所以单独跑 `test/e2e.mjs` 前先跑一次它。

## 7. 失败排查

1. **先看是哪个 job、哪个平台**：`test (ubuntu-latest, node 20)` 这类名字就是矩阵坐标。
2. **平台差异**：Linux 失败而 Windows 绿，通常是路径大小写、`path.sep`、CRLF、权限位或
   「Windows 上恰好存在」的绝对路径。断言里的 `C:\...` 是合成字符串，不代表实现只能在 Windows 跑。
3. **浏览器层**：报 `PDF2EPUB_REQUIRE_BROWSER=1 but no Chrome/Chromium/Edge was found` 时，
   要么镜像变了，要么候选路径过期——更新 `BROWSER_CANDIDATES` 或显式设置 `PDF2EPUB_CHROMIUM`。
4. **`npm ci` 失败**：`package-lock.json` 与 `package.json` 不一致。本地改依赖后要提交锁文件。
5. **只在一个 Node 版本失败**：对照 `engines.node` 判断是提高下限还是避免新 API；不要为了过 CI
   悄悄删断言。
6. **重跑**：Actions 页面 → 该次运行 → Re-run failed jobs；或推送新提交触发新一轮。
