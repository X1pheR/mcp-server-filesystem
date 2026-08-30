# Tool reference

The server exposes the tracked upstream filesystem tools plus two narrowly scoped connector file-transport extensions. Every filesystem path remains constrained by the server's allowed-directory boundary.

| Tool | Access | Destructive | Purpose |
|---|---|---:|---|
| `read_file` | Read | No | Deprecated text-file reader retained for compatibility; use `read_text_file`. |
| `read_text_file` | Read | No | Read a text file, optionally limited to its first or last N lines. |
| `read_media_file` | Read | No | Preview image or audio content as a native MCP content block; generic binaries are rejected and no file/resource export is created. |
| `export_file` | Transport | No | Explicitly export/download/attach/transfer a file only after the required user-materialization confirmation; configured static export creates an externally reachable temporary copy. |
| `read_multiple_files` | Read | No | Read multiple text files in one call; individual file errors are returned without aborting all reads. |
| `write_file` | Write | Yes | Create a new text file or completely replace the content of an existing file. |
| `ingest_file` | Write | Yes when replacing; creates staged files otherwise | Stream a native ChatGPT connector file into the fixed configured ingress staging root with SHA-256 and atomic publication. |
| `edit_file` | Write | Yes when `dryRun=false` | Apply line-based text replacements and return a unified diff; `dryRun=true` previews without writing. |
| `create_directory` | Write | No | Create a directory and any missing parent directories; succeeds when the directory already exists. |
| `list_directory` | Read | No | List files and directories directly below a directory. |
| `list_directory_with_sizes` | Read | No | List directory entries with sizes and sort by name or size. |
| `directory_tree` | Read | No | Build a recursive JSON directory tree with optional exclusion patterns. |
| `move_file` | Write | Yes | Move or rename a file or directory within the allowed-directory boundary. |
| `search_files` | Read | No | Recursively search for files and directories using glob-style include and exclusion patterns. |
| `get_file_info` | Read | No | Return size, timestamps, type and permission metadata for a path. |
| `list_allowed_directories` | Read | No | Return the current directory roots that define the server's filesystem boundary. |

## Read tools

### `read_file`

Deprecated alias for `read_text_file`.

Inputs:

- `path`: file path;
- `head`: optional number of first lines;
- `tail`: optional number of last lines.

`head` and `tail` cannot be supplied together.

### `read_text_file`

Inputs are identical to `read_file`. The tool returns file content as text. The path must resolve inside an allowed directory.

### `read_media_file`

Input:

- `path`: file path.

Known image and audio extensions are returned as native image or audio MCP content. Other file types are rejected so this preview tool cannot become a generic user-visible resource/materialization path.

### `export_file`

Input:

- `path`: existing regular file path within the current allowed-directory boundary.
- `intent`: required explicit egress intent: `download`, `export`, `attach`, or `transfer`.
- `confirm_user_requested_materialization`: required literal `true`; set it only when the user explicitly requested that egress action. Preview/show/open/render/inspect/display intent is not approval.

The authorization gate runs before any ticket, copy, `resource_link`, or `file_uri` is created. The tool then rejects directories, non-regular files, paths outside the allowlist, symlink escapes, and files larger than `FILE_BRIDGE_MAX_EXPORT_BYTES` (50 MiB by default). It returns filename, MIME type, size, SHA-256 and an MCP `resource_link`.

When `FILE_BRIDGE_EXPORT_DIR` and `FILE_BRIDGE_EXPORT_PUBLIC_BASE_URL` are configured together, the server writes an exact atomic copy below a UUID-scoped directory in the static export root and returns the matching HTTPS URL plus `structuredContent.file_uri`. The static copy is mode `0644`, expires after `FILE_BRIDGE_EXPORT_TTL_MS`, and is removed by startup/periodic cleanup. Without static export configuration, the tool falls back to a short-lived `mcp-file://` resource available through `resources/read`.

The ordinary tool result contains no file body or large base64 payload. Because the tool reserves transport state and may create an externally reachable static copy, its annotations are `readOnlyHint=false`, `destructiveHint=false`, and `openWorldHint=true`.

The returned file reference is a download/materialization reference. Whether a client subsequently authorizes that returned file as a native file-parameter input is client-specific and is not guaranteed by this server.

