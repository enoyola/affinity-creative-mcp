# Affinity Creative MCP

[![CI](https://github.com/enoyola/affinity-creative-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/enoyola/affinity-creative-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A safe local MCP server for automating Affinity Photo, Designer, and Publisher from Codex or another MCP client.

It presents a modern stdio MCP interface and bridges to Affinity 3's native loopback connector. The public tools use fixed, validated operations; Affinity's unrestricted `execute_script` capability is deliberately not exposed.

> [!IMPORTANT]
> This is an unofficial community project. It is not affiliated with, endorsed by, or supported by Canva or the Affinity team.

## Platform support

| Requirement | Support |
|---|---|
| Operating system | macOS |
| Affinity | Affinity 3; live-tested with 3.2.0 |
| Node.js | 22.7.5 or newer |
| MCP clients | Codex and other clients that support local stdio MCP servers |

## What it can automate

### App and documents

| Tool | Purpose |
|---|---|
| `affinity_status` | Check the installed version, running state, native connector, allowed folders, and safety settings |
| `affinity_launch` | Launch Affinity and wait for its connector |
| `affinity_plan_document` | Validate a Photo, Designer, or Publisher document request without writing anything |
| `affinity_create_document` | Create an editable `.af` document with exact dimensions and no overwrite |
| `affinity_open_document` | Open an existing `.af`, legacy Affinity file, image, SVG, EPS, or PDF and return its session UUID |
| `affinity_list_open_documents` | List open documents and their session UUIDs |
| `affinity_inspect_document` | Inspect dimensions, path, identity, and save state for one session |
| `affinity_save_document` | Save an existing native Affinity file in place after path-policy checks |

### Layers and editing

| Tool | Purpose |
|---|---|
| `affinity_list_layers` | List layers in Affinity's flattened layer order with types, bounds, indices, and selection state |
| `affinity_select_layer` | Select a layer by exact name and duplicate occurrence |
| `affinity_add_layer` | Add a named container layer |
| `affinity_add_shape` | Add an editable rectangle or ellipse with fill and optional stroke |
| `affinity_add_text` | Add editable artistic or frame text with size, alignment, and colour |
| `affinity_find_text` | Preview literal matches in editable text layers and return stale-plan guards |
| `affinity_replace_text` | Replace a previewed match set in one document as one undoable, unsaved edit |
| `affinity_batch_replace_text` | Dry-run or apply the same guarded replacement across up to 20 open documents |
| `affinity_place_image` | Embed a PNG, JPEG, TIFF, or WebP as an image layer without changing the source |
| `affinity_transform_selection` | Move, scale, and rotate the current selection |
| `affinity_set_fill` | Change the current selection's solid fill colour |
| `affinity_add_live_effect` | Add a clipped exposure, invert, or Gaussian-blur live effect |
| `affinity_undo` | Undo the latest document history operation |

Edits return a `historyPosition`, are undoable, and remain unsaved until `affinity_save_document` is called. `affinity_undo` requires that exact position so it refuses to undo if another edit occurred in between.

### Guarded text replacement

Text replacement is a preview-then-apply workflow:

1. `affinity_find_text` returns every literal match plus the document history position, match count, and a fingerprint of the exact text-layer snapshot.
2. Pass those three guards to `affinity_replace_text`. It rescans and refuses the edit if the document, count, or fingerprint changed.
3. Render a preview. Save only after approval, or use the returned history position with `affinity_undo`.

`affinity_batch_replace_text` supports the same pattern for up to 20 already-open documents:

- `mode: "dry_run"` returns a guarded plan for every session.
- `mode: "apply"` preflights every plan before changing any document, applies one undoable history operation per document, and guarded-undoes earlier documents if a later replacement fails.
- Batch replacements are deliberately left unsaved. Save each native source explicitly with `affinity_save_document`, or create new deliverables with `affinity_batch_export`.

Literal matching supports case-sensitive or case-insensitive search, optional whole-word matching, and an exact layer-name allowlist. It is glyph-aware, so matches after emoji map to the correct Affinity story positions. Dynamic fields and special glyphs form safe search boundaries. Search phrases containing line breaks are rejected in this release.

Affinity preserves formatting outside each replaced range. Inserted characters inherit formatting from the beginning of that range; mixed character-level styles inside the removed text are not reconstructed. Longer replacement text can reflow or overflow a frame, so preview before saving.

This feature operates on real editable Affinity text only. It does not OCR raster images, restore outlined text, edit text inside embedded documents, or modify linked multi-frame text flows.

### Preview and export

| Tool | Purpose |
|---|---|
| `affinity_render_spread` | Return an image preview of an open spread |
| `affinity_render_selection` | Return an image preview of the current selection |
| `affinity_list_export_presets` | List Affinity's installed presets and this MCP's curated preset IDs |
| `affinity_export_document` | Export one open document without overwriting a destination |
| `affinity_batch_export` | Stage up to 20 exports and commit only after every export succeeds |

Curated exports include PNG, four JPEG qualities, GIF, RGB/CMYK TIFF, SVG variants, PDF variants, EPS, editable PSD, and lossy/lossless WebP.

### SDK inspection

`affinity_list_sdk_documentation` and `affinity_read_sdk_documentation` expose Affinity's installed documentation for diagnostics. They do not expose raw script execution.

## One-time Affinity setup

This server was built and live-tested against Affinity 3.2.0 on macOS.

1. Open Affinity.
2. Open **Affinity > Settings > Model Context Protocol**.
3. Enable **Enable Affinity MCP**.
4. Enable **Access files on your Desktop**.

Desktop access is required because Affinity limits SDK file I/O to that location. Image placement and exports use unpredictable Desktop staging names, validate the result, copy it exclusively to an allowed destination, and clean up staging.

Affinity 3.2's SDK cannot reliably close a document. Consequently:

- Every new document is first saved to a random hidden Desktop staging file, then committed to the requested path with an exclusive, hash-verified copy. This preserves the no-overwrite guarantee even if another process races for the destination.
- Call `affinity_open_document` on the final path before editing it, and close the hidden staging document manually when convenient.
- There is intentionally no `affinity_close_document` tool.

## Install from source

```bash
git clone https://github.com/enoyola/affinity-creative-mcp.git
cd affinity-creative-mcp
npm ci
npm run check
```

Requirements: macOS, Affinity 3 with its MCP connector enabled, and Node.js 22.7.5 or newer.

The automated suite covers schemas, fixed-script generation, hostile-string escaping, text history/fingerprint guards, timeout audits, verified batch rollback, path and symlink containment, no-overwrite behavior, bridge reconnect behavior, staging policy, and MCP protocol discovery. Glyph-aware matching after emoji, partial range replacement, formatting inheritance, exact undo, placement, effects, save, PNG export, and rendering have also been live-validated against Affinity 3.2.

## Codex configuration

From the cloned repository, register the built server with Codex:

```bash
NODE_BIN="$(command -v node)"
SERVER_ENTRY="$(pwd)/dist/index.js"

codex mcp add affinity-creative \
  --env "AFFINITY_MCP_ALLOWED_ROOTS=$HOME/Documents:$HOME/Desktop" \
  -- "$NODE_BIN" "$SERVER_ENTRY"
```

A TOML form is in [`codex-config.example.toml`](./codex-config.example.toml). Replace its placeholders with the output of `command -v node`, the absolute path to `dist/index.js`, and your desired allowed roots. Restart Codex after adding the server or rebuilding its tool surface so a new MCP process loads the updated tools.

For another MCP client, configure a local stdio server whose command is your Node.js executable, whose first argument is the absolute path to `dist/index.js`, and whose environment includes `AFFINITY_MCP_ALLOWED_ROOTS`.

## Example requests

```text
Create a 1920 × 1080 px Designer document on my Desktop, add a purple
background rectangle and a white headline saying "Summer launch", then save it.
```

```text
Open /Users/YOUR_USERNAME/Documents/Creative/post.af, list its layers, select the layer
named Product, move it 40 px right, add a 2 px Gaussian blur, and show me a preview.
Do not save until I approve the preview.
```

```text
Place /Users/YOUR_USERNAME/Documents/Assets/logo.png at x 120, y 80 in the open document,
resize it to 360 px wide, export the whole document as high-quality JPEG, and also
export a PDF for print. Do not overwrite existing files.
```

```text
In these ten open Affinity documents, find every editable occurrence of "XYZ".
Show me the dry-run counts first. If every document is ready, replace them with
"ABC" as unsaved edits, render the first result, and do not save until I approve.
```

```text
In the open document, replace the whole word "Draft" with "Approved" only in
layers named Header or Footer. Match case, show me a preview, then save it.
```

```text
Create an 8-page A4 Publisher document in millimetres with facing pages at
/Users/YOUR_USERNAME/Documents/Creative/brochure.af.
```

For editing calls, Codex obtains `documentSessionUuid` from document creation, opening, or `affinity_list_open_documents`. Tools that operate on the current selection can be preceded by `affinity_select_layer`.

## Document creation options

- Workspaces: `photo`, `designer`, `publisher`
- Units: `px`, `mm`, `cm`, `in`
- DPI and transparent background
- Raster formats: `RGBA8`, `RGBA16`, `RGBAUF`, `IA8`, `IA16`, `CMYKA8`, `LABA16`
- Designer artboards
- Publisher page count and facing pages
- Native Affinity 3 `.af` output

The destination directory must already exist. Pixel dimensions must be whole numbers.

## Safety model

- Input and output paths must be absolute, canonical, and inside `AFFINITY_MCP_ALLOWED_ROOTS`.
- Existing output files are never overwritten; final commits use exclusive copies.
- Input files must exist as regular readable files; in-place saves must also be writable native Affinity files.
- Canonical paths are checked so symlink traversal cannot escape an allowed root.
- Image size, text length, coordinates, dimensions, transforms, effects, page counts, DPI, and batch size have explicit ceilings.
- Text replacement uses literal matching, glyph-boundary mapping, exact history/count/fingerprint guards, one compound undo step per document, complete post-edit text readback, and a 5,000-match batch ceiling.
- A text scan is limited to 10,000 layers and 500,000 story glyphs. Insertions are limited to 2,000,000 UTF-16 code units per document and 5,000,000 per batch.
- Batch text apply preflights every open session before editing and never saves source documents implicitly.
- Export format and filename extension must match a curated preset.
- Batch exports preflight every destination, stage every result first, and roll back outputs created by a failed commit.
- Native calls time out and reconnect rather than blocking the script queue forever.
- The Affinity endpoint must remain loopback HTTP. The bridge handles IPv4 and IPv6 localhost listeners.
- User strings are JSON encoded into fixed SDK templates. Raw scripts, shell commands, and network access are not MCP tools.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AFFINITY_MCP_ALLOWED_ROOTS` | Server working directory | Path-delimited folders that inputs, saves, and outputs may use |
| `AFFINITY_MCP_ENDPOINT` | `http://localhost:6767/sse` | Affinity native connector; loopback HTTP only |
| `AFFINITY_APP_PATH` | `/Applications/Affinity.app` | Installed Affinity application path |
| `AFFINITY_BUNDLE_ID` | `com.canva.affinity` | Bundle ID used to launch/open files |
| `AFFINITY_MCP_STAGING_DIR` | `~/Desktop` | Existing writable directory available to Affinity's SDK |
| `AFFINITY_MCP_CONNECTOR_WAIT_MS` | `15000` | How long launch/open waits for the connector or document |
| `AFFINITY_MCP_CALL_TIMEOUT_MS` | `60000` | Maximum native MCP tool-call duration |

On macOS, multiple allowed roots are separated by `:`.

## Troubleshooting

- `AFFINITY_CONNECTOR_DISABLED`: enable both Affinity MCP settings, then call `affinity_status` again.
- `PATH_OUTSIDE_ALLOWED_ROOTS`: use a path beneath an allowed folder or deliberately update the server configuration.
- `PARENT_DIRECTORY_MISSING`: create the destination directory first.
- `OUTPUT_EXISTS`: choose a new filename; overwrite is intentionally refused.
- `INVALID_EXTENSION`: make the output extension match the selected export preset.
- `DOCUMENT_REQUIRES_SAVE_AS`: open or create a native `.af` document first; automated Save As is intentionally omitted because Affinity cannot close the staged backing document.
- `BATCH_TEXT_PREFLIGHT_FAILED`: rerun text dry-run because a document, match count, fingerprint, or editability state changed.
- `BATCH_TEXT_REPLACE_ROLLED_BACK`: a later batch edit failed and earlier content was restored; Affinity may still mark those documents as needing save.
- `BATCH_TEXT_ROLLBACK_INCOMPLETE`: an external edit changed history, so the MCP refused to risk undoing the wrong operation.
- `TEXT_REPLACE_NOT_APPLIED`: Affinity lost its response, but a follow-up audit verified the original plan unchanged; rerun find before retrying.
- `TEXT_REPLACE_STATE_UNCERTAIN`: Affinity lost its response and exact state could not be verified; inspect the document before retrying or undoing.
- `AFFINITY_CALL_TIMEOUT`: Affinity did not finish in the configured period; the next operation reconnects.
- If rebuilt tools do not appear, restart Codex so it launches the rebuilt MCP process.

## Contributing and security

Contributions are welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the development workflow. Please report security issues privately according to [`SECURITY.md`](./SECURITY.md), not in a public issue.

## License

Released under the [MIT License](./LICENSE).
