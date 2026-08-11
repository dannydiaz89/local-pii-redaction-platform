# `@local-pii/adapter-csv`

Native, rules-only CSV extraction and redaction for the local CLI profile.

The adapter strictly parses UTF-8 `.csv` files, detects comma, tab, or semicolon delimiters when unambiguous, or accepts an explicit supported delimiter selected by a validated policy. It exposes decoded cell values as canonical detector text and maps trusted code-point spans back to their original cells. Redaction rewrites only changed field tokens, preserves every untouched byte, stages output privately, reopens it through the same CSV configuration, and uses the shared no-clobber publication boundary.

Current scope is deliberately narrow: header mode is explicit (`NONE` or `PRESENT`), never guessed; a declared header is preserved but excluded from canonical detector text; exact one-based index or exact header-name selectors can classify whole nonempty cells; unmatched cells use free-text rules; rows must have a uniform width; double quotes use standard doubled-quote escaping; and processing is bounded but whole-document. Wildcard/ignore selectors, heuristic headers, and million-row streaming remain future work.

Formula-like cells are treated as untrusted text. The adapter never evaluates them, but it also does not neutralize spreadsheet formulas; unchanged formula tokens remain unchanged and require the usual caution if an output is opened in spreadsheet software.

This package is an adapter boundary. Detection, resolution, policy, and verification remain in their owning packages.
