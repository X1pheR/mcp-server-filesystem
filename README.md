# Filesystem MCP Server

A narrowly maintained downstream variant of the [Model Context Protocol filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) that preserves the existing file inode and filesystem metadata when `write_file` or `edit_file` changes an existing file.

This is a community-maintained integration. It is not affiliated with, endorsed by, or officially maintained by the Model Context Protocol project.

## Why this variant exists

The upstream `2026.7.10` filesystem server replaces an existing file through a temporary-file rename. That is rename-atomic, but it replaces the inode and can therefore break file-bind consumers or discard inode-associated metadata.

This variant keeps upstream behavior except for existing-file replacement. It opens the existing file with `O_NOFOLLOW`, truncates it and writes the new content through the same file handle. As a result, file identity, hard links, mode and other inode-associated metadata remain attached to the same inode.

The tradeoff is explicit: an interrupted in-place write can leave partial content after truncation. This variant therefore favors inode and metadata preservation over rename atomicity for existing files. New-file creation keeps the upstream exclusive-create behavior.

See [`UPSTREAM.md`](UPSTREAM.md) for the exact baseline, tracked upstream fix and update procedure.

## Requirements

- Node.js 22 is the maintained build and CI baseline.
- At least one allowed directory must be supplied by command line or by an MCP client that provides Roots.
- The server only operates within its configured allowed-directory boundary.

## Install and build

```bash
npm ci --ignore-scripts
npm run build
```

Run the built STDIO server with one or more allowed directories:

```bash
node dist/index.js /allowed/root [/another/root]
```

Example MCP client configuration after building the repository:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": [
        "/path/to/mcp-server-filesystem/dist/index.js",
        "/path/to/allowed/root"
      ]
    }
  }
}
```

Pin production consumption to an immutable reviewed release rather than a mutable branch checkout.

## MCP surface

The server intentionally retains the upstream filesystem tool surface. It does not add deployment-specific administration tools.

| Capability | Tools |
|---|---|
| Read | `read_file` (deprecated), `read_text_file`, `read_media_file`, `read_multiple_files`, `list_directory`, `list_directory_with_sizes`, `directory_tree`, `search_files`, `get_file_info`, `list_allowed_directories` |
| Write | `write_file`, `edit_file`, `create_directory`, `move_file` |

See [`docs/tools.md`](docs/tools.md) for the complete 14-tool reference, including access and destructive classifications, important inputs and mutation semantics.

## Security model

The allowed-directory boundary and MCP Roots handling remain the primary filesystem authorization boundary inherited from upstream. Paths are validated against that boundary and symlink targets outside it are rejected.

For existing-file writes, `O_NOFOLLOW` prevents the downstream in-place writer from following a symlink opened at the target path. This preserves the intended symlink-race protection while avoiding inode replacement.

The server does not provide authentication or authorization beyond its filesystem boundary. Restrict which directories are exposed and which MCP clients can invoke mutating tools according to the deployment environment.

## Deliberate exclusions

This repository deliberately does not include:

- extra filesystem tools beyond the upstream surface;
- deployment-specific checkout paths, revision guards or environment configuration;
- an independent identity or authorization layer;
- automatic upstream source merges;
- npm publication automation.

Deployment policy belongs to the consuming environment, not to this reusable product repository.

## Compatibility

The maintained downstream baseline is exactly `@modelcontextprotocol/server-filesystem@2026.7.10` from upstream commit `9a96ea6e5913736f92b88345bf51caeaaa8e719f` plus the narrow existing-file write patch described above.

Newer upstream releases are not considered supported until they have been reviewed and adopted through the process in [`UPSTREAM.md`](UPSTREAM.md).

## Development

Run the complete repository verification locally with:

```bash
npm ci --ignore-scripts
npm run verify
npm pack --ignore-scripts --dry-run
```

CI uses the same install, test and build contract. A weekly upstream check reports when the upstream repository publishes a release different from the baseline in `upstream.json`. Dependabot refreshes locked npm dependencies within the declared compatibility ranges and tracks GitHub Actions revisions; changes to declared major-version boundaries remain explicit compatibility work.

Accepted version tags can create a GitHub Release containing the packed npm artifact and `SHA256SUMS`. Creating the first version tag remains an explicit release decision.

Security reports are handled according to [`SECURITY.md`](SECURITY.md).

## License

This downstream variant is distributed under the upstream MIT license. See [`LICENSE`](LICENSE). The Model Context Protocol project retains ownership of its upstream project and governance; this repository is an independently maintained downstream variant.
