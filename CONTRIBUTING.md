# Contributing

Thanks for helping improve Affinity Creative MCP.

## Development setup

Requirements:

- macOS
- Node.js 22.7.5 or newer
- Affinity 3 for live integration testing

Install dependencies and run the complete automated suite:

```bash
npm ci
npm run check
```

The unit and protocol tests use fakes and do not require Affinity. Live testing requires Affinity's native MCP connector and Desktop access to be enabled.

## Pull requests

1. Keep public tools narrow, validated, and bounded.
2. Do not expose Affinity's unrestricted `execute_script` tool.
3. Add or update tests for every behavior change.
4. Run `npm run check` before opening a pull request.
5. Document new tools, safety limits, and user-visible behavior in `README.md`.

Generated `dist/` files are intentionally not committed. They are produced by `npm run build` and included automatically when the package is packed.

## Live-testing precautions

- Use disposable Affinity documents.
- Preview edits before saving.
- Do not overwrite user files.
- Clean up random Desktop staging files after their Affinity documents are closed.
- Preserve unrelated open or unsaved documents.

## Issues

Use GitHub Issues for reproducible bugs and focused feature requests. Include the macOS version, Affinity version, Node.js version, MCP client, tool name, and sanitized error output. Do not include private documents, credentials, or personal paths.
