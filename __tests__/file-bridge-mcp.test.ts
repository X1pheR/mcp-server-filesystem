import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js';

const SERVER_PATH = path.resolve(__dirname, '../dist/index.js');
let testDir: string;
let client: Client;
let transport: StdioClientTransport;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-file-bridge-mcp-'));
  transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH, testDir],
    env: {
      ...process.env,
      FILE_BRIDGE_INGRESS_DIR: path.join(testDir, 'ingress'),
      FILE_BRIDGE_MCP_ROOT: testDir,
      FILE_BRIDGE_HOST_ROOT: '/host/data',
      FILE_BRIDGE_MAX_INGEST_BYTES: String(1024 * 1024),
      FILE_BRIDGE_MAX_EXPORT_BYTES: String(1024 * 1024),
    },
  });
  client = new Client({ name: 'file-bridge-test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
});

afterEach(async () => {
  await client?.close();
  await fs.rm(testDir, { recursive: true, force: true });
});

describe('native MCP file bridge contracts', () => {
  it('advertises ingest_file as a ChatGPT native file parameter and export_file as stateful external transport', async () => {
    const { tools } = await client.listTools();
    const ingest = tools.find((tool) => tool.name === 'ingest_file');
    const exported = tools.find((tool) => tool.name === 'export_file');

    expect(ingest).toBeDefined();
    expect(ingest!._meta).toEqual(expect.objectContaining({ 'openai/fileParams': ['file'] }));
    expect(ingest!.inputSchema.required).toContain('file');
    expect((ingest!.inputSchema.properties as Record<string, unknown>).file).toBeDefined();
    expect(exported).toBeDefined();
    expect(exported!.annotations?.readOnlyHint).toBe(false);
    expect(exported!.annotations?.destructiveHint).toBe(false);
    expect(exported!.annotations?.openWorldHint).toBe(true);
  });

  it('returns export_file as a resource_link and serves the exact bytes through resources/read', async () => {
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0, 255, 10, 13]);
    const file = path.join(testDir, 'fixture.pdf');
    await fs.writeFile(file, bytes);

    const result = await client.callTool({ name: 'export_file', arguments: { path: file } });
    expect(result.isError).not.toBe(true);
    expect(result.content).toHaveLength(1);
    const link = result.content[0] as { type: string; uri: string; name: string; mimeType?: string; size?: number };
    expect(link.type).toBe('resource_link');
    expect(link.name).toBe('fixture.pdf');
    expect(link.mimeType).toBe('application/pdf');
    expect(link.size).toBe(bytes.byteLength);

    const metadata = result.structuredContent as Record<string, unknown>;
    expect(metadata.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(metadata.resource_uri).toBe(link.uri);

    const resource = await client.request(
      { method: 'resources/read', params: { uri: link.uri } },
      ReadResourceResultSchema,
    );
    expect(resource.contents).toHaveLength(1);
    const content = resource.contents[0];
    expect('blob' in content).toBe(true);
    if (!('blob' in content)) throw new Error('Expected binary resource contents');
    expect(Buffer.from(content.blob, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});
