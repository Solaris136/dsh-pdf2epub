/**
 * dsh-pdf2epub end-to-end harness.
 *
 * Runs the real pipeline (`src/pipeline.js`) against a fake Host: no provider
 * API, no DSH runtime, no network. Nine scenarios cover the happy path,
 * cross-review of a page that fails a sentinel, fail-fast on a text-only model,
 * cache reuse, structured table/list blocks, a failed page staying out of the
 * page cache, the cache key including the render settings, and the diagnostic
 * report a run writes when every page comes back without text (once for pages
 * that parsed to zero blocks, once for replies that never parsed at all). Two
 * more cover the thinking budget a route cannot turn off: a reply that is all
 * reasoning and no text, and the reasoning level forwarded with the answer budget
 * on the first call. One more covers the session routing header the provider
 * refuses to work without: a non-empty id on every call, the same id across the
 * pages of one book, a different one for a different book, and `spec.sessionId`
 * winning over the derived value. The last three cover figure extraction: a
 * boxed figure is cropped out of the page bitmap into the archive, an invalid box
 * is rejected without failing the page, and a crop failure degrades to the
 * caption-only figure instead of losing the page. The six after those cover the
 * reading-quality pass: a page range narrows what is transcribed while the page
 * cache stays keyed by the whole book (so a batch and the final whole-book run
 * share it), `excludePages` subtracts from that range, `cover` renders page 1 into
 * the package (and a failed render only warns), `title`/`author`/`publisher`
 * override the PDF metadata in priority order, and the two deterministic text
 * passes - heading-level clamping, half-open bracket repair and punctuation
 * normalisation - with footnotes and margin folios landing in the right block
 * types. The last six are the reading-quality pass that came out of a real
 * 11-page QC run of 《巴布尔回忆录》: a cross-page continuation is joined only
 * between adjacent pages (so a `pages: "73,216"` selection cannot weld two pages
 * 143 apart), the adjacent join still works, a `toc` block becomes a real
 * `<nav epub:type="toc">` list (leader dots gone, page numbers in `.toc-page`,
 * indentation as `class="toc-N"`, consecutive blocks merged into one list), a
 * folio the model typed inline is deleted from a page WITH or WITHOUT a
 * `page-number` block (tier H dropped the page gate), an empty `figure` renders as
 * nothing, and a heading-only chapter is
 * dropped while the surviving chapter ids stay continuous. The last two pin the
 * narrowed form of that rule: a heading-only chapter opened by an `h1` is a part
 * title page and must survive even when the chapter after it is a sibling `h1`
 * (the same-level shape that lost 部一级结构 in the QC run), while an empty `h2`
 * chapter is still dropped.
 *
 * The last four cover the output layout: ONE BOOK, ONE DIRECTORY. Every run now
 * writes `<outputDir>/<input file name>/` holding `<name>.epub`,
 * `<name>.book.json`, `<name>.report.json`, `pages/` and `images/` (the output
 * directory itself defaults to the PDF's own folder, so the book lands beside its
 * source). (ad) pins that layout end to end, (ae) the Windows sanitising of the
 * directory name, (af) that two different books sharing one file name - and
 * therefore one directory - never reuse each other's cached pages, and (ag) that
 * the page cache of the replaced dot-directory layout is moved into the book
 * directory instead of being abandoned.
 *
 * The final four pin the two defects a real 764-page QC run turned up. (ah) a
 * running head the model typed as `h1` on the SAME page as the `header` that
 * printed it must be demoted to furniture instead of becoming a chapter (the
 * pilot's page 537 built `ch002` out of nothing and broke the page's
 * continuation), and (ai) a chapter-level title that repeats verbatim is NO longer
 * deduplicated: an index section is titled 「人 名」 in every chapter, so both
 * occurrences keep their heading and open a chapter each (the control run proves
 * ordinary unique `h1`s still do). (aj) a genuinely blank page (measured ink
 * 0.000) is not a failed page: it is `ok`, counted in `stats.pagesBlank` only,
 * cached with `blank: true`, and a rerun of the same parameters costs zero model
 * calls; (ak) the other side of that exception - a page with ink whose reply
 * carried no blocks still fails and is still never cached.
 *
 * The next two harden that demotion against the real data it was written for.
 * (al) the same running head reaches the model in two spellings - full-width
 * brackets on the `header`, half-width brackets plus letter-spacing on the line
 * typed as `h1` - so strict equality misses the pair; the comparison key has to
 * fold whitespace and punctuation width first, and the control run proves the
 * variant does not end up with more chapters. (am) the running head is longer
 * than the 40-character furniture hint the pipeline shows the model, so a key
 * built from any truncated hint can never equal the heading; the 60+ character
 * line has to be demoted from the block's own full text.
 *
 * The last three pin the PAGE-LOCAL form of that rule, after the book-wide version
 * of it destroyed a real book. 《巴布尔回忆录》 prints the same
 * 「回历九〇X年(公元 …)的事件」 line as the running head of every continuation page
 * and centres it as the chapter title on the chapter's first page, where this
 * layout prints no running head at all. Comparing a heading against every `header`
 * in the book therefore demoted 8 of the 9 year headings in the first 190 cached
 * pages, and the book came out with 2 chapters where it should have had a dozen.
 * (ar) a chapter first page keeps its title even though the very same text is a
 * running head elsewhere (no `header` on its own page, `demotedHeadings` 0); (as)
 * the page-537 shape is still demoted when the `header` and the heading meet on
 * ONE page; (at) two index sections titled 「人 名」 in different chapters both keep
 * their heading. The repeated-title fallback is gone for the same reason: printing
 * a title twice is not evidence of furniture, printing it beside its own `header`
 * is.
 *
 * The final four cover the leaf mark the same margin carries beside the page
 * number. Page 90 of the pilot book reports `58` as its `page-number` while the
 * running text carries `35a`, so the equality rule of (y) can never see it and a
 * shape rule is needed: (an) that `35a`/`9b`/`22a` are deleted and the sentence
 * closes over the gap (`战斗，开向`, no double space). The first version of that
 * rule cost the book real text - on the first 95 pages of the pilot it deleted
 * four tokens and three of them were cross-page references - so (ao) pins the
 * four guards of tier H: the English `in 1994a study`, a bare `1494`/`1525`, a
 * token glued to a Latin letter or digit, and the citation guard. Tier H also
 * REMOVED the fifth guard - "the page must report a `page-number` block" - after a
 * page-by-page measurement of 495 real pages showed it hid two real leaf marks
 * (page 221) and protected nothing: the other four guards keep plain prose
 * untouched, and a page without the block still prints its mark. The three
 * `page-number`-less expectations below therefore flip to "deleted", with the
 * reason written where they stand. (ap) pins that citation guard on the three
 * reference shapes the real page cache produced (`（见 f. 376b）`,
 * `（f. 49a）`, `见本书编叶 179b。`) plus the two the first version of the guard
 * missed (`参看本书 171a 注。` and `…到达那里后，101a`: a comma is only read across
 * for the STRONG markers, so the positional `后，` does not turn the leaf mark
 * behind it into a reference), and (aq) pins the other direction: every
 * shape a real leaf mark takes - glued to a Chinese character, spaced on both
 * sides, behind a half-width comma, behind the book's middot or a curly quote -
 * is deleted and leaves neither a double space nor a `， ` behind. (y)'s `124b`
 * assertion is the deliberate cost of the same rule and is documented where it now
 * flips.
 *
 * (au) pins the second assembly defect batch 4 (pages 286–380) turned up: the
 * model can answer ONE page with two `p` blocks and the margin leaf mark as a
 * `page-number` block in between (`…要塞里出` / `215b` / `生。诗人大毛拉…`, page
 * 375). Dropping the furniture used to leave two paragraphs, so 出生 was split and
 * the sentence visibly broke; `flattenPages` now re-sews that pair across nothing
 * but dropped `page-number` / `footer` / `header` blocks, and refuses when the
 * first half already ended a sentence or when a heading / table / figure / verse
 * line sits between.
 *
 * The three before those pin the POSITION guards, after two defects that damaged the
 * finished book. Shape and equality say what a token looks like; only its position
 * says where it stands, and both folio rules used to ignore that. (av) page 15 of
 * 《巴布尔回忆录》 reports its `page-number` block as `9` and prints the date
 * `回历九三六年穆哈兰月三日(公元 1529 年 9 月 7 日)原稿中断。`, so the equality
 * rule deleted the month and the book read `公元 1529 年月 7 日`; a token beside
 * `年` `月` `日` `时` `分` `秒` `页` `卷` `章` `节` is now kept by BOTH rules.
 * (aw) the last 64 pages are the index, whose entries end in a locator
 * (`马利克·阿力·库特比,217b`, `阿布都勒·库杜斯,23a,38b`) shaped exactly like a
 * leaf mark: the shape rule deleted 1650 of them in the real 764-page cache, and
 * the equality rule does the same when the model reports a locator as the page's
 * `page-number` block. An index without page references is not an index, so an
 * index line (a bilingual headword, a comma-separated locator list, or a bare
 * entry with no sentence mark) now keeps its locators. (ax) is the control that
 * the guards did not disable the rule they guard: a folio at the block start, at
 * the block end and between two spaces is still deleted.
 *
 * The last five pin the CORRECTION of a printed contents page against the chapter
 * titles - the defect that made the finished book's first page wrong while its body
 * was right. 《巴布尔回忆录》's contents page was transcribed on a page of its own,
 * with no chapter context, and 14 of its entries came out
 * `回忆九〇〇年(1494—1495)的事件` where the chapter is
 * `回历九〇〇年(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)的事件`; `忆` is a
 * homophone of `历` and `回忆` is a real word, so nothing local to the entry marks
 * it wrong, and the 90 chapter titles (each a heading on its own page) are right.
 * (ay) an entry is corrected against the nearest chapter title when the edit distance
 * is at most 2 and the length difference at most 3, by SUBSTITUTING the wrong
 * characters only - the printed abbreviation and the printed page number stay;
 * (az) an entry that is close to no chapter title (`附录：引用书目`) stays exactly as
 * transcribed; (ba) the prose `《巴布尔回忆录》` survives byte for byte - the
 * correction matches entries against a chapter title and is never a 回忆→回历 string
 * replacement, and (ba) is the control that proves it. (bb) pins the reason the
 * substitution must not look inside a parenthetical group: the entry's printed
 * `(1494—1495)` is not the chapter's `(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)`,
 * and a digit-level "fix" would rewrite a date the page prints correctly.
 * (bc) is the outer bound: an entry that differs from the chapter title by four
 * characters or more is left as transcribed rather than half-repaired.
 *
 * The last three pin the full-book audit's three defects. (bd) the running head
 * 「索引与译名对照」 that the model answered as `h1` on page 704 of 《巴布尔回忆录》
 * where the page reports NO `header` block at all - the same-page criterion cannot
 * see it, so the demotion gained a second criterion (the heading repeats the title
 * of the chapter open at its own level AND that title is printed as a `header`
 * somewhere in the book), the duplicate chapter is folded back and `nav.xhtml`
 * lists the title once. (be) is the regression that keeps the second criterion from
 * eating real chapters: a year chapter title IS printed as a running head
 * elsewhere, but it does not repeat the previous chapter's title, so both year
 * chapters survive with `demotedHeadings` 0. (bf) the date guard now speaks about
 * pure numbers only, so `回历九一七年 175b (公元 1511 年)` loses its leaf mark
 * while `公元 1529 年 9 月 7 日` on the same page keeps every digit.
 *
 *   node test/e2e.mjs
 *
 * Artifacts land in `.out/e2e/`; the process exits 1 when any scenario fails.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { strFromU8, unzipSync } from 'fflate'

import { REASONING_HEADROOM } from '../src/host/bridge.js'
// Scenario (aq) asserts the half-width-comma case on the assembler's own output
// as well, because the rendered XHTML no longer shows what the rule produced
// there: `stripFoliage` runs before `normalizePunctuation`, so the flat text is
// `,开向` while the book prints `，开向`. Imported without the pipeline's `?v=`
// stamp on purpose - the rule is a pure function and this is a unit-level check
// of it, not a second pipeline.
import { stripFoliage } from '../src/model/assemble.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, '.out')
const E2E_DIR = path.join(OUT, 'e2e')
const LONG_PDF = path.join(OUT, 'test-long.pdf')
const SHORT_PDF = path.join(OUT, 'test.pdf')
/** Built by this harness (single-page fixtures come from src/pdf/smoke.mjs). */
const TWO_PAGE_PDF = path.join(OUT, 'test-two-pages.pdf')
/** Built on first use by {@link fourPagePdf}; the page-range scenarios need >3 pages. */
const FOUR_PAGE_PDF = path.join(OUT, 'test-four-pages.pdf')
/** Built on first use by {@link manyPagePdf}; the cross-page join scenarios need page 216. */
const MANY_PAGE_PDF = path.join(OUT, 'test-many-pages.pdf')
/** Built on first use by {@link headerPagesPdf}; the running-head scenarios need three pages. */
const HEADER_PAGES_PDF = path.join(OUT, 'test-header-pages.pdf')
/** Built on first use by {@link blankPagesPdf}; the blank-page scenarios need a page that can be answered with nothing. */
const BLANK_PAGES_PDF = path.join(OUT, 'test-blank-pages.pdf')
const PIPELINE = path.join(ROOT, 'src', 'pipeline.js')

const PRIMARY = 'fake/model'
const REVIEW_MODELS = ['fake/a', 'fake/b']

/**
 * What the fake thinking model "thinks" in scenario (j), streamed as
 * `reasoning-delta` chunks and never followed by an answer. Its length is the
 * expected `reasoningChars`, so the assertion proves the diagnostics account for
 * exactly the characters the Host streamed - not merely that some number exists.
 */
const REASONING_TEXT = '我先通读这一页的版面：标题在页眉下方，正文分两栏，脚注很小。'
  + '接下来我逐行辨认文字，忽略页眉页脚，并核对表格的列数。'
  + '最后我把结果整理成 JSON，只保留正文块。'

/**
 * Root cause shared by the token checks in (a) and (b), kept as a regression
 * hint: the page ledger must reach `runConversion`. `transcribeOnce()` has to
 * record spend into the ledger it is handed, and `transcribePage()` has to fold
 * every call's ledger into the page's own one.
 */
const LEDGER_CAUSE =
  '回归提示：transcribeOnce() 必须把花费记进调用方传入的 ledger，transcribePage() 再把各次调用的 ledger 合进本页 ledger；' +
  '否则 runConversion 合到的永远是 0，report.tokens 全为 0'

/** A page that fails a sentinel is retried — the retry call must carry `prompt`. */
const RETRY_CAUSE =
  '回归提示：重试调用必须传 prompt（transcribeOnce 会用 prompt.user + retryNote）；漏传会让任何哨兵不通过的页直接抛 TypeError'

/**
 * A cache hit spends nothing in this run. The entry's historical ledger belongs
 * to `reused`, never to the run's own `ledger`: folding it back makes a fully
 * cached rerun report the first run's bill a second time.
 */
const REUSE_CAUSE =
  '回归提示：命中缓存的分支应 mergeLedger(reused, cached.ledger)，而不是 mergeLedger(ledger, cached.ledger)；' +
  '否则第二次全命中缓存的重跑会把第一次的账再报一遍，report.tokens.calls/input 不为 0'

/** `extractPageText()` only returns `{ text, blockCount }`; `hasText` lives on `extractPageTextDetailed()`. */
const HASTEXT_CAUSE =
  '回归提示：baseline 必须用 extractPageTextDetailed()（或等价方式）拿到 hasText；extractPageText() 不返回该字段，' +
  '会让「有文本层」的页被判成扫描页，needsCrossReview 与 source 都跟着错'

/**
 * A page that produced no book text must not enter the resume cache. A cache hit
 * is replayed as an answer, so caching a 429 turns one failure into a permanent
 * hole in the book: later runs call no model, yet the job reports completion.
 */
const POISON_CAUSE =
  '回归提示：只有 pageHasBookText(page) 为真才写缓存（blocks 非空、没有 error、至少一个非页眉/页脚正文块），' +
  'readCache 也必须拒绝 blocks 为空/带 error 的条目并删除它；否则一次 429 或取消会被缓存成永久缺页：' +
  '后续运行模型零调用、作业却显示完成'

/** The cache key must cover the input file and the render settings, not just page number + model. */
const SETTINGS_CAUSE =
  '回归提示：页缓存条目里必须继续存输入指纹（路径 + 大小 + mtime）、dpi 和主模型，' +
  'readCache 读回时逐项校验，不匹配就当未命中并删除该文件；' +
  '只按页号和模型名判断，会让改 dpi、换提示词版本或换书之后错误复用旧页'

/**
 * Every artifact of one book lives in `<outputDir>/<input file name>/`, and the
 * directory name comes from the FILE, never from `title`: a title can arrive from
 * the caller on one run and from the PDF's `/Title` on the next, so a directory
 * named after it would move under the same input and a resumed run would miss the
 * cache sitting right there.
 */
const BOOK_DIR_CAUSE =
  '回归提示：产物目录必须是 <outputDir>/<输入文件名去扩展名>/，且 epub/book.json/report.json ' +
  '三个文件都以同一个名字命名。目录名只由输入文件名净化而来，不能改用 title；' +
  'title 只进 OPF/book.json。outputDir 缺省是 PDF 所在目录，产物因此与书同级'

/**
 * Two different PDFs with the same file name land in the same book directory, so
 * the page-cache separation no longer comes from the directory name: every cached
 * page carries the input fingerprint, and a mismatch is a miss that is deleted and
 * re-transcribed. A run that replays another book's page here would silently put
 * the wrong text in the book.
 */
const SAME_NAME_CAUSE =
  '回归提示：页缓存 payload 里的 input 指纹必须继续写入并校验；目录改成按文件名命名后，' +
  '两本同名（同名 PDF）书会共用一个 pages/ 目录，只有 payload 里的指纹能把它们分开。' +
  '指纹不匹配时要当未命中并删除旧文件，否则第二本书会直接重放第一本的页'

/**
 * The provider's per-session routing header is mandatory, and the adapter derives
 * it from `GenerateOptions.sessionId`: opencode-go answers `400 MissingSessionID`
 * when that field is absent. Every call therefore has to carry one, and every call
 * of one book has to carry the SAME one - a per-page or random value would route
 * each page as a different conversation and the provider's prompt-prefix cache
 * would never hit.
 */
const SESSION_CAUSE =
  '回归提示：每次 callModel 都必须带非空 sessionId，且同一本书的所有页共用一个；' +
  'pipeline 取 spec.sessionId，缺省用 pdf2epub-<bookId>（不要每页随机）。' +
  '缺这个头会被 opencode-go 直接 400 MissingSessionID，请求根本到不了模型'

/**
 * `pages`/`excludePages` narrow what one run converts; they must NOT become part
 * of the page cache key. If they did, every batch of a batching strategy would be
 * a cold start and the whole point - paying once for a 700-page book - would be
 * lost. The cache key stays "this whole book, read with these settings, page N".
 */
const PAGE_SELECTION_CAUSE =
  '回归提示：页缓存仍按「整本书 + 设置 + 页号」定位（pages/<dpi>-<model>/0000N.json），' +
  '绝不能把 pages/excludePages 拼进 settingsFingerprint；否则分批跑的每一批都是冷启动，' +
  '整本书要按批数重复付费。分批要用 pages，不是复制/改名 PDF'

/**
 * A page break can only tear a paragraph between pages that touch. `pages` is a
 * free selection, so page 73 and page 216 sit next to each other in the flattened
 * list; judging "the previous block" by list order alone welds two pages 143 apart
 * into one sentence (`…都是根` + `速，这似乎表明…`).
 */
const JOIN_CAUSE =
  '回归提示：flattenPages 合并跨页段落前必须校验 block.page === prev.page + 1；' +
  '否则非连续选区（如 pages: "73,216"）会把相隔上百页的两段焊成一句，' +
  '而 continues 标记又让模型抄不到证据。被拒绝的续接要计入 rejectedJoins 并保留标记'

/**
 * A `toc` block is a printed contents list, not verse: it needs a real
 * `nav`/`ol`/`li` structure, no leader dots, the printed page number in its own
 * span, the indentation as `class="toc-N"`, and a single `nav` when the list
 * spans a page break.
 */
const TOC_CAUSE =
  '回归提示：toc 不能按 verse 渲染。要输出 <nav class="toc" epub:type="toc"><ol><li>，' +
  '去掉引导点、把行尾阿拉伯数字页码放进 .toc-page、按行首缩进写 class="toc-N"，' +
  '并把连续的多个 toc 块合并成一个 <nav>（目录跨页是常事）'

/**
 * The printed contents page is transcribed on its own, with no chapter context, so
 * the model slips there: 14 entries of 《巴布尔回忆录》's contents page read
 * `回忆八九九年(…)的事件` while the chapter itself is titled `回历八九九年(…)的事件`.
 * The 90 chapter titles are right - each is a heading block on its own page - so the
 * entries are corrected against THAT list by a deterministic match. It must never
 * become a `回忆`→`回历` string replacement: `回忆` is a real word in this book's
 * prose (`《巴布尔回忆录》`), and it is on almost every page.
 */
const TOC_RECONCILE_CAUSE =
  '回归提示：目录条目要用 buildChapters 的章标题校正——按 headingKey 归一化（去空白、全半角折叠，' +
  '再折掉括注和 〇/○），键相同就原样保留；最近的章标题编辑距离 ≤ 2 且长度差 ≤ 3 才参与校正；' +
  '整条都被改写（距离不小于较短一侧的长度，例如两个字的人名 ↔ 目 录）不算校正；' +
  '两个章标题并列最近时保留原样；没有页码的条目一律不参与。' +
  '校正必须是「段级替换」：字符级对齐后只换一一对应的错字（单条 ≤ 3 个），' +
  '插入/删除一律跳过，括号内不参与，替换后长度不变且与章标题的键距离必须变小，否则回滚。' +
  '绝不能做 回忆→回历 的字符串替换（正文《巴布尔回忆录》会被改坏），' +
  '也不能把本来正确的缩写条目整条换成完整长标题'

/**
 * The model sometimes reports a folio twice: as a `page-number` block (dropped)
 * and inline in the paragraph that runs past it. The dropped copy is right, so the
 * inline one must go too - but only when it is the same standalone token.
 */
const FOLIO_CAUSE =
  '回归提示：正文块里与本页任一 page-number 块 text 完全相同的独立 token 必须删掉，' +
  '并连同它一侧的空格一起删（"倾向 24b 于" -> "倾向于"）；' +
  '只能删独立 token（前后是空格/标点/行首行尾）。这条等价规则本身仍需要 page-number 块提供 token，' +
  '但叶码形状规则不再以「本页有没有 page-number 块」为门（档 H 去掉了第 5 条护栏）：' +
  '没有页码块的页面同样按形状+上下文判，否则 p221 的 120a/120b 会永远漏在正文里'

/**
 * The same margin carries a second mark the equality rule can never see: a leaf
 * mark (`35a`, `9b`, `124b`). Page 90 of the pilot book reports `58` as its
 * `page-number` while the running text carries `35a`, so `stripFoliage` needs a
 * second, shape-based rule beside the equality one.
 */
const LEAF_CAUSE =
  '回归提示：stripFoliage 的叶码规则要四条全满足才删：形状 /^\\d{1,4}[ab]$/；' +
  '独立 token 只在紧邻拉丁字母或数字（含全角数字）时被拒绝（x124b、35ab、２35a 保留；山区，4a在 / 曾23a有 / 领精35b锐 仍按叶码判）；' +
  '跳过空格后至少一侧是 CJK（河 3a 流 删、in 1994a study 留；半角逗号在中文行里也算 CJK 上下文；' +
  '名字间隔号 · 与弯引号 “”‘’ 也算 CJK 邻居——赛伊德· 184b、什么也不要放过。” 197b 都要删）；' +
  '引用护栏——强标记 f. / f / ff. / 叶 / 页 / 见 / 参看 / 本书 结尾时一律不删，可以隔着空格与一个冒号或逗号' +
  '（（见 f. 376b）、（f. 49a）、见本书编叶 179b。、参看本书 171a 注。都是真书正文）；' +
  '弱标记 前 / 后 只在紧贴 token 时才算引证，逗号只对强标记剥离（到达那里后，101a 里的 101a 是叶码，不是引证）；' +
  '档 H 同时去掉了「本页必须有 page-number 块」这条门，没有页码块的页面同样按形状判；' +
  '日期护栏只挡纯数字（回历九一七年 175b 里的 175b 带字母，不是年/月/日，按叶码删——p309 的残留）；' +
  '删除复用 removeFolioToken 的空格吞噬逻辑（"战斗，35a 开向" -> "战斗，开向"，不留双空格）；' +
  '已知取舍，不要为它放宽 CJK 护栏：叶码夹在拉丁词中间时两侧都是拉丁字符、CJK 上下文不成立，' +
  '所以 p419 的「(hu- 233a jra)」会留在书里——这条护栏正是防误删引证的主要防线；' +
  '纯数字（1494、1525）永远不在形状内，不能删'

/**
 * A page number/leaf mark can cut one paragraph into two `p` blocks: the model
 * answered `…要塞里出`, the margin mark as a `page-number` block, then `生。…`
 * (page 375 of the pilot book). Dropping the furniture used to leave two
 * paragraphs, so `出生` was split. `flattenPages` re-sews that pair only when both
 * kept blocks are `p`, nothing but dropped `page-number` / `footer` / `header` sits
 * between them, the pages touch, and the first half did NOT end a sentence - never
 * across a heading, a table, a figure, a verse line or another kept block.
 */
const SPLIT_JOIN_CAUSE =
  '回归提示：被页码/叶码块切断的同一个段落必须重新接上（前块 p、后块 p、中间只有页眉/页脚/页码块、' +
  '页码相邻——同页或 prev+1、前块不以 。！？；：… 等句末标点结尾），接续用 smartJoin，' +
  '中文之间不能留空格（要塞里出 + 生 -> 要塞里出生），并计入 blocksJoined；' +
  '前块以句号结尾时是正常段落边界，不许合并；隔着标题/表格/figure/verse 或另一个正文块时也不许合并'

/**
 * Shape and equality say WHAT a token looks like; only its position says WHERE it
 * stands. Two real defects of 《巴布尔回忆录》 came from reading the first without
 * the second: page 15 lost the month of `公元 1529 年 9 月 7 日` (its `page-number`
 * block is `9`), and the 64-page index lost 1650 locators (`库特比,217b`), because
 * a locator is shaped exactly like a leaf mark. Both rules therefore run the
 * POSITION guards first, and every guard is one-sided: it can only refuse a
 * deletion. A missed margin mark is ugly; a deleted month or index locator is a
 * damaged book.
 */
const POSITION_CAUSE =
  '回归提示：两条规则都要先问「token 站在页码的位置上吗」——页码在版面上独立出现在页边：' +
  '必须处于块的边缘或两侧都是空白（… 9 月 … 的后侧紧贴「月」→ 拒绝）；' +
  '紧邻的非空白字符不能是 , ， 、 ; ； （库特比,217b → 拒绝）；' +
  '日期/引用护栏只对纯数字 token 生效：紧邻（跳过空格）年/月/日/时/分/秒/页/卷/章/节 的**纯数字**一律不删' +
  '（公元 1529 年 9 月 7 日 的 9；第 135 页 的 135），带字母后缀的 175b 不在这条保护里（它不是年/月/日/页/卷）；' +
  '索引条目里的定位符不删——索引行有三种形态：拉丁转写开头（Malik \'Ali qutbi 马利克·阿力·库特比,217b）、' +
  '两个以上后跟列表标点的定位符（,13b,14b,55a）、逗号收尾且整行无句末标点的短条目（丁 · 巴耳班,267b）；' +
  '真正的页边页码仍要删（块首 58、块尾 58、两侧空白 58）。' +
  '护栏只能往「不删」的方向收紧；放宽任何一条都要重跑 764 页真实缓存对比，' +
  '索引区（p701–764）的删除条数是 0，正文叶码清除量不得明显下降（见 .out/page-guards/report.txt）'

/**
 * A running head the model typed as `h1`/`h2` must not become a chapter. The rule
 * has TWO criteria and a heading is demoted only when at least one holds:
 *
 *  1. SAME PAGE - the heading repeats a `header` block printed on its own page;
 *  2. SAME NAME AS THE OPEN CHAPTER, AND THAT NAME IS A RUNNING HEAD SOMEWHERE -
 *     the heading repeats the title of the chapter open at its own level AND that
 *     text is printed as a `header` on some page of the book.
 *
 * Either criterion alone was measured wrong on 《巴布尔回忆录》. The book-wide half
 * of (2) alone is the defect: the running head and the chapter title are the same
 * text (the chapter's first page prints no running head), so a book-wide set
 * deleted the real year-chapter titles. The name half alone would eat legitimate
 * consecutive same-name chapters - 「人 名」 is the title of every chapter's index.
 * ANDed they are exact, which is what scenario (bd)/(be) pin from both sides. Nor
 * is a repeated title furniture on its own: 「人 名」 repeats by design.
 */
const RUNNING_HEAD_CAUSE =
  '回归提示：书眉降级要两条判据，h1/h2 满足任意一条即丢弃（同时计入 blocksDropped 与 demotedHeadings）：' +
  '① 同页——本页有同键（headingKey）的 header 块；' +
  '② 同名且全书印过——标题与「同层已开的章」标题同键，且该键出现在全书任意 header 块的文本集合里，两条同时成立。' +
  '只用 ② 会误杀章首页的真章标题（《巴布尔回忆录》的章首页印的就是书眉那同一句文本：前 190 页 9 个年章标题只剩 1 个）；' +
  '只用「与上一个章同名」会误杀合法的同名连续章（索引小节「人 名」每章都有）。' +
  '绝不对 h1/h2 做全书按标题去重。' +
  '比较键必须由块自身完整 text 经 headingKey 归一（空白折叠并去空格、全角 ASCII 与中日韩标点折成半角），' +
  '不得改用 pipeline 截断到 40 字符的 furnitureHint。' +
  '否则「书眉被标成 h1 而本页恰好没有 header 块」会切出一个重名章（p704），nav 里同名条目出现两次'

/**
 * A visually blank page is not a failed page. The model answering zero blocks is
 * correct there, so the page has to stay `ok`, be counted in `stats.pagesBlank`
 * instead of `pagesFailed`/`pagesDegraded`, and be cached with `blank: true` -
 * otherwise every batch of a full-book run pays for the same blank page again. A
 * page that really has ink keeps the old failure behaviour.
 */
const BLANK_PAGE_CAUSE =
  '回归提示：0 个内容块且 pageInkRatio < 0.005 应判为 blank-page（ok=true、degraded=false、failure="blank-page"、' +
  '计入 stats.pagesBlank，缓存 blocks:[] 且 blank:true）；readCache 必须接受这种条目，普通失败页仍然不缓存'

const state = { checks: 0, failures: [], notes: [], epubs: [], happy: null }
let pipeline = null

/* ------------------------------------------------------------------ *
 * fake Host
 * ------------------------------------------------------------------ */

/**
 * Build a Host double implementing exactly the three seams the pipeline uses.
 *
 * @param {{ textOnly?: boolean, gateNoise?: boolean, tableAndList?: boolean, failPages?: number[], emptyBlocks?: boolean, garbled?: boolean, reasoningOnly?: boolean, reasoningEfforts?: string[], figure?: boolean, badBbox?: boolean }} [options] -
 *   `textOnly` makes `resolveModelInfo` advertise text-only input; `gateNoise`
 *   puts a control character in every page footer, a real sentinel hit;
 *   `tableAndList` adds a one-column pipe table and a three-item list to the
 *   page; `failPages` makes exactly those 1-based pages fail with a 429 the way
 *   a real provider does, by finishing the stream with an `error` reason;
 *   `emptyBlocks` makes every page answer with legal JSON carrying no blocks;
 *   `garbled` makes every page answer with prose that is not JSON;
 *   `reasoningOnly` streams only `reasoning-delta` chunks and ends at
 *   `max-tokens` with no text at all (a route whose thinking consumed the whole
 *   output budget); `reasoningEfforts` makes `resolveModelInfo` advertise
 *   thinking, with those effort ids in lowest-to-highest order;
 *   `figure` adds a captioned figure with a valid bbox; `badBbox` adds the same
 *   figure with a box far below the minimum area; `proseShapes` answers with the
 *   page scenario (t) inspects (a heading that skips a level, half-width
 *   punctuation, a half-open full-width parenthesis, full-width digits, a clock
 *   time and a `code` block that must not be touched); `footnoteAndFolio` answers
 *   with a page footnote plus the folio this book prints in the margin;
 *   `blocksByPage` answers exactly page `N` with `blocksByPage[N]`, which is what
 *   the reading-quality scenarios need (an exact page 73 and page 216, a contents
 *   page, a page carrying a folio both inline and as a block).
 * @returns {object} a Host context plus `__stats` counters (`pages` is the
 *   1-based page number of every call, in call order; `streamRequests` is the
 *   shape of every `stream` request, in call order).
 */
