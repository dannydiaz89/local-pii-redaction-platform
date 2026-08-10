# `@local-pii/adapter-docx`

Bounded native DOCX inspection, extraction, and scan support for the rules-only local CLI profile.

This first qualification slice accepts only strict, non-encrypted OOXML `.docx` ZIP packages whose visible text is contained in `w:t` nodes under paragraphs in `word/document.xml`. That includes ordinary body paragraphs and table-cell paragraphs. Text fragmented across runs is exposed as one paragraph region, and Unicode code-point actions are mapped back across the original run text nodes. Changed nodes are XML-escaped while untouched package-part bytes remain unchanged after decompression.

The adapter fails closed for macros, encryption, external relationships, metadata property parts, headers, footers, footnotes, endnotes, comments, images/drawings, text boxes, fields, hyperlinks, revisions, hidden text, embedded objects, custom XML, structured document tags, styles, settings, font tables, numbering, themes, unknown package parts, unsafe archive paths, duplicate entries, ZIP64, encrypted ZIP entries, and archive/resource-limit violations. These features are not silently skipped. This makes the first slice intentionally narrower than ordinary Word-authored packages; those auxiliary parts require their own canary inventory and sanitization rules before broad support is advertised.

The package includes an experimental native writer boundary that writes a normalized ZIP package to a private `0600` stage, validates its exact bytes, reopens it through this adapter, and publishes with the shared no-clobber hard-link boundary. It never modifies the input. The capability descriptor advertises only probe, inspect, extract, and scan with `EXTRACT_ONLY` assurance. Its `docx-extract-v1` profile attests only ZIP structure, the feature allowlist, and native source mapping; it is not redaction verification and cannot authorize publication. Redaction and verification must not be exposed by a composition root until a DOCX-native leakage verifier and fidelity evidence exist. Independent Office-renderer fidelity, sandboxed worker isolation, metadata sanitization policies, and broader DOCX parts remain Milestone 4 qualification work.

Hard limits currently include 25 MiB compressed input, 256 ZIP entries, 50 MiB total expanded content, 10 MiB per entry, 100× maximum compression ratio, 100,000 text nodes, 50,000 paragraphs, 10 million canonical code points, and 100,000 plan actions. Parsing is bounded but whole-document.

The implementation uses only Node built-ins for ZIP/DEFLATE handling; it introduces no parser or network dependency.
