# `@local-pii/adapter-pdf`

Experimental, extraction-only adapter for one deliberately narrow searchable-PDF profile.

## Accepted profile

- PDF 1.4 with its exact text header, or PDF 1.7 with one bounded 4–16-byte all-binary comment
  immediately after the header; both require one classic, complete, single-revision xref table and
  no free or unused objects.
- One catalog, one flat page tree, and at most 100 pages.
- One uncompressed or exact `/Filter /FlateDecode` content stream per page. Compressed and decoded
  bytes are each limited to 256 KiB; expansion is capped at 64× with a small 1 KiB floor. The zlib
  checksum must pass and every declared compressed byte must be consumed. Filter arrays,
  `DecodeParms`, trailing data/members, object streams, and xref streams are rejected.
- A shared or page-local built-in Helvetica Type 1 font with WinAnsi encoding.
- Visible ASCII literal-string `Tj` text at bounded in-page coordinates, using only `BT`, `Tf`,
  `Td`, `Tj`, and `ET` operators. Canonical reading order is page order followed by operator order.
- The catalog may contain one inline `OpenAction` only as
  `[page-reference /XYZ null null 0]`, optionally without a separator before `[`. The reference must
  identify a page already in the closed page tree. This non-executable initial-view destination has
  no canonical value or omitted source-map carrier.
- An accepted metadata profile must contain both one trailer `/Info` dictionary and one catalog
  `/Metadata` XML stream. The Info dictionary admits only a bounded closed field/value grammar. The
  XMP stream must be one UTF-8 xpacket containing exactly one namespace-bound
  `x:xmpmeta/rdf:RDF/rdf:Description` tree; only the enumerated DC/XMP/PDF fields, one optional
  RDF container, and `rdf:li` values are accepted. Every admitted value receives a value-free v4
  Info/XMP object/field/occurrence location. Missing or spoofed namespace bindings, duplicate
  attributes, arbitrary nesting, entities, document IDs, unknown XML, and unpaired metadata
  carriers fail closed.

The closed grammar lets the adapter prove that every accepted content-stream operator and object is
understood, enumerated, and extracted for inspection. Version 0.2 added one frozen canonical
region per accepted text-showing operator. Each value-free v3 location binds exact canonical
code-point offsets to page, page object, content object, font object, text-item ordinal, and glyph
count. Version 0.3 adds only the bounded PDF 1.7 binary header and Flate content profile above.
Version 0.4 adds only the exact value-free `/XYZ` initial-view destination above. Named/string
destinations, action dictionaries, indirect actions, other destination operators, and every other
`OpenAction` shape remain blocked as active content. Version 0.5 adds the paired, closed Info/XMP
metadata profile above and canonical-region v4/detection v5 provenance; it does not sanitize or
write metadata. Unknown dictionaries, objects, operators, encodings, filters, XML elements, or
trailing revisions fail closed. Encrypted files, object/xref streams, document IDs, broader
metadata, executable actions/JavaScript, forms, annotations, attachments, images,
layers, patterns, alternate fonts, OCR/scanned pages, and other carriers are rejected. Inputs are
bounded, opened without following the selected-file symlink, and checked for identity changes
around the read.

## Assurance boundary

The advertised capability is `EXPERIMENTAL`, `EXTRACT_ONLY`, and limited to probe and inspect.
The complete typed map covers only the accepted visible-ASCII literal profile. Scan is deliberately
not advertised until that new map has end-to-end scan admission and security qualification;
real-world Unicode/font mapping remains absent. This is a synthetic foundation, not general PDF
compatibility. It does not accept real-world font/layout features, perform OCR, preview/render,
write PDFs, redact, verify, or claim that an output is safe. True searchable-PDF scanning and
redaction remain Milestone 4B.

A privacy-safe structural audit of one caller-supplied real-world PDF 1.7 fixture originally found
binary syntax and Flate streams alongside independent ToUnicode, tagging, initial-view, document-ID,
and metadata carriers. Version 0.5 adds a typed, closed metadata foundation, but the audited file
still fails closed because its broader metadata/container and document-structure grammar is not the
accepted synthetic profile. No values were retained as evidence. Compatibility with each remaining
feature must be added as a separate closed profile rather than by weakening this grammar.
