import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

/**
 * Integration tests to verify that tool handlers return structuredContent
 * that matches the declared outputSchema.
 *
 * These tests address issues #3110, #3106, #3093 where tools were returning
 * structuredContent: { content: [contentBlock] } (array) instead of
 * structuredContent: { content: string } as declared in outputSchema.
 */
describe('structuredContent schema compliance', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let testDir: string;

  beforeEach(async () => {
    // Create a temp directory for testing
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fs-test-'));

    // Create test files
    await fs.writeFile(path.join(testDir, 'test.txt'), 'test content');
    await fs.mkdir(path.join(testDir, 'subdir'));
    await fs.writeFile(path.join(testDir, 'subdir', 'nested.txt'), 'nested content');

    // Start the MCP server
    const serverPath = path.resolve(__dirname, '../dist/index.js');
    transport = new StdioClientTransport({
      command: 'node',
      args: [serverPath, testDir],
    });

    client = new Client({
      name: 'test-client',
      version: '1.0.0',
    }, {
      capabilities: {}
    });

    await client.connect(transport);
  });

  afterEach(async () => {
    await client?.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('directory_tree', () => {
    it('should return structuredContent.content as a string, not an array', async () => {
      const result = await client.callTool({
        name: 'directory_tree',
        arguments: { path: testDir }
      });

      // The result should have structuredContent
      expect(result.structuredContent).toBeDefined();

      // structuredContent.content should be a string (matching outputSchema: { content: z.string() })
      const structuredContent = result.structuredContent as { content: unknown };
      expect(typeof structuredContent.content).toBe('string');

      // It should NOT be an array
      expect(Array.isArray(structuredContent.content)).toBe(false);

      // The content should be valid JSON representing the tree
      const treeData = JSON.parse(structuredContent.content as string);
      expect(Array.isArray(treeData)).toBe(true);
    });
  });

  describe('list_directory_with_sizes', () => {
    it('should return structuredContent.content as a string, not an array', async () => {
      const result = await client.callTool({
        name: 'list_directory_with_sizes',
        arguments: { path: testDir }
      });

      // The result should have structuredContent
      expect(result.structuredContent).toBeDefined();

      // structuredContent.content should be a string (matching outputSchema: { content: z.string() })
      const structuredContent = result.structuredContent as { content: unknown };
      expect(typeof structuredContent.content).toBe('string');

      // It should NOT be an array
      expect(Array.isArray(structuredContent.content)).toBe(false);

      // The content should contain directory listing info
      expect(structuredContent.content).toContain('[FILE]');
    });
  });

  describe('move_file', () => {
    it('should return structuredContent.content as a string, not an array', async () => {
      const sourcePath = path.join(testDir, 'test.txt');
      const destPath = path.join(testDir, 'moved.txt');

      const result = await client.callTool({
        name: 'move_file',
        arguments: {
          source: sourcePath,
          destination: destPath
        }
      });

      // The result should have structuredContent
      expect(result.structuredContent).toBeDefined();

      // structuredContent.content should be a string (matching outputSchema: { content: z.string() })
      const structuredContent = result.structuredContent as { content: unknown };
      expect(typeof structuredContent.content).toBe('string');

      // It should NOT be an array
      expect(Array.isArray(structuredContent.content)).toBe(false);

      // The content should contain success message
      expect(structuredContent.content).toContain('Successfully moved');
    });
  });

  describe('list_directory (control - already working)', () => {
    it('should return structuredContent.content as a string', async () => {
      const result = await client.callTool({
        name: 'list_directory',
        arguments: { path: testDir }
      });

      expect(result.structuredContent).toBeDefined();

      const structuredContent = result.structuredContent as { content: unknown };
      expect(typeof structuredContent.content).toBe('string');
      expect(Array.isArray(structuredContent.content)).toBe(false);
    });
  });

  describe('search_files (control - already working)', () => {
    it('should return structuredContent.content as a string', async () => {
      const result = await client.callTool({
        name: 'search_files',
        arguments: {
          path: testDir,
          pattern: '*.txt'
        }
      });

      expect(result.structuredContent).toBeDefined();

      const structuredContent = result.structuredContent as { content: unknown };
      expect(typeof structuredContent.content).toBe('string');
      expect(Array.isArray(structuredContent.content)).toBe(false);
    });
  });

  // read_media_file must return a VALID MCP content block. Previously it emitted
  // type: "blob" for non-image/audio files, which is not in the MCP content-block
  // union (text | image | audio | resource_link | resource) and a strict client
  // rejects on schema validation. See issue #4029.
  describe('read_media_file (issue #4029)', () => {
    // Image/audio inputs already returned valid content types before #4029 (only the
    // non-media fallback was the invalid "blob"), so these two cases remain byte-integrity
    // coverage. Generic non-media binaries are now deliberately rejected so this preview tool
    // cannot become a resource/materialization escape hatch.
    it('returns type "image" for image files, round-tripping the bytes', async () => {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const pngPath = path.join(testDir, 'pixel.png');
      // Contents aren't validated by the tool (MIME is by extension), so arbitrary bytes are fine.
      await fs.writeFile(pngPath, pngBytes);

      const result = await client.callTool({
        name: 'read_media_file',
        arguments: { path: pngPath }
      });

      const content = result.content as Array<{ type: string; data?: string; mimeType?: string }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('image');
      expect(content[0].mimeType).toBe('image/png');
      expect(Buffer.from(content[0].data!, 'base64').equals(pngBytes)).toBe(true);
      // structuredContent must MIRROR content. The SDK validates each field independently
      // against the outputSchema union (either arm is valid for either field), so schema
      // validation alone cannot catch the two drifting apart — only this equality can.
      expect(result.structuredContent).toEqual({ content });
    });

    it('returns type "audio" for audio files, round-tripping the bytes', async () => {
      const mp3Bytes = Buffer.from([0x49, 0x44, 0x33, 0x04]);
      const mp3Path = path.join(testDir, 'clip.mp3');
      await fs.writeFile(mp3Path, mp3Bytes);

      const result = await client.callTool({
        name: 'read_media_file',
        arguments: { path: mp3Path }
      });

      const content = result.content as Array<{ type: string; data?: string; mimeType?: string }>;
      expect(content[0].type).toBe('audio');
      expect(content[0].mimeType).toBe('audio/mpeg');
      expect(Buffer.from(content[0].data!, 'base64').equals(mp3Bytes)).toBe(true);
      expect(result.structuredContent).toEqual({ content }); // must mirror content (see image case)
    });

    it('rejects non-media binaries instead of returning a generic MCP resource', async () => {
      const binPath = path.join(testDir, 'data.bin');
      await fs.writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));

      const result = await client.callTool({
        name: 'read_media_file',
        arguments: { path: binPath }
      });

      expect(result.isError).toBe(true);
      expect(result.content.some((item) => item.type === 'resource' || item.type === 'resource_link')).toBe(false);
      expect(result.content[0]).toMatchObject({ type: 'text' });
    });

    it('advertises only native image/audio preview content via tools/list', async () => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'read_media_file');
      expect(tool).toBeDefined();
      const schemaStr = JSON.stringify(tool!.outputSchema);
      expect(schemaStr).not.toMatch(/resource_link/);
      expect(schemaStr).not.toMatch(/"resource"/);
      expect(schemaStr).toMatch(/image/);
      expect(schemaStr).toMatch(/audio/);
    });
  });
});
