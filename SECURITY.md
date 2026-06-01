# Security

## Supported Versions

Shelf is pre-1.0. Security fixes target the current `main` branch until release
channels are established.

## Reporting A Vulnerability

Please do not open a public issue for vulnerabilities that could put users at
risk. Contact the maintainer privately, or open a minimal GitHub security
advisory once the public remote exists.

Include:

- affected version or commit
- operating system
- reproduction steps
- expected impact

Shelf v1 refuses physical delete operations, but reports involving unsafe file
movement, path handling, ledger tampering, or cleanup plan execution are still
important.
