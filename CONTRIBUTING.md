# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Before opening a change

- Use GitHub Issues for reproducible bugs and focused feature proposals.
- Use the private reporting process in [SECURITY.md](SECURITY.md) for suspected vulnerabilities.
- Keep changes narrowly scoped; this repository intentionally tracks one upstream filesystem-server baseline plus explicit downstream deltas.
- Never include private filesystem contents, credentials, host-specific deployment paths, or other sensitive material in issues, fixtures, tests, logs, or commits.

## Development setup

Use Node.js 22 and the committed lock file:

```bash
npm ci --ignore-scripts
npm run verify
npm pack --ignore-scripts --dry-run
```

## Change requirements

- Add or update automated tests for downstream behavior changes and bug fixes where a regression test is practical.
- Preserve the upstream filesystem tool surface unless a product decision explicitly owns a surface change.
- Update `UPSTREAM.md` and `upstream.json` when adopting a new upstream baseline or changing the tracked upstream patch relationship.
- Update `docs/tools.md` when the public tool contract changes.
- Update README or security documentation when requirements, write semantics, compatibility, or trust boundaries change.
- Add a concise entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- Keep dependency changes within declared compatibility ranges unless the pull request explicitly owns a compatibility change.

A pull request is ready for review when the locked build/tests/package checks pass and its documentation describes any upstream or behavioral delta it changes.
