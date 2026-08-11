# `@local-pii/adapter-pdf`

Experimental, extraction-only adapter for one deliberately narrow searchable-PDF profile.

## Accepted profile

- PDF 1.4 with one classic, complete, single-revision xref table and no free or unused objects.
- One catalog, one flat page tree, and at most 100 pages.
- One uncompressed content stream per page.
- A shared or page-local built-in Helvetica Type 1 font with WinAnsi encoding.
- Visible ASCII literal-string `Tj` text at bounded in-page coordinates, using only `BT`, `Tf`,
  `Td`, `Tj`, and `ET` operators. Canonical reading order is page order followed by operator order.

The closed grammar lets the adapter prove that every accepted content-stream operator and object is
understood, enumerated, and extracted for inspection. Version 0.2 also emits one frozen canonical
region per accepted text-showing operator. Each value-free v3 location binds exact canonical
code-point offsets to page, page object, content object, font object, text-item ordinal, and glyph
count. Unknown dictionaries, objects, operators, encodings, or trailing revisions fail closed.
Encrypted files, compressed/object/xref streams, metadata, actions/JavaScript, forms,
annotations, attachments, images, layers, patterns, alternate fonts, OCR/scanned pages, and other
carriers are rejected. Inputs are bounded, opened without following the selected-file symlink, and
checked for identity changes around the read.

## Assurance boundary

The advertised capability is `EXPERIMENTAL`, `EXTRACT_ONLY`, and limited to probe and inspect.
The complete typed map covers only the accepted visible-ASCII literal profile. Scan is deliberately
not advertised until that new map has end-to-end scan admission and security qualification;
real-world Unicode/font mapping remains absent. This is a synthetic foundation, not general PDF
compatibility. It does not accept real-world font/layout features, perform OCR, preview/render,
write PDFs, redact, verify, or claim that an output is safe. True searchable-PDF scanning and
redaction remain Milestone 4B.

A privacy-safe structural audit of one caller-supplied real-world PDF 1.7 fixture found independent
unsupported requirements including binary syntax, Flate streams, ToUnicode maps, document tagging,
and metadata carriers. The adapter continues to reject that file before extracting or reporting any
document values. Compatibility with those features must be added as separate closed profiles rather
than by weakening this grammar.
