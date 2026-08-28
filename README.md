# Filesystem MCP Server

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/X1pheR/mcp-server-filesystem/badge)](https://scorecard.dev/viewer/?uri=github.com/X1pheR/mcp-server-filesystem)

A narrowly maintained downstream variant of the [Model Context Protocol filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem). It preserves the existing file inode and filesystem metadata for existing-file text writes and adds a bounded, binary-safe connector file bridge.

This is a community-maintained integration. It is not affiliated with, endorsed by, or officially maintained by the Model Context Protocol project.

## Why this variant exists

The upstream `2026.7.10` filesystem server replaces an existing file through a temporary-file rename. That is rename-atomic, but it replaces the inode and can therefore break file-bind consumers or discard inode-associated metadata.

This variant has two explicit downstream behavior deltas. Existing text-file replacement opens the existing file with `O_NOFOLLOW`, truncates it and writes the new content through the same file handle, preserving file identity, hard links, mode and other inode-associated metadata. The connector file bridge adds native connector-file ingress and downloadable file-reference export without routing binary payloads through ordinary model-visible tool JSON.

The existing-write tradeoff is explicit: an interrupted in-place text write can leave partial content after truncation. This variant therefore favors inode and metadata preservation over rename atomicity for existing text files. Bridge ingress uses separate atomic publication semantics and is not affected by that tradeoff.

See [`UPSTREAM.md`](UPSTREAM.md) for the exact baseline, tracked upstream fix and update procedure.

## Requirements

- Node.js 22 is the maintained build and CI baseline.
- At least one allowed directory must be supplied by command line or by an MCP client that provides Roots.
- The server only operates within its configured allowed-directory boundary.
- Connector-file ingress defaults to `/tmp/mcp-file-ingress`. Production deployments should set `FILE_BRIDGE_INGRESS_DIR` explicitly to a staging directory inside the configured allowed-directory boundary.

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

The server retains the upstream filesystem tools and adds two deliberately narrow file-transport tools.

| Capability | Tools |
|---|---|
| Read | `read_file` (deprecated), `read_text_file`, `read_media_file`, `read_multiple_files`, `list_directory`, `list_directory_with_sizes`, `directory_tree`, `search_files`, `get_file_info`, `list_allowed_directories` |
| File transport | `export_file`, `ingest_file` |
| Filesystem write | `write_file`, `edit_file`, `create_directory`, `move_file` |

See [`docs/tools.md`](docs/tools.md) for the complete 16-tool reference, including access and destructive classifications, important inputs and mutation semantics.

## Bidirectional connector file bridge

The bridge transports bytes only. It does not commit to Git, promote assets, update manifests, run shell commands, or decide whether an ingested file is canonical.

### Runtime to filesystem: `ingest_file`

`ingest_file` declares its top-level `file` input through ChatGPT's native `_meta["openai/fileParams"]` mechanism. The runtime supplies an authorized connector-file reference containing a temporary download URL and file ID; the model does not send base64 payloads through ordinary tool JSON. The server accepts configured trusted download-host suffixes and the narrowly matched signed OpenAI runtime Azure Blob pattern `oaisdmntpr<region>.blob.core.windows.net`; arbitrary Azure Blob hosts are not trusted. Redirect targets are revalidated before bytes are streamed.

All completed files are published below the server-controlled ingress root. The generic default is:

```text
/tmp/mcp-file-ingress
```

Production deployments should configure a staging path inside one of the server's existing allowed directories, for example:

```text
FILE_BRIDGE_INGRESS_DIR=/data/connector-ingress
```

The caller can optionally choose a safe filename, but cannot choose a destination directory or absolute path. Traversal, path separators, NUL bytes, destination symlinks, and ingress-root escapes are rejected. The default maximum ingest size is 50 MiB. SHA-256 is calculated while streaming. If `expected_sha256` is supplied, the temporary file is discarded unless the digest matches. Publication is atomic on the destination filesystem: no-clobber ingest uses an atomic hard-link publication and explicit overwrite uses an atomic rename. Temporary files are removed on failure.

Existing targets are refused by default. `overwrite=true` is required to replace an existing regular file.

### Filesystem to runtime: `export_file`

`export_file` accepts one existing path and applies the same filesystem allowlist and symlink-target validation as the rest of the server. Directories and non-regular files are rejected. The default maximum export size is 50 MiB. The server calculates SHA-256 and returns compact metadata plus an MCP `resource_link`.

`export_file` is intentionally not annotated read-only: even though it never modifies the source file, it reserves short-lived transport state and, when static export is configured, creates an externally reachable temporary copy. For HTTPS file download and host-side materialization, configure a directory already served by a trusted HTTPS static file server. The bridge creates a UUID-scoped directory, writes an exact bounded copy atomically, and returns `structuredContent.file_uri` with the resulting HTTPS URL, opaque file ID, MIME type, and filename. For example:

```text
FILE_BRIDGE_EXPORT_DIR=/var/www/downloads/tmp
FILE_BRIDGE_EXPORT_PUBLIC_BASE_URL=https://downloads.example.com/tmp
```

Static export copies are mode `0644` inside UUID directories and are removed after `FILE_BRIDGE_EXPORT_TTL_MS` (10 minutes by default). Cleanup runs at startup and periodically while the MCP process is alive; stale exports from an earlier process are therefore removed after restart as well. Deployments should configure their static server to disable caching and indexing for the export path.

A returned tool file reference makes the exported bytes available to file-aware clients, but client-side authorization semantics are outside this server's control. In particular, a client may support downloading or displaying a returned file without automatically authorizing that same tool result as a later native file-parameter input. Callers that require cross-tool file-input reuse must use an authorization flow supported by their client/host.

When static export is not configured, `export_file` falls back to a short-lived `mcp-file://` resource that compatible MCP clients can resolve through `resources/read`. The ordinary tool result never embeds the file body or a large base64 value.

`read_media_file` remains available for media display/backward compatibility and is not the preferred mechanism for downloadable connector-file export.

### Bridge configuration

| Variable | Default | Purpose |
|---|---|---|
| `FILE_BRIDGE_INGRESS_DIR` | `/tmp/mcp-file-ingress` | Server-controlled ingress staging root; must resolve inside the filesystem allowlist. |
| `FILE_BRIDGE_MAX_INGEST_BYTES` | `52428800` | Maximum accepted connector-file size. |
| `FILE_BRIDGE_MAX_EXPORT_BYTES` | `52428800` | Maximum exported file size. |
| `FILE_BRIDGE_MCP_ROOT` | unset | Optional source-side root used with `FILE_BRIDGE_HOST_ROOT` to derive `host_path` metadata. |
| `FILE_BRIDGE_HOST_ROOT` | unset | Optional mapped host root; must be configured together with `FILE_BRIDGE_MCP_ROOT`. |
| `FILE_BRIDGE_CONNECTOR_DOWNLOAD_HOSTS` | `oaiusercontent.com` | Comma-separated trusted HTTPS hostname suffixes for runtime-issued connector download URLs. The signed OpenAI runtime Azure Blob pattern is separately constrained. |
| `FILE_BRIDGE_EXPORT_DIR` | unset | Optional absolute staging directory already exposed by a trusted static HTTPS server. |
| `FILE_BRIDGE_EXPORT_PUBLIC_BASE_URL` | unset | Public HTTPS base URL corresponding to `FILE_BRIDGE_EXPORT_DIR`, for example `https://downloads.example.com/tmp`. |
| `FILE_BRIDGE_EXPORT_TTL_MS` | `600000` | Lifetime for static export copies and fallback resource tickets. |

The bridge never broadens the general filesystem allowlist. Static export is a separately configured egress staging directory and should contain only short-lived bridge copies.

## Security model

The allowed-directory boundary and MCP Roots handling remain the primary filesystem authorization boundary inherited from upstream. Paths are validated against that boundary and symlink targets outside it are rejected.

For existing-file writes, `O_NOFOLLOW` prevents the downstream in-place writer from following a symlink opened at the target path. This preserves the intended symlink-race protection while avoiding inode replacement.

Bridge ingress uses a separate fixed staging root, validates the real ingress path against the same allowlist, refuses destination symlinks, restricts connector downloads to HTTPS on configured trusted suffixes or the narrowly matched signed OpenAI runtime Azure Blob pattern, enforces byte limits while streaming, and publishes only after optional SHA-256 verification. Export revalidates the source path and file identity before creating a bounded static copy or fallback MCP resource. Static export directories are explicit deployment configuration, UUID-scoped, time-bounded and cleaned automatically.

The server does not provide authentication or authorization beyond its filesystem boundary and connector trust boundary. Restrict which directories are exposed and which MCP clients can invoke mutating tools according to the deployment environment.

## Deliberate exclusions

This repository deliberately does not include:

- extra deployment or lifecycle tools beyond the two bounded file-transport extensions;
- deployment-specific checkout paths, revision guards or environment configuration;
- an independent identity or authorization layer;
- automatic upstream source merges;
- npm publication automation.

Deployment policy belongs to the consuming environment, not to this reusable product repository.

## Feedback and contributions

Use [GitHub Issues](https://github.com/X1pheR/mcp-server-filesystem/issues) for bug reports and focused proposals and pull requests for proposed downstream changes. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, upstream-baseline requirements, tests, and change expectations. Security issues must follow the private process in [SECURITY.md](SECURITY.md).

User-visible downstream release changes are summarized in [CHANGELOG.md](CHANGELOG.md).

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

CI uses the same install, test and build contract. A weekly upstream check reports when the upstream repository publishes a release different from the baseline in `upstream.json`. Dependabot refreshes locked npm dependencies within the declared compatibility ranges and tracks GitHub Actions revisions; changes to declared major-version boundaries remain explicit compatibility work. OpenSSF Scorecard runs on `main` and weekly and publishes its public result for independent repository-security review.

The current immutable downstream release is `v2026.7.10-x1pher.1`. Normal development does not publish a release. An accepted version tag matching `v${package.json.version}` triggers the release workflow, which verifies the exact tag/source/package version, reruns locked verification, proves two independent packed npm artifacts are byte-identical, generates signed GitHub/Sigstore build provenance, creates a draft release, attaches the package, `SHA256SUMS` and provenance bundle, and only then publishes the release. The project deliberately does not publish to npm.

Security reports are handled according to [`SECURITY.md`](SECURITY.md).

## License

This downstream variant is distributed under the upstream MIT license. See [`LICENSE`](LICENSE). The Model Context Protocol project retains ownership of its upstream project and governance; this repository is an independently maintained downstream variant.
