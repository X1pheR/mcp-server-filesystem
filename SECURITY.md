# Security policy

## Reporting a vulnerability

Please report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/X1pheR/mcp-server-filesystem/security/advisories/new). Do not include credentials, private filesystem contents or other secrets in a public issue.

If private vulnerability reporting is unexpectedly unavailable, open a public issue that contains only enough non-sensitive information to request a private follow-up channel.

## Scope

Security reports are especially relevant when they involve:

- escaping the configured allowed-directory boundary;
- symlink or path-validation bypasses;
- unintended file mutation or deletion;
- differences introduced by the downstream in-place write behavior;
- ingress filename, staging-root, size-limit or connector-download trust-boundary bypasses;
- export ticket/HTTPS resource-link authorization, stale-file, size-limit or file-identity bypasses;
- dependency vulnerabilities that are exploitable through this server.

The downstream existing-file write intentionally trades rename atomicity for inode preservation. An interrupted write can therefore leave partial content; that documented durability tradeoff is not by itself a vulnerability. Connector-file ingress is separate: it writes to an unlinked/exclusive temporary file and publishes only after bounded transfer, fsync and optional digest verification. Runtime download URLs must remain HTTPS and inside the configured OpenAI trust boundary; the built-in Azure exception is limited to signed readable URLs on the `oaisdmntpr<region>.blob.core.windows.net` pattern rather than generic Azure Blob storage. Static export uses UUID-scoped directories, a bounded TTL, atomic copy publication and periodic cleanup. The deployment-owned HTTPS server is responsible for cache/indexing policy on that path; the bridge never exposes an embedded HTTP listener.

## Supported version

The latest accepted downstream release is the supported public line unless a release note states otherwise. Security fixes are developed on the reviewed `main` branch and released through the normal downstream release lifecycle.

## Dependency and code security

The repository uses a committed npm lock file, full-SHA-pinned GitHub Actions, locked CI/package verification, Dependabot, upstream release tracking and OpenSSF Scorecard. Public-release acceptance also requires applicable GitHub-native dependency alerts, secret scanning with push protection and CodeQL code scanning to be reviewed and green before a release is published.

These controls supplement rather than replace review of the narrow downstream patch and its upstream relationship.
