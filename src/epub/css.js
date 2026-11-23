/**
 * Default EPUB 3 stylesheet for dsh-pdf2epub.
 *
 * Chinese-first book typography. No @font-face: the module never embeds font
 * files (readers must supply their own CJK fonts), so the file stays tiny and
 * the EPUB stays free of licensed font binaries.
 *
 * `buildEpub()` writes this verbatim to `OEBPS/styles/book.css` unless the
 * caller supplies `book.css`.
 */
export const DEFAULT_CSS = `@charset "utf-8";

/* ---------- base / CJK typography ---------- */
html {
  font-size: 100%;
}

body {
  margin: 0 5%;
  padding: 0;
  font-family: "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC",
    "SimSun", "STSong", serif;
  font-size: 1em;
  line-height: 1.75;
  line-break: strict;
  word-break: normal;
  overflow-wrap: break-word;
  text-align: justify;
  text-justify: inter-ideograph;
}

p {
  margin: 0;
  text-indent: 2em;
}

/* headings never indent, and start a new page at top level */
h1,
h2,
h3,
h4,
h5,
h6 {
  text-indent: 0;
  line-height: 1.4;
  font-weight: 700;
  page-break-after: avoid;
  break-after: avoid;
}

h1 {
  margin: 1em 0 1.2em;
  font-size: 1.8em;
  text-align: center;
  break-before: page;
  page-break-before: always;
}

h2 {
  margin: 1.2em 0 0.8em;
  font-size: 1.4em;
}

h3 {
  margin: 1em 0 0.6em;
  font-size: 1.2em;
}

h4,
h5,
h6 {
  margin: 0.9em 0 0.5em;
  font-size: 1em;
}

/* ---------- inline ---------- */
em,
i {
  font-style: italic;
}

strong,
b {
  font-weight: 700;
}

sup,
sub {
  font-size: 0.75em;
  line-height: 0;
}

a {
  color: #0b5fff;
  text-decoration: none;
}

/* ---------- media ---------- */
img {
  max-width: 100%;
  height: auto;
}

figure {
  margin: 1em 0;
  text-align: center;
  text-indent: 0;
}

figcaption {
  margin-top: 0.4em;
  font-size: 0.85em;
  text-indent: 0;
  color: #555;
}

.cover {
  margin: 0;
  padding: 0;
  text-align: center;
  text-indent: 0;
}

/* ---------- tables ---------- */
table {
  width: 100%;
  margin: 1em 0;
  border-collapse: collapse;
  border-spacing: 0;
  font-size: 0.95em;
  text-indent: 0;
}

th,
td {
  padding: 0.4em 0.6em;
  border: 1px solid #999999;
  vertical-align: top;
  text-align: left;
}

th {
  font-weight: 700;
  background-color: #f2f2f2;
}

caption {
  margin-bottom: 0.4em;
  font-weight: 700;
  text-indent: 0;
}

/* ---------- special blocks ---------- */
.footnote,
.footnotes {
  margin: 1.2em 0 0;
  padding-top: 0.6em;
  border-top: 1px solid #cccccc;
  font-size: 0.85em;
  line-height: 1.5;
  text-indent: 0;
  color: #444444;
}

.footnote p,
.footnotes p {
  text-indent: 0;
}

.footnote-ref {
  font-size: 0.75em;
  line-height: 0;
  vertical-align: super;
}

/* ---------- chapter-end notes ---------- *
 * What the "chapter" footnote placement produces: every page-bottom note of a
 * chapter collected behind one rule at its end, so a note can no longer stand in
 * the middle of the sentence the next page continues. The circled number a note
 * opens with is the way back to the text, and the marker in the text is the way
 * forward; both keep the book's own colour, because a circled number is already
 * an unmistakable link target and colouring it turns every other paragraph blue. */
.endnotes {
  margin: 2.2em 0 0;
  padding-top: 0.8em;
  border-top: 1px solid #bbbbbb;
  font-size: 0.86em;
  line-height: 1.6;
  text-indent: 0;
}

.endnotes-title {
  margin: 0 0 0.7em;
  font-size: 1em;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-indent: 0;
}

.endnote {
  margin: 0 0 0.55em;
  text-indent: 0;
}

.endnote p {
  margin: 0;
  text-indent: 0;
  text-align: justify;
}

a.noteref,
a.noteback {
  color: inherit;
  text-decoration: none;
}

.verse {
  margin: 0.8em 0;
  padding-left: 1em;
  white-space: pre-wrap;
  text-indent: 0;
  text-align: left;
}

/* An address block (imprint, publisher's line): centred and tight, because the
   lines belong together and the model already broke them at the right spots. */
.address {
  margin: 0.8em 0;
  text-indent: 0;
  text-align: center;
  line-height: 1.4;
}

.code {
  margin: 0.8em 0;
  white-space: pre-wrap;
  text-indent: 0;
  text-align: left;
  font-family: "SFMono-Regular", "Consolas", "Menlo", monospace;
  font-size: 0.9em;
}

/* ---------- table of contents ---------- *
 * A "toc" block is rendered as a real nav list: one li per printed entry, the
 * depth carried by .toc-N, and the printed page number pushed to the right on
 * the same line (display: flex aligns the two ends without a leader made of
 * dots, which a reflowable layout could not align anyway). */
.toc {
  margin: 1.2em 0;
  text-indent: 0;
}

.toc ol {
  margin: 0;
  padding: 0;
  list-style: none;
}

.toc li {
  display: flex;
  align-items: baseline;
  margin: 0.15em 0;
  text-indent: 0;
}

.toc-1 { padding-left: 0; }
.toc-2 { padding-left: 1.6em; }
.toc-3 { padding-left: 3.2em; }
.toc-4 { padding-left: 4.8em; }
.toc-5 { padding-left: 6.4em; }
.toc-6 { padding-left: 8em; }

.toc-title {
  flex: 1 1 auto;
  text-align: left;
}

.toc-page {
  flex: 0 0 auto;
  padding-left: 0.6em;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.quote,
.blockquote {
  margin: 1em 2em;
  text-indent: 0;
}

.center {
  text-align: center;
  text-indent: 0;
}

.page-break {
  break-before: page;
  page-break-before: always;
}
`;
