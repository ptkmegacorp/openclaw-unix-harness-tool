import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { executeLlmSegment } from '../src/llm.js';

function cfg(overrides = {}) {
  return {
    llmEndpoints: overrides.llmEndpoints || [],
    llmModel: 'test-model',
    llmDefaultModel: 'test-model',
    llmToolsEnabled: overrides.llmToolsEnabled ?? true,
    llmTimeoutMs: 2000
  };
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test('llm command disabled behavior is deterministic', async () => {
  const r = await executeLlmSegment('llm health', cfg({ llmToolsEnabled: false }));
  assert.equal(r.exitCode, 3);
  assert.match(r.stderr.toString('utf8'), /llm tools disabled/);
});

test('llm failover works for models', async () => {
  const s = await startServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const r = await executeLlmSegment('llm models --json', cfg({ llmEndpoints: ['http://127.0.0.1:9', s.url] }));
    assert.equal(r.exitCode, 0);
    const j = JSON.parse(r.stdout.toString('utf8'));
    assert.equal(j.kind, 'models');
    assert.deepEqual(j.models, ['a', 'b']);
    assert.equal(j.endpoint, s.url);
  } finally {
    await s.close();
  }
});

test('llm chat arg handling and output shape', async () => {
  let body = null;
  const s = await startServer(async (req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      body = await new Promise((resolve) => {
        let d = '';
        req.on('data', (c) => (d += c));
        req.on('end', () => resolve(JSON.parse(d)));
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { total_tokens: 7 } }));
      return;
    }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const r = await executeLlmSegment('llm chat "ping" --system "s" --temp 0.2 --max-tokens 12 --json', cfg({ llmEndpoints: [s.url] }));
    assert.equal(r.exitCode, 0);
    const j = JSON.parse(r.stdout.toString('utf8'));
    assert.equal(j.kind, 'chat');
    assert.equal(j.output, 'pong');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 12);
    assert.equal(body.messages[0].role, 'system');
  } finally {
    await s.close();
  }
});

test('llm embed unsupported gives deterministic graceful error', async () => {
  const s = await startServer((req, res) => {
    if (req.url === '/v1/embeddings') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const r = await executeLlmSegment('llm embed "hello"', cfg({ llmEndpoints: [s.url] }));
    assert.equal(r.exitCode, 4);
    assert.match(r.stderr.toString('utf8'), /unsupported/);
  } finally {
    await s.close();
  }
});

test('llm tokenize fallback estimate when unsupported', async () => {
  const s = await startServer((req, res) => {
    if (req.url === '/tokenize') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const r = await executeLlmSegment('llm tokenize "abcd1234" --json', cfg({ llmEndpoints: [s.url] }));
    assert.equal(r.exitCode, 0);
    const j = JSON.parse(r.stdout.toString('utf8'));
    assert.equal(j.kind, 'tokenize');
    assert.equal(j.supported, false);
    assert.equal(j.estimateTokens, 2);
  } finally {
    await s.close();
  }
});