### `read_multiple_files`

Input:

- `paths`: one or more file paths.

Each path is validated separately. A failure for one path is included in the combined result instead of aborting successful reads of the other paths.

### `list_directory`

Input:

- `path`: directory path.

Returns one `[FILE]` or `[DIR]` line per direct child.

### `list_directory_with_sizes`

Inputs:

- `path`: directory path;
- `sortBy`: optional `name` or `size`, default `name`.

Returns direct children with type and size information.

### `directory_tree`

Inputs:

- `path`: root directory;
- `excludePatterns`: optional glob-style patterns.

Recursively returns a JSON tree. Excluded paths are omitted from traversal/output.

### `search_files`

Inputs:

- `path`: search root;
- `pattern`: glob-style match pattern;
- `excludePatterns`: optional glob-style exclusions.

Only paths that remain within the allowed-directory boundary are traversed.

### `get_file_info`

Input:

- `path`: file or directory path.

Returns size, creation/access/modification timestamps, file/directory type and mode-derived permissions without reading file content.

### `list_allowed_directories`

No inputs. Returns the effective allowed directories. MCP Roots updates may replace this set during a session when the client supports Roots notifications.

## Mutating tools

### `ingest_file`

Inputs:

- `file`: native ChatGPT connector/runtime file parameter; declared through `_meta["openai/fileParams"]` and received by the server as `{download_url, file_id, mime_type?, file_name?}`;
- `file_name`: optional safe destination filename only;
- `expected_sha256`: optional expected 64-hex SHA-256;
- `overwrite`: optional boolean, default `false`.

The caller cannot choose a destination directory. All completed files land below `FILE_BRIDGE_INGRESS_DIR`, default `/tmp/mcp-file-ingress`. The ingress root must itself remain inside the server's existing allowlist. The server rejects traversal, absolute names, path separators, NUL bytes, destination symlinks and ingress-root escapes.

The connector download must use HTTPS and either a configured trusted runtime hostname suffix or the narrowly matched signed OpenAI runtime Azure Blob form `oaisdmntpr<region>.blob.core.windows.net`; arbitrary Azure Blob hosts are rejected. Redirect targets are revalidated. Bytes are streamed without media decoding/re-encoding, counted against `FILE_BRIDGE_MAX_INGEST_BYTES` (50 MiB by default), and hashed as they arrive. The temporary file is fsynced and optional `expected_sha256` is checked before publication. No-clobber publication is atomic; explicit overwrite uses atomic rename. Failures remove temporary files and never publish a hash-mismatched target.

The result contains metadata only: path, optional mapped host path, filename, size, MIME type, SHA-256 and whether an existing target was overwritten. The bridge does not promote, publish, manifest, commit or otherwise govern the staged file.

### `write_file`

Inputs:

- `path`: target file;
- `content`: complete new text content.

For a new path, the file is created exclusively so a pre-existing path is not silently followed. For an existing regular file, this downstream variant opens the existing inode with `O_NOFOLLOW`, truncates it and writes the replacement content in place.

Consequences for existing files:

- inode identity and hard-link identity are preserved;
- inode-associated metadata such as mode remains attached to the same inode;
- symlink targets are not followed by the in-place writer;
- rename atomicity is intentionally not provided, so interruption after truncation can leave partial content.

### `edit_file`

Inputs:

- `path`: target text file;
- `edits`: ordered `{oldText, newText}` replacements;
- `dryRun`: optional boolean, default `false`.

The tool applies edits sequentially and returns a unified diff. With `dryRun=true` it does not write. With `dryRun=false` it uses the same in-place existing-inode write behavior and durability tradeoff as `write_file`.

### `create_directory`

Input:

- `path`: directory to create.

Creates missing parents recursively. Existing directories are accepted without destructive replacement.

### `move_file`

Inputs:

- `source`: existing source path;
- `destination`: target path.

Both paths are validated against the allowed-directory boundary before the underlying filesystem rename is attempted. The operation changes pathname ownership of the source and can have platform-specific destination semantics; treat it as destructive.

## Boundary notes

The tool annotations are advisory metadata for MCP clients. They do not replace deployment policy. An operator should independently restrict allowed directories and the set of mutating tools exposed to an agent or user.
