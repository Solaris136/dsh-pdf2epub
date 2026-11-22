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

.verse {
  margin: 0.8em 0;
  padding-left: 1em;
  white-space: pre-wrap;
  text-indent: 0;
  text-align: left;
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
