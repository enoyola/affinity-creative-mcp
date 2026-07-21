# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-21

### Added

- Guarded single-document text discovery and replacement.
- Guarded batch text replacement across up to 20 open documents.
- Glyph-aware matching after emoji and safe handling of special glyph boundaries.
- Document inspection and in-place save tools.
- Exact-history undo support.
- Live effects for exposure, invert, and Gaussian blur.
- Protocol discovery tests and live Affinity 3.2 validation.

### Security

- Text replacement requires matching history, count, and fingerprint guards.
- Batch apply preflights every document and attempts guarded rollback on failure.
- Raw Affinity script execution remains unavailable through the public MCP surface.

[0.3.0]: https://github.com/enoyola/affinity-creative-mcp/releases/tag/v0.3.0
