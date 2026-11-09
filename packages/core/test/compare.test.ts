import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureOllama, measureOpenAI, median } from '../src';

// A fake engine that streams 21 tokens, one every 25 ms, i.e. 40 tokens per second
const TOKENS = 21;
const GAP_MS = 25;
let server: Server;
let base = '';
let lastBody: any = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      lastBody = JSON.parse(raw || '{}');
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        await wait(60); // time to first token
        for (let i = 0; i < TOKENS; i++) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `t${i} ` } }] })}\n\n`);
          await wait(GAP_MS);
        }
        res.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: TOKENS, prompt_tokens: 12 }, timings: { predicted_per_second: 40 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else if (req.url === '/api/chat') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        await wait(60);
        for (let i = 0; i < TOKENS; i++) {
          res.write(JSON.stringify({ message: { content: `t${i} ` }, done: false }) + '\n');
          await wait(GAP_MS);
        }
        res.end(JSON.stringify({ done: true, eval_count: TOKENS, eval_duration: (TOKENS / 40) * 1e9, prompt_eval_count: 12 }) + '\n');
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('comparison stopwatch', () => {
  it('measures an OpenAI-compatible stream (llama-server, LM Studio)', async () => {
    const r = await measureOpenAI(`${base}/v1`, 'm', 'hi', 64, { chat_template_kwargs: { enable_thinking: false } });
    expect(r.tokens).toBe(TOKENS);
    expect(r.ttftMs).toBeGreaterThanOrEqual(50);
    expect(r.genTps).toBeGreaterThan(30);
    expect(r.genTps).toBeLessThan(45);
    expect(r.engineGenTps).toBe(40);
    expect(r.promptTokens).toBe(12);
    // Same request settings for every engine
    expect(lastBody).toMatchObject({ temperature: 0, max_tokens: 64, stream: true });
  });

  it('measures an Ollama native stream with matching context length', async () => {
    const r = await measureOllama(base, 'm', 'hi', 64, 8192);
    expect(r.tokens).toBe(TOKENS);
    expect(r.genTps).toBeGreaterThan(30);
    expect(r.genTps).toBeLessThan(45);
    expect(r.engineGenTps).toBe(40);
    expect(lastBody.options).toMatchObject({ num_ctx: 8192, num_predict: 64, temperature: 0 });
    expect(lastBody.think).toBe(false);
  });

  it('takes medians that ignore failed (zero) runs', () => {
    expect(median([30, 0, 40, 35])).toBe(35);
    expect(median([])).toBe(0);
  });
});
