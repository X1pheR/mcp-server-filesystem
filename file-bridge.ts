import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import fs, { type FileHandle } from 'fs/promises';
import path from 'path';

import { getAllowedDirectories, validatePath } from './lib.js';
import { isPathWithinAllowedDirectories } from './path-validation.js';

export const DEFAULT_INGRESS_DIR = '/tmp/mcp-file-ingress';
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_CONNECTOR_DOWNLOAD_HOST_SUFFIXES = ['oaiusercontent.com'];
const OPENAI_RUNTIME_AZURE_BLOB_HOST_PATTERN = /^oaisdmntpr[a-z0-9]+\.blob\.core\.windows\.net$/;
const DEFAULT_EXPORT_TTL_MS = 10 * 60 * 1000;
const MAX_EXPORT_TICKETS = 1024;
const IO_CHUNK_BYTES = 64 * 1024;

export interface BridgeConfig {
  ingressDir: string;
  maxIngestBytes: number;
  maxExportBytes: number;
  mcpRoot?: string;
  hostRoot?: string;
  connectorDownloadHostSuffixes: string[];
  exportDir?: string;
  exportPublicBaseUrl?: string;
  exportTtlMs: number;
}

export interface ConnectorFileInput {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface IngestRequest {
  file: ConnectorFileInput;
  file_name?: string;
  expected_sha256?: string;
  overwrite?: boolean;
}

export interface FileMetadata extends Record<string, unknown> {
  path: string;
  host_path?: string;
  file_name: string;
  size: number;
  mime_type: string;
  sha256: string;
}

export interface IngestMetadata extends FileMetadata {
  overwritten: boolean;
}

export interface ExportMetadata extends FileMetadata {
  resource_uri: string;
  file_uri?: ConnectorFileInput;
}

interface ExportTicket {
  path: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  expiresAt: number;
}

export interface ExportResource {
  uri: string;
  mimeType: string;
  blob: string;
}

export type FetchLike = typeof fetch;

const exportTickets = new Map<string, ExportTicket>();

function parsePositiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function parseHostSuffixes(raw: string | undefined): string[] {
  const values = (raw ?? DEFAULT_CONNECTOR_DOWNLOAD_HOST_SUFFIXES.join(','))
    .split(',')
    .map((value) => value.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean);
  if (values.length === 0 || values.some((value) => value.includes('/') || value.includes(':'))) {
    throw new Error('FILE_BRIDGE_CONNECTOR_DOWNLOAD_HOSTS contains an invalid hostname suffix');
  }
  return [...new Set(values)];
}

function parseOptionalAbsolutePath(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  if (raw.includes('\0') || !path.isAbsolute(raw)) {
    throw new Error(`${name} must be an absolute path without NUL bytes`);
  }
  return path.resolve(raw);
}

function parseExportPublicBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('FILE_BRIDGE_EXPORT_PUBLIC_BASE_URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('FILE_BRIDGE_EXPORT_PUBLIC_BASE_URL must use HTTPS and contain no credentials, query, or fragment');
  }
  const pathName = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathName === '/' ? '' : pathName}`;
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const mcpRoot = parseOptionalAbsolutePath(env.FILE_BRIDGE_MCP_ROOT, 'FILE_BRIDGE_MCP_ROOT');
  const hostRoot = parseOptionalAbsolutePath(env.FILE_BRIDGE_HOST_ROOT, 'FILE_BRIDGE_HOST_ROOT');
  if (Boolean(mcpRoot) !== Boolean(hostRoot)) {
    throw new Error('FILE_BRIDGE_MCP_ROOT and FILE_BRIDGE_HOST_ROOT must be configured together');
  }

  const exportDir = parseOptionalAbsolutePath(env.FILE_BRIDGE_EXPORT_DIR, 'FILE_BRIDGE_EXPORT_DIR');
  const exportPublicBaseUrl = parseExportPublicBaseUrl(env.FILE_BRIDGE_EXPORT_PUBLIC_BASE_URL);
  if (Boolean(exportDir) !== Boolean(exportPublicBaseUrl)) {
    throw new Error('FILE_BRIDGE_EXPORT_DIR and FILE_BRIDGE_EXPORT_PUBLIC_BASE_URL must be configured together');
  }

  return {
    ingressDir: env.FILE_BRIDGE_INGRESS_DIR || DEFAULT_INGRESS_DIR,
    maxIngestBytes: parsePositiveInteger(
      env.FILE_BRIDGE_MAX_INGEST_BYTES,
      DEFAULT_MAX_FILE_BYTES,
      'FILE_BRIDGE_MAX_INGEST_BYTES',
    ),
    maxExportBytes: parsePositiveInteger(
      env.FILE_BRIDGE_MAX_EXPORT_BYTES,
      DEFAULT_MAX_FILE_BYTES,
      'FILE_BRIDGE_MAX_EXPORT_BYTES',
    ),
    mcpRoot,
    hostRoot,
    connectorDownloadHostSuffixes: parseHostSuffixes(env.FILE_BRIDGE_CONNECTOR_DOWNLOAD_HOSTS),
    exportDir,
    exportPublicBaseUrl,
    exportTtlMs: parsePositiveInteger(
      env.FILE_BRIDGE_EXPORT_TTL_MS,
      DEFAULT_EXPORT_TTL_MS,
      'FILE_BRIDGE_EXPORT_TTL_MS',
    ),
  };
}

function isHostnameAllowed(hostname: string, suffixes: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isOpenAiRuntimeAzureBlobUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!OPENAI_RUNTIME_AZURE_BLOB_HOST_PATTERN.test(host)) return false;

  const permissions = url.searchParams.get('sp') || '';
  return permissions.includes('r') && Boolean(url.searchParams.get('se')) && Boolean(url.searchParams.get('sig'));
}

export function validateConnectorDownloadUrl(rawUrl: string, config: BridgeConfig): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Connector file download URL is invalid');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Connector file download URL must use HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Connector file download URL must not contain credentials');
  }
  if (
    !isHostnameAllowed(url.hostname, config.connectorDownloadHostSuffixes)
    && !isOpenAiRuntimeAzureBlobUrl(url)
  ) {
    throw new Error(`Connector file download URL host is not trusted: ${url.hostname}`);
  }
  return url;
}

function validateExpectedSha256(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('expected_sha256 must be exactly 64 hexadecimal characters');
  }
  return value.toLowerCase();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

export function sanitizeFileName(value: string): string {
  if (value.includes('\0')) throw new Error('file_name must not contain NUL bytes');
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('file_name must not be an absolute path');
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error('file_name must contain a filename only, not path separators');
  }

  const normalized = value.normalize('NFC').trim();
  if (normalized === '' || normalized === '.' || normalized === '..') {
    throw new Error('file_name is not a usable filename');
  }

  const sanitized = normalized.replace(/[\u0001-\u001f\u007f]/g, '_');
  const bounded = truncateUtf8(sanitized, 240);
  if (bounded === '' || bounded === '.' || bounded === '..') {
    throw new Error('file_name is not a usable filename');
  }
  return bounded;
}

function sourceFileName(file: ConnectorFileInput): string {
  if (file.file_name) {
    try {
      return sanitizeFileName(file.file_name);
    } catch {
      // A runtime-provided source name is advisory. Unsafe names are never used.
    }
  }
  const compactId = file.file_id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return sanitizeFileName(compactId ? `connector-${compactId}.bin` : `connector-${randomUUID()}.bin`);
}

export function inferMimeType(fileName: string, providedMimeType?: string): string {
  if (providedMimeType && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;.*)?$/.test(providedMimeType)) {
    return providedMimeType.split(';', 1)[0].toLowerCase();
  }
  const extension = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
  };
  return mimeTypes[extension] || 'application/octet-stream';
}

function metadataHostPath(filePath: string, config: BridgeConfig): string | undefined {
  if (!config.mcpRoot || !config.hostRoot) return undefined;
  const mcpRoot = path.resolve(config.mcpRoot);
  const resolved = path.resolve(filePath);
  const relative = path.relative(mcpRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return path.join(path.resolve(config.hostRoot), relative);
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`No existing ancestor for ${candidate}`);
      current = parent;
    }
  }
}

export async function ensureIngressRoot(config: BridgeConfig): Promise<string> {
  if (config.ingressDir.includes('\0') || !path.isAbsolute(config.ingressDir)) {
    throw new Error('FILE_BRIDGE_INGRESS_DIR must be an absolute path without NUL bytes');
  }
  const requested = path.resolve(config.ingressDir);
  const allowed = getAllowedDirectories();
  if (!isPathWithinAllowedDirectories(requested, allowed)) {
    throw new Error('Configured ingress directory is outside the filesystem allowlist');
  }

  const ancestor = await nearestExistingAncestor(requested);
  if (!isPathWithinAllowedDirectories(ancestor, allowed)) {
    throw new Error('Configured ingress directory resolves through an ancestor outside the allowlist');
  }

  await fs.mkdir(requested, { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(requested);
  if (!isPathWithinAllowedDirectories(realRoot, allowed)) {
    throw new Error('Configured ingress directory resolves outside the filesystem allowlist');
  }
  return realRoot;
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
  } finally {
    await handle.close();
  }
}

async function targetState(finalPath: string): Promise<'missing' | 'file'> {
  try {
    const stats = await fs.lstat(finalPath);
    if (stats.isSymbolicLink()) throw new Error('Ingress destination must not be a symbolic link');
    if (!stats.isFile()) throw new Error('Ingress destination exists but is not a regular file');
    return 'file';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function fetchConnectorResponse(
  initialUrl: URL,
  config: BridgeConfig,
  fetchImpl: FetchLike,
): Promise<Response> {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetchImpl(current, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error('Connector file download redirect omitted Location');
      if (redirectCount === 3) throw new Error('Connector file download exceeded redirect limit');
      current = validateConnectorDownloadUrl(new URL(location, current).href, config);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Connector file download failed with HTTP ${response.status}`);
    }
    return response;
  }
  throw new Error('Connector file download failed');
}

