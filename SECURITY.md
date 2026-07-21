# Security Policy

## Supported version

Security fixes are applied to the latest released version.

## Reporting a vulnerability

Do not report suspected vulnerabilities in a public issue. Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Include affected tools, reproducible steps, expected impact, and any suggested mitigation.

Please remove credentials, private document content, and personal filesystem paths from reports. The maintainer will acknowledge a report when practical and coordinate disclosure after a fix is available.

## Security boundaries

This server intentionally exposes fixed, validated Affinity operations rather than raw script execution. File access is restricted to configured roots, output operations refuse overwrite, and the Affinity connector must remain on loopback HTTP. These controls reduce risk but do not make untrusted MCP clients or untrusted local files safe.
