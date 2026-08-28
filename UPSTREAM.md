# Upstream tracking

This repository is a focused downstream variant of the filesystem server in [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem).

The machine-readable upstream baseline is [`upstream.json`](upstream.json):

- release: `2026.7.10`;
- commit: `9a96ea6e5913736f92b88345bf51caeaaa8e719f`;
- package: `@modelcontextprotocol/server-filesystem@2026.7.10`;
- tracked upstream fix: [`modelcontextprotocol/servers#4516`](https://github.com/modelcontextprotocol/servers/pull/4516).

## Downstream delta

Application behavior intentionally differs from the upstream baseline in two reviewed areas:

1. Existing-file writes performed by `write_file` and non-dry-run `edit_file` write through the existing inode with `O_NOFOLLOW` rather than replacing the path through a temporary-file rename. This preserves file identity, hard links, birth time and existing filesystem metadata that would otherwise be lost when the inode is replaced.
2. The downstream variant adds `ingest_file` and `export_file` as bounded transport-only extensions. `ingest_file` uses ChatGPT's native file-parameter metadata and a fixed configured staging root. `export_file` returns a short-lived MCP resource link and can materialize a downloadable `structuredContent.file_uri` reference by writing a time-bounded copy into a deployment-configured static HTTPS directory. Neither extension performs lifecycle, publication or Git operations.

The repository also contains standalone package/build configuration, regression tests, public documentation and GitHub maintenance automation. Those are packaging and maintenance differences, not additional MCP behavior.

## Update procedure

When `upstream-check.yml` reports a different upstream release:

1. inspect the newer `src/filesystem` source and release notes;
2. determine whether equivalent inode-preserving behavior is included upstream;
3. review the existing-write delta and the connector-file bridge independently against the newer upstream capabilities; remove any downstream behavior that upstream now satisfies end to end;
4. otherwise, import the newer filesystem source exactly and reapply only the still-required reviewed downstream deltas;
5. run `npm ci --ignore-scripts`, `npm run verify`, the real-filesystem regression tests and package validation;
6. update `upstream.json` only after the new baseline is reviewed.

Do not automatically merge an upstream source update. The local write behavior changes durability semantics and requires explicit compatibility review.