function createFakeHost(options = {}) {
  const stats = { calls: 0, inputTokens: 0, outputTokens: 0, imageSaves: 0, resolves: 0, routes: [], pages: [], streamRequests: [] }
  const failing = new Set(Array.isArray(options.failPages) ? options.failPages : [])

  return {
    __stats: stats,

    llm: {
      async resolveModelInfo(provider, model) {
        stats.resolves += 1
        stats.routes.push(`${provider}/${model}`)
        if (options.textOnly === true) return { inputModalities: ['text'] }
        if (Array.isArray(options.reasoningEfforts)) {
          return {
            inputModalities: ['text', 'image'],
            reasoning: { efforts: options.reasoningEfforts.map(id => ({ id })) },
          }
        }
        return { inputModalities: ['text', 'image'] }
      },

      /** Async generator: `callModel()` only ever iterates the returned value. */
      async *stream(request) {
        const page = pageNumberFrom(request)
        const model = String(request.model ?? '')
        stats.calls += 1
        stats.pages.push(page)
        stats.routes.push(`${request.provider}/${model}`)
        // The request shape is what scenarios (j) and (k) assert on, so record
        // what the pipeline actually sent instead of only that a call happened.
        stats.streamRequests.push({
          provider: request.provider,
          model,
          maxTokens: request.maxTokens,
          reasoningEffort: request.reasoningEffort,
          sessionId: request.sessionId,
        })

        // A failed call is `finish.reason.kind === 'error'`, with the failure at
        // `reason.failure` — exactly what the Host's stream contract delivers for
        // a 429 (`collectStream()` turns it into `error`). No text, no usage.
        if (failing.has(page)) {
          yield { kind: 'finish', reason: { kind: 'error', failure: { code: 429, message: `429 Too Many Requests (page ${page})` } } }
          return
        }

        // (j) Thinking that never reaches an answer: reasoning deltas, no text
        // delta at all, and the stream ends on the normalised `max-tokens` reason
        // — the shape a route that cannot disable thinking produces when its
        // reasoning phase spends the whole output budget.
        if (options.reasoningOnly === true) {
          for (const chunk of splitInto(REASONING_TEXT, 3)) yield { kind: 'reasoning-delta', text: chunk }
          yield { kind: 'finish', reason: { kind: 'max-tokens' } }
          return
        }

        const reply = fakeReply(page, model, options)
        const inputTokens = 1000 + page * 10
        const outputTokens = 40 + reply.length

        stats.inputTokens += inputTokens
        stats.outputTokens += outputTokens

        yield { kind: 'block-start' }
        for (const chunk of splitInto(reply, 3)) yield { kind: 'text-delta', text: chunk }
        yield { kind: 'usage', usage: { inputTokens, outputTokens } }
        yield { kind: 'finish' }
      },
    },

    attachments: {
      async saveImage(input) {
        if (!(input?.data instanceof Uint8Array)) {
          throw new Error('fake host: saveImage input.data must be a Uint8Array')
        }
        if (![0x89, 0x50, 0x4e, 0x47].every((byte, index) => input.data[index] === byte)) {
          throw new Error('fake host: saveImage input.data must start with the PNG magic')
        }
        // The attachment seam only carries bytes; intrinsic size comes from IHDR.
        const size = pngSize(input.data)
        if (size === null) throw new Error('fake host: saveImage input.data has no readable IHDR')
        stats.imageSaves += 1
        return {
          id: 'img',
          mediaType: 'image/png',
          width: Number.isInteger(input.width) ? input.width : size.width,
          height: Number.isInteger(input.height) ? input.height : size.height,
        }
      },
    },
  }
}

/** Three deliberately different body lengths, keyed by the model id. */
function bodyFor(page, model) {
  const base = `这是第${page}页的正文。<p>`
  if (model === 'a') return `${base}复核模型 A 补充了更长的一段文字，用来制造明显的长度差异。`
  if (model === 'b') return `第${page}页。`
  return base
}

/**
 * The text one fake model call returns.
 *
 * Three shapes are produced on purpose, because they are what the diagnostic
 * report has to tell apart afterwards: a normal page (the default), a legal JSON
 * reply with no blocks (`emptyBlocks`), and prose that is not JSON at all
 * (`garbled`). The garbled text carries no braces, so `stripToJson()` cannot
 * rescue it into a parse and it really exercises the unparsable branch.
 *
 * @param {number} page - 1-based page number being transcribed.
 * @param {string} model - model id from the request.
 * @param {object} options - the fake Host options.
 * @returns {string} assistant text.
 */
function fakeReply(page, model, options) {
  if (options.emptyBlocks === true) return JSON.stringify({ blocks: [] })
  if (options.garbled === true) {
    // Longer than the 400-character excerpt on purpose: a model that answers in
    // prose rambles, and the report has to truncate rather than archive it.
    return `抱歉，这一页我看不清，模型没有按 JSON 回答。 (fake host: plain text, not JSON, page ${page}) `
      .repeat(12)
  }
  // An exact answer for one page, so a scenario can dictate the text a repair or
  // a join has to act on instead of accepting whatever the default page holds.
  const exact = options.blocksByPage?.[page]
  if (Array.isArray(exact)) return JSON.stringify({ blocks: exact })
  if (options.proseShapes === true) return JSON.stringify({ blocks: proseShapeBlocks() })
  if (options.footnoteAndFolio === true) return JSON.stringify({ blocks: footnoteAndFolioBlocks() })
  const blocks = [
    { type: 'h2', text: `第${page}章` },
    { type: 'p', text: bodyFor(page, model), continues: false },
    ...(options.tableAndList === true ? layoutBlocks() : []),
    ...figureBlocks(options),
    { type: 'footer', text: `页脚${page}${options.gateNoise === true ? '\u0007' : ''}` },
  ]
  return JSON.stringify({ blocks })
}

/**
 * The mixed page scenario (t) reads, one repair per block.
 *
 * `h1` followed by `h3` skips a level; the first paragraph mixes half-width
 * `,`/`;` with a half-open full-width `（`; the second carries full-width digits
 * and a clock time whose colon must stay half-width; the `code` block must come
 * through byte for byte; the footnote runs through the same punctuation pass.
 *
 * @returns {object[]} raw blocks for the fake model reply.
 */
function proseShapeBlocks() {
  return [
    { type: 'h1', text: '第一部' },
    { type: 'h3', text: '小节' },
    { type: 'p', text: '这是一句话, 另一句话; 括号未闭合（注' },
    { type: 'p', text: '全角数字１２３保留为半角, 时间12:30不动' },
    { type: 'code', text: '中文, 这里不动; 括号（注' },
    { type: 'footnote', text: '① 译者注, 标点也归一（注' },
  ]
}

/**
 * The page scenario (u) reads: a page footnote with its marker kept, and the folio
 * this book prints in the middle of the outer margin (not in the footer).
 *
 * @returns {object[]} raw blocks for the fake model reply.
 */
function footnoteAndFolioBlocks() {
  return [
    { type: 'footnote', text: '① 这是译者注，注文在页面底部' },
    { type: 'page-number', text: '131b' },
    { type: 'p', text: '正文一句。' },
  ]
}

/**
 * Figures the fake model claims to see.
 *
 * The valid box covers the middle of the page: big enough to pass the pipeline's
 * area check and small enough not to be the page itself. The invalid one has a
 * 0.0001 area, which is exactly the "the model pointed at a sliver" shape the
 * block contract rejects.
 *
 * @param {object} options - fake Host options.
 * @returns {object[]} zero or one raw figure block.
 */
function figureBlocks(options) {
  if (options.figure === true) {
    return [{ type: 'figure', text: '图 1', bbox: [0.1, 0.2, 0.9, 0.7] }]
  }
  if (options.badBbox === true) {
    return [{ type: 'figure', text: '图 1', bbox: [0.1, 0.1, 0.11, 0.11] }]
  }
  return []
}

/**
 * Blocks whose source is multi-line Markdown. A pipe table and a bullet list
 * only survive as real structures if `normalizeBlock()` keeps their newlines;
 * collapse them into one line and the table loses `<tbody>`/`<td>` and the list
 * becomes a single `<li>`.
 */
function layoutBlocks() {
  return [
    { type: 'table', text: '| 词语 |\n| --- |\n| 甲 |' },
    { type: 'list', text: '- 第一项\n- 第二项\n- 第三项' },
  ]
}

/** Concatenate the text parts of the last user turn. */
function userText(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  const user = [...messages].reverse().find(message => message?.role === 'user')
  const parts = Array.isArray(user?.content) ? user.content : []
  return parts.filter(part => part?.type === 'text').map(part => part.text).join('\n')
}

/** Read the page number the prompt announces as 「第 N 页」. */
function pageNumberFrom(request) {
  const match = /第\s*(\d+)\s*页/.exec(userText(request))
  return match === null ? 1 : Number(match[1])
}

/** Split a string into `count` non-empty chunks, preserving order. */
function splitInto(text, count) {
  const size = Math.max(1, Math.ceil(text.length / count))
  const chunks = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

/**
 * The book id the pipeline derives from an input path: its absolute path hashed
 * with sha256 and cut to 12 hex characters.
 *
 * Scenario (l) asserts the exact fallback session id, so it has to compute that
 * id the same way the pipeline does. It is recomputed here rather than imported
 * to keep the harness importing nothing but the pipeline module under test.
 *
 * @param {string} file - path of the PDF.
 * @returns {string} the 12-hex book id.
 */
function bookIdFor(file) {
  return createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 12)
}

/** Read width/height from a PNG's IHDR chunk (signature 8 bytes, then IHDR). */
function pngSize(bytes) {
  if (bytes.length < 24) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width === 0 || height === 0) return null
  return { width, height }
}

/**
 * Build a valid multi-page PDF by hand (Helvetica, one text line per line of the
 * per-page arrays), with a correctly computed xref table. *
 * The fixtures in `.out/` that `src/pdf/smoke.mjs` writes are single-page, and
 * the cache scenarios need a document where one page can fail while the rest of
 * the book still succeeds. Hand-building it keeps the harness offline and
 * dependency-free, exactly like the smoke fixture it is modelled on.
 *
 * @param {string[][]} linesPerPage - text lines for each page, in order.
 * @returns {Buffer} the PDF bytes.
 */
function buildMultiPagePdf(linesPerPage) {
  const pdfString = (s) => `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`
  // Object numbering: 1 catalog, 2 page tree, 3 font, then page/content pairs.
  const fontObject = 3
  const objects = new Map([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, `<< /Type /Pages /Kids [${linesPerPage.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${linesPerPage.length} >>`],
    [fontObject, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
  ])
  linesPerPage.forEach((lines, index) => {
    const pageObject = 4 + index * 2
    const contentObject = pageObject + 1
    const content = lines
      .map((line, row) => `BT /F1 24 Tf 72 ${700 - row * 40} Td ${pdfString(line)} Tj ET`)
      .join('\n')
      .concat('\n')
    objects.set(pageObject, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.276 841.89] '
      + `/Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>`)
    objects.set(contentObject, `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`)
  })

  const total = objects.size
  const parts = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  let offset = parts[0].length
  const offsets = new Array(total + 1).fill(0)
  for (let number = 1; number <= total; number += 1) {
    const body = Buffer.from(`${number} 0 obj\n${objects.get(number)}\nendobj\n`, 'latin1')
    offsets[number] = offset
    parts.push(body)
    offset += body.length
  }
  const xrefOffset = offset
  // Every xref entry is exactly 20 bytes: 10 offset + space + 5 gen + space + type + CRLF.
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f\r\n`
  for (let number = 1; number <= total; number += 1) {
    xref += `${String(offsets[number]).padStart(10, '0')} 00000 n\r\n`
  }
  xref += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

/**
 * Four-page fixture, built once and shared by the page-selection scenarios.
 *
 * Each page carries one short ASCII line, so every page has book text but no text
 * layer (`hasText` is false below 20 characters) - which keeps the fake model's
 * answer identical from run to run and leaves the ratio sentinel out of the way.
 * Four pages are the smallest document that can prove "page 2-3 only" and
 * "1-3 minus 2" are different selections.
 *
 * @type {Promise<string> | null}
 */
let fourPagePromise = null

/**
 * Build {@link FOUR_PAGE_PDF} on first use and hand back its path.
 *
 * @returns {Promise<string>} absolute path of the PDF.
 */
function fourPagePdf() {
  if (fourPagePromise === null) {
    fourPagePromise = (async () => {
      await mkdir(OUT, { recursive: true })
      await writeFile(FOUR_PAGE_PDF, buildMultiPagePdf([
        ['Page-range fixture, page one.'],
        ['Page-range fixture, page two.'],
        ['Page-range fixture, page three.'],
        ['Page-range fixture, page four.'],
      ]))
      return FOUR_PAGE_PDF
    })()
  }
  return fourPagePromise
}

/**
 * 220-page fixture, built once and shared by the cross-page join scenarios.
 *
 * The join rule is about page *numbers*, so the scenarios need a document where
 * page 73 and page 216 exist: that is exactly the span of the pilot book's bad
 * weld (73 ends mid-sentence, 216 opens with `continues: true`, and they are 143
 * pages apart in the PDF). Each page carries one short line, so no page has a
 * text layer and the fake model's answer is the only text that matters.
 *
 * @type {Promise<string> | null}
 */
let manyPagePromise = null

/**
 * Build {@link MANY_PAGE_PDF} on first use and hand back its path.
 *
 * @returns {Promise<string>} absolute path of the PDF.
 */
function manyPagePdf() {
  if (manyPagePromise === null) {
    manyPagePromise = (async () => {
      await mkdir(OUT, { recursive: true })
      const lines = []
      for (let page = 1; page <= 220; page += 1) lines.push([`p${page}`])
      await writeFile(MANY_PAGE_PDF, buildMultiPagePdf(lines))
      return MANY_PAGE_PDF
    })()
  }
  return manyPagePromise
}

/**
 * Three-page fixture for the running-head scenarios.
 *
 * Page content is dictated by `blocksByPage`, so one document serves all three
 * cases: a running head the model typed as `h1` (the pilot's page-537 defect), a
 * chapter title that repeats verbatim (the fallback rule for a book that has no
 * `header` block at all), and a control run with two distinct chapter titles.
 * Each page carries one short ASCII line, so no page has a text layer and the
 * fake model's answer is the only text that matters.
 *
 * @type {Promise<string> | null}
 */
let headerPagesPromise = null

/**
 * Build {@link HEADER_PAGES_PDF} on first use and hand back its path.
 * @returns {Promise<string>} absolute path of the PDF.
 */
function headerPagesPdf() {
  if (headerPagesPromise === null) {
    headerPagesPromise = (async () => {
      await mkdir(OUT, { recursive: true })
      await writeFile(HEADER_PAGES_PDF, buildMultiPagePdf([
        ['Header fixture, page one.'],
        ['Header fixture, page two.'],
        ['Header fixture, page three.'],
      ]))
      return HEADER_PAGES_PDF
    })()
  }
  return headerPagesPromise
}

/**
 * Two-page fixture for the blank-page scenarios: page 1 is the page the fake model
 * answers with no blocks at all, page 2 a normal page so the run still produces a
 * book.
 *
 * @type {Promise<string> | null}
 */
let blankPagesPromise = null

/**
 * Build {@link BLANK_PAGES_PDF} on first use and hand back its path.
 * @returns {Promise<string>} absolute path of the PDF.
 */
function blankPagesPdf() {
  if (blankPagesPromise === null) {
    blankPagesPromise = (async () => {
      await mkdir(OUT, { recursive: true })
      await writeFile(BLANK_PAGES_PDF, buildMultiPagePdf([
        ['Blank fixture, page one.'],
        ['Blank fixture, page two.', 'This page must still transcribe.'],
      ]))
      return BLANK_PAGES_PDF
    })()
  }
  return blankPagesPromise
}

/* ------------------------------------------------------------------ *
 * pipeline loading (with a minimal, documented load-time repair)
 * ------------------------------------------------------------------ */

/**
 * Import the real pipeline exactly the way a Host would.
 *
 * No patching, no data: URL, no shim: if `src/pipeline.js` cannot be imported
 * this run fails loudly, which is itself the first thing worth knowing.
 *
 * @returns {Promise<object>} the pipeline module.
 */
async function loadPipeline() {
  return import(pathToFileURL(PIPELINE).href)
}

/** Count non-overlapping occurrences of a literal needle. */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * The text of the FIRST `.toc-title` in a rendered chapter.
 *
 * The contents scenarios assert on what a reader sees, which is the span's text and
 * not the markup around it: the same entry is `回忆…` in the source, `回历…` in the
 * output, and the length of the two is the assertion that no character was inserted
 * or deleted. `''` when the chapter has no contents list at all, so a scenario that
 * lost its `<nav>` fails on the text rather than on a TypeError.
 */
function tocTitleOf(chapter) {
  const match = String(chapter ?? '').match(/<span class="toc-title">([^<]*)<\/span>/)
  return match === null ? '' : match[1]
}

/* ------------------------------------------------------------------ *
 * assertions and output
 * ------------------------------------------------------------------ */

/** Record a failure and keep the scenario running, so one root cause cannot hide the rest. */
function recordFailure(label, detail, options = {}) {
  state.checks += 1
  state.failures.push({ label, detail, cause: options.cause })
  return false
}

function expect(label, actual, expected, options = {}) {
  if (isDeepStrictEqual(actual, expected)) {
    state.checks += 1
    return true
  }
  return recordFailure(label, `期望 ${show(expected)}，实际 ${show(actual)}`, options)
}

function expectTrue(label, condition, options = {}) {
  if (condition === true) {
    state.checks += 1
    return true
  }
  return recordFailure(label, options.detail ?? '条件为假', options)
}

function show(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof Uint8Array) return `<${value.length} bytes>`
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

function shorten(text, limit = 160) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, limit)
}

/** The rendered table markup, for failure messages (empty when nothing rendered). */
function tableSnippet(chapter) {
  const start = chapter.indexOf('<table>')
  if (start === -1) return '没有 <table>'
  const end = chapter.indexOf('</table>', start)
  return shorten(`<table>…${chapter.slice(start, end === -1 ? start + 120 : end)}`)
}

function note(text) {
  state.notes.push(text)
}

function drainNotes() {
  const lines = state.notes.slice()
  state.notes.length = 0
  return lines
}

async function isFile(file) {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * Every page-cache file of one book, grouped by file name.
 *
 * The directory a book's artifacts live in is a contract now
 * (`<outputDir>/<input file name>/`), so the scenarios assert it instead of
 * searching for whatever directory the pipeline happened to choose. The settings
 * segment below `pages/` (`<dpi>-<model>`) is still the pipeline's business - a
 * hard-coded `100-fake_model` would break the day the key changes - so it is
 * discovered by walking exactly one level under `<bookDir>/pages/`, while the
 * layout ABOVE it is asserted, not searched for: a page file anywhere else is
 * simply not found, which is what makes "there is no `00001.json`" meaningful.
 *
 * @param {string} outputDir - the directory the conversion was asked to write into.
 * @param {string} bookName - the book directory name (the input file's stem).
 * @returns {Promise<Map<string, string[]>>} cache file name -> absolute paths.
 */
async function cacheFilesOf(outputDir, bookName) {
  const byName = new Map()
  const pagesRoot = path.join(outputDir, bookName, 'pages')
  const settingsDirs = await readdir(pagesRoot, { withFileTypes: true }).catch(() => [])
  for (const dir of settingsDirs) {
    if (!dir.isDirectory()) continue
    const settingsDir = path.join(pagesRoot, dir.name)
    const files = await readdir(settingsDir, { withFileTypes: true }).catch(() => [])
    for (const file of files) {
      if (!file.isFile()) continue
      const list = byName.get(file.name) ?? []
      list.push(path.join(settingsDir, file.name))
      byName.set(file.name, list)
    }
  }
  return byName
}

/**
 * The absolute cache paths under `<outputDir>/<book>/pages/` for one file name.
 * @param {string} outputDir - output directory.
 * @param {string} bookName - book directory name.
 * @param {string} fileName - cache file name, e.g. `00001.json`.
 * @returns {Promise<string[]>} absolute paths, sorted by the walk order.
 */
async function cacheEntries(outputDir, bookName, fileName) {
  return (await cacheFilesOf(outputDir, bookName)).get(fileName) ?? []
}

/**
 * Whether `<outputDir>/<book>/pages` exists and is a directory.
 *
 * A "no cache file for page N" assertion is only meaningful if the directory that
 * would hold it exists; without this, a changed layout would make the negative
 * pass vacuously. Every scenario that asserts a missing page file pairs the two.
 *
 * @param {string} outputDir - output directory.
 * @param {string} bookName - book directory name.
 * @returns {Promise<boolean>} true when the pages directory is there.
 */
async function hasPagesDirectory(outputDir, bookName) {
  const info = await stat(path.join(outputDir, bookName, 'pages')).catch(() => null)
  return info !== null && info.isDirectory()
}

/**
 * The names of the files and directories directly inside one directory.
 * @param {string} dir - directory to list.
 * @returns {Promise<{ files: string[], directories: string[] }>} sorted names, or two empty lists when `dir` is missing.
 */
async function listDirectory(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return {
    files: entries.filter(entry => entry.isFile()).map(entry => entry.name).sort(),
    directories: entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
  }
}

/**
 * The input fingerprint the pipeline stores as `input` in every page-cache entry:
 * `sha256(absolute path \0 size \0 mtimeMs)` cut to 12 hex characters.
 *
 * Scenario (ag) writes a cache entry by hand in the old layout, so it has to agree
 * with the pipeline on this value exactly - otherwise the entry would be rejected
 * for the wrong reason and the migration would be "proven" by a cold start.
 *
 * @param {string} file - path of the input PDF.
 * @returns {Promise<string>} the 12-hex fingerprint.
 */
async function inputFingerprintFor(file) {
  const info = await stat(file)
  return createHash('sha256')
    .update(`${path.resolve(file)}\u0000${info.size}\u0000${Math.trunc(info.mtimeMs)}`)
    .digest('hex')
    .slice(0, 12)
}

function relativeToRoot(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function unzip(buffer) {
  return unzipSync(new Uint8Array(buffer))
}

/**
 * The body text of every chapter document, concatenated.
 *
 * Each fake page opens its own `h2`, and `splitLevel` is 2, so one page's text
 * lives in its own `OEBPS/text/*.xhtml` document: "does the book contain page 3"
 * has to read them all, not just `ch001`.
 *
 * @param {Record<string, Uint8Array>} entries - `unzipSync` output.
 * @returns {string} the concatenated chapter documents.
 */
function allChapterText(entries) {
  return Object.keys(entries)
    .filter(name => /^OEBPS\/text\/[^/]+\.xhtml$/.test(name))
    .sort()
    .map(name => strFromU8(entries[name]))
    .join('\n')
}

/**
 * Run one conversion that is expected to fail, keeping the scenario alive.
 *
 * @param {object} options - `runConversion` options.
 * @returns {Promise<{ run: object | null, error: Error | null }>} the result, or the thrown error.
 */
async function runExpectingFailure(options) {
  try {
    return { run: await pipeline.runConversion(options), error: null }
  } catch (error) {
    return { run: null, error }
  }
}

/**
 * The absolute report path a failure message names, or null.
 *
 * The pipeline appends `; diagnostics written to <path>` exactly so the path is
 * recoverable from the error alone - that is the only thing a caller who logs the
 * failure but never sees the file will have. The harness reads it back out
 * instead of guessing the file name, so a report written somewhere unexpected
 * fails the test rather than being found by a lucky hard-coded path.
 *
 * @param {unknown} message - the thrown error's message.
 * @returns {string | null} absolute path, or null when the message names none.
 */
function diagnosticPathFrom(message) {
  const marker = 'diagnostics written to '
  const text = String(message ?? '')
  const at = text.indexOf(marker)
  return at === -1 ? null : text.slice(at + marker.length).trim()
}

/**
 * Read and parse one report file.
 *
 * @param {string} file - absolute path.
 * @returns {Promise<{ report: object | null, error: Error | null }>} parsed report, or why it could not be parsed.
 */
async function readReport(file) {
  try {
    return { report: JSON.parse(await readFile(file, 'utf8')), error: null }
  } catch (error) {
    return { report: null, error }
  }
}

/* ------------------------------------------------------------------ *
 * scenarios
 * ------------------------------------------------------------------ */

/** (a) One page, no reviewers: EPUB structure, XHTML escaping, furniture dropped, billing. */
async function scenarioHappyPath() {
  const host = createFakeHost()
  const progress = []
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: E2E_DIR },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
    onProgress: event => progress.push(event),
  })
  state.happy = { run, host, progress }
  state.epubs.push(run.epubPath)

  const epubThere = await isFile(run.epubPath)
  const reportThere = await isFile(run.reportPath)
  expectTrue('epubPath 与 reportPath 都存在', epubThere && reportThere,
    { detail: `${relativeToRoot(run.epubPath)}=${epubThere}, ${relativeToRoot(run.reportPath)}=${reportThere}` })
  // The book lives in its own directory under the requested outputDir, named
  // after the input FILE (`test-long.pdf` -> `test-long/`), not after the title.
  const bookDir = path.join(E2E_DIR, 'test-long')
  expect('(a) 产物落在 <outputDir>/<PDF 文件名>', path.dirname(run.epubPath), bookDir, { cause: BOOK_DIR_CAUSE })
  expect('(a) reportPath 与 epubPath 同目录', path.dirname(run.reportPath), bookDir, { cause: BOOK_DIR_CAUSE })
  expect('(a) bookJsonPath 与 epubPath 同目录', path.dirname(run.bookJsonPath), bookDir, { cause: BOOK_DIR_CAUSE })
  expect('(a) report.book.directory 就是该书目录', run.report.book.directory, bookDir, { cause: BOOK_DIR_CAUSE })
  expectTrue('(a) 书目录里有 pages/ 缓存子目录', await hasPagesDirectory(E2E_DIR, 'test-long'),
    { detail: path.join(bookDir, 'pages') })

  const entries = unzip(await readFile(run.epubPath))
  const names = Object.keys(entries)
  expectTrue('fflate 能解开 EPUB', names.length > 0, { detail: `entries = ${names.length}` })
  expectTrue('EPUB 含 mimetype', names.includes('mimetype'), { detail: names.join(', ') })
  expectTrue('EPUB 含 OEBPS/text/ch001.xhtml', names.includes('OEBPS/text/ch001.xhtml'), { detail: names.join(', ') })

  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  expectTrue('ch001.xhtml 含「第1章」', chapter.includes('第1章'))
  expectTrue('正文里的 <p> 字面量已转义为 &lt;p&gt;', chapter.includes('&lt;p&gt;'))
  expectTrue('ch001.xhtml 不含未转义的「正文。<p>」', !chapter.includes('正文。<p>'))

  const report = JSON.parse(await readFile(run.reportPath, 'utf8'))
  expect('report.schema', report.schema, 'dsh-pdf2epub/report@1')
  expectTrue('report.stats.blocks > 0', report.stats.blocks > 0, { detail: `blocks = ${report.stats.blocks}` })
  expectTrue('report.stats.blocksDropped >= 1（页脚被丢）', report.stats.blocksDropped >= 1,
    { detail: `blocksDropped = ${report.stats.blocksDropped}` })
  expect('report.stats.chapters', report.stats.chapters, 1)
  expectTrue('report.tokens.input > 0', report.tokens.input > 0, {
    detail: `report.tokens.input = ${report.tokens.input}，但宿主实际计费 inputTokens = ${host.__stats.inputTokens}`,
    cause: LEDGER_CAUSE,
  })
  expectTrue('report.stats.pagesFromTextLayer >= 1（该 PDF 有真实文本层）', report.stats.pagesFromTextLayer >= 1, {
    detail: `pagesFromTextLayer = ${report.stats.pagesFromTextLayer}`,
    cause: HASTEXT_CAUSE,
  })
  expect('report.pages[0].source 为 vlm+text-layer', report.pages[0].source, 'vlm+text-layer', { cause: HASTEXT_CAUSE })
  expect('主模型只调用 1 次（无复核）', host.__stats.calls, 1)
  expect('页图以 PNG 交给宿主 1 次', host.__stats.imageSaves, 1)

  return `epub ${names.length} entries | blocks ${report.stats.blocks} | dropped ${report.stats.blocksDropped} | host calls ${host.__stats.calls} | report tokens ${report.tokens.input}`
}

/** (b) A page that trips the control-character sentinel must be retried, cross-reviewed, and still assemble. */
async function scenarioCrossReview() {
  const host = createFakeHost({ gateNoise: true })
  let run = null
  let crash = null
  try {
    run = await pipeline.runConversion({
      host,
      spec: { input: LONG_PDF, outputDir: path.join(E2E_DIR, 'review') },
      config: { primaryModel: PRIMARY, reviewModels: REVIEW_MODELS, dpi: 100, concurrency: 2 },
    })
  } catch (error) {
    crash = error
  }

  const survived = expectTrue('哨兵不通过的页不应让整次转换抛错', crash === null, {
    detail: crash === null ? '' : `${crash.name}: ${crash.message}`,
    cause: RETRY_CAUSE,
  })
  if (!survived) return '转换在重试阶段中止，复核相关断言无法求值'

  state.epubs.push(run.epubPath)
  const page = run.report.pages[0]
  expect('report.pages[0].reviewed === true', page.reviewed, true)
  expect('该页三个模型都参与了', page.models, ['fake/model', 'fake/a', 'fake/b'])
  expect('report.pages[0].degraded 是布尔值', typeof page.degraded, 'boolean')
  expectTrue('该页确实触发过哨兵（控制字符）', page.issues.some(issue => issue.includes('control characters')),
    { detail: `issues = ${JSON.stringify(page.issues)}` })
  expectTrue('report.tokens.calls >= 3', run.report.tokens.calls >= 3, {
    detail: `report.tokens.calls = ${run.report.tokens.calls}，但宿主实际调用 ${host.__stats.calls} 次`,
    cause: LEDGER_CAUSE,
  })
  expectTrue('report.tokens.input > 0', run.report.tokens.input > 0,
    { detail: `report.tokens.input = ${run.report.tokens.input}`, cause: LEDGER_CAUSE })
  expectTrue('report.tokens.output > 0', run.report.tokens.output > 0,
    { detail: `report.tokens.output = ${run.report.tokens.output}`, cause: LEDGER_CAUSE })
  expectTrue('宿主实际调用 >= 3 次', host.__stats.calls >= 3, { detail: `host calls = ${host.__stats.calls}` })
  expect('report.stats.pagesCrossReviewed', run.report.stats.pagesCrossReviewed, 1)
  expectTrue('复核后仍产出可读正文（不抛错）', run.report.stats.chapters >= 1 && run.report.stats.blocks > 0,
    { detail: `chapters = ${run.report.stats.chapters}, blocks = ${run.report.stats.blocks}` })

  return `reviewed=${page.reviewed} degraded=${page.degraded} agreement=${page.agreement} | host calls ${host.__stats.calls}`
}

/** (e) Multi-line Markdown blocks must build real XHTML table/list structures. */
async function scenarioTableAndList() {
  const host = createFakeHost({ tableAndList: true })
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: path.join(E2E_DIR, 'blocks') },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  state.epubs.push(run.epubPath)

  const entries = unzip(await readFile(run.epubPath))
  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  const td = countOf(chapter, '<td>')
  const th = countOf(chapter, '<th>')
  const li = countOf(chapter, '<li>')

  expectTrue('章节里有 <table>', chapter.includes('<table>'))
  expectTrue('表格有 <tbody>（数据行没被当成表头）', chapter.includes('<tbody>'),
    { detail: tableSnippet(chapter) })
  expect('数据行 <td> 数量', td, 1)
  expect('表头 <th> 数量', th, 1)
  expectTrue('列表 <li> 数量', li === 3, { detail: `li = ${li}` })
  expectTrue('表格分隔行没有残留成单元格', !chapter.includes('---'))
  expectTrue('列表项文字都在', chapter.includes('第三项'))

  return `td=${td} th=${th} li=${li} tbody=${chapter.includes('<tbody>')} | host calls ${host.__stats.calls}`
}

/** (c) A route that cannot read images must fail before any model call. */
async function scenarioTextOnly() {
  const host = createFakeHost({ textOnly: true })
  let error = null
  try {
    await pipeline.runConversion({
      host,
      spec: { input: SHORT_PDF, outputDir: path.join(E2E_DIR, 'text-only') },
      config: { primaryModel: PRIMARY, reviewModels: [] },
    })
  } catch (caught) {
    error = caught
  }
  const rejected = expectTrue('runConversion 被 reject', error !== null, { detail: '返回成功而不是抛错' })
  if (!rejected) return '没有错误可检查'
  expectTrue('错误信息含 image', /image/i.test(error.message), { detail: `message = ${error.message}` })
  expect('拒绝前没有发起模型调用', host.__stats.calls, 0)
  return `rejected: ${error.message}`
}

/**
 * (d) Re-running the exact same arguments must be served from the page cache,
 * and a cache hit must cost nothing: the rerun's own ledger stays at zero while
 * the historical spend is visible under `reused`, and the EPUB it rebuilds is
 * byte-identical to the first one.
 */
