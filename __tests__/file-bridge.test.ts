import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearExportTicketsForTests,
  createExport,
  cleanupExpiredStaticExports,
  inferMimeType,
  ingestConnectorFile,
  readExportResource,
  sanitizeFileName,
  validateConnectorDownloadUrl,
  type BridgeConfig,
  type ConnectorFileInput,
  type ExportAuthorization,
} from '../file-bridge.js';
import { setAllowedDirectories } from '../lib.js';

const createdDirectories: string[] = [];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function makeDirectory(prefix = 'mcp-file-bridge-'): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

function configFor(root: string, maxIngestBytes = 1024 * 1024, maxExportBytes = 1024 * 1024): BridgeConfig {
  return {
    ingressDir: path.join(root, 'ingress'),
    maxIngestBytes,
    maxExportBytes,
    mcpRoot: root,
    hostRoot: '/host/data',
    connectorDownloadHostSuffixes: ['oaiusercontent.com'],
    exportTtlMs: 10 * 60 * 1000,
  };
}

function exportAuthorization(intent: ExportAuthorization['intent'] = 'download'): ExportAuthorization {
  return { intent, confirmUserRequestedMaterialization: true };
}

function connectorFile(fileName = 'source.bin', mimeType = 'application/octet-stream'): ConnectorFileInput {
  return {
    download_url: 'https://files.oaiusercontent.com/file-test/download',
    file_id: 'file-test',
    file_name: fileName,
    mime_type: mimeType,
  };
}

function fetchBytes(bytes: Uint8Array, contentLength = true): typeof fetch {
  return (async () => new Response(bytes, {
    status: 200,
    headers: contentLength ? { 'content-length': String(bytes.byteLength) } : {},
  })) as unknown as typeof fetch;
}

function interruptedFetch(): typeof fetch {
  return (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3, 4]));
        controller.error(new Error('simulated interrupted transfer'));
      },
    });
    return new Response(stream, { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearExportTicketsForTests();
});

