# Security Policy

## Supported Scope

`claudy-talky` is designed for local, CLI-first collaboration on a single machine. The broker is intended to stay bound to `127.0.0.1` and should not be exposed directly to untrusted networks.

The current supported security posture applies to the latest `main` branch only.

## Reporting a Vulnerability

Please do not open a public issue for a sensitive security report.

Preferred order:

1. Use GitHub private vulnerability reporting or a GitHub Security Advisory, if available for this repository.
2. If private reporting is not available, contact the repository owner directly before public disclosure.
3. Use public issues only for non-sensitive hardening suggestions that do not expose a live exploit path.

## Security Notes

- Broker auth tokens are local session credentials. Treat them as secrets and do not log or publish them.
- Do not commit local SQLite databases, broker logs, or local launch shortcuts.
- Review any MCP config before publishing it. Keep machine-specific paths and personal environment details out of tracked files when possible.
- The current auth and broker model is intended as local-machine protection, not as a hardened internet-facing service boundary.
