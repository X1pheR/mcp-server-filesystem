# Security policy

## Reporting a vulnerability

Please report vulnerabilities through GitHub private vulnerability reporting when it is available for this repository. Do not include credentials, private filesystem contents or other secrets in a public issue.

If private vulnerability reporting is unavailable, open a public issue that contains only enough non-sensitive information to request a private follow-up channel.

## Scope

Security reports are especially relevant when they involve:

- escaping the configured allowed-directory boundary;
- symlink or path-validation bypasses;
- unintended file mutation or deletion;
- differences introduced by the downstream in-place write behavior;
- dependency vulnerabilities that are exploitable through this server.

The downstream existing-file write intentionally trades rename atomicity for inode preservation. An interrupted write can therefore leave partial content; that documented durability tradeoff is not by itself a vulnerability.

## Supported version

Until the first immutable downstream release is published, only the current reviewed `main` revision is maintained. After releases begin, the latest accepted downstream release is the supported line unless a release note states otherwise.