afterEach(async () => {
  setAllowedDirectories([]);
  clearExportTicketsForTests();
  await Promise.all(
    createdDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('connector file ingest', () => {
  it('accepts only the narrow OpenAI runtime Azure Blob pattern with a signed readable URL', () => {
    const config = configFor('/tmp/unused');
    expect(() => validateConnectorDownloadUrl(
      'https://oaisdmntprukwest.blob.core.windows.net/container/file?sp=r&se=2026-08-29T00%3A00%3A00Z&sig=test',
      config,
    )).not.toThrow();
    expect(() => validateConnectorDownloadUrl(
      'https://attacker.blob.core.windows.net/container/file?sp=r&se=2026-08-29T00%3A00%3A00Z&sig=test',
      config,
    )).toThrow(/not trusted/);
    expect(() => validateConnectorDownloadUrl(
      'https://oaisdmntprukwest.blob.core.windows.net/container/file',
      config,
    )).toThrow(/not trusted/);
  });

  it('1-2. preserves PNG bytes exactly and returns the source SHA-256', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

    const result = await ingestConnectorFile(
      { file: connectorFile('pixel.png', 'image/png') },
      config,
      fetchBytes(png),
    );

    expect(result.file_name).toBe('pixel.png');
    expect(result.mime_type).toBe('image/png');
    expect(result.sha256).toBe(sha256(png));
    expect(result.size).toBe(png.byteLength);
    expect(Buffer.from(await fs.readFile(result.path)).equals(Buffer.from(png))).toBe(true);
    expect(result.host_path).toBe('/host/data/ingress/pixel.png');
  });

  it('3. accepts a correct expected_sha256', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const bytes = Uint8Array.from([7, 8, 9, 0, 255]);
    const result = await ingestConnectorFile(
      { file: connectorFile('checked.bin'), expected_sha256: sha256(bytes) },
      configFor(root),
      fetchBytes(bytes),
    );
    expect(result.sha256).toBe(sha256(bytes));
  });

  it('4. preserves a safe source filename and sanitizes control characters in an explicit filename', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root);
    const first = await ingestConnectorFile(
      { file: connectorFile('preserved.pdf', 'application/pdf') },
      config,
      fetchBytes(Uint8Array.from([0x25, 0x50, 0x44, 0x46])),
    );
    const second = await ingestConnectorFile(
      { file: connectorFile('unused.bin'), file_name: 'safe\u0007name.zip' },
      config,
      fetchBytes(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])),
    );
    expect(first.file_name).toBe('preserved.pdf');
    expect(first.mime_type).toBe('application/pdf');
    expect(second.file_name).toBe('safe_name.zip');
    expect(second.mime_type).toBe('application/octet-stream');
    expect(inferMimeType('archive.zip')).toBe('application/zip');
    expect(sanitizeFileName(' café.png ')).toBe('café.png');
  });

  it('5. refuses an existing destination when overwrite=false', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root);
    await fs.mkdir(config.ingressDir, { recursive: true });
    const target = path.join(config.ingressDir, 'existing.bin');
    await fs.writeFile(target, Buffer.from('original'));

    await expect(ingestConnectorFile(
      { file: connectorFile('existing.bin') },
      config,
      fetchBytes(Buffer.from('replacement')),
    )).rejects.toThrow(/already exists/);
    expect(await fs.readFile(target, 'utf8')).toBe('original');
  });

  it('6. atomically replaces an existing regular file only when overwrite=true', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root);
    await fs.mkdir(config.ingressDir, { recursive: true });
    const target = path.join(config.ingressDir, 'replace.bin');
    await fs.writeFile(target, Buffer.from('before'));
    const before = await fs.stat(target);

    const result = await ingestConnectorFile(
      { file: connectorFile('replace.bin'), overwrite: true },
      config,
      fetchBytes(Buffer.from('after')),
    );
    const after = await fs.stat(target);
    expect(result.overwritten).toBe(true);
    expect(await fs.readFile(target, 'utf8')).toBe('after');
    expect(after.ino).not.toBe(before.ino);
    expect((await fs.readdir(config.ingressDir)).some((name) => name.startsWith('.ingest-'))).toBe(false);
  });

  it('7. rejects an SHA mismatch and leaves no completed target or temporary file', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root);
    await expect(ingestConnectorFile(
      { file: connectorFile('mismatch.bin'), expected_sha256: '0'.repeat(64) },
      config,
      fetchBytes(Buffer.from('different')),
    )).rejects.toThrow(/SHA-256 mismatch/);
    expect(await fs.readdir(config.ingressDir)).toEqual([]);
  });

  it('8. rejects traversal in a caller-supplied filename', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    await expect(ingestConnectorFile(
      { file: connectorFile(), file_name: '../escape.bin' },
      configFor(root),
      fetchBytes(Buffer.from('x')),
    )).rejects.toThrow(/path separators/);
  });

  it('rejects NUL bytes in a caller-supplied filename', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    await expect(ingestConnectorFile(
      { file: connectorFile(), file_name: 'bad\x00name.bin' },
      configFor(root),
      fetchBytes(Buffer.from('x')),
    )).rejects.toThrow(/NUL bytes/);
  });

  it('9. rejects an absolute caller-supplied filename', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    await expect(ingestConnectorFile(
      { file: connectorFile(), file_name: '/tmp/escape.bin' },
      configFor(root),
      fetchBytes(Buffer.from('x')),
    )).rejects.toThrow(/absolute path/);
  });

  it('10. rejects an existing symlink destination instead of following it', async () => {
    const root = await makeDirectory();
    const outside = await makeDirectory('mcp-file-bridge-outside-');
    setAllowedDirectories([root]);
    const config = configFor(root);
    await fs.mkdir(config.ingressDir, { recursive: true });
    const protectedFile = path.join(outside, 'protected.bin');
    await fs.writeFile(protectedFile, 'protected');
    await fs.symlink(protectedFile, path.join(config.ingressDir, 'link.bin'));

    await expect(ingestConnectorFile(
      { file: connectorFile('link.bin'), overwrite: true },
      config,
      fetchBytes(Buffer.from('replacement')),
    )).rejects.toThrow(/symbolic link/);
    expect(await fs.readFile(protectedFile, 'utf8')).toBe('protected');
  });

  it('11. rejects oversized input even when Content-Length is absent', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root, 4);
    await expect(ingestConnectorFile(
      { file: connectorFile('large.bin') },
      config,
      fetchBytes(Uint8Array.from([1, 2, 3, 4, 5]), false),
    )).rejects.toThrow(/maximum ingest size/);
    expect(await fs.readdir(config.ingressDir)).toEqual([]);
  });

  it('12. cleans the temporary file after an interrupted transfer', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root);
    await expect(ingestConnectorFile(
      { file: connectorFile('interrupted.bin') },
      config,
      interruptedFetch(),
    )).rejects.toThrow(/simulated interrupted transfer/);
    expect(await fs.readdir(config.ingressDir)).toEqual([]);
  });
});

describe('static file export transport', () => {
  it('materializes an exact static copy and returns a downloadable HTTPS file reference', async () => {
    const root = await makeDirectory();
    const staticRoot = await makeDirectory('mcp-file-export-static-');
    setAllowedDirectories([root]);
    const file = path.join(root, 'download me.png');
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
    await fs.writeFile(file, bytes);
    const config: BridgeConfig = {
      ...configFor(root),
      exportDir: staticRoot,
      exportPublicBaseUrl: 'https://downloads.example.com/tmp',
    };

    const exported = await createExport(file, exportAuthorization(), config);
    expect(exported.resource_uri).toMatch(
      /^https:\/\/downloads\.example\.com\/tmp\/[0-9a-f-]{36}\/download%20me\.png$/i,
    );
    expect(exported.sha256).toBe(sha256(bytes));
    expect(exported.file_uri).toEqual({
      download_url: exported.resource_uri,
      file_id: expect.stringMatching(/^file_bridge_[0-9a-f-]{36}$/i),
      mime_type: 'image/png',
      file_name: 'download me.png',
    });

    const url = new URL(exported.resource_uri);
    const token = url.pathname.split('/').at(-2)!;
    const materialized = path.join(staticRoot, token, 'download me.png');
    expect(Buffer.from(await fs.readFile(materialized)).equals(Buffer.from(bytes))).toBe(true);
    expect((await fs.stat(materialized)).mode & 0o777).toBe(0o644);
  });

  it('removes only expired token directories from the configured static export root', async () => {
    const root = await makeDirectory();
    const staticRoot = await makeDirectory('mcp-file-export-static-');
    setAllowedDirectories([root]);
    const config: BridgeConfig = {
      ...configFor(root),
      exportDir: staticRoot,
      exportPublicBaseUrl: 'https://downloads.example.com/tmp',
      exportTtlMs: 1000,
    };
    const expired = path.join(staticRoot, '11111111-1111-4111-8111-111111111111');
    const fresh = path.join(staticRoot, '22222222-2222-4222-8222-222222222222');
    const unrelated = path.join(staticRoot, 'keep-me');
    await fs.mkdir(expired);
    await fs.mkdir(fresh);
    await fs.mkdir(unrelated);
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(expired, old, old);

    const removed = await cleanupExpiredStaticExports(config, Date.now());
    expect(removed).toBe(1);
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(fresh)).isDirectory()).toBe(true);
    expect((await fs.stat(unrelated)).isDirectory()).toBe(true);
  });
});

