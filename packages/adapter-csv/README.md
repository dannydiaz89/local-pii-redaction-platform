# `@local-pii/adapter-csv`

Native, rules-only CSV extraction and redaction for the local CLI profile.

The adapter strictly parses UTF-8 `.csv` files, detects comma, tab, or semicolon delimiters when unambiguous, exposes decoded cell values as canonical detector text, and maps trusted code-point spans back to their original cells. Redaction rewrites only changed field tokens, preserves every untouched byte, stages output privately, reopens it through the CSV parser, and uses the shared no-clobber publication boundary.

Current scope is deliberately narrow: every cell, including the first row, is scanned; rows must have a uniform width; double quotes use the standard doubled-quote escape; and processing is bounded but whole-document. Header-aware column selection, structured/free-text policies, configurable dialects, and million-row streaming remain future work.

Formula-like cells are treated as untrusted text. The adapter never evaluates them, but it also does not neutralize spreadsheet formulas; unchanged formula tokens remain unchanged and require the usual caution if an output is opened in spreadsheet software.

This package is an adapter boundary. Detection, resolution, policy, and verification remain in their owning packages.
