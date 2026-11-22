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
9. 只输出一个 JSON 对象，不要任何解释文字。`

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
