# Tool reference

The server exposes the same 14 MCP tools as the tracked upstream filesystem baseline. Every path is constrained by the server's allowed-directory boundary.

| Tool | Access | Destructive | Purpose |
|---|---|---:|---|
| `read_file` | Read | No | Deprecated text-file reader retained for compatibility; use `read_text_file`. |
| `read_text_file` | Read | No | Read a text file, optionally limited to its first or last N lines. |
| `read_media_file` | Read | No | Read media or binary content as an MCP image, audio or embedded resource content block. |
| `read_multiple_files` | Read | No | Read multiple text files in one call; individual file errors are returned without aborting all reads. |
| `write_file` | Write | Yes | Create a new text file or completely replace the content of an existing file. |
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

Known image and audio extensions are returned as image or audio MCP content. Other binary content is returned as an embedded resource with a MIME type and base64 payload.

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