async function streamResponseToFile(
  response: Response,
  handle: FileHandle,
  maxBytes: number,
): Promise<{ size: number; sha256: string }> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Connector file exceeds maximum ingest size of ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error('Connector file download returned no body');

  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Connector file exceeds maximum ingest size of ${maxBytes} bytes`);
      }
      const chunk = Buffer.from(value);
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return { size, sha256: hash.digest('hex') };
}

export async function ingestConnectorFile(
  request: IngestRequest,
  config: BridgeConfig = loadBridgeConfig(),
  fetchImpl: FetchLike = fetch,
): Promise<IngestMetadata> {
  const expectedSha256 = validateExpectedSha256(request.expected_sha256);
  if (!request.file.file_id) throw new Error('Connector file is missing file_id');
  const sourceUrl = validateConnectorDownloadUrl(request.file.download_url, config);
  const fileName = request.file_name
    ? sanitizeFileName(request.file_name)
    : sourceFileName(request.file);
  const ingressRoot = await ensureIngressRoot(config);
  const finalPath = path.join(ingressRoot, fileName);
  if (path.dirname(finalPath) !== ingressRoot) {
    throw new Error('Ingress destination resolves outside the ingress root');
  }

  const before = await targetState(finalPath);
  if (before === 'file' && !request.overwrite) {
    throw new Error(`Ingress destination already exists: ${fileName}`);
  }

  const temporaryPath = path.join(ingressRoot, `.ingest-${process.pid}-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let temporaryHandle: FileHandle | undefined;
  try {
    temporaryHandle = await fs.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;

    const response = await fetchConnectorResponse(sourceUrl, config, fetchImpl);
    const streamed = await streamResponseToFile(response, temporaryHandle, config.maxIngestBytes);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    if (expectedSha256 && streamed.sha256 !== expectedSha256) {
      throw new Error(
        `SHA-256 mismatch: expected ${expectedSha256}, received ${streamed.sha256}`,
      );
    }

    if (request.overwrite) {
      const stateAtCommit = await targetState(finalPath);
      await fs.rename(temporaryPath, finalPath);
      temporaryCreated = false;
      await fsyncDirectory(ingressRoot);
      return {
        path: finalPath,
        host_path: metadataHostPath(finalPath, config),
        file_name: fileName,
        size: streamed.size,
        mime_type: inferMimeType(fileName, request.file.mime_type),
        sha256: streamed.sha256,
        overwritten: stateAtCommit === 'file',
      };
    }

    // link(2) is an atomic no-clobber publication on the same filesystem.
    // It fails with EEXIST if a competing writer creates the destination.
    try {
      await fs.link(temporaryPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Ingress destination already exists: ${fileName}`);
      }
      throw error;
    }
    await fs.unlink(temporaryPath);
    temporaryCreated = false;
    await fsyncDirectory(ingressRoot);
    return {
      path: finalPath,
      host_path: metadataHostPath(finalPath, config),
      file_name: fileName,
      size: streamed.size,
      mime_type: inferMimeType(fileName, request.file.mime_type),
      sha256: streamed.sha256,
      overwritten: false,
    };
  } finally {
    if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
    if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

async function hashOpenFile(
  handle: FileHandle,
  maxBytes: number,
  collectBytes: boolean,
): Promise<{ size: number; sha256: string; bytes?: Buffer; dev: number; ino: number; mtimeMs: number }> {
  const before = await handle.stat();
  if (!before.isFile()) throw new Error('Path is not a regular file');
  if (before.size > maxBytes) throw new Error(`File exceeds maximum export size of ${maxBytes} bytes`);

  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  let position = 0;
  while (position < before.size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, before.size - position),
      position,
    );
    if (bytesRead === 0) break;
    const chunk = Buffer.from(buffer.subarray(0, bytesRead));
    hash.update(chunk);
    if (collectBytes) chunks.push(chunk);
    position += bytesRead;
  }

  const after = await handle.stat();
  if (
    position !== before.size ||
    after.size !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error('File changed while it was being exported');
  }

  return {
    size: position,
    sha256: hash.digest('hex'),
    bytes: collectBytes ? Buffer.concat(chunks, position) : undefined,
    dev: after.dev,
    ino: after.ino,
    mtimeMs: after.mtimeMs,
  };
}

function reserveExportTicket(token: string, ticket: ExportTicket): void {
  const now = Date.now();
  for (const [existingToken, existing] of exportTickets) {
    if (existing.expiresAt < now) exportTickets.delete(existingToken);
  }
  if (exportTickets.size >= MAX_EXPORT_TICKETS) {
    throw new Error('Too many active export resources; retry after an existing export expires');
  }
  exportTickets.set(token, ticket);
}

async function openValidatedExportFile(requestedPath: string): Promise<{ path: string; handle: FileHandle }> {
  const validPath = await validatePath(requestedPath);
  const stats = await fs.stat(validPath);
  if (stats.isDirectory()) throw new Error('Cannot export a directory');
  if (!stats.isFile()) throw new Error('Cannot export a non-regular file');
  const handle = await fs.open(validPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  return { path: validPath, handle };
}

async function ensureStaticExportRoot(config: BridgeConfig): Promise<string | undefined> {
  if (!config.exportDir) return undefined;
  await fs.mkdir(config.exportDir, { recursive: true, mode: 0o755 });
  const stats = await fs.lstat(config.exportDir);
  if (stats.isSymbolicLink()) throw new Error('Configured static export directory must not be a symbolic link');
  if (!stats.isDirectory()) throw new Error('Configured static export path is not a directory');
  return fs.realpath(config.exportDir);
}

function isExportTokenName(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name);
}

export async function cleanupExpiredStaticExports(
  config: BridgeConfig = loadBridgeConfig(),
  now = Date.now(),
): Promise<number> {
  const exportRoot = await ensureStaticExportRoot(config);
  if (!exportRoot) return 0;
  let removed = 0;
  for (const entry of await fs.readdir(exportRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isExportTokenName(entry.name)) continue;
    const candidate = path.join(exportRoot, entry.name);
    const stats = await fs.lstat(candidate);
    if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
    if (now - stats.mtimeMs < config.exportTtlMs) continue;
    await fs.rm(candidate, { recursive: true, force: false });
    removed += 1;
  }
  return removed;
}

async function materializeStaticExport(
  token: string,
  fileName: string,
  bytes: Buffer,
  config: BridgeConfig,
): Promise<string | undefined> {
  if (!config.exportDir || !config.exportPublicBaseUrl) return undefined;
  const exportRoot = await ensureStaticExportRoot(config);
  if (!exportRoot) return undefined;
  await cleanupExpiredStaticExports(config);

  const tokenDirectory = path.join(exportRoot, token);
  await fs.mkdir(tokenDirectory, { mode: 0o755 });
  const finalPath = path.join(tokenDirectory, fileName);
  const temporaryPath = path.join(tokenDirectory, `.export-${process.pid}-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  try {
    handle = await fs.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(0o644);
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, finalPath);
    temporaryCreated = false;
    await fsyncDirectory(tokenDirectory);
    await fsyncDirectory(exportRoot);
    return `${config.exportPublicBaseUrl}/${token}/${encodeURIComponent(fileName)}`;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => undefined);
    await fs.rm(tokenDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function createExport(
  requestedPath: string,
  config: BridgeConfig = loadBridgeConfig(),
): Promise<ExportMetadata> {
  const opened = await openValidatedExportFile(requestedPath);
  try {
    const useStaticExport = Boolean(config.exportDir && config.exportPublicBaseUrl);
    const hashed = await hashOpenFile(opened.handle, config.maxExportBytes, useStaticExport);
    const fileName = path.basename(opened.path);
    const mimeType = inferMimeType(fileName);
    const token = randomUUID();
    const staticUri = useStaticExport && hashed.bytes
      ? await materializeStaticExport(token, fileName, hashed.bytes, config)
      : undefined;
    const uri = staticUri || `mcp-file://export/${token}`;

    reserveExportTicket(token, {
      path: opened.path,
      fileName,
      mimeType,
      size: hashed.size,
      sha256: hashed.sha256,
      dev: hashed.dev,
      ino: hashed.ino,
      mtimeMs: hashed.mtimeMs,
      expiresAt: Date.now() + config.exportTtlMs,
    });

    return {
      path: opened.path,
      host_path: metadataHostPath(opened.path, config),
      file_name: fileName,
      size: hashed.size,
      mime_type: mimeType,
      sha256: hashed.sha256,
      resource_uri: uri,
      file_uri: staticUri
        ? {
            download_url: staticUri,
            file_id: `file_bridge_${token}`,
            mime_type: mimeType,
            file_name: fileName,
          }
        : undefined,
    };
  } finally {
    await opened.handle.close();
  }
}

function exportTokenFromVariables(value: string | string[] | undefined): string {
  if (Array.isArray(value)) value = value[0];
  if (!value || !isExportTokenName(value)) throw new Error('Invalid export resource token');
  return value;
}

interface ExportDownload {
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  bytes: Buffer;
}

async function readValidatedExport(
  tokenValue: string | string[] | undefined,
  config: BridgeConfig = loadBridgeConfig(),
): Promise<ExportDownload> {
  const token = exportTokenFromVariables(tokenValue);
  const ticket = exportTickets.get(token);
  if (!ticket) throw new Error('Export resource is unknown or expired');
  if (ticket.expiresAt < Date.now()) {
    exportTickets.delete(token);
    throw new Error('Export resource has expired');
  }

  const opened = await openValidatedExportFile(ticket.path);
  try {
    if (opened.path !== ticket.path) throw new Error('Export path resolution changed');
    const stats = await opened.handle.stat();
    if (
      stats.dev !== ticket.dev ||
      stats.ino !== ticket.ino ||
      stats.size !== ticket.size ||
      stats.mtimeMs !== ticket.mtimeMs
    ) {
      throw new Error('Export file changed after the export link was created');
    }
    const read = await hashOpenFile(opened.handle, config.maxExportBytes, true);
    if (read.sha256 !== ticket.sha256 || !read.bytes) {
      throw new Error('Export file integrity changed after the export link was created');
    }
    return {
      fileName: ticket.fileName,
      mimeType: ticket.mimeType,
      size: ticket.size,
      sha256: ticket.sha256,
      bytes: read.bytes,
    };
  } finally {
    await opened.handle.close();
  }
}

export async function readExportResource(
  tokenValue: string | string[] | undefined,
  resourceUri: string,
  config: BridgeConfig = loadBridgeConfig(),
): Promise<ExportResource> {
  const read = await readValidatedExport(tokenValue, config);
  return {
    uri: resourceUri,
    mimeType: read.mimeType,
    blob: read.bytes.toString('base64'),
  };
}

export async function startStaticExportCleanup(
  config: BridgeConfig = loadBridgeConfig(),
): Promise<NodeJS.Timeout | undefined> {
  if (!config.exportDir) return undefined;
  await cleanupExpiredStaticExports(config);
  const intervalMs = Math.min(60_000, Math.max(1_000, Math.floor(config.exportTtlMs / 2)));
  const timer = setInterval(() => {
    void cleanupExpiredStaticExports(config).catch((error) => {
      console.error('Static export cleanup failed:', error instanceof Error ? error.message : String(error));
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

export function clearExportTicketsForTests(): void {
  exportTickets.clear();
}