describe('file export', () => {
  it('blocks the business-layer export path without explicit user materialization authorization', async () => {
    const root = await makeDirectory();
    const staticRoot = await makeDirectory('mcp-file-export-static-');
    setAllowedDirectories([root]);
    const file = path.join(root, 'preview.html');
    await fs.writeFile(file, '<!doctype html><title>Preview</title>');
    const config: BridgeConfig = {
      ...configFor(root),
      exportDir: staticRoot,
      exportPublicBaseUrl: 'https://downloads.example.com/tmp',
    };

    await expect(createExport(file, undefined, config)).rejects.toThrow(/explicit user request/);
    expect(await fs.readdir(staticRoot)).toEqual([]);
  });

  it('13-15. exports an allowed PNG as an MCP resource with identical bytes and SHA-256', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root);
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 0, 255]);
    const file = path.join(root, 'allowed.png');
    await fs.writeFile(file, bytes);

    const exported = await createExport(file, exportAuthorization(), config);
    const token = exported.resource_uri.split('/').at(-1)!;
    const resource = await readExportResource(token, exported.resource_uri, config);

    expect(exported.mime_type).toBe('image/png');
    expect(exported.sha256).toBe(sha256(bytes));
    expect(exported.size).toBe(bytes.byteLength);
    expect(Buffer.from(resource.blob, 'base64').equals(Buffer.from(bytes))).toBe(true);
    expect(sha256(Buffer.from(resource.blob, 'base64'))).toBe(exported.sha256);
  });

  it('16. rejects export outside the configured allowed directory', async () => {
    const root = await makeDirectory();
    const outside = await makeDirectory('mcp-file-bridge-outside-');
    setAllowedDirectories([root]);
    const file = path.join(outside, 'outside.bin');
    await fs.writeFile(file, 'outside');
    await expect(createExport(file, exportAuthorization(), configFor(root))).rejects.toThrow(/outside allowed directories/);
  });

  it('17. rejects a symlink escape during export', async () => {
    const root = await makeDirectory();
    const outside = await makeDirectory('mcp-file-bridge-outside-');
    setAllowedDirectories([root]);
    const target = path.join(outside, 'outside.bin');
    const link = path.join(root, 'escape.bin');
    await fs.writeFile(target, 'outside');
    await fs.symlink(target, link);
    await expect(createExport(link, exportAuthorization(), configFor(root))).rejects.toThrow(/symlink target outside allowed directories/);
  });

  it('18. rejects directory export', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    await expect(createExport(root, exportAuthorization(), configFor(root))).rejects.toThrow(/directory/);
  });

  it('19. rejects oversized export', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const file = path.join(root, 'large.bin');
    await fs.writeFile(file, Uint8Array.from([1, 2, 3, 4, 5]));
    await expect(createExport(file, exportAuthorization(), configFor(root, 1024, 4))).rejects.toThrow(/maximum export size/);
  });
});

describe('binary round trip', () => {
  it('20-22. ingests and exports an arbitrary binary fixture byte-for-byte with identical SHA-256', async () => {
    const root = await makeDirectory();
    setAllowedDirectories([root]);
    const config = configFor(root);
    const fixture = Uint8Array.from([0, 255, 1, 254, 2, 253, 0, 10, 13, 128, 64]);

    const ingested = await ingestConnectorFile(
      { file: connectorFile('fixture.bin') },
      config,
      fetchBytes(fixture),
    );
    const exported = await createExport(ingested.path, exportAuthorization(), config);
    const token = exported.resource_uri.split('/').at(-1)!;
    const resource = await readExportResource(token, exported.resource_uri, config);
    const roundTripped = Buffer.from(resource.blob, 'base64');

    expect(roundTripped.equals(Buffer.from(fixture))).toBe(true);
    expect(exported.sha256).toBe(ingested.sha256);
    expect(exported.sha256).toBe(sha256(fixture));
  });
});