async function scenarioCacheReuse() {
  if (state.happy === null) {
    return expectTrue('场景 (a) 产出了可比较的 run', false, { detail: 'runConversion 在 (a) 里就失败了' }) ? '' : '跳过'
  }
  const first = state.happy
  // Snapshot the first EPUB *before* the rerun writes the same output path:
  // reading both paths afterwards compares the file with itself and passes for
  // any content.
  const firstEpub = await readFile(first.run.epubPath)
  const host = createFakeHost()
  const progress = []
  const second = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: E2E_DIR },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
    onProgress: event => progress.push(event),
  })

  const cached = progress.filter(event => event.phase === 'page' && event.status === 'cached')
  expect('第二次运行零模型调用', host.__stats.calls, 0)
  expectTrue('onProgress 出现 status:"cached"', cached.length >= 1,
    { detail: progress.map(event => `${event.phase}:${event.status ?? ''}`).join(' -> ') })
  expect('全部页命中缓存', cached.length, second.report.book.pages)

  // 1. 本次没花：命中缓存不得把该页历史 ledger 并进本次账本。
  expect('第二次 report.tokens.calls === 0', second.report.tokens.calls, 0, { cause: REUSE_CAUSE })
  expect('第二次 report.tokens.input === 0', second.report.tokens.input, 0, { cause: REUSE_CAUSE })
  // 2. 复用可见：历史花费记在 reused 里，而不是凭空消失。
  expectTrue('第二次 report.tokens.reused.input > 0', second.report.tokens.reused.input > 0, {
    detail: `reused = ${show(second.report.tokens.reused)}`,
    cause: REUSE_CAUSE,
  })
  expect('第一次 report.tokens.reused.calls === 0（首跑没有复用）', first.run.report.tokens.reused.calls, 0)
  expectTrue('第一次 report.tokens.byPage 每页 cached:false', first.run.report.tokens.byPage.every(entry => entry.cached === false),
    { detail: show(first.run.report.tokens.byPage) })
  expectTrue('第二次 report.tokens.byPage 每页 cached:true', second.report.tokens.byPage.every(entry => entry.cached === true),
    { detail: show(second.report.tokens.byPage) })
  // 返回值与 report 同一口径：同一份 tokens 既随 report 落盘，也直接返回。
  expect('返回值 tokens.input 与 report 一致（首跑）', first.run.tokens?.input, first.run.report.tokens.input)
  expectTrue('返回值 tokens.reused.input > 0（第二次）', (second.tokens?.reused?.input ?? 0) > 0,
    { detail: `second.tokens = ${show(second.tokens)}`, cause: REUSE_CAUSE })

  // 3. 宿主调用 1 -> 0，且重建出的 EPUB 与首跑逐字节一致。
  expect('宿主模型调用次数 1 -> 0', [first.host.__stats.calls, host.__stats.calls], [1, 0])
  const after = await readFile(second.epubPath)
  expectTrue('缓存重建的 EPUB 与首次逐字节一致', firstEpub.equals(after),
    { detail: `${firstEpub.length} vs ${after.length} bytes` })

  return `cached events ${cached.length} | model calls ${first.host.__stats.calls} -> ${host.__stats.calls} | ` +
    `report calls/input ${second.report.tokens.calls}/${second.report.tokens.input} | reused input ${second.report.tokens.reused.input}`
}

/**
 * (f) 失败页不污染缓存.
 *
 * A page that produced no text (here: its model call always ends in a 429) must
 * not be written to the resume cache. If it were, every later run would replay
 * the empty entry: no model call, a `completed` job, and one permanently blank
 * page. The test drives that exact sequence on a real two-page PDF: fail page 1,
 * then swap in a healthy fake Host on the same `outputDir` without `force` and
 * require that page 1 is really transcribed while page 2 is still cached.
 */
