import { describe, expect, it } from 'vitest';
import express from 'express';
import { jsonParseErrorHandler } from './jsonParseErrorHandler.js';

describe('jsonParseErrorHandler', () => {
  it('returns JSON when the raw body is [object Object]', async () => {
    const app = express();
    app.use(express.json());
    app.use(jsonParseErrorHandler);
    app.post('/t', (_req, res) => res.json({ ok: true }));

    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/t`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '[object Object]',
      });
      const data = await res.json();
      expect(res.status).toBe(400);
      expect(data).toMatchObject({ ok: false, code: 'INVALID_JSON' });
    } finally {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
