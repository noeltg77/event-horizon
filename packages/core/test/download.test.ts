import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadFile } from '../src';

const payload = randomBytes(256 * 1024);
const sha = createHash('sha256').update(payload).digest('hex');
let server: Server;
let base = '';
let rangeRequests = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = req.headers.range?.match(/bytes=(\d+)-/);
    if (range) {
      rangeRequests++;
      const start = Number(range[1]);
      res.writeHead(206, { 'Content-Length': payload.length - start, 'Content-Type': 'application/octet-stream' });
      res.end(payload.subarray(start));
    } else {
      res.writeHead(200, { 'Content-Length': payload.length, 'Content-Type': 'application/octet-stream' });
      res.end(payload);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('downloadFile', () => {
  it('downloads and verifies a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lmx-'));
    const dest = join(dir, 'a.bin');
    await downloadFile(`${base}/a`, dest, { expectedSha256: sha, expectedSize: payload.length });
    expect((await readFile(dest)).equals(payload)).toBe(true);
  });

  it('resumes from a .part file and still verifies the whole file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lmx-'));
    const dest = join(dir, 'b.bin');
    await writeFile(`${dest}.part`, payload.subarray(0, 100_000));
    const before = rangeRequests;
    await downloadFile(`${base}/b`, dest, { expectedSha256: sha, expectedSize: payload.length });
    expect(rangeRequests).toBe(before + 1);
    expect((await readFile(dest)).equals(payload)).toBe(true);
  });

  it('rejects and deletes a file with the wrong checksum', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lmx-'));
    const dest = join(dir, 'c.bin');
    await expect(downloadFile(`${base}/c`, dest, { expectedSha256: '0'.repeat(64), expectedSize: payload.length })).rejects.toThrow(/Checksum mismatch/);
    await expect(stat(dest)).rejects.toThrow();
    await expect(stat(`${dest}.part`)).rejects.toThrow();
  });
});
