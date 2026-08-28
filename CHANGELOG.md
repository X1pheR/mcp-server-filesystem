# Changelog

## 2026.7.10-x1pher.8 - 2026-08-29

- Republished the clean generic product state after repository immutable-release protection was enabled; no file-transport behavior changed.

## 2026.7.10-x1pher.7 - 2026-08-29

- Added a bounded binary-safe connector file bridge with native file-parameter ingress, streaming size limits, SHA-256 verification, path and symlink defenses, atomic publication, and no-clobber defaults.
- Added bounded export metadata plus short-lived downloadable/materializable file references, with optional atomic static HTTPS staging and TTL cleanup configured entirely by the deployment environment.
- Kept deployment policy, host paths, domains, runtime naming, and infrastructure-specific configuration outside this reusable public package.
- Clarified that automatic authorization of an exported reference as a later native file-parameter input is client-specific and is not guaranteed by the server.
- Consolidated the maintained bridge work into this release so the recreated public repository contains only deployment-neutral product history and release metadata.

This file records user-visible changes to the maintained downstream `mcp-server-filesystem` product. Upstream-baseline changes are also documented in [UPSTREAM.md](UPSTREAM.md).

## Unreleased

## 2026.7.10-x1pher.1 - 2026-08-14

Initial public downstream release based on `@modelcontextprotocol/server-filesystem@2026.7.10`.

- Preserved the upstream 14-tool filesystem surface.
- Applied the narrow existing-file write change aligned with upstream PR `#4516` so writes preserve the existing inode, hard links, mode and inode-associated metadata.
- Retained `O_NOFOLLOW` protection on existing-file writes while explicitly documenting the durability tradeoff of in-place truncation/write semantics.
- Published the packed npm artifact with `SHA256SUMS`; production consumption uses the immutable release rather than a mutable checkout.
