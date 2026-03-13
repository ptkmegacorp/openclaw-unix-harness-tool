import { createServer } from 'node:http';
import { getConfig } from './config.js';
import { run } from './run.js';
import { llmHealth } from './presenter.js';

const cfg = getConfig();
const port = Number(process.env.PORT || 8787);

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(s);
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    const health = await llmHealth(cfg);
    return json(res, 200, { ok: true, llm: health });
  }

  if (req.method === 'POST' && req.url === '/run') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      try {
        const j = JSON.parse(body || '{}');
        if (!j.command || typeof j.command !== 'string') return json(res, 400, { ok: false, error: 'command is required' });
        const result = await run(j.command, cfg, {
          confirmDelete: Boolean(j?.confirm?.delete),
          confirmExternalSend: Boolean(j?.confirm?.external)
        });
        return json(res, 200, result);
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message) });
      }
    });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(port, () => {
  console.log(`local-ai-harness listening on :${port}`);
});
