import { describe, expect, it } from 'vitest';
import { createApp, isLocalOrigin, mimeEssence } from '../src/server';

// The cancel endpoint only touches the job list, so a stub session is enough here.
const app = createApp({ port: 4747, uiDir: null, version: 'test' }, {} as never);
const BASE = 'http://127.0.0.1:4747';

function post(headers: Record<string, string>) {
  return app.request(`${BASE}/api/jobs/nope/cancel`, { method: 'POST', headers: { host: '127.0.0.1:4747', ...headers }, body: '{}' });
}

describe('request guard', () => {
  it('accepts JSON from the app itself and from tools with no Origin', async () => {
    expect((await post({ 'content-type': 'application/json', origin: 'http://127.0.0.1:4747' })).status).toBe(200);
    expect((await post({ 'content-type': 'application/json; charset=utf-8', origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await post({ 'content-type': 'application/json' })).status).toBe(200);
  });

  it('rejects writes from other websites', async () => {
    expect((await post({ 'content-type': 'application/json', origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ 'content-type': 'application/json', origin: 'null' })).status).toBe(403);
    expect((await post({ 'content-type': 'application/json', origin: 'http://localhost.evil.example' })).status).toBe(403);
  });

  it('rejects content types a page can send cross-site without a preflight', async () => {
    expect((await post({ 'content-type': 'text/plain; x=application/json' })).status).toBe(415);
    expect((await post({ 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post({})).status).toBe(415);
  });

  it('rejects requests addressed to another host name (DNS rebinding)', async () => {
    expect((await post({ host: 'attacker.example:4747', 'content-type': 'application/json' })).status).toBe(403);
  });
});

describe('helpers', () => {
  it('reads the MIME essence', () => {
    expect(mimeEssence('Application/JSON ; charset=utf-8')).toBe('application/json');
    expect(mimeEssence(undefined)).toBe('');
  });

  it('only treats this machine as a local origin', () => {
    expect(isLocalOrigin('http://[::1]:4747')).toBe(true);
    expect(isLocalOrigin('http://127.0.0.1.evil.example')).toBe(false);
  });
});
