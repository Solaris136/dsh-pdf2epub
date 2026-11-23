/**
 * Prompt builders. Kept pure so the exact text a model receives is reviewable
 * and can be diffed between the transcription pass and a cross-review pass.
 */

const SYSTEM = `你是一个 PDF 页面转录器。输入是一页书的图像，输出是这一页的结构化文本块。

铁律：
1. 逐字转录。不润色、不改错、不补全、不纠正笔误、不总结、不翻译、不合并句子。原文错就照错抄。
2. 页眉、页脚、页码、水印照抄文字，type 分别标成 "header"、"footer"、"page-number"、"watermark"。
3. 段落内部的换行不要保留；只有真正另起一段才是新的块。
4. 诗歌、目录、代码、地址或落款：type 用 "verse"、"toc"、"code"、"address"，并且必须用 \\n 保留原始换行。
5. 标题按视觉层级标 "h1" 到 "h4"，依据字号、字重和居中判断。
6. 表格：type 用 "table"，text 写成 Markdown 管道表格。
7. 图片：type 用 "figure"，text 只写图注，没有图注写空字符串。
8. 无法辨认的字符：原样输出，并在该块的 "uncertain" 里描述位置（最多 5 条）。绝不猜测。
9. 只输出一个 JSON 对象，不要任何解释文字。
10. 每个 "figure" 块必须额外给出 "bbox"：格式是 [x0, y0, x1, y1]，四个 0 到 1 之间的归一化数字，相对于这一页的图像，原点在左上角。bbox 只框插图本身（图形、照片、地图等），不框下面的图注文字，也不要包含周围的正文。这一页没有插图，或者你无法判断插图边界时，省略 bbox（只留图注）。
11. 页脚注：正文页面底部、一条短分隔线之下的注文（字号通常比正文小），type 用 "footnote"，不要混进正文段落。注文开头的标记（圆圈序号 ①②③④⑤，或 ＊）原样保留在 text 的开头，不要删掉、不要改写成 "(1)" 之类。注文可以跨页：上一页的注文在本页以无编号的文字接续时，也用 "footnote"，并把这个块的 "continues" 设为 true。
12. 正文里的注码（紧跟在被注词语后面的 ①②③ 或 ＊）：在原位置原样保留字符，不要删除，不要改写成别的形式，不要挪到句末或段末，也不要单独成块。
13. 页码：这本书的页码不在页脚，而在页面垂直中部的外侧边缘（单页在右、双页在左），通常紧挨着一个出版社徽记；有时还会带一个叶码，形如 "131b"、"24b"、"1b*"。出现在这个位置的数字或数字加字母，一律标 type "page-number"，不要当成正文的一行，也不要当成 "footer"。
14. 书眉：页面顶部、单页右对齐、双页左对齐，下面常有一条贯穿版心的细横线，内容可能是书名、部名或章名，type 用 "header"。章首页没有书眉：页面顶部居中的那行章标题是章节标题，按第 5 条标成标题，不要标成 "header"。`

const SCHEMA = `输出格式：
{"blocks":[{"type":"p","text":"段落正文","continues":false}],"notes":"可选的一句话说明"}`

/**
 * Build the transcription request for one page.
 * @param {{ pageNumber: number, totalPages: number, previousTail?: { type: string, text: string } | null, furnitureHint?: string[] }} input - page context.
 * @returns {{ system: string, user: string }} prompt pair.
 */
export function transcriptionPrompt(input) {
  const lines = [
    `这是全书第 ${input.pageNumber} 页，共 ${input.totalPages} 页。`,
    SCHEMA,
    '',
    '补充规则：',
    '- 如果本页第一个块是上一页最后一段的延续，把第一个块的 "continues" 设为 true，并且不要重复上一页已经出现过的文字。',
    '- 纯装饰性线条、分隔符不要输出。',
  ]
  if (input.previousTail !== undefined && input.previousTail !== null) {
    const tail = input.previousTail.text.slice(-80)
    lines.push(`- 上一页最后一个块的类型是 "${input.previousTail.type}"，结尾是："${tail}"`)
  }
  if (Array.isArray(input.furnitureHint) && input.furnitureHint.length > 0) {
    lines.push('- 这本书反复出现的页眉页脚样文如下，遇到时按第 2 条标注类型：')
    for (const hint of input.furnitureHint.slice(0, 8)) lines.push(`  · ${hint}`)
  }
  return { system: SYSTEM, user: lines.join('\n') }
}

/**
 * Build a stricter retry prompt after a page failed its sentinels.
 * @param {string} reason - human-readable sentinel failure.
 * @returns {string} extra instruction appended to the user turn.
 */
export function retryNote(reason) {
  return [
    '',
    '注意：上一次转录没有通过校验（' + reason + '）。这次请特别注意：',
    '- 完整覆盖这一页的每一段文字，不要漏段、不要提前结束。',
    '- 不要输出与本页无关的重复内容。',
    '- 仍然是只输出 JSON。',
  ].join('\n')
}
