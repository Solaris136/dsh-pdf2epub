# EPUB 3 组装模块

`src/epub/build.js` 导出 `buildEpub(book) -> Uint8Array`：纯内存打包，不落临时文件、无 DRM、不嵌字体。

## 输入
- `title`、`language` 必填；`author`、`publisher` 可选。
- `identifier` 缺省自动生成 `urn:uuid:`；`modified` 缺省 `1970-01-01T00:00:00Z`。固定时间戳 + 固定 zip mtime，同一书稿可复现字节一致的 EPUB。
- `coverImage`、`assets`：`{ href, mediaType, data }`，`href` 相对 `OEBPS/`（如 `images/cover.png`），省略 `mediaType` 时按扩展名推断；越界（`..`、绝对路径）直接报错。
- `css` 覆盖默认样式；默认见 `src/epub/css.js`（中文排版、`.footnote`、`.verse`、表格边框）。
- `chapters`：`{ id, title, html, level }`，`html` 是 XHTML body 内部片段，由调用方负责转义；`level` 决定 nav 嵌套（1 顶层，2 归入上一个条目）。

## 产物结构
`mimetype`（第一条、存储）→ `META-INF/container.xml` → `OEBPS/content.opf`（EPUB 3.0）→ `OEBPS/nav.xhtml` → `OEBPS/styles/book.css` → `OEBPS/text/<id>.xhtml`（id 不安全时改名）→ 有封面时 `OEBPS/text/cover.xhtml` → `OEBPS/<asset href>`。

## 测试
`node src/epub/test.mjs` 生成 `.out/sample.epub`，逐字节校验 zip 头、manifest、nav 与各章 XHTML，成功打印 `EPUB MODULE OK`。

> 修订（复审 S1/S2/M1–M5）：`ZIP_MTIME` 改为本地构造的 2000-01-01（任意时区均可打包且字节一致）；`title`/`author`/`language`/`publisher`/`identifier`/章节标题经 `sanitizeXmlText` 剔除 XML 1.0 非法码位；`chapter.html` 改为校验后快速失败（`<script>`/内联事件/裸 `&` 抛错，`allowScripts: true` 可放行并写 `properties="scripted"`）；`href` 校验并百分号编码（zip 条目名保持解码形态）；条目名超 200 字节或 Windows 设备名抛错；`language` 需形如 BCP-47；`coverImage.mediaType` 必须为 `image/*`。回归见 `node src/epub/hardening.test.mjs`。
