import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface Progress {
  received: number;
  total: number;
  /** bytes per second, smoothed */
  speed: number;
}

export interface DownloadOptions {
  headers?: Record<string, string>;
  expectedSha256?: string | null;
  expectedSize?: number | null;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

/**
 * Download to `dest` with resume support. Data goes to `dest.part` first and is
 * only renamed into place after the size and SHA256 check pass, so a half-finished
 * or corrupt file can never be mistaken for a good one.
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const hash = createHash('sha256');

  let offset = 0;
  try {
    offset = (await stat(part)).size;
  } catch {}
  if (opts.expectedSize && offset > opts.expectedSize) {
    await unlink(part);
    offset = 0;
  }

  // Re-hash whatever we already have so the final checksum covers the whole file
  if (offset > 0) {
    await new Promise<void>((resolve, reject) => {
      createReadStream(part)
        .on('data', (c) => hash.update(c))
        .on('end', () => resolve())
        .on('error', reject);
    });
  }

  const headers: Record<string, string> = { 'User-Agent': 'localmax', ...(opts.headers ?? {}) };
  if (offset > 0) headers.Range = `bytes=${offset}-`;

  const res = await fetch(url, { headers, redirect: 'follow', signal: opts.signal });
  if (res.status === 416 && opts.expectedSize && offset === opts.expectedSize) {
    // Already complete
  } else if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  }
  if (offset > 0 && res.status === 200) {
    // Server ignored the range request: start again
    hash.end();
    return downloadFileFresh(url, dest, opts);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (/text\/html/i.test(contentType)) {
    throw new Error(`Expected a file but got an HTML page from ${new URL(url).host} (the server may be having problems). Try again shortly.`);
  }

  const total = opts.expectedSize ?? (Number(res.headers.get('content-length') ?? 0) + offset);
  let received = offset;
  let lastTick = Date.now();
  let lastBytes = received;
  let speed = 0;

  if (res.body && res.status !== 416) {
    const out = createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' });
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        received += chunk.length;
        const now = Date.now();
        if (now - lastTick >= 500) {
          const inst = ((received - lastBytes) * 1000) / (now - lastTick);
          speed = speed ? speed * 0.7 + inst * 0.3 : inst;
          lastTick = now;
          lastBytes = received;
          opts.onProgress?.({ received, total, speed });
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
  }
  opts.onProgress?.({ received, total, speed });

  if (opts.expectedSize && received !== opts.expectedSize) {
    throw new Error(`Size mismatch: expected ${opts.expectedSize} bytes, got ${received}. Run again to resume.`);
  }
  const digest = hash.digest('hex');
  if (opts.expectedSha256 && digest !== opts.expectedSha256.replace(/^sha256:/, '')) {
    await unlink(part).catch(() => {});
    throw new Error(`Checksum mismatch for ${dest.split(/[\\/]/).pop()}: the file was corrupted in transit and has been deleted. Please retry.`);
  }
  await rename(part, dest);
}

async function downloadFileFresh(url: string, dest: string, opts: DownloadOptions): Promise<void> {
  await unlink(`${dest}.part`).catch(() => {});
  return downloadFile(url, dest, opts);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}
