import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idempotencyMiddleware } from './idempotency.js';

let db;

beforeEach(() => {
  const rows = new Map();
  const rowKey = (userId, scope, key) => `${userId}\u0000${scope}\u0000${key}`;
  db = {
    prepare(sql) {
      if (/^INSERT INTO http_idempotency/i.test(sql.trim())) {
        return {
          run(userId, scope, key, statusCode, bodyJson, createdAtIso) {
            const k = rowKey(userId, scope, key);
            if (rows.has(k)) {
              const error = new Error('UNIQUE constraint failed');
              error.code = 'SQLITE_CONSTRAINT_PRIMARYKEY';
              throw error;
            }
            rows.set(k, {
              user_id: userId,
              scope,
              idempotency_key: key,
              status_code: statusCode,
              body_json: bodyJson,
              created_at_iso: createdAtIso,
            });
            return { changes: 1 };
          },
        };
      }
      if (/^SELECT status_code, body_json FROM http_idempotency/i.test(sql.trim())) {
        return { get: (userId, scope, key) => rows.get(rowKey(userId, scope, key)) };
      }
      if (/^UPDATE http_idempotency/i.test(sql.trim())) {
        return {
          run(statusCode, bodyJson, userId, scope, key, pendingStatus) {
            const k = rowKey(userId, scope, key);
            const row = rows.get(k);
            if (!row || row.status_code !== pendingStatus) return { changes: 0 };
            rows.set(k, { ...row, status_code: statusCode, body_json: bodyJson });
            return { changes: 1 };
          },
        };
      }
      if (/^DELETE FROM http_idempotency/i.test(sql.trim())) {
        return {
          run(...args) {
            if (args.length === 1) return { changes: 0 };
            const [userId, scope, key, pendingStatus] = args;
            const k = rowKey(userId, scope, key);
            const row = rows.get(k);
            if (row?.status_code === pendingStatus) rows.delete(k);
            return { changes: row ? 1 : 0 };
          },
        };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
});

function request(body = { amount: 100 }) {
  return {
    method: 'POST',
    originalUrl: '/api/expenses',
    body,
    user: { id: 'user-1' },
    get: (name) => (String(name).toLowerCase() === 'idempotency-key' ? 'operation_123' : ''),
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    type() {
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

describe('global idempotency middleware', () => {
  it('blocks a concurrent duplicate, then replays the completed response', () => {
    const middleware = idempotencyMiddleware(db);
    const firstResponse = response();
    const firstNext = vi.fn();
    middleware(request(), firstResponse, firstNext);
    expect(firstNext).toHaveBeenCalledOnce();

    const concurrentResponse = response();
    const concurrentNext = vi.fn();
    middleware(request(), concurrentResponse, concurrentNext);
    expect(concurrentNext).not.toHaveBeenCalled();
    expect(concurrentResponse.statusCode).toBe(409);
    expect(concurrentResponse.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');

    firstResponse.status(201).json({ ok: true, id: 'EXP-1' });

    const replayResponse = response();
    middleware(request(), replayResponse, vi.fn());
    expect(replayResponse.statusCode).toBe(201);
    expect(replayResponse.body).toEqual({ ok: true, id: 'EXP-1' });
  });

  it('rejects reuse of a pending operation ID with different input', () => {
    const middleware = idempotencyMiddleware(db);
    middleware(request({ amount: 100 }), response(), vi.fn());

    const mismatchResponse = response();
    middleware(request({ amount: 200 }), mismatchResponse, vi.fn());

    expect(mismatchResponse.statusCode).toBe(409);
    expect(mismatchResponse.body.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });
});
