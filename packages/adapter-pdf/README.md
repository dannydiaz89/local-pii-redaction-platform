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
understood, enumerated, and extracted for inspection. Unknown dictionaries, objects, operators, encodings, or trailing revisions
fail closed. Encrypted files, compressed/object/xref streams, metadata, actions/JavaScript, forms,
annotations, attachments, images, layers, patterns, alternate fonts, OCR/scanned pages, and other
carriers are rejected. Inputs are bounded, opened without following the selected-file symlink, and
checked for identity changes around the read.

## Assurance boundary

The advertised capability is `EXPERIMENTAL`, `EXTRACT_ONLY`, and limited to probe and inspect.
Extraction exists only as adapter-internal evidence for inspection. Scan is deliberately not
advertised because the repository does not yet have a complete typed page/object/glyph source map
or qualified Unicode mapping. This is a synthetic foundation, not general PDF compatibility. It
does not accept real-world font/layout features, perform OCR, preview/render, write PDFs, redact,
verify, or claim that an output is safe. True searchable-PDF scanning and redaction remain Milestone 4B.
