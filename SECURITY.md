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

Shelf v1 refuses `cleanup=delete`, while reviewed trash purge can physically
remove quarantined trash. Reports involving unsafe file movement, purge path
handling, ledger tampering, cleanup plan execution, or trash purge execution are
still important.