async function scenarioFailedPageNotCached() {
  await mkdir(OUT, { recursive: true })
  await writeFile(TWO_PAGE_PDF, buildMultiPagePdf([
    ['Two-page fixture, page one.', 'Only plain ASCII on purpose.'],
    ['Two-page fixture, page two.', 'The second page must still transcribe.'],
  ]))
  const outDir = path.join(E2E_DIR, 'failed-page')

  // 1. Page 1 is a 429 on every attempt; page 2 succeeds.
  const broken = createFakeHost({ failPages: [1] })
  const first = await pipeline.runConversion({
    host: broken,
    spec: { input: TWO_PAGE_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  expect('失败页计入 report.stats.pagesFailed', first.report.stats.pagesFailed, 1, { cause: POISON_CAUSE })
  expect('返回值 pagesFailed 与 report 一致', first.pagesFailed, 1, { cause: POISON_CAUSE })
  expectTrue('第 1 页在 report.pages 里带着错误信息',
    typeof first.report.pages[0].error === 'string' && first.report.pages[0].error.includes('429'),
    { detail: `report.pages[0].error = ${show(first.report.pages[0].error)}`, cause: POISON_CAUSE })
  expect('第 2 页没有 error', first.report.pages[1].error, null)
  expectTrue('report.warnings 用一句人话说明缺页',
    first.report.warnings.some(line => line.includes('produced no text') && line.includes('page 1')),
    { detail: `report.warnings = ${show(first.report.warnings)}` })

  // The book's directory is `<outputDir>/<input file name>/`; the page cache is
  // under its `pages/`. A page-1 entry there is exactly the poison this forbids.
  expectTrue('失败页场景里有 <outputDir>/<书名>/pages/', await hasPagesDirectory(outDir, 'test-two-pages'),
    { detail: path.join(outDir, 'test-two-pages', 'pages'), cause: BOOK_DIR_CAUSE })
  const pageOneEntries = await cacheEntries(outDir, 'test-two-pages', '00001.json')
  const pageTwoEntries = await cacheEntries(outDir, 'test-two-pages', '00002.json')
  expect('缓存目录里没有第 1 页的文件', pageOneEntries.length, 0,
    { detail: pageOneEntries.map(relativeToRoot).join(', '), cause: POISON_CAUSE })
  expectTrue('成功的第 2 页照常写入缓存', pageTwoEntries.length === 1,
    { detail: pageTwoEntries.map(relativeToRoot).join(', ') || '没有找到 00002.json' })

  // 2. Same outputDir, healthy Host, no `force`: only page 1 may cost a call.
  const good = createFakeHost()
  const second = await pipeline.runConversion({
    host: good,
    spec: { input: TWO_PAGE_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  expectTrue('重跑时第 1 页真的调用了模型', good.__stats.calls >= 1,
    { detail: `host calls = ${good.__stats.calls}`, cause: POISON_CAUSE })
  expectTrue('重跑只请求第 1 页（第 2 页仍命中缓存）',
    good.__stats.pages.length > 0 && good.__stats.pages.every(page => page === 1),
    { detail: `请求过/重试过的页 = ${show(good.__stats.pages)}`, cause: POISON_CAUSE })
  expect('重跑后没有失败页', second.report.stats.pagesFailed, 0, { cause: POISON_CAUSE })
  expectTrue('重跑产物里第 1 页内容非空',
    second.report.pages[0].chars > 0 && second.report.pages[0].error === null,
    { detail: `report.pages[0] = ${show(second.report.pages[0])}`, cause: POISON_CAUSE })
  expect('重跑后没有缺页警告', second.report.warnings, [])
  const entries = unzip(await readFile(second.epubPath))
  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  expectTrue('重跑后的 EPUB 含第 1 页正文', chapter.includes('这是第1页的正文'),
    { detail: shorten(chapter), cause: POISON_CAUSE })
  note(`失败页报告：stats.pagesFailed=${first.report.stats.pagesFailed}，`
    + `pages[0].error=${JSON.stringify(first.report.pages[0].error)}，`
    + `warnings=${JSON.stringify(first.report.warnings)}`)

  // 3. The self-healing half: an entry written by an older build ("blocks: []")
  //    must be treated as a miss, deleted, and rewritten - never replayed. That
  //    is what stops a cache poisoned before this fix from poisoning every run
  //    after it.
  const [pageOneFile] = await cacheEntries(outDir, 'test-two-pages', '00001.json')
  const poisoned = JSON.parse(await readFile(pageOneFile, 'utf8'))
  poisoned.page = { ...poisoned.page, blocks: [], error: '429 Too Many Requests (page 1)' }
  await writeFile(pageOneFile, JSON.stringify(poisoned))

  const healing = createFakeHost()
  const third = await pipeline.runConversion({
    host: healing,
    spec: { input: TWO_PAGE_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  expectTrue('读到毒缓存时第 1 页被重新转录', healing.__stats.pages.includes(1),
    { detail: `请求过的页 = ${show(healing.__stats.pages)}`, cause: POISON_CAUSE })
  const healed = JSON.parse(await readFile(pageOneFile, 'utf8'))
  expectTrue('毒缓存被重写成有内容的条目',
    Array.isArray(healed.page?.blocks) && healed.page.blocks.length > 0 && healed.page.error === null,
    { detail: `重写后的条目 = ${show(healed.page)}`, cause: POISON_CAUSE })
  expectTrue('毒缓存修复后第 1 页进入产物', third.report.pages[0].chars > 0,
    { detail: `report.pages[0].chars = ${third.report.pages[0].chars}`, cause: POISON_CAUSE })

  return `failed pages ${first.report.stats.pagesFailed} -> ${second.report.stats.pagesFailed} | ` +
    `cache page1=${pageOneEntries.length} page2=${pageTwoEntries.length} | ` +
    `rerun calls ${good.__stats.calls} for pages ${good.__stats.pages.join(',') || 'none'} | ` +
    `healed calls ${healing.__stats.calls} for pages ${healing.__stats.pages.join(',') || 'none'}`
}

/**
 * (g) 缓存键包含设置.
 *
 * The page cache must be keyed by the settings that produced the page, not only
 * by the page number and the model name. Same PDF, same outputDir: `dpi: 100`
 * then `dpi: 120` must not reuse the first run's pages, and going back to
 * `dpi: 100` must hit again for free.
 */
async function scenarioCacheKeyIncludesSettings() {
  const outDir = path.join(E2E_DIR, 'settings-key')
  const run = (host, dpi) => pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi, concurrency: 2 },
  })

  const at100 = createFakeHost()
  await run(at100, 100)
  expect('dpi 100 首跑调用模型 1 次', at100.__stats.calls, 1)

  const at120 = createFakeHost()
  await run(at120, 120)
  expectTrue('改 dpi 后没有命中旧缓存（模型调用 > 0）', at120.__stats.calls > 0,
    { detail: `host calls = ${at120.__stats.calls}`, cause: SETTINGS_CAUSE })

  const backTo100 = createFakeHost()
  await run(backTo100, 100)
  expect('回到 dpi 100 命中缓存（模型调用 0）', backTo100.__stats.calls, 0, { cause: SETTINGS_CAUSE })

  // Two settings namespaces under one book's `pages/`, one page entry each, is
  // the on-disk proof that the key really contains the DPI.
  const pageOneEntries = await cacheEntries(outDir, 'test-long', '00001.json')
  expect('缓存按设置分成两个命名空间', pageOneEntries.length, 2,
    { detail: pageOneEntries.map(relativeToRoot).join(', '), cause: SETTINGS_CAUSE })
  expectTrue('两个命名空间是不同的目录', new Set(pageOneEntries.map(file => path.dirname(file))).size === 2,
    { detail: pageOneEntries.map(relativeToRoot).join(', '), cause: SETTINGS_CAUSE })

  return `model calls 100/120/100 = ${at100.__stats.calls}/${at120.__stats.calls}/${backTo100.__stats.calls} | ` +
    `page-1 cache entries ${pageOneEntries.length}`
}

/**
 * (h) 全空页时也写诊断.
 *
 * The bug this covers: a scanned book whose every page came back `blocks: []`
 * failed with one sentence and left nothing on disk. The per-page reasons lived
 * only in memory, so after the process ended nothing could tell "the model
 * returned empty blocks" from "the reply was unparsable" from "the call failed".
 * The page cache cannot answer it either - a failed page is deliberately never
 * cached (scenario (f)) - so the failure path has to write its own report before
 * it throws, and the thrown message has to name that file.
 */
async function scenarioFailureReportEmptyPages() {
  const outDir = path.join(E2E_DIR, 'empty-pages')
  const host = createFakeHost({ emptyBlocks: true })
  const { run, error } = await runExpectingFailure({
    host,
    spec: { input: LONG_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })

  expect('全空页时 runConversion 不返回成功结果', run, null)
  const threw = expectTrue('全空页时 runConversion 抛错', error !== null,
    { detail: error === null ? '返回了成功结果' : '' })
  if (!threw) return '没有错误可检查'
  expectTrue('错误信息仍以「no book text produced」开头', error.message.startsWith('no book text produced'),
    { detail: `message = ${error.message}` })

  const diagnosticPath = diagnosticPathFrom(error.message)
  const named = expectTrue('错误信息给出 report.json 路径', diagnosticPath !== null,
    { detail: `message = ${error.message}` })
  if (!named) return '错误信息里没有 report 路径'
  const diagnosticDir = path.join(outDir, 'test-long')
  expect('report.json 落在书目录里', path.dirname(diagnosticPath), diagnosticDir, { cause: BOOK_DIR_CAUSE })
  expect('report.json 的文件名是 <书名>.report.json', path.basename(diagnosticPath), 'test-long.report.json')

  const exists = await isFile(diagnosticPath)
  const written = expectTrue('失败路径真的把 report.json 写到了磁盘', exists, { detail: diagnosticPath })
  if (!written) return 'report.json 不存在，后续断言无法求值'

  const parsed = await readReport(diagnosticPath)
  const readable = expectTrue('失败 report 能被 JSON.parse', parsed.report !== null,
    { detail: parsed.error === null ? '' : `${parsed.error.name}: ${parsed.error.message}` })
  if (!readable) return 'report.json 读不出来，后续断言无法求值'
  const report = parsed.report

  // 与成功时同构：同一套顶层字段，只是 chapters 为 0。
  const REQUIRED = ['schema', 'generatedAt', 'input', 'book', 'models', 'stats', 'tokens', 'timing', 'rendering', 'warnings', 'pages']
  const missing = REQUIRED.filter(key => !(key in report))
  expectTrue('失败 report 与成功时同构（关键字段齐全）', missing.length === 0,
    { detail: `缺少 ${missing.join(', ') || '无'}；实际字段 ${Object.keys(report).join(', ')}` })
  expect('失败 report 的 schema', report.schema, 'dsh-pdf2epub/report@1')
  expect('失败 report 的 stats.chapters === 0', report.stats.chapters, 0)
  expect('失败 report 的 book.chapters === 0', report.book.chapters, 0)
  expect('失败 report 的 stats.pagesFailed 等于页数', report.stats.pagesFailed, report.book.pages)
  expect('失败 report 的 stats.pagesEmpty 等于页数', report.stats.pagesEmpty, report.book.pages)

  const page = report.pages[0] ?? {}
  expect('失败页归类为 empty-blocks', page.failure, 'empty-blocks')
  expectTrue('失败页带模型原始响应（raw 非空）', typeof page.raw === 'string' && page.raw !== '',
    { detail: `raw = ${show(page.raw)}` })
  expectTrue('raw 长度不超过 420 字符（400 + 省略号）', typeof page.raw === 'string' && page.raw.length <= 420,
    { detail: `raw.length = ${typeof page.raw === 'string' ? page.raw.length : 'not a string'}` })
  expect('失败页的 error 为 null（模型确实回了合法 JSON）', page.error, null)
  expectTrue('每一条页记录都带分类与 raw',
    report.pages.length > 0 && report.pages.every(entry => entry.failure === 'empty-blocks'
      && typeof entry.raw === 'string' && entry.raw !== ''),
    { detail: show(report.pages) })
  expectTrue('warnings 用分类解释为什么没有正文',
    report.warnings.some(line => line.includes('produced no text') && line.includes('empty blocks')),
    { detail: `warnings = ${show(report.warnings)}` })
  expectTrue('失败 report 自己声明没有写出 EPUB',
    report.warnings.some(line => line.includes('no EPUB was written')),
    { detail: `warnings = ${show(report.warnings)}` })
  note(`失败诊断：${relativeToRoot(diagnosticPath)} | message=${JSON.stringify(error.message)} | `
    + `warnings=${JSON.stringify(report.warnings)}`)

  return `report ${relativeToRoot(diagnosticPath)} | pagesEmpty ${report.stats.pagesEmpty}/${report.book.pages} | ` +
    `raw ${typeof page.raw === 'string' ? page.raw.length : 0} chars | host calls ${host.__stats.calls}`
}

/**
 * (i) 不可解析响应也归类.
 *
 * Same failure path, different cause: the model answers with prose, so
 * `parsePageJson()` throws and no block ever exists. The report must say
 * `unparsable` (not `empty-blocks`, not `transport`) and count it separately, or
 * the reader would be sent to fix the wrong thing.
 */
async function scenarioFailureReportUnparsable() {
  const outDir = path.join(E2E_DIR, 'unparsable')
  const host = createFakeHost({ garbled: true })
  const { error } = await runExpectingFailure({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })

  const threw = expectTrue('不可解析响应时 runConversion 抛错', error !== null,
    { detail: error === null ? '返回了成功结果' : '' })
  if (!threw) return '没有错误可检查'

  const diagnosticPath = diagnosticPathFrom(error.message)
  const named = expectTrue('错误信息给出 report.json 路径', diagnosticPath !== null,
    { detail: `message = ${error.message}` })
  if (!named) return '错误信息里没有 report 路径'

  const exists = await isFile(diagnosticPath)
  const written = expectTrue('不可解析响应的 report.json 存在', exists, { detail: diagnosticPath })
  if (!written) return 'report.json 不存在，后续断言无法求值'

  const parsed = await readReport(diagnosticPath)
  const readable = expectTrue('不可解析响应的 report 能被 JSON.parse', parsed.report !== null,
    { detail: parsed.error === null ? '' : `${parsed.error.name}: ${parsed.error.message}` })
  if (!readable) return 'report.json 读不出来，后续断言无法求值'
  const report = parsed.report

  expect('stats.pagesUnparsable === 1', report.stats.pagesUnparsable, 1)
  expect('stats.pagesEmpty === 0（不是空块，是解析不了）', report.stats.pagesEmpty, 0)
  expect('stats.pagesTransportFailed === 0', report.stats.pagesTransportFailed, 0)
  const page = report.pages[0] ?? {}
  expect('该页归类为 unparsable', page.failure, 'unparsable')
  expectTrue('该页的 error 说明 JSON 解析失败',
    typeof page.error === 'string' && /parseable/i.test(page.error),
    { detail: `error = ${show(page.error)}` })
  expectTrue('raw 保存了那段非 JSON 文本',
    typeof page.raw === 'string' && page.raw.includes('not JSON'),
    { detail: `raw = ${show(page.raw)}` })
  // The fake reply is longer than the excerpt window, so the truncation is real
  // here: the report keeps the opening of the reply and marks the cut, it does
  // not quietly archive a page of prose per failed page.
  expectTrue('长回复的 raw 被截断并加省略号',
    typeof page.raw === 'string' && page.raw.length <= 420 && page.raw.endsWith('…'),
    { detail: `raw.length = ${typeof page.raw === 'string' ? page.raw.length : 'not a string'}，` +
      `末尾 = ${JSON.stringify(typeof page.raw === 'string' ? page.raw.slice(-8) : page.raw)}` })
  expectTrue('warnings 把 unparsable 单独列出来',
    report.warnings.some(line => line.includes('unparsable JSON')),
    { detail: `warnings = ${show(report.warnings)}` })
  note(`不可解析响应：${relativeToRoot(diagnosticPath)} | failure=${page.failure} | `
    + `error=${JSON.stringify(page.error)} | warnings=${JSON.stringify(report.warnings)}`)

  return `report ${relativeToRoot(diagnosticPath)} | pagesUnparsable ${report.stats.pagesUnparsable} | ` +
    `raw ${typeof page.raw === 'string' ? `${page.raw.length} chars: ${shorten(page.raw, 60)}` : 'none'}`
}

/**
 * (j) 推理吃光预算时给出可区分诊断.
 *
 * The route cannot disable thinking, and reasoning and the answer share one
 * output budget. When the reasoning phase takes all of it, the stream ends at
 * `max-tokens` with no text delta at all — and the run used to report that as
 * "model returned no text": indistinguishable from a silent model, a bad prompt
 * or a dead provider, with the reasoning that really happened thrown away. The
 * fake Host now streams only `reasoning-delta` chunks, so the page has to be
 * classified as `reasoning-budget`, counted, and described with the number of
 * reasoning characters that were actually produced.
 */
async function scenarioReasoningBudget() {
  const outDir = path.join(E2E_DIR, 'reasoning-budget')
  const host = createFakeHost({ reasoningOnly: true })
  const { run, error } = await runExpectingFailure({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })

  expect('推理吃光预算时 runConversion 不返回成功结果', run, null)
  const threw = expectTrue('推理吃光预算时 runConversion 抛错', error !== null,
    { detail: error === null ? '返回了成功结果' : '' })
  if (!threw) return '没有错误可检查'
  expectTrue('错误信息仍以「no book text produced」开头', error.message.startsWith('no book text produced'),
    { detail: `message = ${shorten(error.message)}` })

  const diagnosticPath = diagnosticPathFrom(error.message)
  const named = expectTrue('错误信息给出 report.json 路径', diagnosticPath !== null,
    { detail: `message = ${error.message}` })
  if (!named) return '错误信息里没有 report 路径'
  const parsed = await readReport(diagnosticPath)
  const readable = expectTrue('推理诊断 report 能被 JSON.parse', parsed.report !== null,
    { detail: parsed.error === null ? '' : `${parsed.error.name}: ${parsed.error.message}` })
  if (!readable) return 'report.json 读不出来，后续断言无法求值'
  const report = parsed.report

  const page = report.pages[0] ?? {}
  expect('该页归类为 reasoning-budget（不是 transport）', page.failure, 'reasoning-budget')
  expect('stats.pagesReasoningBudget 等于页数', report.stats.pagesReasoningBudget, report.book.pages)
  expect('stats.pagesFailed 仍等于页数', report.stats.pagesFailed, report.book.pages)
  expect('该页没有被误判成空块', report.stats.pagesEmpty, 0)
  expect('该页没有被误判成 transport', report.stats.pagesTransportFailed, 0)
  expectTrue('该页仍然是 truncated（finish 是 max-tokens）', page.truncated === true,
    { detail: `truncated = ${show(page.truncated)}, finishKind = ${show(page.finishKind)}` })
  expectTrue('warnings 里出现了 "reasoning"', report.warnings.some(line => /reasoning/i.test(line)),
    { detail: `warnings = ${show(report.warnings)}` })
  expectTrue('warnings 给了「调大 maxTokens」的人话提示', report.warnings.some(line => line.includes('raise maxTokens')),
    { detail: `warnings = ${show(report.warnings)}` })

  // 诊断不是空话：推理字符数既在结构化字段里，也在 error 文案里，且等于宿主真正吐出的长度。
  expect('该页记下的推理字符数等于宿主发出的长度', page.reasoningChars, REASONING_TEXT.length)
  expectTrue('error 文案里带着同一串字符数',
    typeof page.error === 'string' && page.error.includes(`(${REASONING_TEXT.length} chars)`),
    { detail: `error = ${show(page.error)}` })

  note(`推理诊断：failure=${page.failure} | reasoningChars=${page.reasoningChars} | `
    + `error=${JSON.stringify(page.error)} | warnings=${JSON.stringify(report.warnings)}`)

  return `pagesReasoningBudget ${report.stats.pagesReasoningBudget}/${report.book.pages} | ` +
    `reasoningChars ${page.reasoningChars}/${REASONING_TEXT.length} | warnings ${report.warnings.length}`
}

/**
 * (k) 推理档位被透传.
 *
 * The level is not hard-coded: it comes from the model's own capability report
 * (`reasoning.efforts`) and the lowest one is forwarded. `off` is not an option
 * on this route family (`thinkingLevelMap.off === null` drops it), and naming no
 * level at all would leave the provider default in charge of a budget the answer
 * also needs. The second assertion pins the budget contract: `maxTokens` stays
 * the answer budget (4000 by default, not raised behind the user's back), and the
 * request carries `maxTokens + REASONING_HEADROOM` so reasoning cannot spend the
 * answer's share.
 */
async function scenarioReasoningEffortForwarded() {
  const host = createFakeHost({ reasoningEfforts: ['low', 'high'] })
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: path.join(E2E_DIR, 'reasoning-effort') },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  expect('bridge 导出的 REASONING_HEADROOM', REASONING_HEADROOM, 16384)
  expect('启动时对主模型只解析了一次能力', host.__stats.resolves, 1)
  const first = host.__stats.streamRequests[0] ?? {}
  expect('第一个 stream 请求带上了最低推理档位', first.reasoningEffort, 'low')
  expect('第一个 stream 请求的 maxTokens = 4000 + REASONING_HEADROOM',
    first.maxTokens, 4000 + REASONING_HEADROOM)
  expect('没有显式 sessionId 时用本书的派生值', first.sessionId, `pdf2epub-${bookIdFor(LONG_PDF)}`)
  expect('透传档位不影响正文产出', run.report.pages[0].error, null)

  note(`请求形状：reasoningEffort=${show(first.reasoningEffort)} | maxTokens=${first.maxTokens} | `
    + `sessionId=${show(first.sessionId)}`)

  return `reasoningEffort ${show(first.reasoningEffort)} | maxTokens ${first.maxTokens} ` +
    `(4000 + ${REASONING_HEADROOM}) | resolves ${host.__stats.resolves}`
}

/**
 * (l) 会话路由头被传递且按书稳定.
 *
 * The adapter derives a per-session routing header from `GenerateOptions.sessionId`
 * and the provider refuses a call that carries none (`400 MissingSessionID`, the
 * real failure this scenario pins). So every `stream` request has to carry a
 * NON-EMPTY id; the pages of one book have to share it - that is what lets the
 * provider route one conversation and keep its prompt-prefix cache warm; a
 * different book has to get a different one; and `spec.sessionId` has to win
 * outright, since that is the caller's own Session identity.
 *
 * Each run gets its own `outputDir` on purpose: a page served from the disk cache
 * sends no request at all, and then there is no header left to assert on.
 */
async function scenarioSessionRoutingHeader() {
  const bookA = path.join(OUT, 'test-session-a.pdf')
  const bookB = path.join(OUT, 'test-session-b.pdf')
  // Same content, different paths: the fallback id must follow the input path,
  // so this pair isolates "a different book" from "different bytes".
  const lines = [
    ['Session routing fixture, page one.', 'One book, one routing id.'],
    ['Session routing fixture, page two.', 'A page never invents a session.'],
  ]
  await writeFile(bookA, buildMultiPagePdf(lines))
  await writeFile(bookB, buildMultiPagePdf(lines))

  const convert = async (input, name, extra = {}) => {
    const host = createFakeHost()
    const run = await pipeline.runConversion({
      host,
      spec: { input, outputDir: path.join(E2E_DIR, `session-${name}`), ...extra },
      config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
    })
    return { host, run, ids: host.__stats.streamRequests.map(request => request.sessionId) }
  }

  const first = await convert(bookA, 'a')
  expectTrue('同一本书确实发了跨页请求（断言才有意义）', first.ids.length >= 2,
    { detail: `请求数 = ${first.ids.length}，页数 = ${first.run.report.book.pages}`, cause: SESSION_CAUSE })
  expectTrue('每次 stream 请求的 sessionId 都是非空字符串',
    first.ids.length > 0 && first.ids.every(id => typeof id === 'string' && id.trim() !== ''),
    { detail: `sessionId = ${show(first.ids)}`, cause: SESSION_CAUSE })
  expectTrue('同一本书的多页请求 sessionId 全部相同',
    first.ids.length >= 2 && new Set(first.ids).size === 1,
    { detail: `sessionId = ${show(first.ids)}`, cause: SESSION_CAUSE })
  expect('取不到真实会话时用 pdf2epub-<bookId>', first.ids[0], `pdf2epub-${bookIdFor(bookA)}`,
    { cause: SESSION_CAUSE })

  const second = await convert(bookB, 'b')
  expectTrue('换一本 PDF（不同输入路径）时 sessionId 不同', typeof second.ids[0] === 'string'
    && second.ids[0] !== first.ids[0]
    && second.ids[0] === `pdf2epub-${bookIdFor(bookB)}`,
  { detail: `A = ${show(first.ids[0])}, B = ${show(second.ids[0])}`, cause: SESSION_CAUSE })

  // The caller's own id is the real thing (the tool path forwards the Agent's
  // SessionId), so an explicit `spec.sessionId` must be used verbatim, not
  // rewritten into the derived shape.
  const explicit = 'session-explicit-override'
  const third = await convert(bookA, 'explicit', { sessionId: explicit })
  expectTrue('显式 spec.sessionId 覆盖派生值', third.ids.length > 0 && third.ids.every(id => id === explicit),
    { detail: `sessionId = ${show(third.ids)}，期望全部为 ${show(explicit)}`, cause: SESSION_CAUSE })

  note(`会话路由：A=${show(first.ids[0])}（${first.ids.length} 次调用）| B=${show(second.ids[0])} | `
    + `显式=${show(third.ids[0])}（${third.ids.length} 次调用）`)

  return `A ${first.ids[0]} (${first.ids.length} calls) | B ${second.ids[0]} | ` +
    `explicit ${third.ids[0]} (${third.ids.length} calls)`
}

/**
 * (m) 插图按 bbox 抽出并嵌入.
 *
 * The scan has no separate image object: the illustration is part of the page
 * bitmap, so the only way to get it into the EPUB is to crop by the box the model
 * reported. This scenario drives that whole chain: the model's bbox survives
 * `normalizeBlock`, the kept page is cropped by `pdf.cropRegion`, the PNG is
 * written under the book's `images/` directory, the asset reaches `buildEpub`,
 * and the chapter renders the picture BEFORE its caption.
 */
async function scenarioFigureExtracted() {
  const outDir = path.join(E2E_DIR, 'figures')
  const host = createFakeHost({ figure: true })
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  expect('report.stats.figuresExtracted === 1', run.report.stats.figuresExtracted, 1)
  const page = run.report.pages[0] ?? {}
  expectTrue('该页记录带 figures（bbox/href/bytes）',
    Array.isArray(page.figures) && page.figures.length === 1
      && Array.isArray(page.figures[0].bbox) && typeof page.figures[0].href === 'string'
      && page.figures[0].bytes > 0,
    { detail: show(page.figures) })

  const entries = unzip(await readFile(run.epubPath))
  const names = Object.keys(entries)
  const imageNames = names.filter(name => /^OEBPS\/images\/fig-\d+-\d+\.png$/.test(name))
  expect('EPUB 里有一个 OEBPS/images/fig-<页>-<序号>.png', imageNames, ['OEBPS/images/fig-1-1.png'])
  const wrote = imageNames.length === 1
  if (wrote) {
    const png = entries[imageNames[0]]
    const PngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    expectTrue('嵌入的图片以 PNG 魔数开头', PngMagic.every((byte, index) => png[index] === byte),
      { detail: `前 8 字节 = [${Array.from(png.slice(0, 8)).join(',')}]` })
    const size = pngSize(png)
    expectTrue('图片尺寸可读且长边不超过 1600px',
      size !== null && Math.max(size.width, size.height) <= 1600 && size.width > 0 && size.height > 0,
      { detail: `size = ${show(size)}` })
  }
  // The PNG is also on disk, in the book's own images/ directory.
  const onDisk = await isFile(path.join(outDir, 'test-long', 'images', 'fig-1-1.png'))
  expectTrue('图片同时落盘到 <outputDir>/<书名>/images/fig-1-1.png', onDisk,
    { detail: path.join(outDir, 'test-long', 'images'), cause: BOOK_DIR_CAUSE })

  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  const imgAt = chapter.indexOf('<img src="../images/')
  const captionAt = chapter.indexOf('<figcaption>图 1</figcaption>')
  expectTrue('章节里有 <figure><img src="../images/…"/>', imgAt !== -1, { detail: shorten(chapter) })
  expectTrue('图注在 <figcaption> 里', captionAt !== -1, { detail: shorten(chapter) })
  expectTrue('<img> 出现在 <figcaption> 之前', imgAt !== -1 && captionAt !== -1 && imgAt < captionAt,
    { detail: `img@${imgAt} caption@${captionAt}` })
  expectTrue('<img> 的 alt 用了图注文字', /<img src="\.\.\/images\/fig-1-1\.png" alt="图 1"\/>/.test(chapter),
    { detail: shorten(chapter) })

  return `figuresExtracted ${run.report.stats.figuresExtracted} | images ${imageNames.join(',')} | ` +
    `img@${imgAt} < caption@${captionAt}`
}

/**
 * (n) 非法 bbox 被拒绝且不影响成书.
 *
 * A box whose area is 0.0001 is below the contract's minimum: `normalizeBbox`
 * must drop it (with an issue) rather than crop a sliver of page margin. The page
 * must stay healthy, the book must still be written, and the chapter must fall
 * back to the caption-only `<figure>` shape - with no `images/` entry anywhere.
 */
async function scenarioInvalidBboxRejected() {
  const outDir = path.join(E2E_DIR, 'bad-bbox')
  const host = createFakeHost({ badBbox: true })
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  expect('非法 bbox 不计入 figuresExtracted', run.report.stats.figuresExtracted, 0)
  const page = run.report.pages[0] ?? {}
  expect('该页仍 ok（坏框不等于坏页）', page.ok, true)
  expect('该页没有 figures', page.figures, [])

  const entries = unzip(await readFile(run.epubPath))
  const names = Object.keys(entries)
  expect('EPUB 里没有 images/ 条目', names.filter(name => name.includes('images/')), [])
  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  expectTrue('章节保持只有 <figcaption> 的旧形态',
    chapter.includes('<figure><figcaption>图 1</figcaption></figure>'), { detail: shorten(chapter) })
  expectTrue('章节里没有 <img>', !chapter.includes('<img'), { detail: shorten(chapter) })
  expectTrue('进程没崩，EPUB 正常写出', await isFile(run.epubPath), { detail: run.epubPath })

  return `figuresExtracted ${run.report.stats.figuresExtracted} | page.ok ${page.ok} | ` +
    `images ${names.filter(name => name.includes('images/')).length}`
}

/**
 * (o) 裁图失败不拖垮整页.
 *
 * The crop seam is replaced with one that always throws: exactly what a bad box,
 * a renderer failure or an unreadable page looks like downstream. The page has
 * already earned its place in the book, so it must stay `ok`, keep its caption,
 * and lose only the picture - with one run-level warning saying why.
 */
async function scenarioCropFailureDoesNotFailPage() {
  const outDir = path.join(E2E_DIR, 'crop-failure')
  const host = createFakeHost({ figure: true })
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    // The injected hook fails every crop; the pipeline must catch it per figure.
    cropRegion: async () => {
      throw new Error('injected crop failure')
    },
  })
  state.epubs.push(run.epubPath)

  const page = run.report.pages[0] ?? {}
  expect('裁图失败时该页 ok === true', page.ok, true)
  expect('裁图失败时 figuresExtracted === 0', run.report.stats.figuresExtracted, 0)
  expect('该页没有 figures', page.figures, [])
  expectTrue('warnings 里有一条提到插图/裁剪',
    run.report.warnings.some(line => /illustration|crop|figure/i.test(line)),
    { detail: `warnings = ${show(run.report.warnings)}` })
  expectTrue('warnings 点明了注入的失败原因',
    run.report.warnings.some(line => line.includes('injected crop failure')),
    { detail: `warnings = ${show(run.report.warnings)}` })
  expectTrue('该页的正文照常进入书里', page.chars > 0 && run.report.stats.blocks > 0,
    { detail: `chars = ${page.chars}, blocks = ${run.report.stats.blocks}` })

  const entries = unzip(await readFile(run.epubPath))
  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  expectTrue('图注仍在，退回只有 <figcaption> 的形态',
    chapter.includes('<figure><figcaption>图 1</figcaption></figure>'), { detail: shorten(chapter) })
  expectTrue('没有指向不存在图片的 <img>', !chapter.includes('<img'), { detail: shorten(chapter) })
  expect('EPUB 里没有 images/ 条目',
    Object.keys(entries).filter(name => name.includes('images/')), [])

  note(`裁图失败：page.ok=${page.ok} | figuresExtracted=${run.report.stats.figuresExtracted} | ` +
    `warnings=${JSON.stringify(run.report.warnings)}`)

  return `page.ok ${page.ok} | figuresExtracted ${run.report.stats.figuresExtracted} | ` +
    `warnings ${run.report.warnings.length}: ${shorten(run.report.warnings[0] ?? '')}`
}

/**
 * (p) 页码范围：只转指定页，缓存仍按整本书.
 *
 * `pages: "2-3"` on a four-page document must render and send only pages 2 and 3:
 * no page-1 model call, no page-1 cache entry, no page-1 text in the EPUB, and the
 * report must say "4 pages in the document, 2 pages in this run". The second half
 * is what makes batching a 700-page book affordable: a whole-book rerun in the
 * same output directory has to find pages 2 and 3 in the cache and pay for pages 1
 * and 4 only, which is true only if the selection stays OUT of the cache key. The
 * last block pins the error contract - bad syntax, a reversed range, an
 * out-of-range page and an empty selection all fail before a single model call.
 */
async function scenarioPageRange() {
  const pdf = await fourPagePdf()
  const outDir = path.join(E2E_DIR, 'page-range')
  const host = createFakeHost()
  const run = await pipeline.runConversion({
    host,
    spec: { input: pdf, outputDir: outDir, pages: '2-3' },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  state.epubs.push(run.epubPath)

  const report = run.report
  expect('range: report.book.pages 仍是文档总页数', report.book.pages, 4)
  expect('range: report.book.pagesSelected 是本次处理的页数', report.book.pagesSelected, 2)
  expect('range: report.selection 回显了页码范围', report.selection,
    { pages: '2-3', excludePages: null, resolved: [2, 3] })
  expect('range: report.pages 只有第 2、3 页', report.pages.map(page => page.page), [2, 3])
  expect('range: 模型只被问了第 2、3 页', host.__stats.pages, [2, 3])

  const entries = unzip(await readFile(run.epubPath))
  const chapter = allChapterText(entries)
  expectTrue('range: 第 2、3 页的正文在产物里',
    chapter.includes('这是第2页的正文') && chapter.includes('这是第3页的正文'),
    { detail: shorten(chapter) })
  expectTrue('range: 第 1 页不出现在产物里', !chapter.includes('这是第1页的正文'),
    { detail: shorten(chapter) })
  expectTrue('range: 第 4 页不出现在产物里', !chapter.includes('这是第4页的正文'),
    { detail: shorten(chapter) })

  // The cache of this book lives under `<outputDir>/<PDF 文件名>/pages/`; the
  // page files the selection never touched must be absent from exactly there.
  expectTrue('range: 书目录下有 pages/', await hasPagesDirectory(outDir, 'test-four-pages'),
    { detail: path.join(outDir, 'test-four-pages', 'pages'), cause: BOOK_DIR_CAUSE })
  const pageOne = await cacheEntries(outDir, 'test-four-pages', '00001.json')
  const pageTwo = await cacheEntries(outDir, 'test-four-pages', '00002.json')
  const pageThree = await cacheEntries(outDir, 'test-four-pages', '00003.json')
  const pageFour = await cacheEntries(outDir, 'test-four-pages', '00004.json')
  expect('range: 缓存目录里没有第 1 页的文件', pageOne.length, 0,
    { detail: pageOne.map(relativeToRoot).join(', ') })
  expect('range: 缓存目录里没有第 4 页的文件', pageFour.length, 0,
    { detail: pageFour.map(relativeToRoot).join(', ') })
  expectTrue('range: 第 2、3 页照常进缓存', pageTwo.length === 1 && pageThree.length === 1,
    { detail: `00002.json=${pageTwo.length}, 00003.json=${pageThree.length}` })

  // The selection is not part of the cache key: the whole-book rerun reuses the
  // two pages this batch transcribed and pays for the other two only.
  const wholeHost = createFakeHost()
  const whole = await pipeline.runConversion({
    host: wholeHost,
    spec: { input: pdf, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  state.epubs.push(whole.epubPath)
  const asked = [...wholeHost.__stats.pages].sort((left, right) => left - right)
  expect('range: 整本重跑只补第 1、4 页（2、3 页命中缓存）', asked, [1, 4],
    { detail: `请求过的页 = ${show(wholeHost.__stats.pages)}`, cause: PAGE_SELECTION_CAUSE })
  expect('range: 整本重跑覆盖全 4 页', whole.report.book.pagesSelected, 4, { cause: PAGE_SELECTION_CAUSE })
  expect('range: 整本重跑没有 selection', whole.report.selection, null)
  const wholeChapter = allChapterText(unzip(await readFile(whole.epubPath)))
  expectTrue('range: 整本重跑四页都在', ['1', '2', '3', '4']
    .every(page => wholeChapter.includes(`这是第${page}页的正文`)), { detail: shorten(wholeChapter) })

  // Error contract: a bad expression must fail before any page is rendered.
  const badDir = path.join(E2E_DIR, 'page-range-bad')
  const invalidCases = [
    ['abc', undefined, /cannot read/],
    ['3-1', undefined, /runs backwards/],
    ['0-2', undefined, /start at 1/],
    ['1-9', undefined, /has 4 pages/],
    ['1-4', '1-4', /selection is empty/],
  ]
  const outcomes = []
  for (const [pages, excludePages, pattern] of invalidCases) {
    const badHost = createFakeHost()
    const attempt = await runExpectingFailure({
      host: badHost,
      spec: { input: pdf, outputDir: badDir, pages, ...(excludePages === undefined ? {} : { excludePages }) },
      config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    })
    const label = excludePages === undefined ? `pages=${pages}` : `pages=${pages} + excludePages=${excludePages}`
    const threw = expectTrue(`range: ${label} 抛错`, attempt.error !== null,
      { detail: attempt.error === null ? '返回了成功结果' : '' })
    if (threw) {
      expectTrue(`range: ${label} 的错误说明原因`, pattern.test(attempt.error.message),
        { detail: `message = ${attempt.error.message}` })
    }
    expect(`range: ${label} 没有发起模型调用`, badHost.__stats.calls, 0)
    outcomes.push(`${label}:${threw ? 'rejected' : 'accepted'}`)
  }

  note(`页码范围：pages=2-3 -> report.pages=${show(report.pages.map(page => page.page))}，`
    + `selection=${show(report.selection)}，00002.json=${pageTwo.length} 00003.json=${pageThree.length}`)
  note(`页码范围错误契约：${outcomes.join(' | ')}`)

  return `pages 2-3 -> ${report.pages.length} page(s), pagesSelected `
    + `${report.book.pagesSelected}/${report.book.pages} | rerun asked ${asked.join(',')} | `
    + `cache p1=${pageOne.length} p4=${pageFour.length} | ${outcomes.length} invalid expression(s) rejected`
}

/**
 * (q) excludePages：从选定集合里剔除.
 *
 * `pages: "1-3"` with `excludePages: "2"` converts pages 1 and 3. The subtraction
 * happens after `pages`, so page 4 is out because `pages` never named it and page 2
 * is out because `excludePages` removed it: the two compose instead of one
 * overriding the other.
 */
async function scenarioPageExclude() {
  const pdf = await fourPagePdf()
  const outDir = path.join(E2E_DIR, 'page-exclude')
  const host = createFakeHost()
  const run = await pipeline.runConversion({
    host,
    spec: { input: pdf, outputDir: outDir, pages: '1-3', excludePages: '2' },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 2 },
  })
  state.epubs.push(run.epubPath)

  expect('exclude: 解析结果是第 1、3 页', run.report.selection?.resolved, [1, 3])
  expect('exclude: report.book.pagesSelected', run.report.book.pagesSelected, 2)
  expect('exclude: 模型只被问了第 1、3 页', host.__stats.pages, [1, 3])
  expect('exclude: report.pages 只有第 1、3 页', run.report.pages.map(page => page.page), [1, 3])

  const chapter = allChapterText(unzip(await readFile(run.epubPath)))
  expectTrue('exclude: 第 1 页在产物里', chapter.includes('这是第1页的正文'), { detail: shorten(chapter) })
  expectTrue('exclude: 第 3 页在产物里', chapter.includes('这是第3页的正文'), { detail: shorten(chapter) })
  expectTrue('exclude: 被剔除的第 2 页不在产物里', !chapter.includes('这是第2页的正文'),
    { detail: shorten(chapter) })
  const pageTwo = await cacheEntries(outDir, 'test-four-pages', '00002.json')
  expect('exclude: 被剔除的第 2 页没有缓存文件', pageTwo.length, 0,
    { detail: pageTwo.map(relativeToRoot).join(', ') })

  return `pages 1-3 minus 2 -> ${show(run.report.selection?.resolved)} | `
    + `asked pages ${host.__stats.pages.join(',')} | cache 00002.json=${pageTwo.length}`
}

/**
 * (r) 封面被嵌入.
 *
 * `cover: true` renders page 1 as the package cover: the archive gains an
 * `OEBPS/images/cover.png`, the OPF declares it with `properties="cover-image"`,
 * and a dedicated `cover.xhtml` opens the spine. The picture must not cost a
 * transcription - the report keeps one page entry - and its long edge must land on
 * the 1400px target rather than the transcription DPI. The second half proves the
 * failure contract through the cover render seam: a cover that cannot be produced
 * is a run-level warning, and the book is still written.
 */
async function scenarioCoverEmbedded() {
  const outDir = path.join(E2E_DIR, 'cover')
  const host = createFakeHost()
  const run = await pipeline.runConversion({
    host,
    spec: { input: LONG_PDF, outputDir: outDir, cover: true },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const entries = unzip(await readFile(run.epubPath))
  const names = Object.keys(entries)
  const coverNames = names.filter(name => /^OEBPS\/images\/cover\.[a-z]+$/.test(name))
  expect('cover: EPUB 里有一个 OEBPS/images/cover.*', coverNames, ['OEBPS/images/cover.png'])
  const opf = strFromU8(entries['OEBPS/content.opf'])
  expectTrue('cover: OPF 里有 properties="cover-image"', opf.includes('properties="cover-image"'),
    { detail: shorten(opf, 500) })
  expectTrue('cover: OPF 的 manifest 指向 cover.png', /href="images\/cover\.png"/.test(opf),
    { detail: shorten(opf, 500) })
  expectTrue('cover: 有独立的封面页 cover.xhtml', names.includes('OEBPS/text/cover.xhtml'),
    { detail: names.join(', ') })
  if (coverNames.length === 1) {
    const png = entries[coverNames[0]]
    const PngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    expectTrue('cover: 封面以 PNG 魔数开头', PngMagic.every((byte, index) => png[index] === byte),
      { detail: `前 8 字节 = [${Array.from(png.slice(0, 8)).join(',')}]` })
    const size = pngSize(png)
    const longEdge = size === null ? 0 : Math.max(size.width, size.height)
    expectTrue('cover: 长边落在 1300..1400px', size !== null && longEdge <= 1400 && longEdge >= 1300,
      { detail: show(size) })
  }
  expect('cover: report.book.cover', run.report.book.cover, true)
  expect('cover: 封面不算一页正文', run.report.pages.length, 1)
  expectTrue('cover: 该页正文照常转录', run.report.pages[0].chars > 0,
    { detail: show(run.report.pages[0]) })
  // The cover is also left on disk beside the book, in the book's own images/.
  expectTrue('cover: cover.png 落在 <书名>/images/ 里',
    await isFile(path.join(outDir, 'test-long', 'images', 'cover.png')),
    { detail: path.join(outDir, 'test-long', 'images', 'cover.png'), cause: BOOK_DIR_CAUSE })

  // A cover that cannot be rendered must warn, not fail: the seam stands in for a
  // renderer failure, exactly as `cropRegion` does for a figure.
  const failDir = path.join(E2E_DIR, 'cover-failure')
  const failed = await pipeline.runConversion({
    host: createFakeHost(),
    spec: { input: LONG_PDF, outputDir: failDir, cover: true },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    renderCover: async () => {
      throw new Error('injected cover failure')
    },
  })
  state.epubs.push(failed.epubPath)
  expect('cover: 渲染失败时 report.book.cover 为 false', failed.report.book.cover, false)
  expectTrue('cover: 渲染失败时 warnings 说明原因',
    failed.report.warnings.some(line => line.includes('injected cover failure')),
    { detail: show(failed.report.warnings) })
  const failedNames = Object.keys(unzip(await readFile(failed.epubPath)))
  expect('cover: 渲染失败时没有封面图', failedNames.filter(name => name.includes('images/cover')), [])
  expectTrue('cover: 渲染失败时磁盘上也没有 cover.png',
    !(await isFile(path.join(failDir, 'test-long', 'images', 'cover.png'))),
    { detail: path.join(failDir, 'test-long', 'images', 'cover.png') })
  expectTrue('cover: 渲染失败时 EPUB 照常写出', await isFile(failed.epubPath), { detail: failed.epubPath })

  note(`封面：cover=${show(coverNames)} | report.book.cover=${run.report.book.cover} | `
    + `失败注入 warnings=${JSON.stringify(failed.report.warnings)}`)

  return `cover ${coverNames.join(',') || 'MISSING'} | properties=${opf.includes('properties="cover-image"')} | `
    + `failed render -> cover ${failed.report.book.cover}, warnings ${failed.report.warnings.length}`
}

/**
 * (s) 元数据覆盖生效.
 *
 * The caller's metadata wins: title, author and publisher reach `dc:title`,
 * `dc:creator` and `dc:publisher` in the OPF, plus the `<book>.book.json` sidecar
 * the reading view renders. The second half pins the priority order - with nothing
 * passed, the title falls back to the file name (this PDF has no `/Title`) and no
 * `dc:publisher` is invented.
 */
async function scenarioMetadata() {
  const outDir = path.join(E2E_DIR, 'metadata')
  const run = await pipeline.runConversion({
    host: createFakeHost(),
    spec: {
      input: LONG_PDF,
      outputDir: outDir,
      title: '巴布尔回忆录',
      author: '〔印度〕巴布尔',
      publisher: '商务印书馆',
    },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const entries = unzip(await readFile(run.epubPath))
  const opf = strFromU8(entries['OEBPS/content.opf'])
  expectTrue('metadata: dc:title 是调用方给的', opf.includes('<dc:title>巴布尔回忆录</dc:title>'),
    { detail: shorten(opf, 600) })
  expectTrue('metadata: dc:creator 是调用方给的', opf.includes('<dc:creator>〔印度〕巴布尔</dc:creator>'),
    { detail: shorten(opf, 600) })
  expectTrue('metadata: dc:publisher 是调用方给的', opf.includes('<dc:publisher>商务印书馆</dc:publisher>'),
    { detail: shorten(opf, 600) })
  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  expect('metadata: book.json 的 title', book.title, '巴布尔回忆录')
  expect('metadata: book.json 的 author', book.author, '〔印度〕巴布尔')
  expect('metadata: book.json 的 publisher', book.publisher, '商务印书馆')
  expect('metadata: report.book.publisher', run.report.book.publisher, '商务印书馆')

  // Priority: no spec value and no PDF /Title -> the file name.
  const fallbackDir = path.join(E2E_DIR, 'metadata-fallback')
  const fallback = await pipeline.runConversion({
    host: createFakeHost(),
    spec: { input: LONG_PDF, outputDir: fallbackDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(fallback.epubPath)
  const fallbackOpf = strFromU8(unzip(await readFile(fallback.epubPath))['OEBPS/content.opf'])
  expect('metadata: 没有元数据时书名退回文件名', fallback.report.book.title, 'test-long')
  expectTrue('metadata: 没有元数据时 OPF 不编造 dc:publisher', !fallbackOpf.includes('<dc:publisher>'),
    { detail: shorten(fallbackOpf, 600) })

  note(`元数据：title=${show(book.title)} author=${show(book.author)} publisher=${show(book.publisher)} | `
    + `fallback title=${show(fallback.report.book.title)}`)

  return `opf title/creator/publisher = ${opf.includes('巴布尔回忆录')}/`
    + `${opf.includes('〔印度〕巴布尔')}/${opf.includes('商务印书馆')} | `
    + `fallback title ${fallback.report.book.title}`
}

/**
 * (t) 标点归一化与括号配对（含标题层级 clamp）.
 *
 * One page, one repair per block: the half-width `,`/`;` become full-width because
 * a CJK character sits next to them, the half-open `（` gets its closer, the
 * full-width digits become ASCII while the clock time keeps its half-width colon,
 * the `code` block is untouched, and the `h1` followed by an `h3` is clamped to
 * `h2` instead of leaving a hole in the outline. Everything asserted here is
 * deterministic, so the expected strings are exact.
 */
async function scenarioPunctuationAndBrackets() {
  const outDir = path.join(E2E_DIR, 'prose-shapes')
  const host = createFakeHost({ proseShapes: true })
  const run = await pipeline.runConversion({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const entries = unzip(await readFile(run.epubPath))
  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])

  expectTrue('punct: 半角逗号与分号变全角，括号补齐',
    chapter.includes('<p>这是一句话，另一句话；括号未闭合（注）</p>'), { detail: shorten(chapter) })
  expectTrue('punct: 连续空白已折叠', !chapter.includes('另一句话； 括号未闭合'),
    { detail: shorten(chapter) })
  expectTrue('punct: 全角数字变半角、时间里的半角冒号不动',
    chapter.includes('<p>全角数字123保留为半角，时间12:30不动</p>'), { detail: shorten(chapter) })
  expectTrue('punct: code 块一个字都没改', chapter.includes('中文, 这里不动; 括号（注'),
    { detail: shorten(chapter) })
  expectTrue('punct: footnote 也走同一套归一', chapter.includes('① 译者注，标点也归一（注）'),
    { detail: shorten(chapter) })
  expectTrue('clamp: h1 之后跳级的 h3 被提升为 h2', chapter.includes('<h2>小节</h2>'),
    { detail: shorten(chapter) })
  expectTrue('clamp: 章节里没有跳级的 h3', !chapter.includes('<h3>'), { detail: shorten(chapter) })

  return `punct ok, code untouched, h1->h3 clamped to h2 | page chars ${run.report.pages[0].chars}`
}

/**
 * (u) 脚注与页码进对类型.
 *
 * Prompt 4 tells the model that the text below the short rule is a `footnote` and
 * that this book prints its page number in the middle of the outer margin (with a
 * folio such as `131b`), not in the footer. The renderer honours both: the footnote
 * becomes an `<aside class="footnote">`, and the folio is furniture that never
 * reaches the reader - it is counted in `blocksDropped` instead, which is the
 * signal QC uses to confirm the furniture rules are being followed.
 */
async function scenarioFootnoteAndFolio() {
  const outDir = path.join(E2E_DIR, 'page-marks')
  const host = createFakeHost({ footnoteAndFolio: true })
  const run = await pipeline.runConversion({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const entries = unzip(await readFile(run.epubPath))
  const chapter = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  expectTrue('marks: footnote 渲染成 <aside class="footnote">',
    chapter.includes('<aside class="footnote" epub:type="footnote">'), { detail: shorten(chapter) })
  expectTrue('marks: 注文与它的圆圈序号都在', chapter.includes('① 这是译者注'),
    { detail: shorten(chapter) })
  expectTrue('marks: 页码块没有进正文', !chapter.includes('131b'), { detail: shorten(chapter) })
  expect('marks: 页码块计入 blocksDropped', run.report.stats.blocksDropped, 1)
  expect('marks: 正文块只剩 footnote 与 p', run.report.stats.blocks, 2)
  expect('marks: 该页不因页码块失败', run.report.stats.pagesFailed, 0)

  return `footnote rendered, folio dropped | blocks ${run.report.stats.blocks}, `
    + `blocksDropped ${run.report.stats.blocksDropped}`
}

/* ------------------------------------------------------------------ *
 * reading-quality scenarios
 * ------------------------------------------------------------------ */

/**
 * (v) 非相邻页不焊接.
 *
 * The pilot book's most visible defect: page 73 ends `…我的大部分事务都是根`
 * and page 216 opens `速，这似乎表明…` with `continues: true`, and the two were
 * welded into one 349-character paragraph (`都是根速，这似乎表明`) because a
 * `pages: "73,216"` selection puts them side by side in the flattened list.
 * The pages are 143 apart, so the join has to be refused on the page numbers
 * alone; the `continues` flag has to survive on the block and the refusal has to
 * be counted in `blocksRejectedJoins`.
 */
async function scenarioNonAdjacentPagesDoNotJoin() {
  const pdf = await manyPagePdf()
  const outDir = path.join(E2E_DIR, 'join-gap')
  const host = createFakeHost({
    blocksByPage: {
      73: [{ type: 'p', text: '在所有的妇女中，很少有人像我外祖母那样明察有主见。我的大部分事务都是根' }],
      216: [{ type: 'p', text: '速，这似乎表明，该山隘是在以后才关闭，而不是在其关闭时期以前进入的。', continues: true }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: pdf, outputDir: outDir, pages: '73,216' },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 72, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  expect('join-gap: 选区就是第 73、216 页', run.report.selection?.resolved, [73, 216])
  expect('join-gap: 没有发生跨页合并', run.report.stats.blocksJoined, 0, { cause: JOIN_CAUSE })
  expect('join-gap: 被拒绝的续接计入 blocksRejectedJoins', run.report.stats.blocksRejectedJoins, 1,
    { cause: JOIN_CAUSE })
  expect('join-gap: 两页各是一个段落', run.report.stats.blocks, 2, { cause: JOIN_CAUSE })

  const chapter = allChapterText(unzip(await readFile(run.epubPath)))
  expectTrue('join-gap: 成品里没有「都是根速」', !chapter.includes('都是根速'), { detail: shorten(chapter) })
  expectTrue('join-gap: 第 73 页末段保持原样', chapter.includes('我的大部分事务都是根</p>'),
    { detail: shorten(chapter) })
  expectTrue('join-gap: 第 216 页首段独立成段', chapter.includes('<p>速，这似乎表明'),
    { detail: shorten(chapter) })

  return `pages 73,216（相隔 143 页）| joined ${run.report.stats.blocksJoined} | `
    + `rejected ${run.report.stats.blocksRejectedJoins} | 焊成一句 ${chapter.includes('都是根速')}`
}

/**
 * (w) 相邻页仍正常焊接（回归）.
 *
 * The page-adjacency guard must not disable the join it protects: page 73 ends
 * mid-sentence and page 74 continues it, so the two paragraphs still become one.
 */
async function scenarioAdjacentPagesJoin() {
  const pdf = await manyPagePdf()
  const outDir = path.join(E2E_DIR, 'join-adjacent')
  const host = createFakeHost({
    blocksByPage: {
      73: [{ type: 'p', text: '他走到门口，' }],
      74: [{ type: 'p', text: '回头看了一眼。', continues: true }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: pdf, outputDir: outDir, pages: '73-74' },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 72, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  expect('join-adjacent: 相邻页合并了', run.report.stats.blocksJoined, 1, { cause: JOIN_CAUSE })
  expect('join-adjacent: 没有拒绝任何续接', run.report.stats.blocksRejectedJoins, 0)
  expect('join-adjacent: 合并后只剩一个段落', run.report.stats.blocks, 1, { cause: JOIN_CAUSE })

  const chapter = allChapterText(unzip(await readFile(run.epubPath)))
  expectTrue('join-adjacent: 两页文字接成一句', chapter.includes('他走到门口，回头看了一眼。'),
    { detail: shorten(chapter) })

  return `pages 73-74 | joined ${run.report.stats.blocksJoined} | blocks ${run.report.stats.blocks}`
}

/**
 * (x) 目录块渲染成真正的目录.
 *
 * The model reports the contents pages as `toc` blocks and they used to render as
 * `<p class="verse">`: no `<nav>`, no `<li>`, no page numbers a reader could use.
 * Two consecutive `toc` blocks (the list spans a page break) must become ONE
 * `<nav epub:type="toc">`; the leader dots are typography and must be gone; the
 * printed page number moves into `.toc-page`; the indentation becomes
 * `class="toc-N"` (two full-width spaces per level in this book, so the first
 * indented entry is `toc-2`); blank lines are dropped.
 */
async function scenarioTocRendered() {
  const outDir = path.join(E2E_DIR, 'toc')
  // Page 31 and page 32 of the pilot book, verbatim apart from the truncation.
  const first = '费尔干纳 …………………………………………………………………………… 1\n\n'
    + '　　回历八九九年(1493—1494)的事件　…………………………………… 3\n'
    + '　　　英译者补回历九〇八年至九〇九年(1503—1504)的事件　……… 183'
  const second = '喀布尔 …………………………………………………………………………… 187\n'
    + '　　人名……………………………………………………………… 669'
  const host = createFakeHost({
    blocksByPage: {
      1: [
        { type: 'h1', text: '目 录' },
        { type: 'toc', text: first },
        { type: 'toc', text: second },
      ],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const chapter = strFromU8(unzip(await readFile(run.epubPath))['OEBPS/text/ch001.xhtml'])
  expect('toc: 两个 toc 块合成一个 nav', countOf(chapter, '<nav class="toc" epub:type="toc">'), 1)
  expect('toc: 只有一个 <ol>', countOf(chapter, '<ol>'), 1)
  expect('toc: 一条目录一个 <li>', countOf(chapter, '<li class="toc-'), 5)
  expectTrue('toc: 引导点被去掉', !chapter.includes('…') && !chapter.includes('···'),
    { detail: shorten(chapter) })
  expectTrue('toc: 一级条目（无缩进）是 toc-1',
    chapter.includes('<li class="toc-1"><span class="toc-title">费尔干纳</span><span class="toc-page">1</span></li>'),
    { detail: shorten(chapter) })
  expectTrue('toc: 两个全角空格缩进是 toc-2',
    chapter.includes('<li class="toc-2"><span class="toc-title">回历八九九年(1493—1494)的事件</span>'
      + '<span class="toc-page">3</span></li>'),
    { detail: shorten(chapter) })
  expectTrue('toc: 三个全角空格缩进是 toc-3',
    chapter.includes('<li class="toc-3"><span class="toc-title">英译者补回历九〇八年至九〇九年(1503—1504)的事件</span>'),
    { detail: shorten(chapter) })
  expect('toc: 每条目录都有页码', countOf(chapter, '<span class="toc-page">'), 5)
  expectTrue('toc: 跨页的第二块也在同一个 nav 里', chapter.includes('class="toc-title">人名</span>')
    && chapter.indexOf('人名') < chapter.indexOf('</nav>'), { detail: shorten(chapter) })

  return `toc lis ${countOf(chapter, '<li class="toc-')} | navs ${countOf(chapter, '<nav')} | `
    + `dots left ${chapter.includes('…')}`
}

/**
 * (y) 页边叶码从正文里清除.
 *
 * The pilot's page 73 reports its folio twice: as a `page-number` block (`24b`,
 * dropped as furniture) and inline (`…装做好像是倾向 24b 于他那一边`). The dropped
 * copy is the right one, so the inline copy goes too, and the spaces that only
 * separated it go with it (`倾向于`, not `倾向 于`). Two guards matter just as
 * much: a token that is part of a longer word (`x124b`, asserted in (ao)) is not a
 * folio, and the reference shapes are kept by the citation guard (see (ap)).
 *
 * CHANGED WITH TIER H - the page gate is gone. The old rule only ran on a page
 * that also reported a `page-number` block, so the run WITHOUT one used to assert
 * `倾向 24b 于` verbatim. That gate was measured against 495 real pages: it hid two
 * genuine leaf marks (page 221, whose model noted the printed page number in prose
 * but never emitted the block) and protected no book text at all - the shape,
 * CJK-context and citation guards already keep plain prose untouched. The same
 * `24b` is therefore deleted here now, and the assertion below pins the deletion.
 *
 * DELIBERATE TRADE-OFF, and the one expectation this rule change flips: `124b` in
 * `这批编号是 124b 的产品` used to survive, because the old CJK guard looked only at
 * the IMMEDIATE neighbours - here two spaces - and found no Chinese character. V3
 * skips those spaces (that is exactly how `河 3a 流` is recognised), so `是` and
 * `的` now count, and the token is deleted. A catalogue number spaced off inside
 * Chinese prose and a margin leaf mark have the same structure; no guard
 * separates them, and the rule chooses cleaning, because the alternative keeps
 * every ugly mark the rule exists for. Reference shapes carry their own evidence
 * and are protected by the citation guard instead (see (ap)) - not by luck.
 */
async function scenarioFoliageRemoved() {
  const runOnce = async (name, blocks) => {
    const host = createFakeHost({ blocksByPage: { 1: blocks } })
    const run = await pipeline.runConversion({
      host,
      spec: { input: SHORT_PDF, outputDir: path.join(E2E_DIR, name) },
      config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    })
    state.epubs.push(run.epubPath)
    return strFromU8(unzip(await readFile(run.epubPath))['OEBPS/text/ch001.xhtml'])
  }

  const withFolio = await runOnce('folio-inline', [
    { type: 'p', text: '他的回答是模棱两可的，装做好像是倾向 24b 于他那一边，而让其离去。' },
    { type: 'page-number', text: '24b' },
  ])
  expectTrue('folio: 叶码连同两侧空格一起删掉', withFolio.includes('装做好像是倾向于他那一边'),
    { detail: shorten(withFolio), cause: FOLIO_CAUSE })
  expectTrue('folio: 正文里不再出现 24b', !withFolio.includes('24b'),
    { detail: shorten(withFolio), cause: FOLIO_CAUSE })
  expectTrue('folio: 段落里没有留下双空格',
    !/<p>[^<]*[ \t]{2,}[^<]*<\/p>/.test(withFolio) && !withFolio.includes('倾向 于'),
    { detail: shorten(withFolio) })

  const noFolioBlock = await runOnce('folio-absent', [
    { type: 'p', text: '他的回答是模棱两可的，装做好像是倾向 24b 于他那一边。' },
  ])
  // CHANGED WITH TIER H: the shape rule is no longer gated on the page carrying a
  // `page-number` block, so the same leaf mark is deleted on this page too. See
  // the scenario comment for the 495-page measurement behind that decision.
  expectTrue('folio: 本页没有 page-number 块时叶码仍按形状规则删掉',
    noFolioBlock.includes('装做好像是倾向于他那一边') && !noFolioBlock.includes('24b'),
    { detail: shorten(noFolioBlock), cause: FOLIO_CAUSE })

  const inWord = await runOnce('folio-in-word', [
    { type: 'p', text: '这批编号是 124b 的产品，共 24b 类。' },
    { type: 'page-number', text: '24b' },
  ])
  // The flipped assertion - see the trade-off note in the scenario comment above.
  expectTrue('folio: 与真叶码同形的 124b 也被删掉（有意的取舍）', !inWord.includes('124b'),
    { detail: shorten(inWord), cause: FOLIO_CAUSE })
  expectTrue('folio: 独立的 24b 仍然被删掉', !inWord.includes('24b </p>') && inWord.includes('共类。'),
    { detail: shorten(inWord), cause: FOLIO_CAUSE })
  expectTrue('folio: 删完只剩原文，不留双空格',
    inWord.includes('这批编号是的产品，共类。')
    && !/<p>[^<]*[ \t]{2,}[^<]*<\/p>/.test(inWord),
    { detail: shorten(inWord), cause: FOLIO_CAUSE })

  return `inline folio removed=${!withFolio.includes('24b')} | removed without page-number block=`
    + `${!noFolioBlock.includes('24b')} | 124b removed=${!inWord.includes('124b')}`
}

/**
 * (z) 空 figure 不输出.
 *
 * A `figure` with neither a picture nor a caption is an empty box (the model saw
 * a plate it could not crop and had nothing to say about it). It must render as
 * nothing at all, while a caption-only figure keeps the shape scenarios (n) and
 * (o) assert.
 */
async function scenarioEmptyFigureSuppressed() {
  const runOnce = async (name, blocks) => {
    const host = createFakeHost({ blocksByPage: { 1: blocks } })
    const run = await pipeline.runConversion({
      host,
      spec: { input: SHORT_PDF, outputDir: path.join(E2E_DIR, name) },
      config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    })
    state.epubs.push(run.epubPath)
    return strFromU8(unzip(await readFile(run.epubPath))['OEBPS/text/ch001.xhtml'])
  }

  const empty = await runOnce('figure-empty', [
    { type: 'h2', text: '第1章' },
    { type: 'figure', text: '' },
    { type: 'p', text: '正文一段。' },
  ])
  expectTrue('figure: 无图无注的 figure 不输出', !empty.includes('<figure'), { detail: shorten(empty) })
  expectTrue('figure: 页面正文照常输出', empty.includes('<p>正文一段。</p>'), { detail: shorten(empty) })

  const captioned = await runOnce('figure-caption', [
    { type: 'h2', text: '第1章' },
    { type: 'figure', text: '图 1' },
  ])
  expectTrue('figure: 只有图注的 figure 仍按旧形态输出',
    captioned.includes('<figure><figcaption>图 1</figcaption></figure>'), { detail: shorten(captioned) })

  return `empty figure rendered=${empty.includes('<figure')} | caption-only kept=`
    + `${captioned.includes('<figcaption>图 1</figcaption>')}`
}

/**
 * (aa) 只有标题的空章被丢弃且章号连续.
 *
 * The pilot's book carries chapters that hold nothing but a heading (a page
 * transcribed as a title plus a subtitle). They become documents that say nothing
 * and entries in the table of contents that lead nowhere, so a chapter without a
 * single body block is dropped - and because ids are assigned after that filter,
 * the surviving files are `ch001`, `ch002`, ... with no gap (the pilot's archive
 * jumps `ch001` -> `ch003`).
 */
async function scenarioEmptyChapterDropped() {
  const outDir = path.join(E2E_DIR, 'empty-chapter')
  const host = createFakeHost({
    blocksByPage: {
      1: [
        { type: 'h2', text: '第1章' },
        { type: 'p', text: '甲段。' },
        { type: 'h2', text: '第2章' },
        { type: 'h3', text: '空节' },
        { type: 'h2', text: '第3章' },
        { type: 'p', text: '丙段。' },
      ],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  expect('empty-chapter: 只有标题的第 2 章被丢弃', run.report.stats.chapters, 2)
  expect('empty-chapter: report.book.chapters 一致', run.report.book.chapters, 2)

  const entries = unzip(await readFile(run.epubPath))
  const names = Object.keys(entries).sort()
  const chapters = names.filter(name => /^OEBPS\/text\/ch\d+\.xhtml$/.test(name))
  expect('empty-chapter: 章文件重新编号且连续', chapters,
    ['OEBPS/text/ch001.xhtml', 'OEBPS/text/ch002.xhtml'])
  expectTrue('empty-chapter: 没有跳号的 ch003', !names.includes('OEBPS/text/ch003.xhtml'),
    { detail: names.join(', ') })

  const first = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  const second = strFromU8(entries['OEBPS/text/ch002.xhtml'])
  expectTrue('empty-chapter: ch001 是第 1 章', first.includes('<h2>第1章</h2>') && first.includes('甲段'),
    { detail: shorten(first) })
  expectTrue('empty-chapter: ch002 是第 3 章', second.includes('<h2>第3章</h2>') && second.includes('丙段'),
    { detail: shorten(second) })
  const body = allChapterText(entries)
  expectTrue('empty-chapter: 空章的标题与空节都没有进书', !body.includes('第2章') && !body.includes('空节'),
    { detail: shorten(body) })
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])
  expectTrue('empty-chapter: 目录里没有第 2 章', nav.includes('第1章') && !nav.includes('第2章')
    && nav.includes('第3章'), { detail: shorten(nav) })

  return `chapters ${run.report.stats.chapters} | files ${chapters.join(',')} | nav 第2章=`
    + `${nav.includes('第2章')}`
}

/**
 * (ab) 部扉页标题不被丢弃.
 *
 * 《巴布尔回忆录》的 11 页质检里，部扉页「费 尔 干 纳」（源 `h1`，页面上只有标题）后面
 * 跟的是同级的「回历九〇〇年…的事件」（也是 `h1`），不是更深的一章。旧规则只保留
 * 「level-1 且后面紧跟更深一章」的空章，于是这本书记录下来的部一级结构被整段丢掉，
 * 只剩目录里能看到。收窄后的规则是：只有标题的章，只要开章的标题块本身是 `h1` 就一律
 * 保留——部扉页是版式，不是被模型读空的一页。构造复现质检里的版面：
 * `h1 费尔干纳`（无正文块）→ `h1 回历九百年的事件` + 一段正文。
 */
async function scenarioPartTitleKept() {
  const outDir = path.join(E2E_DIR, 'part-title')
  const host = createFakeHost({
    blocksByPage: {
      1: [
        { type: 'h1', text: '费尔干纳' },
        { type: 'h1', text: '回历九百年的事件' },
        { type: 'p', text: '回历九百年，帖木儿出生。' },
      ],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  expect('part-title: 部扉页没有被丢弃', book.chapters.length, 2)
  expect('part-title: 第 1 章是部扉页', book.chapters[0]?.title, '费尔干纳')
  expect('part-title: 部扉页的章级仍是 1', book.chapters[0]?.level, 1)
  expect('part-title: 部扉页没有正文块', String(book.chapters[0]?.html ?? '').trim(),
    '<h1>费尔干纳</h1>')
  expect('part-title: 第 2 章是部里的第一章', book.chapters[1]?.title, '回历九百年的事件')
  expect('part-title: report 里的章数一致', run.report.stats.chapters, 2)

  const entries = unzip(await readFile(run.epubPath))
  const names = Object.keys(entries).sort()
  const chapters = names.filter(name => /^OEBPS\/text\/ch\d+\.xhtml$/.test(name))
  expect('part-title: 两个章文件是 ch001/ch002 连续', chapters,
    ['OEBPS/text/ch001.xhtml', 'OEBPS/text/ch002.xhtml'])
  expectTrue('part-title: 没有跳号的 ch003', !names.includes('OEBPS/text/ch003.xhtml'),
    { detail: names.join(', ') })

  const first = strFromU8(entries['OEBPS/text/ch001.xhtml'])
  expectTrue('part-title: ch001 只讲部扉页', first.includes('<h1>费尔干纳</h1>')
    && !first.includes('回历九百年'), { detail: shorten(first) })
  const second = strFromU8(entries['OEBPS/text/ch002.xhtml'])
  expectTrue('part-title: ch002 是部里的第一章', second.includes('<h1>回历九百年的事件</h1>')
    && second.includes('帖木儿出生'), { detail: shorten(second) })
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])
  expectTrue('part-title: nav 里有费尔干纳', nav.includes('费尔干纳'), { detail: shorten(nav) })

  return `chapters ${book.chapters.length} | ${book.chapters.map(chapter => `${chapter.title}(L${chapter.level})`).join(' -> ')}`
    + ` | files ${chapters.join(',')} | nav 费尔干纳=${nav.includes('费尔干纳')}`
}

/**
 * (ac) 非 h1 的空章仍被丢弃.
 *
 * The narrowing is deliberately not "keep a heading-only chapter when another
 * chapter follows": a heading the model hallucinated on a blank page is followed
 * by a chapter too. The raw level of the opening heading is the discriminator, so
 * an empty `h2` section is still dropped - its title must reach neither the book
 * body nor the navigation document - while the `h1` chapter that follows it stays.
 */
async function scenarioNonH1EmptyChapterDropped() {
  const outDir = path.join(E2E_DIR, 'empty-h2-chapter')
  const host = createFakeHost({
    blocksByPage: {
      1: [
        { type: 'h2', text: '空小节' },
        { type: 'h1', text: '第一章' },
        { type: 'p', text: '正文一段。' },
      ],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  expect('empty-h2: 非 h1 的空章仍被丢弃', book.chapters.length, 1)
  expect('empty-h2: 留下的是第一章', book.chapters[0]?.title, '第一章')
  expect('empty-h2: report 里的章数一致', run.report.stats.chapters, 1)

  const entries = unzip(await readFile(run.epubPath))
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])
  const body = allChapterText(entries)
  expectTrue('empty-h2: nav 里没有空小节', !nav.includes('空小节'), { detail: shorten(nav) })
  expectTrue('empty-h2: 正文里也没有空小节', !body.includes('空小节'), { detail: shorten(body) })
  expectTrue('empty-h2: 第一章照常进书', body.includes('第一章') && body.includes('正文一段。'),
    { detail: shorten(body) })

  return `chapters ${book.chapters.length} | title ${book.chapters[0]?.title}`
    + ` | nav 空小节=${nav.includes('空小节')}`
}

/* ------------------------------------------------------------------ *
 * output-layout scenarios
 * ------------------------------------------------------------------ */

/**
 * (ad) 一本一目录：产物落在 <outputDir>/<输入文件名>/ 下.
 *
 * The layout the title asks for: one directory per book, named after the INPUT
 * FILE (not the title - a title can come from the caller on one run and from the
 * PDF's `/Title` on the next, so a title-named directory would move under a stable
 * input), holding `<name>.epub`, `<name>.book.json`, `<name>.report.json`, a
 * `pages/` cache and an `images/` directory. The book directory also has to be the
 * one `report.book.directory` names, so a caller never has to re-derive it.
 *
 * Three more facts are pinned here:
 *  - the three artifact paths in `report.outputs` point INTO that directory;
 *  - the same PDF with a different `title` still lands in `test-long/`, which is
 *    the whole point of naming the directory after the file;
 *  - with no `outputDir` the directory is created next to the PDF, and a file
 *    whose own name would be the directory (a PDF with no extension) is refused
 *    with a clear error instead of overwriting the input.
 */
async function scenarioBookDirectory() {
  const outDir = path.join(E2E_DIR, 'book-directory')
  const titled = await pipeline.runConversion({
    host: createFakeHost(),
    spec: { input: LONG_PDF, outputDir: outDir, title: '测试书目' },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(titled.epubPath)

  const bookDir = path.join(outDir, 'test-long')
  expect('(ad) 产物目录是 <outputDir>/<PDF 文件名>', titled.report.book.directory, bookDir, { cause: BOOK_DIR_CAUSE })
  expect('(ad) 目录名本身', path.basename(titled.report.book.directory), 'test-long')
  expect('(ad) report.book.outputName', titled.report.book.outputName, 'test-long', { cause: BOOK_DIR_CAUSE })
  expect('(ad) 显式 outputDir 不是 PDF 目录时 alongsideInput=false',
    titled.report.book.alongsideInput, false, { cause: BOOK_DIR_CAUSE })
  expect('(ad) epub 在书目录里', titled.epubPath, path.join(bookDir, 'test-long.epub'), { cause: BOOK_DIR_CAUSE })
  expect('(ad) report 在书目录里', titled.reportPath, path.join(bookDir, 'test-long.report.json'))
  expect('(ad) book.json 在书目录里', titled.bookJsonPath, path.join(bookDir, 'test-long.book.json'))
  expect('(ad) report.outputs 三个路径一致', titled.report.outputs, {
    epub: titled.epubPath,
    report: titled.reportPath,
    book: titled.bookJsonPath,
  })
  expectTrue('(ad) 三个产物都在磁盘上',
    (await isFile(titled.epubPath)) && (await isFile(titled.reportPath)) && (await isFile(titled.bookJsonPath)),
    { detail: Object.values(titled.report.outputs).map(relativeToRoot).join(', ') })

  const layout = await listDirectory(bookDir)
  expect('(ad) 书目录里恰好是三个产物文件', layout.files,
    ['test-long.book.json', 'test-long.epub', 'test-long.report.json'], { cause: BOOK_DIR_CAUSE })
  expectTrue('(ad) 书目录里有 pages/ 缓存子目录', layout.directories.includes('pages'),
    { detail: `directories = ${show(layout.directories)}` })
  expectTrue('(ad) 书目录里有 images/ 子目录', layout.directories.includes('images'),
    { detail: `directories = ${show(layout.directories)}` })
  expectTrue('(ad) pages/ 下确实写了页缓存', (await hasPagesDirectory(outDir, 'test-long')),
    { detail: path.join(bookDir, 'pages') })

  // The title still reaches the book; it just does not name the directory.
  const opf = strFromU8(unzip(await readFile(titled.epubPath))['OEBPS/content.opf'])
  expectTrue('(ad) title 进了 OPF 的 dc:title', opf.includes('<dc:title>测试书目</dc:title>'),
    { detail: shorten(opf, 600) })
  const book = JSON.parse(await readFile(titled.bookJsonPath, 'utf8'))
  expect('(ad) book.json 的 title', book.title, '测试书目')

  // Same PDF, different title -> the SAME directory name. This is what proves the
  // directory is derived from the file, not from the metadata.
  const otherTitle = await pipeline.runConversion({
    host: createFakeHost(),
    spec: { input: LONG_PDF, outputDir: path.join(E2E_DIR, 'book-directory-title'), title: '另一个书名' },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(otherTitle.epubPath)
  expect('(ad) 换 title 后目录名不变', path.basename(otherTitle.report.book.directory), 'test-long',
    { cause: BOOK_DIR_CAUSE })
  expect('(ad) 换 title 后文件名也不变', path.basename(otherTitle.epubPath), 'test-long.epub')

  // No outputDir: the directory is created next to the PDF, which is the default.
  const alongside = await pipeline.runConversion({
    host: createFakeHost(),
    spec: { input: LONG_PDF },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(alongside.epubPath)
  const expectedAlongside = path.join(path.dirname(LONG_PDF), 'test-long')
  expect('(ad) 不传 outputDir 时产物与 PDF 同级', alongside.report.book.directory, expectedAlongside,
    { cause: BOOK_DIR_CAUSE })
  expect('(ad) alongsideInput=true', alongside.report.book.alongsideInput, true, { cause: BOOK_DIR_CAUSE })
  expect('(ad) 同级产物路径', alongside.epubPath, path.join(expectedAlongside, 'test-long.epub'))
  expectTrue('(ad) 与 PDF 同级时 EPUB 正常写出', await isFile(alongside.epubPath), { detail: alongside.epubPath })

  // A file with no extension IS its own stem, so the directory would be the input
  // file itself. That must be a readable error, never an attempt to overwrite it.
  const noExtension = path.join(OUT, 'no-extension-input')
  await writeFile(noExtension, await readFile(LONG_PDF))
  const blockedHost = createFakeHost()
  const blocked = await runExpectingFailure({
    host: blockedHost,
    spec: { input: noExtension },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  const refused = expectTrue('(ad) 目录与输入文件同名时抛错', blocked.error !== null,
    { detail: blocked.error === null ? '返回了成功结果（输入文件可能被覆盖）' : '' })
  if (refused) {
    expectTrue('(ad) 该错误说明目录会顶掉输入文件',
      /artifact directory would be the input file itself/.test(blocked.error.message),
      { detail: `message = ${blocked.error.message}` })
  }
  expect('(ad) 被拒绝前没有发起模型调用', blockedHost.__stats.calls, 0)
  const stillAFile = await stat(noExtension).then(info => info.isFile()).catch(() => false)
  expectTrue('(ad) 输入文件原样还在', stillAFile, { detail: relativeToRoot(noExtension) })

  note(`布局：${relativeToRoot(bookDir)}/ -> ${layout.files.join(', ')}（dirs: ${layout.directories.join(', ')}）`)
  note(`同级默认：${relativeToRoot(alongside.report.book.directory)}（alongsideInput=${alongside.report.book.alongsideInput}）`)

  return `bookDir ${relativeToRoot(bookDir)} | files ${layout.files.length} | dirs ${layout.directories.join(',')} | `
    + `alongside ${relativeToRoot(alongside.report.book.directory)}`
}

/**
 * (ae) 目录名净化：非法字符、设备名、尾部点/空格、超长截断.
 *
 * Windows cannot create a file whose name contains `/ : * ?` or ends with a dot or
 * a space, and it reserves `CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9` (with or
 * without an extension). A PDF dropped on such a name therefore has to be
 * sanitised - and since the input file cannot carry the illegal characters, the
 * illegal cases are unit-tested against the exported `bookDirectoryName()`, which
 * is the function the pipeline itself calls. The length cap IS exercised end to
 * end: a 125-character file name is a legal input, so a real conversion proves the
 * directory name is cut to 100 characters with the head kept.
 */
async function scenarioDirectoryNameSanitizer() {
  const sanitize = name => pipeline.bookDirectoryName(name)

  const illegal = sanitize('A/B:C*D?')
  expectTrue('(ae) 净化后不含任何 Windows 非法字符', !/[\\/:*?"<>|]/.test(illegal), { detail: illegal })
  expectTrue('(ae) 净化结果以 A_B_C_D_ 开头', illegal.startsWith('A_B_C_D_'), { detail: illegal })
  expect('(ae) 非法字符逐个换成 _', illegal, 'A_B_C_D_', { cause: BOOK_DIR_CAUSE })

  const device = sanitize('CON')
  expectTrue('(ae) 设备名 CON 被改名', device.toUpperCase() !== 'CON', { detail: device, cause: BOOK_DIR_CAUSE })
  expect('(ae) CON -> CON_', device, 'CON_')
  expect('(ae) 带扩展名的设备名也算', sanitize('con.txt'), 'con_.txt')
  expect('(ae) COM1 被改名', sanitize('COM1'), 'COM1_')
  expect('(ae) 普通名字带点不受影响', sanitize('第1卷.上册'), '第1卷.上册')

  const trailing = sanitize('  trailing.  ')
  expectTrue('(ae) 净化后不以点或空格结尾', !/[. ]$/.test(trailing), { detail: trailing })
  expect('(ae) 尾部点与空格被去掉', trailing, '  trailing')

  expect('(ae) 全空的名字回退为 book', sanitize('   '), 'book')
  expect('(ae) 只有点的名字回退为 book', sanitize('...'), 'book')

  // End to end: a legal but very long input file name is truncated on the real path.
  const longStem = `很长的书名${'甲'.repeat(120)}`
  const longFile = path.join(OUT, `${longStem}.pdf`)
  await writeFile(longFile, buildMultiPagePdf([['Long-name fixture, page one.']]))
  const longRun = await pipeline.runConversion({
    host: createFakeHost(),
    spec: { input: longFile, outputDir: path.join(E2E_DIR, 'long') },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(longRun.epubPath)
  const longName = path.basename(longRun.report.book.directory)
  expect('(ae) 超长文件名截断到 100 个字符', [...longName].length, 100, { cause: BOOK_DIR_CAUSE })
  expect('(ae) 截断保留开头', longName, [...longStem].slice(0, 100).join(''))
  expect('(ae) 产物文件名跟着截断后的目录名', path.basename(longRun.epubPath), `${longName}.epub`)
  expectTrue('(ae) 截断后的目录真的写出成书', await isFile(longRun.epubPath), { detail: longRun.epubPath })

  note(`净化：A/B:C*D? -> ${sanitize('A/B:C*D?')} | CON -> ${device} | `
    + `${JSON.stringify('  trailing.  ')} -> ${JSON.stringify(trailing)} | 长名 ${[...longStem].length} -> ${[...longName].length}`)

  return `sanitize ${JSON.stringify(illegal)} ${JSON.stringify(device)} ${JSON.stringify(trailing)} | `
    + `long ${[...longStem].length} -> ${[...longName].length} chars`
}

/**
 * (af) 同名不同书不误用缓存.
 *
 * The old directory name carried the input fingerprint, so two books could not
 * share page files even in principle. The directory is now named after the file,
 * so two DIFFERENT PDFs with the same file name (a re-download, a corrected scan,
 * another volume saved under the same generic name) land in the same folder and on
 * the same `pages/` path. The only thing that keeps them apart is the fingerprint
 * stored inside each entry: it must still be written, it must be compared on read,
 * and a mismatch must be a miss whose file is deleted - otherwise the second book
 * silently replays the first one's pages.
 *
 * The test uses two one-page PDFs at different paths with the same file name and
 * different content, converts both into one outputDir, and requires the second run
 * to call the model and to produce the second book's text.
 */
async function scenarioSameNameDifferentBooks() {
  const dirA = path.join(OUT, 'same-name-a')
  const dirB = path.join(OUT, 'same-name-b')
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })
  const bookA = path.join(dirA, '同名书.pdf')
  const bookB = path.join(dirB, '同名书.pdf')
  // Different content, so the two files are also different sizes and mtimes: the
  // fingerprints differ for every reason, exactly as they would for a real pair.
  // Book B is also a page longer, so a run that replayed A's cache would be caught
  // by the page count alone.
  await writeFile(bookA, buildMultiPagePdf([['Same-name fixture, book A.']]))
  await writeFile(bookB, buildMultiPagePdf([
    ['Same-name fixture, book B, a longer line.'],
    ['A second page, so the file is bigger than A.'],
  ]))

  const outDir = path.join(E2E_DIR, 'same-name')
  const hostA = createFakeHost({ blocksByPage: { 1: [{ type: 'p', text: '甲书的正文。' }] } })
  const first = await pipeline.runConversion({
    host: hostA,
    spec: { input: bookA, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(first.epubPath)
  const firstEpub = await readFile(first.epubPath)
  const firstText = allChapterText(unzip(firstEpub))
  expectTrue('(af) 第一本书的正文在产物里', firstText.includes('甲书的正文。'), { detail: shorten(firstText) })
  expect('(af) 两本书共用一个书目录名', path.basename(first.report.book.directory), '同名书')

  const firstEntries = await cacheEntries(outDir, '同名书', '00001.json')
  const stored = expectTrue('(af) 第一本书的第 1 页进了缓存', firstEntries.length === 1,
    { detail: firstEntries.map(relativeToRoot).join(', ') })
  if (!stored) return '第一本书没有写出页缓存，后续断言无法求值'
  const firstPayload = JSON.parse(await readFile(firstEntries[0], 'utf8'))
  expectTrue('(af) 页缓存 payload 里带着输入指纹',
    typeof firstPayload.input === 'string' && /^[0-9a-f]{12}$/.test(firstPayload.input),
    { detail: `payload.input = ${show(firstPayload.input)}`, cause: SAME_NAME_CAUSE })
  expect('(af) 该指纹就是第一本书的输入指纹', firstPayload.input, await inputFingerprintFor(bookA),
    { cause: SAME_NAME_CAUSE })

  const hostB = createFakeHost({ blocksByPage: { 1: [{ type: 'p', text: '乙书的正文。' }] } })
  const second = await pipeline.runConversion({
    host: hostB,
    spec: { input: bookB, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(second.epubPath)

  expectTrue('(af) 第二本书真的调用了模型（没命中第一本的页缓存）', hostB.__stats.calls >= 1,
    { detail: `host calls = ${hostB.__stats.calls}`, cause: SAME_NAME_CAUSE })
  expectTrue('(af) 被问的是第 1 页', hostB.__stats.pages.includes(1),
    { detail: `请求过的页 = ${show(hostB.__stats.pages)}`, cause: SAME_NAME_CAUSE })
  expect('(af) 两本书落在同一个目录', second.report.book.directory, first.report.book.directory,
    { cause: SAME_NAME_CAUSE })

  const secondPayload = JSON.parse(await readFile(firstEntries[0], 'utf8'))
  expect('(af) 缓存里的指纹换成第二本书的', secondPayload.input, await inputFingerprintFor(bookB),
    { cause: SAME_NAME_CAUSE })
  expectTrue('(af) 缓存里的页正文是第二本书的',
    JSON.stringify(secondPayload.page?.blocks ?? []).includes('乙书的正文。'),
    { detail: show(secondPayload.page?.blocks), cause: SAME_NAME_CAUSE })

  const secondEpub = await readFile(second.epubPath)
  const secondText = allChapterText(unzip(secondEpub))
  expectTrue('(af) 产物是第二本书的内容', secondText.includes('乙书的正文。'),
    { detail: shorten(secondText), cause: SAME_NAME_CAUSE })
  expectTrue('(af) 产物里没有第一本书的内容', !secondText.includes('甲书的正文。'),
    { detail: shorten(secondText), cause: SAME_NAME_CAUSE })
  expectTrue('(af) 第二本书重写了 EPUB（内容不沿用第一本）', !firstEpub.equals(secondEpub),
    { detail: `${firstEpub.length} vs ${secondEpub.length} bytes` })

  note(`同名书：${relativeToRoot(first.report.book.directory)} | 指纹 A=${firstPayload.input} B=${secondPayload.input} | `
    + `第二次模型调用 ${hostB.__stats.calls} 次（页 ${hostB.__stats.pages.join(',') || 'none'}）`)

  return `same dir ${relativeToRoot(second.report.book.directory)} | fingerprints ${firstPayload.input} -> `
    + `${secondPayload.input} | second-run calls ${hostB.__stats.calls}`
}

/**
 * (ag) 旧布局的页缓存被迁移进书目录.
 *
 * The previous layout kept the page cache in `<outputDir>/.pdf2epub-<inputKey>/
 * pages/...`. A user upgrading has that directory on disk, and silently ignoring
 * it would make the first run of every book pay for every page again. This
 * scenario writes such a cache entry BY HAND - with a payload the pipeline accepts,
 * so the run really is a cache hit - and then requires the conversion to move it
 * into `<bookDir>/pages/`, reuse it (zero model calls), delete the empty old
 * directory, and say so in `report.warnings`.
 */
async function scenarioLegacyCacheMigrated() {
  const outDir = path.join(E2E_DIR, 'legacy-layout')
  const inputKey = await inputFingerprintFor(SHORT_PDF)
  const legacyRoot = path.join(outDir, `.pdf2epub-${inputKey}`)
  const legacySettings = path.join(legacyRoot, 'pages', '100-fake_model')
  const legacyEntry = path.join(legacySettings, '00001.json')
  await mkdir(legacySettings, { recursive: true })
  const cachedPage = {
    page: 1,
    source: 'vlm',
    chars: 9,
    baselineChars: 0,
    ratio: null,
    ok: true,
    reviewed: false,
    agreement: null,
    degraded: false,
    issues: [],
    failure: null,
    error: null,
    raw: '',
    notes: '',
    models: ['fake/model'],
    finishKind: 'stop',
    truncated: false,
    reasoningChars: 0,
    image: null,
    blocks: [{ type: 'p', text: '旧布局缓存里的正文。' }],
    figures: [],
    ms: 1,
  }
  const ledger = { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0, total: 15, calls: 1, unknownShapes: [] }
  await writeFile(legacyEntry, JSON.stringify({
    version: pipeline.PROMPT_VERSION,
    dpi: 100,
    model: 'fake/model',
    input: inputKey,
    page: cachedPage,
    ledger,
    furniture: [],
  }))

  const host = createFakeHost()
  const run = await pipeline.runConversion({
    host,
    spec: { input: SHORT_PDF, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const bookDir = path.join(outDir, 'test')
  expect('(ag) 书目录是 <outputDir>/test', run.report.book.directory, bookDir, { cause: BOOK_DIR_CAUSE })
  expect('(ag) 旧缓存被真正复用（模型零调用）', host.__stats.calls, 0,
    { detail: `host calls = ${host.__stats.calls}`, cause: BOOK_DIR_CAUSE })
  const moved = await cacheEntries(outDir, 'test', '00001.json')
  expectTrue('(ag) 旧页出现在 <书名>/pages/ 下', moved.length === 1,
    { detail: moved.map(relativeToRoot).join(', ') || '没有找到 00001.json' })
  expect('(ag) 旧缓存文件被移动到新位置', moved[0], path.join(bookDir, 'pages', '100-fake_model', '00001.json'))
  const legacyGone = await stat(legacyRoot).then(() => false).catch(() => true)
  expectTrue('(ag) 空的旧目录被删掉', legacyGone, { detail: relativeToRoot(legacyRoot) })
  expectTrue('(ag) report.warnings 留了一行说明迁移',
    run.report.warnings.some(line => line.includes('previous layout') && line.includes('.pdf2epub-')),
    { detail: show(run.report.warnings) })
  const chapter = allChapterText(unzip(await readFile(run.epubPath)))
  expectTrue('(ag) 产物来自旧缓存的内容', chapter.includes('旧布局缓存里的正文。'), { detail: shorten(chapter) })

  note(`迁移：${relativeToRoot(legacyRoot)} -> ${relativeToRoot(path.join(bookDir, 'pages'))} | `
    + `warnings=${JSON.stringify(run.report.warnings)}`)

  return `migrated ${moved.length} entry | model calls ${host.__stats.calls} | old dir gone ${legacyGone}`
}

/* ------------------------------------------------------------------ *
 * running-head and blank-page scenarios
 * ------------------------------------------------------------------ */

/**
 * (ah) 同页书眉被误判为 h1 时降级.
 *
 * The defect this pins, from the 764-page QC run: page 537 is a continuation page
 * (the previous page ends 「…我就会将其」 and this one continues 「记载下来…」), and
 * its top running head 「回历九三二年(公元 1525 年 10 月 18 日至公元 1526 年 10 月 8
 * 日)的事件」 came back from the model as `h1` instead of `header`. The book then
 * grew a chapter (ch002), the navigation document a second entry, and the page's
 * first paragraph was no longer recognised as a continuation because it followed a
 * "title".
 *
 * REWRITTEN FOR THE PAGE-LOCAL RULE (was: `header` on page 1, the same text as `h1`
 * on page 2). That split fixture pinned exactly the comparison the rule must not
 * make any more - page 2 printed no running head, so nothing on it proves the `h1`
 * is furniture, and scenario (ar) now asserts that shape is KEPT. The defect is the
 * one page that reports the same line twice, so page 2 carries both the `header`
 * and the misclassified `h1` here. The running head must disappear entirely (it is
 * furniture), the chapter count must stay at one, and page 2's text must still
 * reach that chapter.
 */
async function scenarioRunningHeadDemoted() {
  const file = await headerPagesPdf()
  const outDir = path.join(E2E_DIR, 'running-head')
  const HEAD = '回历九三二年(公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日)的事件'
  const host = createFakeHost({
    blocksByPage: {
      1: [
        { type: 'header', text: HEAD },
        { type: 'h2', text: '第一章' },
        { type: 'p', text: '第一页正文，接着往下讲。' },
      ],
      2: [
        // The page prints the line twice: once as furniture, once mistyped as a
        // chapter-level heading. Same page + same key is what may be demoted.
        { type: 'header', text: HEAD },
        { type: 'h1', text: HEAD },
        { type: 'p', text: '第二页正文，仍然是同一节。' },
      ],
      3: [{ type: 'p', text: '第三页正文，本节结束。' }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  expect('(ah) stats.demotedHeadings === 1（同页误判的 h1 被降级）',
    run.report.stats.demotedHeadings, 1,
    { detail: `demotedHeadings = ${run.report.stats.demotedHeadings}`, cause: RUNNING_HEAD_CAUSE })
  expect('(ah) 书眉没有开章（chapters 仍为 1）', run.report.stats.chapters, 1,
    { cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ah) 唯一的章是第一章', book.chapters[0]?.title === '第一章',
    { detail: `chapters = ${show(book.chapters.map(chapter => chapter.title))}`, cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ah) 没有任何章标题以书眉文本开头',
    !book.chapters.some(chapter => String(chapter.title ?? '').startsWith('回历九三二年')),
    { detail: show(book.chapters.map(chapter => chapter.title)), cause: RUNNING_HEAD_CAUSE })

  const entries = unzip(await readFile(run.epubPath))
  const body = allChapterText(entries)
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])
  expectTrue('(ah) 书眉文本没有进正文', !body.includes(HEAD), { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ah) nav 里没有书眉条目', !nav.includes('回历九三二年'), { detail: shorten(nav), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ah) 第 2 页正文仍落在第一章里',
    body.includes('第二页正文') && body.includes('第一页正文') && body.includes('第三页正文'),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ah) 丢弃计数包含两个 header 与被降级的 h1（>= 3）',
    run.report.stats.blocksDropped >= 3,
    { detail: `blocksDropped = ${run.report.stats.blocksDropped}`, cause: RUNNING_HEAD_CAUSE })

  note(`(ah) chapters=${run.report.stats.chapters} titles=${JSON.stringify(book.chapters.map(chapter => chapter.title))} `
    + `demotedHeadings=${run.report.stats.demotedHeadings} blocksDropped=${run.report.stats.blocksDropped}`)

  return `demoted ${run.report.stats.demotedHeadings} | chapters ${run.report.stats.chapters} | `
    + `nav has running head=${nav.includes('回历九三二年')} | body has running head=${body.includes(HEAD)}`
}

/**
 * (ai) 重复的章标题不再全书去重.
 *
 * REWRITTEN FOR THE PAGE-LOCAL RULE. This scenario used to pin the removed
 * fallback: "an identical chapter-level title keeps only its first occurrence",
 * written for a book whose model typed the running head as `h1` on every page and
 * never as `header`. That rule ate real structure - 「人 名」 and 「地 名」 are index
 * section titles printed in EVERY chapter's index, and book-wide dedup deleted the
 * second one (scenario (at) pins the same thing through the rendered chapters).
 * Repetition alone is not evidence of furniture; the same-page `header` match is
 * ({@link RUNNING_HEAD_CAUSE}). Both occurrences must now stay, each opening its
 * own chapter, and `demotedHeadings` must stay 0.
 *
 * The control run in the same scenario is the regression this must not break: two
 * distinct, non-repeating `h1`s still open two chapters.
 */
async function scenarioDuplicateChapterTitle() {
  const file = await headerPagesPdf()
  const outDir = path.join(E2E_DIR, 'duplicate-h1')
  const runConversion = (host, dir) => pipeline.runConversion({
    host,
    spec: { input: file, outputDir: dir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })

  const duplicated = createFakeHost({
    blocksByPage: {
      1: [{ type: 'h1', text: '同名章' }, { type: 'p', text: '第一段正文。' }],
      2: [{ type: 'h1', text: '同名章' }, { type: 'p', text: '第二段正文。' }],
      3: [{ type: 'p', text: '第三段正文。' }],
    },
  })
  const run = await runConversion(duplicated, outDir)
  state.epubs.push(run.epubPath)
  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))

  expect('(ai) 重复的 h1 各开一章（不再全书去重）', run.report.stats.chapters, 2,
    { detail: show(book.chapters.map(chapter => chapter.title)), cause: RUNNING_HEAD_CAUSE })
  expect('(ai) 两次出现的标题都留下', book.chapters.map(chapter => chapter.title), ['同名章', '同名章'],
    { cause: RUNNING_HEAD_CAUSE })
  expect('(ai) 重复标题不再被计入 demotedHeadings', run.report.stats.demotedHeadings, 0,
    { detail: `demotedHeadings = ${run.report.stats.demotedHeadings}`, cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ai) 第一章里是第一段正文',
    String(book.chapters[0]?.html ?? '').includes('第一段正文'),
    { detail: shorten(book.chapters[0]?.html ?? ''), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ai) 第二章里是第二段正文',
    String(book.chapters[1]?.html ?? '').includes('第二段正文'),
    { detail: shorten(book.chapters[1]?.html ?? ''), cause: RUNNING_HEAD_CAUSE })
  const body = allChapterText(unzip(await readFile(run.epubPath)))
  expectTrue('(ai) 三页正文都还在书里',
    body.includes('第一段正文') && body.includes('第二段正文') && body.includes('第三段正文'),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })

  // Control: unique chapter titles still open their own chapters.
  const controlHost = createFakeHost({
    blocksByPage: {
      1: [{ type: 'h1', text: '第一章 甲' }, { type: 'p', text: '甲段。' }],
      2: [{ type: 'h1', text: '第二章 乙' }, { type: 'p', text: '乙段。' }],
      3: [{ type: 'p', text: '尾巴。' }],
    },
  })
  const control = await runConversion(controlHost, path.join(E2E_DIR, 'distinct-h1'))
  state.epubs.push(control.epubPath)
  const controlBook = JSON.parse(await readFile(control.bookJsonPath, 'utf8'))
  expect('(ai) 回归：不重复的 h1 仍各开一章', control.report.stats.chapters, 2,
    { detail: show(controlBook.chapters.map(chapter => chapter.title)) })
  expect('(ai) 回归：章标题按出现顺序', controlBook.chapters.map(chapter => chapter.title),
    ['第一章 甲', '第二章 乙'])
  expect('(ai) 回归：没有标题被降级', control.report.stats.demotedHeadings, 0)

  note(`(ai) duplicate: chapters=${run.report.stats.chapters} `
    + `titles=${JSON.stringify(book.chapters.map(chapter => chapter.title))} `
    + `demotedHeadings=${run.report.stats.demotedHeadings}; control chapters=${control.report.stats.chapters}`)

  return `duplicate chapters ${run.report.stats.chapters} | control chapters ${control.report.stats.chapters} | `
    + `control titles ${JSON.stringify(controlBook.chapters.map(chapter => chapter.title))}`
}

/**
 * (aj) 真空白页不算失败并写入缓存.
 *
 * From the same QC run: page 34 is a genuinely blank page (an independent render
 * measured ink 0.000). The model answered zero blocks and said "blank page", which
 * was correct - but the pipeline counted that page three times (`pagesFailed`,
 * `pagesDegraded`, `pagesEmpty`), warned that re-running "retries" it, and never
 * cached it, so every batch of the full run paid for the same blank page again.
 *
 * The pipeline now asks the page's own ink. Zero blocks plus
 * `pageInkRatio < 0.005` is a `blank-page`: `ok`, not degraded, counted in
 * `stats.pagesBlank` only, no warning, and cached with `blocks: []` and
 * `blank: true`. The second run proves the point that matters - same parameters,
 * zero model calls, zero ink measurements.
 */
async function scenarioBlankPageCached() {
  const file = await blankPagesPdf()
  const outDir = path.join(E2E_DIR, 'blank-page')
  const bookName = 'test-blank-pages'
  let inkCalls = 0
  const host = createFakeHost({ blocksByPage: { 1: [] } })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    pageInkRatio: () => { inkCalls += 1; return 0.0005 },
  })
  state.epubs.push(run.epubPath)

  const page = run.report.pages[0] ?? {}
  expect('(aj) 空白页 ok === true', page.ok, true, { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 空白页 blank === true', page.blank, true, { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 空白页 failure === "blank-page"', page.failure, 'blank-page', { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 空白页不计入 pagesFailed', run.report.stats.pagesFailed, 0, { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 空白页不计入 pagesDegraded', run.report.stats.pagesDegraded, 0, { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 空白页不计入 pagesEmpty', run.report.stats.pagesEmpty, 0, { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 单独计入 stats.pagesBlank', run.report.stats.pagesBlank, 1, { cause: BLANK_PAGE_CAUSE })
  expectTrue('(aj) 不再为空白页生成 produced no text 告警',
    !run.report.warnings.some(line => line.includes('produced no text')),
    { detail: show(run.report.warnings), cause: BLANK_PAGE_CAUSE })
  expect('(aj) 墨迹测量只做了一次', inkCalls, 1, { cause: BLANK_PAGE_CAUSE })

  const entries = await cacheEntries(outDir, bookName, '00001.json')
  const cached = expectTrue('(aj) 空白页写入了页缓存', entries.length === 1,
    { detail: entries.map(relativeToRoot).join(', ') || '没有找到 00001.json', cause: BLANK_PAGE_CAUSE })
  let cachedBlank = 'n/a'
  if (cached) {
    const payload = JSON.parse(await readFile(entries[0], 'utf8'))
    cachedBlank = payload.page?.blank
    expect('(aj) 缓存条目 blank === true', payload.page?.blank, true, { cause: BLANK_PAGE_CAUSE })
    expect('(aj) 缓存条目 blocks 为空数组', payload.page?.blocks, [], { cause: BLANK_PAGE_CAUSE })
  }

  // Same parameters, second run: the blank page must cost nothing at all.
  let secondInk = 0
  const again = createFakeHost()
  const second = await pipeline.runConversion({
    host: again,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    pageInkRatio: () => { secondInk += 1; return 0.9 },
  })
  expect('(aj) 同参数重跑零模型调用', again.__stats.calls, 0,
    { detail: `requested pages = ${show(again.__stats.pages)}`, cause: BLANK_PAGE_CAUSE })
  expect('(aj) 重跑不再测墨迹（缓存命中直接复用）', secondInk, 0, { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 重跑仍把该页算作空白页', second.report.stats.pagesBlank, 1, { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 重跑没有失败页', second.report.stats.pagesFailed, 0, { cause: BLANK_PAGE_CAUSE })
  expect('(aj) 重跑仍无 produced no text 告警',
    second.report.warnings.filter(line => line.includes('produced no text')), [], { cause: BLANK_PAGE_CAUSE })

  note(`(aj) first: pagesBlank=${run.report.stats.pagesBlank} failed=${run.report.stats.pagesFailed} `
    + `inkCalls=${inkCalls}; rerun: calls=${again.__stats.calls} inkCalls=${secondInk} `
    + `pagesBlank=${second.report.stats.pagesBlank}`)

  return `blank ok=${page.ok} failure=${page.failure} | first inkCalls ${inkCalls} | `
    + `cached ${entries.length} entry blank=${cachedBlank} | `
    + `rerun calls ${again.__stats.calls} inkCalls ${secondInk}`
}

/**
 * (ak) 有墨迹的 0 块页仍按失败处理.
 *
 * The other side of (aj): the blank-page exception must stay an exception. A page
 * with real ink whose model reply carried no blocks is still a failed page - not
 * counted as blank, not cached, and warned about exactly as before - so the fix
 * cannot turn "the model failed to read a page" into a silently accepted hole in
 * the book.
 */
async function scenarioInkedEmptyPageStillFails() {
  const file = await blankPagesPdf()
  const outDir = path.join(E2E_DIR, 'inked-empty-page')
  const host = createFakeHost({ blocksByPage: { 1: [] } })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    pageInkRatio: () => 0.3,
  })

  const page = run.report.pages[0] ?? {}
  expect('(ak) 有墨迹的 0 块页仍是失败页', run.report.stats.pagesFailed, 1,
    { cause: BLANK_PAGE_CAUSE })
  expect('(ak) 不计入 stats.pagesBlank', run.report.stats.pagesBlank, 0, { cause: BLANK_PAGE_CAUSE })
  expect('(ak) 该页 ok === false', page.ok, false, { cause: BLANK_PAGE_CAUSE })
  expect('(ak) 该页 NOT blank', page.blank, false, { cause: BLANK_PAGE_CAUSE })
  expect('(ak) failure 仍是 empty-blocks', page.failure, 'empty-blocks', { cause: BLANK_PAGE_CAUSE })
  expectTrue('(ak) 仍生成 produced no text 告警',
    run.report.warnings.some(line => line.includes('produced no text') && line.includes('page 1')),
    { detail: show(run.report.warnings), cause: BLANK_PAGE_CAUSE })

  expectTrue('(ak) 失败页场景里有 <outputDir>/<书名>/pages/', await hasPagesDirectory(outDir, 'test-blank-pages'),
    { detail: path.join(outDir, 'test-blank-pages', 'pages') })
  const entries = await cacheEntries(outDir, 'test-blank-pages', '00001.json')
  expect('(ak) 失败页不写入缓存', entries.length, 0,
    { detail: entries.map(relativeToRoot).join(', '), cause: BLANK_PAGE_CAUSE })

  note(`(ak) pagesFailed=${run.report.stats.pagesFailed} pagesBlank=${run.report.stats.pagesBlank} `
    + `page.ok=${page.ok} cached=${entries.length}`)

  return `failed ${run.report.stats.pagesFailed} | blank ${run.report.stats.pagesBlank} | `
    + `page ok=${page.ok} failure=${page.failure} | cache entries ${entries.length}`
}

/* ------------------------------------------------------------------ *
 * running-head spelling-variant scenarios
 * ------------------------------------------------------------------ */

/**
 * (al) 书眉的全角/半角括号与排字空距变体仍能被降级.
 *
 * The same running head reached the model in two spellings in a real book: some
 * pages carry 「…（公元 1525 年 …）」 with FULL-WIDTH brackets, others the identical
 * line with half-width `()`, and the 《巴布尔回忆录》 pilot's `h1` transcription had
 * typographic letter-spacing on top (`回 历 九三二年…`). Strict string equality
 * matched none of those pairs, so a page whose running head the model typed as
 * `h1` built a chapter - the exact defect (ah) pins, reached by the variant spelling
 * instead of the block type. `headingKey` folds whitespace and punctuation width
 * before the demotion compares, which is what this scenario proves.
 *
 * Page 1 opens a real chapter and prints the line as furniture with full-width
 * brackets; page 2 is the page-local defect - the same line appears twice ON THAT
 * PAGE, once as `header` (full-width brackets) and once as `h1` (half-width
 * brackets plus letter-spacing); page 3 is plain body. The two spellings must meet
 * through the key. The control run is the same fixture without the misclassified
 * `h1`: the variant run may not end up with more chapters than it, and no chapter
 * may carry the running head.
 */
async function scenarioRunningHeadVariants() {
  const file = await headerPagesPdf()
  const outDir = path.join(E2E_DIR, 'running-head-variants')
  // Page furniture, in the full-width spelling of the printed line.
  const HEAD_FULL_WIDTH = '回历九三二年（公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日）的事件'
  // The misclassified `h1`: half-width brackets plus letter-spacing, so it differs
  // from the `header` above in two independent ways.
  const HEAD_SPACED = '回 历 九三二年(公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日)的事件'
  const runConversion = (host, dir) => pipeline.runConversion({
    host,
    spec: { input: file, outputDir: dir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })

  const host = createFakeHost({
    blocksByPage: {
      1: [
        { type: 'header', text: HEAD_FULL_WIDTH },
        { type: 'h2', text: '第一章' },
        { type: 'p', text: '变体页正文一。' },
      ],
      2: [
        // Same page, two spellings of the same printed line.
        { type: 'header', text: HEAD_FULL_WIDTH },
        { type: 'h1', text: HEAD_SPACED },
        { type: 'p', text: '变体页正文二。' },
      ],
      3: [{ type: 'p', text: '变体页正文三。' }],
    },
  })
  const run = await runConversion(host, outDir)
  state.epubs.push(run.epubPath)
  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  const entries = unzip(await readFile(run.epubPath))
  const body = allChapterText(entries)
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])

  expect('(al) 变体书眉的 h1 被降级（demotedHeadings 恰为 1）', run.report.stats.demotedHeadings, 1,
    { cause: RUNNING_HEAD_CAUSE })
  expectTrue('(al) 没有任何章标题以书眉文本开头（忽略空距）',
    !book.chapters.some(chapter => /^回\s*历\s*九三二年/.test(String(chapter.title ?? ''))),
    { detail: show(book.chapters.map(chapter => chapter.title)), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(al) nav 里没有书眉条目', !/九三二年/.test(nav),
    { detail: shorten(nav), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(al) 书眉文本没有进正文',
    !body.includes(HEAD_FULL_WIDTH) && !body.includes(HEAD_SPACED),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(al) 三页正文都还在书里',
    body.includes('变体页正文一') && body.includes('变体页正文二') && body.includes('变体页正文三'),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })

  // Control: the same fixture and the same page-1 furniture, but page 2 carries
  // body only. Demoting the variant must not leave the book with more chapters
  // than a conversion that never had the misclassified heading.
  const controlHost = createFakeHost({
    blocksByPage: {
      1: [
        { type: 'header', text: HEAD_FULL_WIDTH },
        { type: 'h2', text: '第一章' },
        { type: 'p', text: '变体页正文一。' },
      ],
      2: [{ type: 'p', text: '变体页正文二。' }],
      3: [{ type: 'p', text: '变体页正文三。' }],
    },
  })
  const control = await runConversion(controlHost, path.join(E2E_DIR, 'running-head-variants-control'))
  state.epubs.push(control.epubPath)
  const controlBook = JSON.parse(await readFile(control.bookJsonPath, 'utf8'))
  expectTrue('(al) 章数不比对照多', run.report.stats.chapters <= control.report.stats.chapters,
    { detail: `变体 ${run.report.stats.chapters} vs 对照 ${control.report.stats.chapters}`, cause: RUNNING_HEAD_CAUSE })
  expect('(al) 对照只有第一章', controlBook.chapters.map(chapter => chapter.title), ['第一章'],
    { cause: RUNNING_HEAD_CAUSE })

  note(`(al) demotedHeadings=${run.report.stats.demotedHeadings} chapters=${run.report.stats.chapters} `
    + `control chapters=${control.report.stats.chapters} titles=${JSON.stringify(book.chapters.map(chapter => chapter.title))}`)

  return `demoted ${run.report.stats.demotedHeadings} | chapters ${run.report.stats.chapters} `
    + `vs control ${control.report.stats.chapters} | nav has head=${/九三二年/.test(nav)}`
}

/**
 * (am) 超过 40 字符的书眉也能匹配.
 *
 * The pipeline shows the model a book-wide furniture hint, and that hint is
 * `block.text.slice(0, 40)` - the real running head is 49 characters, so the hint
 * is a PREFIX of it. If `flattenPages` ever built its comparison key from that
 * hint, the key would be a 40-character prefix no heading can equal, and the
 * demotion would quietly stop matching exactly the long running heads it was
 * written for. This scenario uses a 60+ character running head and, on the SAME
 * page, the same line as `h1` (the page-local shape the rule demotes): with the
 * full block text the keys meet, with a truncated hint they cannot, so the
 * assertion `demotedHeadings === 1` fails the moment the truncation creeps into the
 * comparison key.
 */
async function scenarioLongRunningHead() {
  const file = await headerPagesPdf()
  const outDir = path.join(E2E_DIR, 'running-head-long')
  // 65 characters - well past the 40-character furniture hint, and past the
  // 49-character running head of the pilot book.
  const HEAD = '费尔干纳盆地与撒马尔罕绿洲之间的商道在公元十六世纪仍然承担着丝绸马匹与瓷器的长途运输任务，'
    + '并在河中地区形成稳定的中转网络与补给体系'
  const host = createFakeHost({
    blocksByPage: {
      1: [
        { type: 'header', text: HEAD },
        { type: 'h2', text: '第一章' },
        { type: 'p', text: '长书眉页正文一。' },
      ],
      2: [
        // The page-local defect: furniture and the mistyped heading on one page.
        { type: 'header', text: HEAD },
        { type: 'h1', text: HEAD },
        { type: 'p', text: '长书眉页正文二。' },
      ],
      3: [{ type: 'p', text: '长书眉页正文三。' }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)
  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  const entries = unzip(await readFile(run.epubPath))
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])
  const body = allChapterText(entries)

  expectTrue('(am) 测试文本本身是 60+ 字符的书眉（且确实超过提示的 40 字符截断）',
    HEAD.length > 60 && HEAD.slice(0, 40) !== HEAD,
    { detail: `length = ${HEAD.length}` })
  expect('(am) 长书眉的 h1 被降级（demotedHeadings 恰为 1）', run.report.stats.demotedHeadings, 1,
    { cause: RUNNING_HEAD_CAUSE })
  expectTrue('(am) 章标题里没有这本书眉',
    !book.chapters.some(chapter => String(chapter.title ?? '').includes('费尔干纳盆地')),
    { detail: show(book.chapters.map(chapter => chapter.title)), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(am) nav 里没有这本书眉', !nav.includes('费尔干纳盆地'),
    { detail: shorten(nav), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(am) 书眉文本没有进正文', !body.includes(HEAD),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(am) 三页正文都还在书里',
    body.includes('长书眉页正文一') && body.includes('长书眉页正文二') && body.includes('长书眉页正文三'),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })

  note(`(am) headLength=${HEAD.length} demotedHeadings=${run.report.stats.demotedHeadings} `
    + `chapters=${run.report.stats.chapters} titles=${JSON.stringify(book.chapters.map(chapter => chapter.title))}`)

  return `head ${HEAD.length} chars | demoted ${run.report.stats.demotedHeadings} | `
    + `chapters ${run.report.stats.chapters} | nav has head=${nav.includes('费尔干纳盆地')}`
}

/* ------------------------------------------------------------------ *
 * page-local running-head scenarios
 *
 * The demotion above used to compare a chapter-level heading against every
 * `header` in the book. On 《巴布尔回忆录》 that deleted real chapters: the running
 * head of a continuation page and the centred title of the chapter's first page are
 * the same text, and the first page of a chapter prints no running head. These
 * three scenarios pin the page-local rule that replaced it - the defect it catches,
 * the real chapter title it must not catch, and the repeated index heading the
 * removed book-wide dedup used to eat.
 * ------------------------------------------------------------------ */

/**
 * (ar) 章首页的真标题不被误杀.
 *
 * The regression this whole page-local rule exists for. 《巴布尔回忆录》 prints
 * 「回历九〇X年(公元 …)的事件」 as the running head of every continuation page and
 * centres that same line as the chapter title on the chapter's first page, where no
 * running head is printed. A book-wide set of `header` keys therefore matched every
 * year chapter title: of the 9 year-heading `h1`s in the first 190 cached pages, 8
 * were demoted and the book came out with 2 chapters instead of a dozen.
 *
 * Page 1 is the chapter's first page - the title as `h1`, no `header` on that page.
 * Page 2 prints the identical text as its `header` and carries no heading. Nothing
 * may be demoted: the title has to open a real chapter, `demotedHeadings` has to be
 * exactly 0, and the page-2 running head stays furniture (the title text therefore
 * appears in the book exactly once, as the chapter heading).
 */
async function scenarioChapterTitleSurvivesRunningHead() {
  const file = await headerPagesPdf()
  const outDir = path.join(E2E_DIR, 'chapter-title-vs-running-head')
  // One printed line, used by the real book in both roles.
  const YEAR = '回历九〇八年(公元 1503 年 6 月 26 日 至公元 1504 年 6 月 15 日)的事件'
  const host = createFakeHost({
    blocksByPage: {
      1: [
        // The chapter's first page: a centred title and no running head.
        { type: 'h1', text: YEAR },
        { type: 'p', text: '年章正文一，本年开始。' },
      ],
      2: [
        // A continuation page: the same line as furniture, no heading.
        { type: 'header', text: YEAR },
        { type: 'p', text: '年章正文二，继续叙述。' },
      ],
      3: [{ type: 'p', text: '年章正文三，本年结束。' }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  const entries = unzip(await readFile(run.epubPath))
  const body = allChapterText(entries)
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])

  expect('(ar) 章首页的真标题不被降级（demotedHeadings === 0）', run.report.stats.demotedHeadings, 0,
    { detail: `demotedHeadings = ${run.report.stats.demotedHeadings}`, cause: RUNNING_HEAD_CAUSE })
  expect('(ar) 这一年的事件真的开了一个章（chapters === 1）', run.report.stats.chapters, 1,
    { detail: show(book.chapters.map(chapter => chapter.title)), cause: RUNNING_HEAD_CAUSE })
  expect('(ar) 章标题就是这一年的事件', book.chapters[0]?.title, YEAR, { cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ar) nav 里有这一章', nav.includes('回历九〇八年'),
    { detail: shorten(nav), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(ar) 三页正文都在这一章里',
    body.includes('年章正文一') && body.includes('年章正文二') && body.includes('年章正文三'),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })
  // The chapter title is rendered twice in every document - once in the head's
  // `<title>` and once as the chapter heading - so the head is stripped first.
  // Exactly one occurrence in the body proves the page-2 running head did not
  // sneak in as a second copy of the line.
  const chapterBody = body.replace(/<head>[\s\S]*?<\/head>/g, '')
  const titleOccurrences = chapterBody.split(YEAR).length - 1
  expect('(ar) 正文里该行只出现一次（第 2 页书眉是家具）', titleOccurrences, 1,
    { detail: shorten(chapterBody), cause: RUNNING_HEAD_CAUSE })

  note(`(ar) chapters=${run.report.stats.chapters} titles=${JSON.stringify(book.chapters.map(chapter => chapter.title))} `
    + `demotedHeadings=${run.report.stats.demotedHeadings} titleOccurrences=${titleOccurrences}`)

  return `demoted ${run.report.stats.demotedHeadings} | chapters ${run.report.stats.chapters} | `
    + `title kept=${book.chapters[0]?.title === YEAR} | occurrences ${titleOccurrences}`
}

/**
 * (as) 同页书眉+标题仍被降级.
 *
 * The other half of the page-local rule, and the page-537 shape judged the way the
 * rule now judges it: the model reported the running head twice on ONE page - once
 * as `header` (correct) and once as `h1` (furniture misclassified as a title). Same
 * page plus same key is exactly what may be demoted, so the heading disappears,
 * counts in `demotedHeadings`, and never opens a chapter or a navigation entry. This
 * is the assertion that stops the fix from swinging too far towards leniency.
 */
async function scenarioSamePageRunningHeadDemoted() {
  const file = await headerPagesPdf()
  const outDir = path.join(E2E_DIR, 'running-head-same-page')
  const HEAD = '回历九三二年(公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日)的事件'
  const host = createFakeHost({
    blocksByPage: {
      1: [
        // One page, two reports of the same printed line.
        { type: 'header', text: HEAD },
        { type: 'h1', text: HEAD },
        { type: 'p', text: '同页正文一。' },
      ],
      2: [{ type: 'p', text: '同页正文二。' }],
      3: [{ type: 'p', text: '同页正文三。' }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  const entries = unzip(await readFile(run.epubPath))
  const body = allChapterText(entries)
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])

  expect('(as) 同页误判的 h1 被降级（demotedHeadings === 1）', run.report.stats.demotedHeadings, 1,
    { detail: `demotedHeadings = ${run.report.stats.demotedHeadings}`, cause: RUNNING_HEAD_CAUSE })
  expect('(as) 书眉没有开章（只剩隐含的第一章）', run.report.stats.chapters, 1,
    { detail: show(book.chapters.map(chapter => chapter.title)), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(as) 没有任何章标题是这本书眉',
    !book.chapters.some(chapter => String(chapter.title ?? '').includes('回历九三二年')),
    { detail: show(book.chapters.map(chapter => chapter.title)), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(as) nav 里没有书眉条目', !nav.includes('回历九三二年'),
    { detail: shorten(nav), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(as) 书眉文本没有进正文', !body.includes(HEAD),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(as) 三页正文都还在书里',
    body.includes('同页正文一') && body.includes('同页正文二') && body.includes('同页正文三'),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })

  note(`(as) demotedHeadings=${run.report.stats.demotedHeadings} chapters=${run.report.stats.chapters} `
    + `nav has head=${nav.includes('回历九三二年')}`)

  return `demoted ${run.report.stats.demotedHeadings} | chapters ${run.report.stats.chapters} | `
    + `nav has head=${nav.includes('回历九三二年')}`
}

/**
 * (at) 重复的索引小节标题不被全书去重.
 *
 * 「人 名」 is an index section title: it belongs to EVERY chapter's index, so it
 * repeats verbatim by design. The removed book-wide dedup rule ("keep only the first
 * occurrence of an identical chapter-level title") ate the heading of every index
 * after the first, which is why it is gone rather than merely narrowed. Both
 * occurrences must keep their heading here, each opening its own chapter and each
 * carrying its own index paragraph - a chapter that lost its title would fold into
 * the previous chapter and the two indexes would read as one.
 */
async function scenarioRepeatedIndexHeadingKept() {
  const file = await fourPagePdf()
  const outDir = path.join(E2E_DIR, 'repeated-index-heading')
  const host = createFakeHost({
    blocksByPage: {
      1: [{ type: 'h1', text: '第一章 甲' }, { type: 'p', text: '甲章正文。' }],
      2: [{ type: 'h2', text: '人 名' }, { type: 'p', text: '甲章人名索引。' }],
      3: [{ type: 'h1', text: '第二章 乙' }, { type: 'p', text: '乙章正文。' }],
      4: [{ type: 'h2', text: '人 名' }, { type: 'p', text: '乙章人名索引。' }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  const titles = book.chapters.map(chapter => chapter.title)
  expect('(at) 两个索引小节各开一章', run.report.stats.chapters, 4,
    { detail: show(titles), cause: RUNNING_HEAD_CAUSE })
  expect('(at) 章标题按出现顺序（两处「人 名」都在）', titles,
    ['第一章 甲', '人 名', '第二章 乙', '人 名'], { cause: RUNNING_HEAD_CAUSE })
  expect('(at) 「人 名」出现两次', titles.filter(title => title === '人 名').length, 2,
    { detail: show(titles), cause: RUNNING_HEAD_CAUSE })
  expect('(at) 重复的索引标题没有被计入 demotedHeadings', run.report.stats.demotedHeadings, 0,
    { detail: `demotedHeadings = ${run.report.stats.demotedHeadings}`, cause: RUNNING_HEAD_CAUSE })
  expectTrue('(at) 第一个索引小节带着自己的人名索引',
    String(book.chapters[1]?.html ?? '').includes('人 名')
      && String(book.chapters[1]?.html ?? '').includes('甲章人名索引'),
    { detail: shorten(book.chapters[1]?.html ?? ''), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(at) 第二个索引小节也带着自己的人名索引',
    String(book.chapters[3]?.html ?? '').includes('人 名')
      && String(book.chapters[3]?.html ?? '').includes('乙章人名索引'),
    { detail: shorten(book.chapters[3]?.html ?? ''), cause: RUNNING_HEAD_CAUSE })
  const body = allChapterText(unzip(await readFile(run.epubPath)))
  expectTrue('(at) 四段正文都还在书里',
    ['甲章正文', '甲章人名索引', '乙章正文', '乙章人名索引'].every(text => body.includes(text)),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })

  note(`(at) chapters=${run.report.stats.chapters} titles=${JSON.stringify(titles)} `
    + `demotedHeadings=${run.report.stats.demotedHeadings}`)

  return `chapters ${run.report.stats.chapters} | titles ${JSON.stringify(titles)} | `
    + `demoted ${run.report.stats.demotedHeadings}`
}

/**
 * Convert the one-page fixture whose reply is exactly `blocks`, and hand back the
 * first chapter document.
 *
 * The leaf-mark scenarios need several one-page conversions that differ only in
 * the blocks the fake model answers with, so the scaffolding lives here instead of
 * being repeated five times.
 *
 * @param {string} name - artifact directory under `.out/e2e/`.
 * @param {object[]} blocks - the blocks the fake model answers page 1 with.
 * @returns {Promise<string>} the `OEBPS/text/ch001.xhtml` document.
 */
async function renderOneBlockPage(name, blocks) {
  const host = createFakeHost({ blocksByPage: { 1: blocks } })
  const run = await pipeline.runConversion({
    host,
    spec: { input: SHORT_PDF, outputDir: path.join(E2E_DIR, name) },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)
  return strFromU8(unzip(await readFile(run.epubPath))['OEBPS/text/ch001.xhtml'])
}

/**
 * (an) 行内叶码被清除.
 *
 * Page 90 of the pilot book prints `58` in the middle of the outer margin - that
 * is the `page-number` block - while the running text carries the LEAF MARK of
 * the same margin: `即准备战斗，35a 开向米儿咱的部队`. The leaf mark is a different
 * token from the page number, so the equality rule of scenario (y) can never
 * reach it; the shape rule has to, and the deletion has to be seam-free: the
 * space that only existed to keep the mark apart goes with it, so the sentence
 * reads `即准备战斗，开向` - never `， 开向` and never two spaces.
 */
async function scenarioInlineLeafMark() {
  const page = await renderOneBlockPage('leaf-inline', [
    {
      type: 'p',
      text: '他在路上停了一夜，即准备战斗，35a 开向米儿咱的部队。'
        + '呼罗珊方面的人虽不说有两倍，但比其多一半是没有问题的。',
    },
    {
      type: 'p',
      text: '穆希布·阿利·库尔奇亦领精锐部队至珂咄罗河河岸，9b 与巴迪翰思咱蛮的人遭遇，'
        + '22a 斩首数级而去。',
    },
    { type: 'page-number', text: '58' },
  ])

  expectTrue('(an) 逗号后的行内叶码 35a 被删掉', !page.includes('35a'),
    { detail: shorten(page), cause: LEAF_CAUSE })
  expectTrue('(an) 句子只剩原文，标点自然衔接（战斗，开向）',
    page.includes('即准备战斗，开向米儿咱的部队。'),
    { detail: shorten(page), cause: LEAF_CAUSE })
  expectTrue('(an) 另一个叶码 9b 也被删掉', !page.includes('9b') && page.includes('河岸，与巴迪翰思咱蛮'),
    { detail: shorten(page), cause: LEAF_CAUSE })
  expectTrue('(an) 22a 也被删掉，且不留「， 开」这种空档',
    !page.includes('22a') && page.includes('遭遇，斩首数级而去。'),
    { detail: shorten(page), cause: LEAF_CAUSE })
  expectTrue('(an) 段落里没有留下双空格',
    !/<p>[^<]*[ \t]{2,}[^<]*<\/p>/.test(page) && !page.includes('， '),
    { detail: shorten(page), cause: LEAF_CAUSE })

  note(`(an) 35a/9b/22a kept=${JSON.stringify(['35a', '9b', '22a'].filter(token => page.includes(token)))} `
    + `| 页码块 58 未进正文=${!page.includes('58')}`)

  return `35a removed=${!page.includes('35a')} | 9b removed=${!page.includes('9b')} | `
    + `22a removed=${!page.includes('22a')} | 双空格=${/<p>[^<]*[ \t]{2,}[^<]*<\/p>/.test(page)}`
}

/**
 * (ao) 不该删的不删.
 *
 * The leaf rule is a shape rule, so every guard it has is a chance to delete book
 * text instead of a margin mark. Six shapes are pinned here, one conversion each:
 *
 *   - print in another script - `in 1994a study` - keeps its token, because after
 *     skipping the spaces neither neighbour is CJK (guard 3);
 *   - a bare number is outside the shape entirely: `1494` and `公元 1525 年` stay
 *     (guard 1);
 *   - `124b` is inside the shape (four digits) and is deleted, which is the point
 *     of the guard being a shape and not a digit count;
 *   - a token glued to a CHINESE character used to be protected and no longer is:
 *     V3 relaxed guard 2 to "only a Latin letter or a digit glues it to a longer
 *     word", because that is exactly how page 90 prints its mark (`领精35b
 *     锐部队`). The guard still has a refusing face, and the control run right
 *     after the glued one pins it: `x124b`, `35ab` and `２35a` (a full-width digit
 *     is a digit too - the book renders it as `235a`) stay;
 *   - a page WITHOUT a `page-number` block used to keep its `35a` because of the
 *     page gate (guard 5). CHANGED WITH TIER H: the gate is gone, measured against
 *     495 real pages where it hid two genuine leaf marks (page 221) and kept no
 *     real text, so the same `35a` is now deleted on that page too, and this
 *     assertion pins the deletion with the reason. Nothing else about the page
 *     changes: it is the guard-3-and-4 pair that keeps prose safe, not the gate.
 */
async function scenarioLeafMarkGuards() {
  const withoutPageNumber = await renderOneBlockPage('leaf-no-page-number', [
    { type: 'p', text: '他在路上停了一夜，即准备战斗，35a 开向米儿咱的部队。' },
  ])
  // CHANGED WITH TIER H: the page gate is gone, so this page's leaf mark is now
  // deleted like any other. See the scenario comment.
  expectTrue('(ao) 本页没有 page-number 块时 35a 也按形状规则删掉',
    !withoutPageNumber.includes('35a') && withoutPageNumber.includes('即准备战斗，开向米儿咱的部队。'),
    { detail: shorten(withoutPageNumber), cause: LEAF_CAUSE })

  const english = await renderOneBlockPage('leaf-english', [
    { type: 'p', text: 'This was noted in 1994a study of the region and accepted.' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(ao) 英文正文里两侧无 CJK 的 1994a 保留', english.includes('in 1994a study'),
    { detail: shorten(english), cause: LEAF_CAUSE })

  const numbers = await renderOneBlockPage('leaf-numbers', [
    { type: 'p', text: '回历八九九年(1493—1494)的事件，公元 1525 年时他又来过这里。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(ao) 纯数字 1494 保留（不在形状内）', numbers.includes('1494'),
    { detail: shorten(numbers), cause: LEAF_CAUSE })
  expectTrue('(ao) 公元 1525 年 保留', numbers.includes('公元 1525 年'),
    { detail: shorten(numbers), cause: LEAF_CAUSE })

  const fourDigits = await renderOneBlockPage('leaf-four-digits', [
    { type: 'p', text: '他在路上停了一夜，即准备战斗，124b 开向米儿咱的部队。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(ao) 四位数叶码 124b 属于形状内，同样被删掉',
    !fourDigits.includes('124b') && fourDigits.includes('即准备战斗，开向米儿咱的部队。'),
    { detail: shorten(fourDigits), cause: LEAF_CAUSE })

  const glued = await renderOneBlockPage('leaf-glued', [
    { type: 'p', text: '穆希布·阿利·库尔奇亦领精35b 锐部队至珂咄罗河河岸。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(ao) 紧贴汉字的 35b 仍是叶码（条件 2 放宽），删掉后句子接得上',
    !glued.includes('35b') && glued.includes('领精锐部队至珂咄罗河河岸'),
    { detail: shorten(glued), cause: LEAF_CAUSE })

  const gluedLatin = await renderOneBlockPage('leaf-glued-latin', [
    { type: 'p', text: '这一批的编号写作 x124b，另一位写作 35ab，第三位写作２35a，三个都不能动。' },
    { type: 'page-number', text: '58' },
  ])
  // `２` is folded to `2` by the renderer's punctuation pass, so the book carries
  // `235a`; the digit survives whole, which is what guard 2 is protecting.
  expectTrue('(ao) 紧贴拉丁字母或数字（含全角数字）的 token 不算叶码（条件 2 的拒绝面）',
    gluedLatin.includes('x124b') && gluedLatin.includes('35ab') && gluedLatin.includes('235a'),
    { detail: shorten(gluedLatin), cause: LEAF_CAUSE })

  note(`(ao) 无页码块删掉 35a=${!withoutPageNumber.includes('35a')} `
    + `| 英文 1994a 保留=${english.includes('1994a')} `
    + `| 1494/1525 保留=${numbers.includes('1494') && numbers.includes('1525')} `
    + `| 124b 删除=${!fourDigits.includes('124b')} | 紧贴汉字的 35b 删除=${!glued.includes('35b')} `
    + `| 紧贴拉丁/全角数字的 x124b/35ab/２35a 保留=${gluedLatin.includes('x124b') && gluedLatin.includes('35ab') && gluedLatin.includes('235a')}`)

  return `guards: no page-number removes 35a=${!withoutPageNumber.includes('35a')} | `
    + `1994a kept=${english.includes('1994a')} | 1494 kept=${numbers.includes('1494')} | `
    + `124b removed=${!fourDigits.includes('124b')} | glued 35b removed=${!glued.includes('35b')} | `
    + `latin/fullwidth-digit glued kept=${gluedLatin.includes('x124b') && gluedLatin.includes('35ab') && gluedLatin.includes('235a')}`
}

/**
 * (ap) 真实引用不被误删.
 *
 * The citation guard, pinned on the three shapes the real page cache of
 * 《巴布尔回忆录》 produced in its first 95 pages. Every one of them was a
 * cross-page reference, and the first version of the leaf rule deleted all three:
 *
 *   - `（见 f. 376b）` (page 16) - the number follows `f.` inside a bracket;
 *   - `（f. 49a）` (page 28) - the same abbreviation with no verb in front;
 *   - `见本书编叶 179b。` (page 95) - the marker is the Chinese character 叶.
 *
 * None of them is protected by the other guards: each is also shape-valid,
 * standalone and CJK-adjacent, so the citation guard is the only thing standing
 * between the reference and the scissors. The rest of the scenario pins the
 * keepers that need no citation to survive - an English sentence (`in 1994a
 * study`), and a bare year (`公历 1493—1494`, `公元 1525 年`).
 *
 * TWO TIER-H ADDITIONS, both from the real 495-page cache:
 *
 *   - `① 参看本书 171a 注。` (page 318) - the only misdeletion the earlier guard
 *     produced. Its reference word is 参看/本书, which the marker list did not
 *     carry, so a real reference was cut. The marker list now has both words, and
 *     this token has to stay;
 *   - `…我们到达那里后，101a 在图拉克花园扎营。` (page 185) - the reverse error: a
 *     comma between the positional `后` and the number used to be skipped, so a
 *     genuine leaf mark (the model even noted 「101a 为原书叶码」) was read as a
 *     reference and kept. The comma is now stripped only for the STRONG markers,
 *     and this leaf mark is deleted.
 *
 * The last case used to pin the page gate: a page without a `page-number` block
 * kept its `35a`. Tier H removed that gate (see (ao)), so the assertion now pins
 * the deletion on the same page, and the citation guard is unchanged by it.
 */
async function scenarioRealCitationsKept() {
  const page16 = await renderOneBlockPage('leaf-citation-f', [
    { type: 'p', text: '巴布尔的手稿可能在事变中损失（见 f. 376b），以后他没有再提到它。' },
    { type: 'page-number', text: '10' },
  ])
  expectTrue('(ap) 「（见 f. 376b）」是跨页引用，376b 保留', page16.includes('（见 f. 376b）'),
    { detail: shorten(page16), cause: LEAF_CAUSE })

  const page28 = await renderOneBlockPage('leaf-citation-bare-f', [
    { type: 'p', text: '这一点在译注里说得更清楚（f. 49a），此处不再重复。' },
    { type: 'page-number', text: '34' },
  ])
  expectTrue('(ap) 「（f. 49a）」是跨页引用，49a 保留', page28.includes('（f. 49a）'),
    { detail: shorten(page28), cause: LEAF_CAUSE })

  const page95 = await renderOneBlockPage('leaf-citation-ye', [
    { type: 'p', text: '这一段战事的记载见本书编叶 179b。' },
    { type: 'page-number', text: '95' },
  ])
  expectTrue('(ap) 「见本书编叶 179b。」里的 179b 保留', page95.includes('编叶 179b。'),
    { detail: shorten(page95), cause: LEAF_CAUSE })

  // Tier H: 参看 / 本书 are reference words, so this token must survive.
  const page318 = await renderOneBlockPage('leaf-citation-cankanshu', [
    { type: 'p', text: '① 参看本书 171a 注。' },
    { type: 'page-number', text: '318' },
  ])
  expectTrue('(ap) 「参看本书 171a 注。」是引证，171a 保留', page318.includes('参看本书 171a 注'),
    { detail: shorten(page318), cause: LEAF_CAUSE })

  // Tier H: a comma is only read across for the STRONG markers, so `后，101a` is a
  // leaf mark behind a sentence comma and not the positional reference `后 101a`.
  const page185 = await renderOneBlockPage('leaf-citation-comma-weak', [
    { type: 'p', text: '我们到达那里后，101a 在图拉克花园扎营。' },
    { type: 'page-number', text: '185' },
  ])
  expectTrue('(ap) 「到达那里后，101a」不是引证，101a 删掉',
    !page185.includes('101a') && page185.includes('到达那里后，在图拉克花园扎营'),
    { detail: shorten(page185), cause: LEAF_CAUSE })

  const english = await renderOneBlockPage('leaf-citation-english', [
    { type: 'p', text: 'This was noted in 1994a study of the region and accepted.' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(ap) 英文正文里两侧无 CJK 的 1994a 保留', english.includes('in 1994a study'),
    { detail: shorten(english), cause: LEAF_CAUSE })

  const numbers = await renderOneBlockPage('leaf-citation-numbers', [
    { type: 'p', text: '公历 1493—1494 年间，公元 1525 年时他又来过这里。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(ap) 公历 1493—1494 保留（纯数字不在形状内）', numbers.includes('1493—1494'),
    { detail: shorten(numbers), cause: LEAF_CAUSE })
  expectTrue('(ap) 公元 1525 年 保留', numbers.includes('公元 1525 年'),
    { detail: shorten(numbers), cause: LEAF_CAUSE })

  const noPageNumber = await renderOneBlockPage('leaf-citation-gate', [
    { type: 'p', text: '他在路上停了一夜，即准备战斗，35a 开向米儿咱的部队。' },
  ])
  // CHANGED WITH TIER H: the page gate is gone, so this page's leaf mark is
  // deleted like any other. See (ao) and the tier-H note above.
  expectTrue('(ap) 本页没有 page-number 块时 35a 也按形状规则删掉',
    !noPageNumber.includes('35a') && noPageNumber.includes('即准备战斗，开向米儿咱的部队。'),
    { detail: shorten(noPageNumber), cause: LEAF_CAUSE })

  note(`(ap) 376b=${page16.includes('376b')} 49a=${page28.includes('49a')} `
    + `179b=${page95.includes('179b')} 171a=${page318.includes('171a')} `
    + `| 后，101a 删除=${!page185.includes('101a')} `
    + `| 英文 1994a=${english.includes('1994a')} `
    + `| 1493/1525=${numbers.includes('1493') && numbers.includes('1525')} `
    + `| 无页码块删掉 35a=${!noPageNumber.includes('35a')}`)

  return `citations kept: 376b=${page16.includes('376b')} | 49a=${page28.includes('49a')} | `
    + `179b=${page95.includes('179b')} | 171a=${page318.includes('171a')} | `
    + `comma-weak 101a removed=${!page185.includes('101a')} | `
    + `no page-number removes 35a=${!noPageNumber.includes('35a')}`
}

/**
 * (aq) 各种形态的真叶码被删.
 *
 * The other direction of V3: the shapes this book really prints. Each case is its
 * own conversion, and each asserts BOTH that the mark is gone and that the
 * sentence closed over the gap - a rule that deletes and leaves two spaces has
 * replaced one defect with another.
 *
 *   - `山区，4a在`   guard 2 relaxed: the mark is typed straight against a Chinese
 *                    character on both sides, which is how the pilot prints it;
 *   - `曾23a有`      the same shape with no punctuation on either side at all;
 *   - `领精35b锐`    the same, taken from the real page-90 sentence;
 *   - `河 3a 流`     guard 3: the mark is spaced away from both neighbours, so the
 *                    spaces have to be skipped to see the Chinese context - and
 *                    they are eaten with the mark when it goes;
 *   - `即准备战斗,35a 开向` the HALF-WIDTH comma case (page 90 of the real cache).
 *                    `stripFoliage` runs before `normalizePunctuation`, so the flat
 *                    text is `,开向` and only the renderer turns the comma into
 *                    `，`; the end-to-end assertion therefore checks the book's
 *                    `，开向`, and the direct `stripFoliage` assertion checks the
 *                    rule's own `,开向`. Without the second one a rule that
 *                    deleted the token but kept the space would still pass.
 *                    Two more assertions isolate the widening itself: a token at
 *                    the END of the block, whose only Chinese context is the `,`
 *                    behind it (`…即准备战斗,35a`) is still deleted, while the
 *                    same comma in a Latin line (`in 1994a, 35a`) does not make
 *                    the line Chinese and the token stays.
 *   - `…不要尊敬。22a 他管治` the shape the pilot's page 69 printed;
 *   - `赛伊德· 184b` (page 325) and `什么也不要放过。” 197b` (page 345) - the two
 *                    marks whose Chinese neighbour is the book's middot `·`
 *                    (U+00B7) and a curly closing quote `”` (U+201D). Tier H added
 *                    both to the CJK-neighbour set after the measurement showed
 *                    they were the only neighbour characters hiding real leaf
 *                    marks; the citation guard still runs behind them, so
 *                    `（见 f. 200b）”` stays a reference.
 */
async function scenarioLeafMarkShapesDeleted() {
  const commaGlued = await renderOneBlockPage('leaf-shape-cjk-comma', [
    { type: 'p', text: '由此进入山区，4a在那一带停了下来。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(aq) 「山区，4a在」删成「山区，在」',
    !commaGlued.includes('4a') && commaGlued.includes('山区，在那一带'),
    { detail: shorten(commaGlued), cause: LEAF_CAUSE })

  const charGlued = await renderOneBlockPage('leaf-shape-cjk-both', [
    { type: 'p', text: '据记载曾23a有大批人随后到来。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(aq) 「曾23a有」删成「曾有」',
    !charGlued.includes('23a') && charGlued.includes('曾有大批人'),
    { detail: shorten(charGlued), cause: LEAF_CAUSE })

  const realGlued = await renderOneBlockPage('leaf-shape-cjk-real', [
    { type: 'p', text: '穆希布亦领精35b锐部队至珂咄罗河河岸。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(aq) 「领精35b锐」删成「领精锐」',
    !realGlued.includes('35b') && realGlued.includes('领精锐部队'),
    { detail: shorten(realGlued), cause: LEAF_CAUSE })

  const spaced = await renderOneBlockPage('leaf-shape-spaced', [
    { type: 'p', text: '大军沿着珂咄罗河 3a 流而下，抵达谷口。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(aq) 「河 3a 流」两侧空格一起删成「河流」',
    !spaced.includes('3a') && spaced.includes('珂咄罗河流而下'),
    { detail: shorten(spaced), cause: LEAF_CAUSE })

  const halfWidth = await renderOneBlockPage('leaf-shape-halfwidth', [
    { type: 'p', text: '他在路上停了一夜，即准备战斗,35a 开向米儿咱的部队。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(aq) 半角逗号后的 35a 被删掉，书里读作「战斗，开向」',
    !halfWidth.includes('35a') && halfWidth.includes('即准备战斗，开向米儿咱的部队。'),
    { detail: shorten(halfWidth), cause: LEAF_CAUSE })
  // The flat text the rule itself produced, before the renderer re-typesets the
  // comma: no gap may be left behind (`战斗, 开向`), and the half-width comma has
  // to stay exactly what it is at this stage.
  const flatHalfWidth = stripFoliage('他在路上停了一夜，即准备战斗,35a 开向米儿咱的部队。', ['58'])
  expect('(aq) stripFoliage 输出「战斗,开向」（半角逗号原样、无空格）', flatHalfWidth,
    '他在路上停了一夜，即准备战斗,开向米儿咱的部队。', { cause: LEAF_CAUSE })

  // Guard 3's half-width widening, isolated. The right side of the token is the
  // END of the block here, so the only Chinese context is the character behind the
  // half-width `,` - a rule that judges the comma as typed would keep this mark.
  const halfWidthTail = await renderOneBlockPage('leaf-shape-halfwidth-tail', [
    { type: 'p', text: '他在路上停了一夜，即准备战斗,35a' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(aq) 半角逗号后、块尾的 35a 也删（逗号按中文上下文判）',
    !halfWidthTail.includes('35a') && halfWidthTail.includes('即准备战斗'),
    { detail: shorten(halfWidthTail), cause: LEAF_CAUSE })
  expect('(aq) 块尾这一例的 flat 输出只剩半角逗号，不留空格',
    stripFoliage('他在路上停了一夜，即准备战斗,35a', ['58']),
    '他在路上停了一夜，即准备战斗,', { cause: LEAF_CAUSE })

  // The other face of the same widening: a half-width comma in a LATIN line must
  // not turn the line Chinese, or the guard would open the rule to `in 1994a, 35a`.
  expect('(aq) 拉丁文行里的半角逗号不构成 CJK 上下文，35a 保留',
    stripFoliage('in 1994a, 35a', ['58']), 'in 1994a, 35a', { cause: LEAF_CAUSE })

  const fullStop = await renderOneBlockPage('leaf-shape-fullstop', [
    { type: 'p', text: '他的部下却对他绝不尊敬。22a 他管治布哈拉，直到那年冬天。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(aq) 「尊敬。22a 他管治」删成「尊敬。他管治」',
    !fullStop.includes('22a') && fullStop.includes('尊敬。他管治布哈拉'),
    { detail: shorten(fullStop), cause: LEAF_CAUSE })

  // Tier H widened the CJK-neighbour set with the book's middot and curly quotes:
  // a name separator or a closing quote is where this book's line-end leaf mark
  // stands (pages 325 and 345 of the real cache).
  const middot = await renderOneBlockPage('leaf-shape-middot', [
    { type: 'p', text: '那里,我们接到曾被派往呼罗珊的赛伊德· 184b' },
    { type: 'page-number', text: '325' },
  ])
  expectTrue('(aq) 名字间隔号后的 184b 也被删掉',
    !middot.includes('184b') && middot.includes('赛伊德·'),
    { detail: shorten(middot), cause: LEAF_CAUSE })

  const curlyQuote = await renderOneBlockPage('leaf-shape-curly-quote', [
    { type: 'p', text: '，并尽你们所能地干，什么也不要放过。” 197b' },
    { type: 'page-number', text: '345' },
  ])
  expectTrue('(aq) 弯引号后的 197b 也被删掉',
    !curlyQuote.includes('197b') && curlyQuote.includes('什么也不要放过。”'),
    { detail: shorten(curlyQuote), cause: LEAF_CAUSE })

  for (const [label, html] of [['comma', commaGlued], ['both', charGlued], ['real', realGlued],
    ['spaced', spaced], ['halfwidth', halfWidth], ['halfwidth-tail', halfWidthTail],
    ['fullstop', fullStop], ['middot', middot], ['curly-quote', curlyQuote]]) {
    expectTrue(`(aq) ${label} 的结果不留双空格 / 「， 」空档`,
      !/<p>[^<]*[ \t]{2,}[^<]*<\/p>/.test(html) && !html.includes('， '),
      { detail: shorten(html), cause: LEAF_CAUSE })
  }

  note(`(aq) 5 种形态 + 半角逗号 + 半角逗号块尾 + · / ” 邻字符：4a/23a/35b/3a/35a/22a/184b/197b `
    + `残留=${JSON.stringify(['4a', '23a', '35b', '3a', '35a', '22a', '184b', '197b']
      .filter(token => [commaGlued, charGlued, realGlued, spaced, halfWidth, halfWidthTail, fullStop,
        middot, curlyQuote]
        .some(html => html.includes(token))))}`
    + ` | 拉丁行 35a 保留=${stripFoliage('in 1994a, 35a', ['58']).includes('35a')}`)

  return `shapes removed: 山区，4a在=${!commaGlued.includes('4a')} | 曾23a有=${!charGlued.includes('23a')} | `
    + `领精35b锐=${!realGlued.includes('35b')} | 河 3a 流=${!spaced.includes('3a')} | `
    + `,35a=${!halfWidth.includes('35a')} | 块尾,35a=${!halfWidthTail.includes('35a')} | `
    + `22a=${!fullStop.includes('22a')} | ·184b=${!middot.includes('184b')} | `
    + `”197b=${!curlyQuote.includes('197b')}`
}

/**
 * (au) 被页码块切断的段落重新接上.
 *
 * Batch 4 of the pilot book (pages 286–380) turned up 17 places where a page
 * number or a leaf mark sat BETWEEN the two halves of one sentence: the model
 * answered one page as `…胡马雍在喀布尔的要塞里出`, the margin leaf mark `215b` as
 * its own `page-number` block, and `生。诗人大毛拉…` (page 375). `flattenPages`
 * drops the furniture, and the two `p` blocks then reached the book as two
 * paragraphs - `…要塞里出` and `生。…` - so 出生 was split and the sentence visibly
 * broke. The old join only knew page breaks, which is why it never fired here:
 * both blocks are on the SAME page.
 *
 * `joinsAcrossFurniture` re-sews exactly that pair: both kept blocks are `p`,
 * nothing but dropped `page-number` / `footer` / `header` sits between them, the
 * pages touch, and the first half did NOT end a sentence. The join reuses
 * `smartJoin` (CJK pairs get no space, so `出` + `生` is 出生, never `出 生`) and
 * counts in `joined`.
 *
 * Three controls pin the boundaries: a CLOSED first paragraph (`第一段结束。`) is a
 * real paragraph boundary and stays two; so is a heading between the halves; so is
 * a table. The heading / table controls are the "a retained block sits between"
 * face of the rule, not the sentence-end face.
 */
async function scenarioSplitParagraphRejoined() {
  const run = async (name, blocks) => {
    const host = createFakeHost({ blocksByPage: { 1: blocks } })
    const conversion = await pipeline.runConversion({
      host,
      spec: { input: SHORT_PDF, outputDir: path.join(E2E_DIR, name) },
      config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
    })
    state.epubs.push(conversion.epubPath)
    return {
      report: conversion.report,
      html: strFromU8(unzip(await readFile(conversion.epubPath))['OEBPS/text/ch001.xhtml']),
    }
  }

  const split = await run('rejoin-page-number', [
    { type: 'p', text: '是年年末,太阳在双鱼星座的时分,胡马雍在喀布尔的要塞里出' },
    { type: 'page-number', text: '215b' },
    { type: 'p', text: '生。诗人大毛拉·赛伊迪以“速檀·胡马雍·汗”数字来表示其出生的时间。' },
  ])
  expect('(au) 被页码块切开的一段计入 blocksJoined', split.report.stats.blocksJoined, 1,
    { cause: SPLIT_JOIN_CAUSE })
  expect('(au) 成品里只剩一个 <p>', countOf(split.html, '<p>'), 1,
    { detail: shorten(split.html), cause: SPLIT_JOIN_CAUSE })
  expectTrue('(au) 两半接成一句，出与生之间没有空格',
    split.html.includes('胡马雍在喀布尔的要塞里出生。诗人大毛拉·赛伊迪'),
    { detail: shorten(split.html), cause: SPLIT_JOIN_CAUSE })
  expectTrue('(au) 叶码 215b 没有跟着进正文', !split.html.includes('215b'),
    { detail: shorten(split.html), cause: SPLIT_JOIN_CAUSE })

  // The same split usually arrives WITH `continues: true` - the model reports the
  // flag it learned for page breaks, while the two halves are on one page. Batch 4
  // produced exactly this shape on pages 316, 322 and 351, and the flag must not
  // cost the join it is describing.
  const flagged = await run('rejoin-continues-flag', [
    { type: 'p', text: '是年年末,太阳在双鱼星座的时分,胡马雍在喀布尔的要塞里出' },
    { type: 'page-number', text: '215b' },
    { type: 'p', text: '生。诗人大毛拉·赛伊迪以“速檀·胡马雍·汗”数字来表示其出生的时间。', continues: true },
  ])
  expect('(au) continues: true 的同页切断也计入 blocksJoined', flagged.report.stats.blocksJoined, 1,
    { cause: SPLIT_JOIN_CAUSE })
  expect('(au) continues: true 时成品仍是一个 <p>', countOf(flagged.html, '<p>'), 1,
    { detail: shorten(flagged.html), cause: SPLIT_JOIN_CAUSE })
  expectTrue('(au) continues: true 时出与生也相连', flagged.html.includes('要塞里出生。诗人大毛拉'),
    { detail: shorten(flagged.html), cause: SPLIT_JOIN_CAUSE })

  // CONTROL 1 - a finished sentence is a real paragraph boundary, not a torn line.
  const closed = await run('rejoin-closed', [
    { type: 'p', text: '第一段结束。' },
    { type: 'page-number', text: '215b' },
    { type: 'p', text: '第二段开始' },
  ])
  expect('(au) 前段以句号结尾时不合并', closed.report.stats.blocksJoined, 0,
    { cause: SPLIT_JOIN_CAUSE })
  expect('(au) 句末边界仍是两段', countOf(closed.html, '<p>'), 2,
    { detail: shorten(closed.html), cause: SPLIT_JOIN_CAUSE })
  expectTrue('(au) 两段文本各自完整',
    closed.html.includes('<p>第一段结束。</p>') && closed.html.includes('<p>第二段开始</p>'),
    { detail: shorten(closed.html), cause: SPLIT_JOIN_CAUSE })

  // CONTROL 2 - a heading between the halves is structure, never a gap to close.
  const heading = await run('rejoin-heading-between', [
    { type: 'p', text: '上半句' },
    { type: 'h3', text: '小节标题' },
    { type: 'page-number', text: '215b' },
    { type: 'p', text: '下半句' },
  ])
  expect('(au) 中间隔着标题时不合并', countOf(heading.html, '<p>'), 2,
    { detail: shorten(heading.html), cause: SPLIT_JOIN_CAUSE })
  expectTrue('(au) 标题两侧的段落各自独立', !heading.html.includes('上半句下半句'),
    { detail: shorten(heading.html), cause: SPLIT_JOIN_CAUSE })

  // CONTROL 3 - the same for a table.
  const table = await run('rejoin-table-between', [
    { type: 'p', text: '上半句' },
    { type: 'table', text: '| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |' },
    { type: 'page-number', text: '215b' },
    { type: 'p', text: '下半句' },
  ])
  expect('(au) 中间隔着表格时不合并', countOf(table.html, '<p>'), 2,
    { detail: shorten(table.html), cause: SPLIT_JOIN_CAUSE })
  expectTrue('(au) 表格两侧的段落各自独立', !table.html.includes('上半句下半句'),
    { detail: shorten(table.html), cause: SPLIT_JOIN_CAUSE })

  note(`(au) joined=${split.report.stats.blocksJoined} | 成品 <p> 数=${countOf(split.html, '<p>')} `
    + `| 出生相连=${split.html.includes('要塞里出生')} `
    + `| continues 标记也接上=${countOf(flagged.html, '<p>') === 1} `
    + `| 句末边界 ${countOf(closed.html, '<p>')} 段 | 标题/表格边界 `
    + `${countOf(heading.html, '<p>')}/${countOf(table.html, '<p>')} 段`)

  return `rejoin: one <p>=${countOf(split.html, '<p>') === 1} `
    + `| 出生 joined=${split.html.includes('要塞里出生')} `
    + `| continues:true joined=${countOf(flagged.html, '<p>') === 1} `
    + `| closed stays 2=${countOf(closed.html, '<p>') === 2} `
    + `| heading/table stop=${countOf(heading.html, '<p>') === 2 && countOf(table.html, '<p>') === 2}`
}

/**
 * (av) 日期里的数字不被当页码删.
 *
 * Page 15 of 《巴布尔回忆录》 prints its `page-number` block as `9`, and its last
 * paragraph carries the date `回历九三六年穆哈兰月三日(公元 1529 年 9 月 7 日)原稿中断。`.
 * The equality rule saw `9`, found `9` in `9 月`, and deleted it: the finished
 * book read `公元 1529 年月 7 日` - a month gone, and a malformed date string the
 * reader cannot repair. The month is not the page number, so the POSITION guard
 * refuses a token whose nearest non-blank neighbour is a date unit
 * (`年` `月` `日` `时` `分` `秒` `页` `卷` `章` `节`).
 *
 * Three shapes are pinned, each on its own page so the page number itself can be
 * the number that appears in the date: `9 月` (the real p15 text), `10 月` (the
 * running head of this book: `公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日`),
 * and `2 月 2 日` (both occurrences are the page number of their page). The flat
 * `stripFoliage` output is asserted as well, because the rendered XHTML rewrites
 * punctuation and the dates have to survive the rule itself, not a lucky render.
 *
 * The guard protects PURE NUMBERS only (see scenario (bf)): a token carrying a
 * letter suffix is a leaf mark, not a year or a month, so `回历九一七年 175b` is
 * deleted while everything asserted here keeps every digit.
 */
async function scenarioDateNumbersKept() {
  // Page 15, verbatim, with the page-number block the model really emitted.
  const month9 = await renderOneBlockPage('date-month-9', [
    { type: 'p', text: '回历九三六年穆哈兰月三日(公元 1529 年 9 月 7 日)原稿中断。' },
    { type: 'page-number', text: '9' },
  ])
  expectTrue('(av) p15 的日期完整保留（公元 1529 年 9 月 7 日）',
    month9.includes('公元 1529 年 9 月 7 日'), { detail: shorten(month9), cause: POSITION_CAUSE })
  expectTrue('(av) 没有出现「年月」这种缺了月份数字的畸形串', !month9.includes('年月'),
    { detail: shorten(month9), cause: POSITION_CAUSE })
  expect('(av) stripFoliage 保留 p15 的日期（规则自身的输出）',
    stripFoliage('回历九三六年穆哈兰月三日(公元 1529 年 9 月 7 日)原稿中断。', ['9']),
    '回历九三六年穆哈兰月三日(公元 1529 年 9 月 7 日)原稿中断。', { cause: POSITION_CAUSE })

  // The book's running head: `10` is the page number here, `10 月` is a date.
  const month10 = await renderOneBlockPage('date-month-10', [
    { type: 'p', text: '回历九三二年(公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日)的事件。' },
    { type: 'page-number', text: '10' },
  ])
  expectTrue('(av) 「10 月」两处都完整（10 月 18 日 / 10 月 8 日）',
    month10.includes('公元 1525 年 10 月 18 日') && month10.includes('公元 1526 年 10 月 8 日'),
    { detail: shorten(month10), cause: POSITION_CAUSE })
  expect('(av) stripFoliage 保留两处 10 月',
    stripFoliage('公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日', ['10']),
    '公元 1525 年 10 月 18 日至公元 1526 年 10 月 8 日', { cause: POSITION_CAUSE })

  // `2` is the day number AND the page number, twice in one date.
  const day2 = await renderOneBlockPage('date-day-2', [
    { type: 'p', text: '他是在公元 1528 年 2 月 2 日 抵达那里的。' },
    { type: 'page-number', text: '2' },
  ])
  expectTrue('(av) 「2 月 2 日」完整保留',
    day2.includes('1528 年 2 月 2 日'), { detail: shorten(day2), cause: POSITION_CAUSE })
  expectTrue('(av) 没有留下「月 日」这种缺数字的畸形串', !/月\s+日/.test(day2),
    { detail: shorten(day2), cause: POSITION_CAUSE })
  expect('(av) stripFoliage 保留 2 月 2 日',
    stripFoliage('他是在公元 1528 年 2 月 2 日 抵达那里的。', ['2']),
    '他是在公元 1528 年 2 月 2 日 抵达那里的。', { cause: POSITION_CAUSE })

  note(`(av) p15 日期保留=${month9.includes('公元 1529 年 9 月 7 日')} `
    + `| 「年月」出现=${month9.includes('年月')} `
    + `| 10 月 x2=${month10.includes('公元 1525 年 10 月 18 日') && month10.includes('公元 1526 年 10 月 8 日')} `
    + `| 2 月 2 日=${day2.includes('1528 年 2 月 2 日')}`)

  return `dates kept: p15=${month9.includes('公元 1529 年 9 月 7 日')} | `
    + `10月=${month10.includes('公元 1525 年 10 月 18 日') && month10.includes('公元 1526 年 10 月 8 日')} | `
    + `2月2日=${day2.includes('1528 年 2 月 2 日')}`
}

/**
 * (aw) 索引定位符不被删.
 *
 * The last 64 pages of 《巴布尔回忆录》 are the index, and every entry ends with
 * the printed leaf/foot reference of the name: `马利克·阿力·库特比,217b`,
 * `阿布都勒·库杜斯,23a,38b`. A locator has exactly the leaf-mark shape
 * (`\d{1,4}[ab]`), so the shape rule deleted them - 1650 of them across the real
 * cache, leaving 878 entries without a single page reference. The model also
 * mis-reports a locator as the page's `page-number` block on some pages, and then
 * the equality rule deletes it too; both rules need the same refusal.
 *
 * The page below models the worse case: the page-number block itself holds `217b`.
 * The two entries must come out textually intact, and the flat rule output must be
 * byte-identical (the rendered book re-typesets the half-width comma to `，`, so
 * the rule-level assertion is the one that shows nothing was deleted).
 */
async function scenarioIndexLocatorsKept() {
  const index = await renderOneBlockPage('index-locators', [
    { type: 'p', text: '马利克·阿力·库特比,217b' },
    { type: 'p', text: '阿布都勒·库杜斯,23a,38b' },
    { type: 'page-number', text: '217b' },
  ])
  expectTrue('(aw) 条目一「马利克·阿力·库特比,217b」原样保留',
    /马利克·阿力·库特比[,，]217b/.test(index), { detail: shorten(index), cause: POSITION_CAUSE })
  expectTrue('(aw) 条目二「阿布都勒·库杜斯,23a,38b」原样保留',
    /阿布都勒·库杜斯[,，]23a[,，]38b/.test(index), { detail: shorten(index), cause: POSITION_CAUSE })
  expectTrue('(aw) 217b / 23a / 38b 三个定位符都还在',
    ['217b', '23a', '38b'].every(token => index.includes(token)),
    { detail: shorten(index), cause: POSITION_CAUSE })
  expectTrue('(aw) 索引条目没有被删成「名,」这种空定位符',
    !index.includes('库特比，</p>') && !index.includes('库特比,</p>')
    && !index.includes('库杜斯，</p>') && !index.includes('库杜斯,</p>'),
    { detail: shorten(index), cause: POSITION_CAUSE })

  expect('(aw) stripFoliage 对条目一原样返回（page-number 块误标成 217b）',
    stripFoliage('马利克·阿力·库特比,217b', ['217b']), '马利克·阿力·库特比,217b',
    { cause: POSITION_CAUSE })
  expect('(aw) stripFoliage 对条目二原样返回',
    stripFoliage('阿布都勒·库杜斯,23a,38b', ['217b']), '阿布都勒·库杜斯,23a,38b',
    { cause: POSITION_CAUSE })
  // The other face of the same guard: a locator that follows a comma and a space
  // (`尔瓦尼, 294a, 298b`, page 720 of the real index) is still a locator.
  expect('(aw) 索引列表里逗号后带空格的定位符也不删',
    stripFoliage('尔瓦尼, 294a, 298b', ['217b']), '尔瓦尼, 294a, 298b', { cause: POSITION_CAUSE })

  note(`(aw) 条目一=${/马利克·阿力·库特比[,，]217b/.test(index)} `
    + `| 条目二=${/阿布都勒·库杜斯[,，]23a[,，]38b/.test(index)} `
    + `| 定位符残留=${JSON.stringify(['217b', '23a', '38b'].filter(token => index.includes(token)))}`)

  return `index locators kept: 217b=${index.includes('217b')} | 23a=${index.includes('23a')} | `
    + `38b=${index.includes('38b')}`
}

/**
 * (ax) 真正的页边页码仍被删.
 *
 * The other direction of (av) and (aw): the position guards must not stop the rule
 * that exists. A folio printed in the margin is alone at an edge of the block or
 * between two spaces, and it follows no list punctuation - the three shapes this
 * scenario pins:
 *
 *   - `58 这是一段正文`   block start, the folio opens the line;
 *   - `他终于到了那里。58` block end, the folio closes the sentence;
 *   - `他停下来 58 又继续前进` the folio between two spaces, inside the sentence.
 *
 * None of them is a date, an index locator or a list member, so all three are
 * deleted, and the page number `58` must not survive anywhere in the document.
 */
async function scenarioMarginFoliosStillDeleted() {
  const margin = await renderOneBlockPage('folio-margin-still', [
    { type: 'p', text: '58 这是一段正文' },
    { type: 'p', text: '他终于到了那里。58' },
    { type: 'p', text: '然后他停下来 58 又继续前进。' },
    { type: 'page-number', text: '58' },
  ])
  expectTrue('(ax) 块首独立的 58 被删（不留「58 这是…」）',
    margin.includes('<p>这是一段正文</p>'), { detail: shorten(margin), cause: POSITION_CAUSE })
  expectTrue('(ax) 块尾独立的 58 被删（不留「那里。58」）',
    margin.includes('他终于到了那里。') && !margin.includes('那里。58'),
    { detail: shorten(margin), cause: POSITION_CAUSE })
  expectTrue('(ax) 两侧空白的 58 被删（不留双空格）',
    margin.includes('然后他停下来又继续前进。'), { detail: shorten(margin), cause: POSITION_CAUSE })
  expectTrue('(ax) 整篇正文里没有残留的 58', !margin.includes('58'),
    { detail: shorten(margin), cause: POSITION_CAUSE })

  expect('(ax) stripFoliage 删块首 58', stripFoliage('58 这是一段正文', ['58']), '这是一段正文',
    { cause: POSITION_CAUSE })
  expect('(ax) stripFoliage 删块尾 58', stripFoliage('他终于到了那里。58', ['58']), '他终于到了那里。',
    { cause: POSITION_CAUSE })
  expect('(ax) stripFoliage 删两侧空白的 58', stripFoliage('他停下来 58 又继续前进', ['58']),
    '他停下来又继续前进', { cause: POSITION_CAUSE })

  note(`(ax) 块首=${margin.includes('<p>这是一段正文</p>')} `
    + `| 块尾=${!margin.includes('那里。58')} `
    + `| 两侧空白=${margin.includes('然后他停下来又继续前进。')} `
    + `| 残留 58=${margin.includes('58')}`)

  return `margin folios removed: start=${margin.includes('<p>这是一段正文</p>')} | `
    + `end=${!margin.includes('那里。58')} | spaced=${margin.includes('然后他停下来又继续前进。')} | `
    + `58 left=${margin.includes('58')}`
}

/**
 * (ay) 目录条目按章标题校正（段级替换）.
 *
 * The printed contents page of 《巴布尔回忆录》 was transcribed on a page of its own,
 * with no chapter context, and 14 of its entries came out `回忆九〇〇年(1494—1495)的事件`
 * where the chapter is titled `回历九〇〇年(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)的事件`:
 * `忆` is a homophone of `历` and `回忆` is a real word, so nothing local to the entry
 * marks it as wrong. The 90 chapter titles are right, so the renderer corrects the
 * entries against `buildChapters()`'s titles (the `reconcileTocEntries()` pass of
 * `src/model/assemble.js`).
 *
 * The page here is the shape of that entry: an `h1` opens the chapter with the
 * EXPANDED title, and a `toc` block lists the same chapter with the model's `回忆`
 * slip, the printed ABBREVIATED parenthetical and the printed page number 41. The
 * finished entry must be `回历九〇〇年(公元 1494 年)的事件` - the slip replaced, the
 * entry's own parenthetical untouched - and must NOT be the 29-character chapter
 * title: handing the whole title back is the defect this scenario was rewritten for.
 * The list it lands in has 19 neighbours that keep their abbreviation, so an entry
 * that swaps its `(公元 1494 年)` for the chapter's full expansion is visibly out of
 * line with them and no longer says what the page prints.
 */
async function scenarioTocEntryReconciled() {
  const printed = '回忆九〇〇年(公元 1494 年)的事件'
  const chapterTitle = '回历九〇〇年(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)的事件'
  const chapter = await renderOneBlockPage('toc-reconcile', [
    { type: 'h1', text: chapterTitle },
    { type: 'p', text: '这一年巴布尔从费尔干纳出发。' },
    { type: 'toc', text: `${printed} …… 41` },
  ])
  const shown = tocTitleOf(chapter)
  const expected = '<li class="toc-1"><span class="toc-title">回历九〇〇年(公元 1494 年)的事件</span>'
    + '<span class="toc-page">41</span></li>'
  expect('(ay) 只把「忆」换成「历」，其余一字不动', shown, '回历九〇〇年(公元 1494 年)的事件',
    { cause: TOC_RECONCILE_CAUSE })
  expectTrue('(ay) 成品目录里没有变成完整长标题（29 字）',
    shown !== chapterTitle && !chapter.includes(`<span class="toc-title">${chapterTitle}`),
    { detail: shorten(chapter), cause: TOC_RECONCILE_CAUSE })
  expect('(ay) 条目长度与原条目相同', shown.length, printed.length,
    { cause: TOC_RECONCILE_CAUSE })
  expectTrue('(ay) 整条 <li> 结构与页码都在', chapter.includes(expected),
    { detail: shorten(chapter), cause: TOC_RECONCILE_CAUSE })
  expect('(ay) 成品目录里的「回忆」一处不剩', countOf(chapter, '回忆'), 0,
    { cause: TOC_RECONCILE_CAUSE })
  expect('(ay) 页码仍在 .toc-page 里', countOf(chapter, '<span class="toc-page">41</span>'), 1,
    { cause: TOC_RECONCILE_CAUSE })
  expect('(ay) 仍是一条目录一个 <li>', countOf(chapter, '<li class="toc-'), 1,
    { cause: TOC_RECONCILE_CAUSE })

  return `toc entry = ${shown} (${shown.length} 字) | 长标题=${shown === chapterTitle} | `
    + `回忆 left=${countOf(chapter, '回忆')} | page 41=${countOf(chapter, '<span class="toc-page">41</span>')}`
}

/**
 * (az) 差距过大时不动.
 *
 * The other side of (ay): the pass may only claim "this line is that chapter's
 * title", so an entry that is close to no chapter title must stay exactly as
 * transcribed. `附录：引用书目` is the shape - a contents entry for a section that
 * never opened a chapter - and the assertion is that its own text survives and the
 * chapter title is not forced onto it.
 */
async function scenarioTocEntryLeftAloneWhenFar() {
  const chapter = await renderOneBlockPage('toc-reconcile-far', [
    { type: 'h1', text: '回历九〇〇年(公元 1494 年)的事件' },
    { type: 'p', text: '这一年巴布尔从费尔干纳出发。' },
    { type: 'toc', text: '附录：引用书目 …… 380' },
  ])
  expectTrue('(az) 差得太远的条目原样保留',
    chapter.includes('<li class="toc-1"><span class="toc-title">附录：引用书目</span>'
      + '<span class="toc-page">380</span></li>'),
    { detail: shorten(chapter), cause: TOC_RECONCILE_CAUSE })
  // The h1 and the document's `<title>` both carry the chapter title; the point is
  // that the entry did NOT become a third copy of it.
  expect('(az) 目录里没有被强行换成本页的章标题', countOf(chapter, '<span class="toc-title">回历'), 0,
    { cause: TOC_RECONCILE_CAUSE })
  expect('(az) 页码仍在 .toc-page 里', countOf(chapter, '<span class="toc-page">380</span>'), 1,
    { cause: TOC_RECONCILE_CAUSE })

  return `far entry kept=${chapter.includes('<span class="toc-title">附录：引用书目</span>')} | `
    + `toc titles starting 回历=${countOf(chapter, '<span class="toc-title">回历')}`
}

/**
 * (ba) 正文里的《回忆录》不被误伤.
 *
 * The control that decides whether (ay) is a CORRECTION or a string replacement.
 * `回忆` is a real word of this book: its very title is `《巴布尔回忆录》`, and the
 * prose says it on page after page. A `回忆`→`回历` rewrite would turn that into
 * `《巴布尔回历录》`. The pass only ever touches a `toc` ENTRY, so the prose has to
 * come through byte for byte while the entry beside it is corrected.
 */
async function scenarioProseMemoryUntouched() {
  const chapter = await renderOneBlockPage('toc-reconcile-prose', [
    { type: 'h1', text: '回历九〇〇年(公元 1494 年)的事件' },
    { type: 'p', text: '《巴布尔回忆录》是一部关于巴布尔的自传。' },
    { type: 'toc', text: '回忆九〇〇年(公元 1494 年)的事件 …… 41' },
  ])
  expectTrue('(ba) 正文里的《巴布尔回忆录》逐字保留',
    chapter.includes('<p>《巴布尔回忆录》是一部关于巴布尔的自传。</p>'),
    { detail: shorten(chapter), cause: TOC_RECONCILE_CAUSE })
  expect('(ba) 全文只剩正文里那一个「回忆」', countOf(chapter, '回忆'), 1,
    { cause: TOC_RECONCILE_CAUSE })
  expectTrue('(ba) 同一页上的目录条目仍然被校正',
    chapter.includes('<span class="toc-title">回历九〇〇年(公元 1494 年)的事件</span>'),
    { detail: shorten(chapter), cause: TOC_RECONCILE_CAUSE })

  return `prose kept=${chapter.includes('<p>《巴布尔回忆录》是一部关于巴布尔的自传。</p>')} | `
    + `回忆 count=${countOf(chapter, '回忆')}`
}

/**
 * (bb) 括号里的数字不被替换.
 *
 * The reason the correction may not look inside a parenthetical group, pinned on the
 * real pair. The contents page abbreviates the printed year range and the chapter
 * spells the whole era out:
 *
 *   entry   回忆九〇〇年(1494—1495)的事件
 *   chapter 回历九〇〇年(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)的事件
 *
 * Outside the brackets the two lines differ by one character. INSIDE them they barely
 * share a substring - `1494` of the entry stands opposite `1495` of the chapter once
 * `—` is consumed - so a character-level alignment that is allowed to touch the group
 * would "correct" a date the page prints correctly, and would spend its substitution
 * budget doing it. The group is therefore masked before the alignment
 * (`maskParentheticals`), and the assertion is that the printed range survives
 * character for character - `(1494—1495)` compared with itself, both widths of
 * bracket included - while the slip outside it is fixed.
 */
async function scenarioTocDigitsInsideParenthesesKept() {
  const printed = '回忆九〇〇年(1494—1495)的事件'
  const chapter = await renderOneBlockPage('toc-reconcile-digits', [
    { type: 'h1', text: '回历九〇〇年(公元 1494 年 10 月 2 日至公元 1495 年 9 月 21 日)的事件' },
    { type: 'p', text: '这一年巴布尔从费尔干纳出发。' },
    { type: 'toc', text: `${printed} …… 41` },
  ])
  const shown = tocTitleOf(chapter)
  expect('(bb) 结果是 回历九〇〇年(1494—1495)的事件', shown, '回历九〇〇年(1494—1495)的事件',
    { cause: TOC_RECONCILE_CAUSE })
  const from = printed.indexOf('(')
  const to = printed.indexOf(')') + 1
  expect('(bb) 括号内逐字未变', shown.slice(from, to), printed.slice(from, to),
    { cause: TOC_RECONCILE_CAUSE })
  expect('(bb) 没有把章标题的长括注搬进条目（「公元」一处不剩）',
    countOf(shown, '公元'), 0, { cause: TOC_RECONCILE_CAUSE })
  expect('(bb) 长度与原条目相同', shown.length, printed.length,
    { cause: TOC_RECONCILE_CAUSE })
  expect('(bb) 页码仍在 .toc-page 里', countOf(chapter, '<span class="toc-page">41</span>'), 1,
    { cause: TOC_RECONCILE_CAUSE })

  return `entry = ${shown} | 括号内 = ${shown.slice(from, to)} | 逐字未变=${shown.slice(from, to) === printed.slice(from, to)}`
}

/**
 * (bc) 替换次数超限时不动.
 *
 * The outermost bound of the correction, and the one that must never leak: an entry
 * that is not the same line with a slip in it is not half-repaired. The entry here is
 * five characters away from the only chapter title on the page (`回忆九〇〇年的往事
 * 和人物` against `回历九〇〇年的事件`), and the refusal is a chain - the match window
 * (two) turns it away first, and the {@link TOC_SUBSTITUTE_MAX} cap of three is the
 * same refusal one level deeper, for the day the window moves: a line that would need
 * four replacements is a different line, and "repair" it here would be a guess with
 * the page's own text as the stake.
 *
 * What the scenario can assert against the code as shipped is the part a reader would
 * notice: the entry comes back byte for byte, and in particular never as
 * `回历九〇〇年的往事和人物` - the entry with only the characters it happens to share
 * with the title fixed, which is what a substitution pass with no bound at all would
 * leave behind. Half a correction is worse than none: it makes the entry differ from
 * both the page and the chapter.
 */
async function scenarioTocEntryTooManySubstitutions() {
  const printed = '回忆九〇〇年的往事和人物'
  const chapter = await renderOneBlockPage('toc-reconcile-many', [
    { type: 'h1', text: '回历九〇〇年的事件' },
    { type: 'p', text: '这一年巴布尔从费尔干纳出发。' },
    { type: 'toc', text: `${printed} …… 41` },
  ])
  const shown = tocTitleOf(chapter)
  expect('(bc) 差 4 字以上的条目原样保留', shown, printed,
    { cause: TOC_RECONCILE_CAUSE })
  expect('(bc) 长度与原条目相同', shown.length, printed.length,
    { cause: TOC_RECONCILE_CAUSE })
  expectTrue('(bc) 没有被「修一半」（回历九〇〇年的往事和人物）',
    shown !== `回历九〇〇年的往事和人物`, { detail: shorten(chapter), cause: TOC_RECONCILE_CAUSE })
  expect('(bc) 页码仍在 .toc-page 里', countOf(chapter, '<span class="toc-page">41</span>'), 1,
    { cause: TOC_RECONCILE_CAUSE })
  expect('(bc) 仍是一条目录一个 <li>', countOf(chapter, '<li class="toc-'), 1,
    { cause: TOC_RECONCILE_CAUSE })

  return `entry = ${shown} | 原样保留=${shown === printed} | 半修=${shown === '回历九〇〇年的往事和人物'}`
}

/* ------------------------------------------------------------------ *
 * running head without a `header` block on its own page
 * ------------------------------------------------------------------ */

/**
 * (bd) 书眉伪章被并回前一章.
 *
 * The defect this pins, from the full 764-page audit: page 704 of 《巴布尔回忆录》
 * is the top of a continuation page inside the index, and the model answered its
 * running head 「索引与译名对照」 as `h1` - but that page prints NO `header` block
 * at all (the block was simply not reported), so the same-page criterion of
 * scenario (as) cannot see it. The book grew a second chapter of that name and the
 * 「人 名」 index was cut in two (ch088 pages 701-703, ch089 pages 704-741), with
 * the same title listed twice in `nav.xhtml`.
 *
 * The page-704 shape is demoted by the SECOND criterion: the heading repeats the
 * title of the chapter that is open at its own level (page 1 opens it as `h1`) AND
 * that title is printed as a `header` somewhere in the book (page 2). Here page 1
 * is the chapter's first page, page 2 is a continuation page that reports the line
 * as furniture, and page 3 is page 704: the same line as `h1`, no `header`.
 *
 * The assertions are the audit's: exactly one chapter carries that title, the
 * demotion is counted, `nav.xhtml` mentions the title once, and page 3's body text
 * still reaches the chapter (it was folded into the chapter before it, not lost).
 */
async function scenarioRunningHeadWithoutOwnHeaderDemoted() {
  const file = await headerPagesPdf()
  const outDir = path.join(E2E_DIR, 'running-head-sibling')
  const HEAD = '索引与译名对照'
  const host = createFakeHost({
    blocksByPage: {
      1: [{ type: 'h1', text: HEAD }, { type: 'p', text: '索引首页正文。' }],
      2: [{ type: 'header', text: HEAD }, { type: 'p', text: '索引续页正文。' }],
      // The defect: the running head again, as `h1`, and NO `header` block on this
      // page - so nothing on the page itself proves it is furniture.
      3: [{ type: 'h1', text: HEAD }, { type: 'p', text: '索引末页正文。' }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  const entries = unzip(await readFile(run.epubPath))
  const body = allChapterText(entries)
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])
  const titles = book.chapters.map(chapter => chapter.title)

  expect('(bd) 伪章没有开出来（chapters === 1）', run.report.stats.chapters, 1,
    { detail: show(titles), cause: RUNNING_HEAD_CAUSE })
  expect('(bd) 只有 1 个以该书眉为标题的章', titles.filter(title => title === HEAD).length, 1,
    { detail: show(titles), cause: RUNNING_HEAD_CAUSE })
  expect('(bd) 伪章被计入 demotedHeadings（=== 1）', run.report.stats.demotedHeadings, 1,
    { detail: `demotedHeadings = ${run.report.stats.demotedHeadings}`, cause: RUNNING_HEAD_CAUSE })
  expect('(bd) nav 里该标题只出现 1 次', countOf(nav, HEAD), 1,
    { detail: shorten(nav), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(bd) 页 C 的正文并入前一章（没有丢）',
    String(book.chapters[0]?.html ?? '').includes('索引末页正文'),
    { detail: shorten(book.chapters[0]?.html ?? ''), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(bd) 三页正文都还在书里',
    ['索引首页正文', '索引续页正文', '索引末页正文'].every(text => body.includes(text)),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })

  note(`(bd) chapters=${run.report.stats.chapters} titles=${JSON.stringify(titles)} `
    + `demotedHeadings=${run.report.stats.demotedHeadings} nav「${HEAD}」×${countOf(nav, HEAD)}`)

  return `chapters ${run.report.stats.chapters} | nav ×${countOf(nav, HEAD)} | `
    + `demoted ${run.report.stats.demotedHeadings} | 页 C 并入=${String(book.chapters[0]?.html ?? '').includes('索引末页正文')}`
}

/**
 * (be) 年章标题不会被误降级.
 *
 * THE regression this rule must not break, and the reason criterion 2 needs its
 * SECOND half as well. 《巴布尔回忆录》 prints 「回历九〇X年(公元 …)的事件」 as the
 * running head of every continuation page and centers the same line as the chapter
 * title on the chapter's first page, where no running head is printed. So a year
 * chapter title IS a text that appears in the book-wide `header` set - the only
 * thing that keeps it alive is that it does NOT repeat the title of the chapter
 * before it (every year has its own title).
 *
 * Page 1 prints 「回历九〇〇年的事件」 as furniture only (a continuation page whose
 * model reported nothing but the running head); page 2 opens 「回历八九九年的事件」;
 * page 3 opens 「回历九〇〇年的事件」. Both chapters must survive, `demotedHeadings`
 * must be exactly 0, and page 3's title must really open the second chapter.
 */
async function scenarioYearChapterTitlesKept() {
  const file = await headerPagesPdf()
  const outDir = path.join(E2E_DIR, 'year-chapters-vs-running-head')
  const YEAR_899 = '回历八九九年的事件'
  const YEAR_900 = '回历九〇〇年的事件'
  const host = createFakeHost({
    blocksByPage: {
      // A continuation page: the year line as furniture, nothing else.
      1: [{ type: 'header', text: YEAR_900 }],
      2: [{ type: 'h1', text: YEAR_899 }, { type: 'p', text: '八九九年的正文。' }],
      // The same text as page 1's running head, but it is a DIFFERENT chapter's
      // title from the one page 2 opened - so it is a real chapter title.
      3: [{ type: 'h1', text: YEAR_900 }, { type: 'p', text: '九〇〇年的正文。' }],
    },
  })
  const run = await pipeline.runConversion({
    host,
    spec: { input: file, outputDir: outDir },
    config: { primaryModel: PRIMARY, reviewModels: [], dpi: 100, concurrency: 1 },
  })
  state.epubs.push(run.epubPath)

  const book = JSON.parse(await readFile(run.bookJsonPath, 'utf8'))
  const entries = unzip(await readFile(run.epubPath))
  const body = allChapterText(entries)
  const nav = strFromU8(entries['OEBPS/nav.xhtml'])
  const titles = book.chapters.map(chapter => chapter.title)

  expect('(be) 两个年章都在', titles, [YEAR_899, YEAR_900],
    { detail: show(titles), cause: RUNNING_HEAD_CAUSE })
  expect('(be) chapters === 2', run.report.stats.chapters, 2,
    { detail: show(titles), cause: RUNNING_HEAD_CAUSE })
  expect('(be) demotedHeadings === 0（年章标题不被降级）', run.report.stats.demotedHeadings, 0,
    { detail: `demotedHeadings = ${run.report.stats.demotedHeadings}`, cause: RUNNING_HEAD_CAUSE })
  expectTrue('(be) nav 里两个年章都在',
    nav.includes(YEAR_899) && nav.includes(YEAR_900),
    { detail: shorten(nav), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(be) 两页正文各自在自己的章里',
    String(book.chapters[0]?.html ?? '').includes('八九九年的正文')
      && String(book.chapters[1]?.html ?? '').includes('九〇〇年的正文'),
    { detail: shorten(String(book.chapters[1]?.html ?? '')), cause: RUNNING_HEAD_CAUSE })
  expectTrue('(be) 三页内容都还在书里（第 1 页书眉是家具，不算正文）',
    body.includes('八九九年的正文') && body.includes('九〇〇年的正文'),
    { detail: shorten(body), cause: RUNNING_HEAD_CAUSE })

  note(`(be) chapters=${run.report.stats.chapters} titles=${JSON.stringify(titles)} `
    + `demotedHeadings=${run.report.stats.demotedHeadings} nav 两章都在=${nav.includes(YEAR_899) && nav.includes(YEAR_900)}`)

  return `chapters ${run.report.stats.chapters} | titles ${JSON.stringify(titles)} | `
    + `demoted ${run.report.stats.demotedHeadings}`
}

/**
 * (bf) 纯数字日期仍受保护、带字母叶码被清除.
 *
 * The two faces of the date guard after the page-309 fix. `175b` stands right
 * behind `年` in `当我在回历九一七年 175b (公元 1511 年)夺取撒马尔罕时`, and the
 * guard that refuses to delete a number beside `年`/`月`/`日`/`页`/`卷`/`章`/`节`
 * kept it in the finished book for the whole audit. A token with a letter suffix is
 * not a year, a month or a page: the guard now only speaks about PURE numbers
 * ({@link PURE_DIGITS} in `src/model/assemble.js`), so `175b` is judged by the leaf
 * rule's remaining guards and deleted, while `9 月` on the very same page is still
 * kept because the page's `page-number` block is `9` (scenario (av)'s shape).
 *
 * Both sentences share one page on purpose: the same page number is the `9` of the
 * date AND the `175b` stands next to the `年` of another date, so a fix that simply
 * dropped the guard would lose the month here.
 */
async function scenarioPureDateKeptLeafMarkRemoved() {
  const page = await renderOneBlockPage('leaf-date-175b', [
    { type: 'p', text: '回历九三六年穆哈兰月三日(公元 1529 年 9 月 7 日)原稿中断。' },
    { type: 'p', text: '当我在回历九一七年 175b (公元 1511 年)夺取撒马尔罕时,赛伊德·哈三来到我处。' },
    { type: 'page-number', text: '9' },
  ])

  expectTrue('(bf) 纯数字日期完整保留（公元 1529 年 9 月 7 日）',
    page.includes('公元 1529 年 9 月 7 日'), { detail: shorten(page), cause: POSITION_CAUSE })
  expectTrue('(bf) 没有留下「年月」这种缺月份数字的畸形串', !page.includes('年月'),
    { detail: shorten(page), cause: POSITION_CAUSE })
  expectTrue('(bf) 带字母的叶码 175b 被清除', !page.includes('175b'),
    { detail: shorten(page), cause: LEAF_CAUSE })
  // The deletion eats the spaces that only kept the margin mark apart, so the
  // parenthetical closes onto the year: `回历九一七年(公元 1511 年)`. The space in
  // the printed line is typography of the margin mark, not a word separator, and
  // the exact shape is asserted flat below.
  expectTrue('(bf) 句子接成「回历九一七年(公元 1511 年)夺取撒马尔罕时」',
    /回历九一七年[ 　]?[(（]公元 1511 年[)）]夺取撒马尔罕时/.test(page),
    { detail: shorten(page), cause: LEAF_CAUSE })
  expectTrue('(bf) 句末没有留下双空格',
    !/<p>[^<]*[ \t]{2,}[^<]*<\/p>/.test(page), { detail: shorten(page), cause: LEAF_CAUSE })

  expect('(bf) stripFoliage 删掉 175b（规则自身的输出）',
    stripFoliage('当我在回历九一七年 175b (公元 1511 年)夺取撒马尔罕时', ['277']),
    '当我在回历九一七年(公元 1511 年)夺取撒马尔罕时', { cause: LEAF_CAUSE })
  expect('(bf) stripFoliage 仍保留纯数字日期',
    stripFoliage('回历九三六年穆哈兰月三日(公元 1529 年 9 月 7 日)原稿中断。', ['9']),
    '回历九三六年穆哈兰月三日(公元 1529 年 9 月 7 日)原稿中断。', { cause: POSITION_CAUSE })
  expect('(bf) stripFoliage 不把 175b 当页码（page-number 是 9）',
    stripFoliage('175b 这是一段正文', ['9']), '这是一段正文', { cause: LEAF_CAUSE })

  note(`(bf) 日期保留=${page.includes('公元 1529 年 9 月 7 日')} `
    + `| 175b 残留=${page.includes('175b')} `
    + `| 句子=${/回历九一七年[^夺]{0,20}/.exec(page)?.[0] ?? '(not found)'}`)

  return `date kept=${page.includes('公元 1529 年 9 月 7 日')} | 175b removed=${!page.includes('175b')} | `
    + `sentence=${/回历九一七年[^夺]{0,20}/.exec(page)?.[0] ?? '(not found)'}`
}

/* ------------------------------------------------------------------ *
 * runner
 * ------------------------------------------------------------------ */
const SCENARIOS = [
  ['(a) happy path', scenarioHappyPath],
  ['(b) 坏页走交叉复核', scenarioCrossReview],
  ['(c) 模型不吃图快速失败', scenarioTextOnly],
  ['(d) 缓存可复用', scenarioCacheReuse],
  ['(e) 表格与列表保住结构', scenarioTableAndList],
  ['(f) 失败页不污染缓存', scenarioFailedPageNotCached],
  ['(g) 缓存键包含设置', scenarioCacheKeyIncludesSettings],
  ['(h) 全空页时也写诊断', scenarioFailureReportEmptyPages],
  ['(i) 不可解析响应也归类', scenarioFailureReportUnparsable],
  ['(j) 推理吃光预算时给出可区分诊断', scenarioReasoningBudget],
  ['(k) 推理档位被透传', scenarioReasoningEffortForwarded],
  ['(l) 会话路由头被传递且按书稳定', scenarioSessionRoutingHeader],
  ['(m) 插图按 bbox 抽出并嵌入', scenarioFigureExtracted],
  ['(n) 非法 bbox 被拒绝且不影响成书', scenarioInvalidBboxRejected],
  ['(o) 裁图失败不拖垮整页', scenarioCropFailureDoesNotFailPage],
  ['(p) 页码范围只转指定页', scenarioPageRange],
  ['(q) excludePages 生效', scenarioPageExclude],
  ['(r) 封面被嵌入', scenarioCoverEmbedded],
  ['(s) 元数据覆盖生效', scenarioMetadata],
  ['(t) 标点归一化与括号配对', scenarioPunctuationAndBrackets],
  ['(u) 脚注与页码进对类型', scenarioFootnoteAndFolio],
  ['(v) 非相邻页不焊接', scenarioNonAdjacentPagesDoNotJoin],
  ['(w) 相邻页仍正常焊接', scenarioAdjacentPagesJoin],
  ['(x) 目录块渲染成真正的目录', scenarioTocRendered],
  ['(y) 页边叶码从正文里清除', scenarioFoliageRemoved],
  ['(z) 空 figure 不输出', scenarioEmptyFigureSuppressed],
  ['(aa) 空标题章被丢弃且章号连续', scenarioEmptyChapterDropped],
  ['(ab) 部扉页标题不被丢弃', scenarioPartTitleKept],
  ['(ac) 非 h1 的空章仍被丢弃', scenarioNonH1EmptyChapterDropped],
  ['(ad) 一本一目录', scenarioBookDirectory],
  ['(ae) 目录名净化', scenarioDirectoryNameSanitizer],
  ['(af) 同名不同书不误用缓存', scenarioSameNameDifferentBooks],
  ['(ag) 旧布局页缓存被迁移', scenarioLegacyCacheMigrated],
  ['(ah) 同页书眉被误判为 h1 时降级', scenarioRunningHeadDemoted],
  ['(ai) 重复的章标题不再全书去重', scenarioDuplicateChapterTitle],
  ['(aj) 真空白页不算失败并写入缓存', scenarioBlankPageCached],
  ['(ak) 有墨迹的 0 块页仍按失败处理', scenarioInkedEmptyPageStillFails],
  ['(al) 书眉变体仍能被降级', scenarioRunningHeadVariants],
  ['(am) 超过 40 字符的书眉也能匹配', scenarioLongRunningHead],
  ['(an) 行内叶码被清除', scenarioInlineLeafMark],
  ['(ao) 不该删的不删', scenarioLeafMarkGuards],
  ['(ap) 真实引用不被误删', scenarioRealCitationsKept],
  ['(aq) 各种形态的真叶码被删', scenarioLeafMarkShapesDeleted],
  ['(ar) 章首页的真标题不被误杀', scenarioChapterTitleSurvivesRunningHead],
  ['(as) 同页书眉+标题仍被降级', scenarioSamePageRunningHeadDemoted],
  ['(at) 重复的索引小节标题不被全书去重', scenarioRepeatedIndexHeadingKept],
  ['(au) 被页码块切断的段落重新接上', scenarioSplitParagraphRejoined],
  ['(av) 日期里的数字不被当页码删', scenarioDateNumbersKept],
  ['(aw) 索引定位符不被删', scenarioIndexLocatorsKept],
  ['(ax) 真正的页边页码仍被删', scenarioMarginFoliosStillDeleted],
  ['(ay) 目录条目按章标题校正', scenarioTocEntryReconciled],
  ['(az) 差距过大时不动', scenarioTocEntryLeftAloneWhenFar],
  ['(ba) 正文里的《回忆录》不被误伤', scenarioProseMemoryUntouched],
  ['(bb) 括号内的数字不被替换', scenarioTocDigitsInsideParenthesesKept],
  ['(bc) 替换次数超限时不动', scenarioTocEntryTooManySubstitutions],
  ['(bd) 书眉伪章被并回前一章', scenarioRunningHeadWithoutOwnHeaderDemoted],
  ['(be) 年章标题不会被误降级', scenarioYearChapterTitlesKept],
  ['(bf) 纯数字日期仍受保护、带字母叶码被清除', scenarioPureDateKeptLeafMarkRemoved],
]

async function main() {
  for (const file of [LONG_PDF, SHORT_PDF]) {
    if (await isFile(file)) continue
    console.log(`FAIL - 缺少样例 PDF ${relativeToRoot(file)}；先运行 node src/pdf/smoke.mjs 生成`)
    process.exitCode = 1
    return
  }

  await rm(E2E_DIR, { recursive: true, force: true })
  await mkdir(E2E_DIR, { recursive: true })

  pipeline = await loadPipeline()
  const source = await readFile(PIPELINE, 'utf8')
  console.log(`note - 被测 src/pipeline.js @ ${createHash('sha256').update(source).digest('hex').slice(0, 12)}（${source.length} bytes）`)

  const outcomes = []
  for (const [name, body] of SCENARIOS) {
    state.failures = []
    let evidence = null
    try {
      evidence = await body()
    } catch (error) {
      recordFailure('场景内未捕获异常', `${error.name ?? 'Error'}: ${error.message}`, { cause: error.cause })
    }

    const failures = state.failures
    const ok = failures.length === 0
    outcomes.push({ name, ok })

    if (ok) {
      console.log(`ok - ${name}`)
    } else {
      process.exitCode = 1
      console.log(`FAIL - ${name}`)
      for (const entry of failures) {
        console.log(`     ${entry.label === undefined ? '' : `${entry.label}：`}${entry.detail}`)
        if (entry.cause !== undefined) console.log(`     cause：${entry.cause}`)
      }
    }
    if (evidence !== null) console.log(`     ${ok ? '' : 'evidence：'}${evidence}`)
    for (const line of drainNotes()) console.log(`     note：${line}`)
  }

  await listArtifacts()

  const failed = outcomes.filter(outcome => outcome.ok !== true)
  console.log('')
  console.log(`${outcomes.length} scenarios | ${state.checks} checks | ${failed.length} failed`)
  if (failed.length > 0) console.log(`failed：${failed.map(outcome => outcome.name).join('、')}`)
  console.log(failed.length === 0 ? 'E2E OK' : 'E2E FAILED')
}

/** Unzip every produced EPUB once more and report its entry count. */
async function listArtifacts() {
  console.log('artifacts：')
  const paths = [...state.epubs]
  if (paths.length === 0) paths.push(path.join(E2E_DIR, 'test-long', 'test-long.epub'))
  for (const epubPath of new Set(paths)) {
    if (!(await isFile(epubPath))) {
      console.log(`     ${relativeToRoot(epubPath)} -> missing`)
      continue
    }
    const names = Object.keys(unzip(await readFile(epubPath)))
    const chapterCount = names.filter(name => name.startsWith('OEBPS/text/')).length
    console.log(`     ${relativeToRoot(epubPath)} -> ${names.length} entries（${chapterCount} 个 XHTML 文档）`)
  }
  // The happy-path book, in the per-book layout scenario (a) writes into.
  const reportPath = path.join(E2E_DIR, 'test-long', 'test-long.report.json')
  if (await isFile(reportPath)) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    console.log(`     ${relativeToRoot(reportPath)} -> ${report.stats.chapters} chapter(s)`)
  }
}

try {
  await main()
} catch (error) {
  process.exitCode = 1
  console.log(`FAIL - harness\n     ${error?.stack ?? error}`)
  console.log('E2E FAILED')
}
