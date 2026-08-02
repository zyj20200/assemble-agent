/**
 * M6 硬化测试：CORS、结构化请求日志、api_key 加密落库
 *
 * 注意：config.ts 在 import 时读取环境变量，因此本文件在 import 前设置 env，
 * 且使用动态 import（node --test 每文件独立进程，互不污染）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.ASSEMBLE_ALLOW_ORIGINS = 'http://localhost:5173,https://admin.example.com';
process.env.ASSEMBLE_SECRET_KEY = 'hardening-test-key';

const { createApp } = await import('../../src/index.ts');
const { openDb, schema } = await import('../../src/db/index.ts');

let app: ReturnType<typeof createApp>;
let db: ReturnType<typeof openDb>['db'];

before(() => {
  const d = openDb(':memory:');
  db = d.db;
  app = createApp({ db });
});

describe('CORS（ASSEMBLE_ALLOW_ORIGINS）', () => {
  it('允许的来源返回 CORS 头', async () => {
    const res = await app.request('/api/health', {
      headers: { origin: 'http://localhost:5173' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.ok((res.headers.get('access-control-allow-methods') ?? '').includes('POST'));
  });

  it('未允许的来源不返回 CORS 头', async () => {
    const res = await app.request('/api/health', {
      headers: { origin: 'http://evil.example.com' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('OPTIONS 预检 → 204', async () => {
    const res = await app.request('/v1/chat/completions', {
      method: 'OPTIONS',
      headers: { origin: 'https://admin.example.com' },
    });
    assert.equal(res.status, 204);
  });
});

describe('结构化请求日志', () => {
  it('每个请求输出 JSON line（requestId/method/path/status/durationMs）', async () => {
    const orig = console.log;
    const lines: string[] = [];
    // eslint-disable-next-line no-console
    console.log = (s: unknown) => lines.push(String(s));
    try {
      await app.request('/api/health');
      await app.request('/v1/models');
    } finally {
      // eslint-disable-next-line no-console
      console.log = orig;
    }
    const requestLines = lines.map((l) => JSON.parse(l)).filter((l) => l.msg === 'request');
    assert.ok(requestLines.length >= 2, '应有 2 条请求日志');
    const first = requestLines[0];
    assert.ok(first.requestId, '应有 requestId');
    assert.ok(first.method && first.path && typeof first.status === 'number');
    assert.equal(typeof first.durationMs, 'number');
    assert.ok(lines.every((l) => !l.includes('api_key') || !l.includes('Bearer')), '日志不应含密钥');
  });
});

describe('api_key 加密落库', () => {
  it('ASSEMBLE_SECRET_KEY 存在时：DB 存密文，API 回显明文', async () => {
    const res = await app.request('/api/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'enc-p', base_url: 'https://api.example.com/v1', api_key: 'sk-plain-visible' }),
    });
    assert.equal(res.status, 201);

    // DB 里是密文
    const row = db.select().from(schema.providers).all()[0]!;
    assert.ok(row.apiKey?.startsWith('e1:'), 'DB 应存密文');
    assert.notEqual(row.apiKey, 'sk-plain-visible');

    // API 回显明文
    const list = (await (await app.request('/api/providers')).json()) as any;
    assert.equal(list.items[0].apiKey, 'sk-plain-visible');
  });
});
