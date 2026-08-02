import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  OpenAICompatibleEmbedder,
  EmbeddingError,
} from '../../../src/core/rag/embedding.ts';

/** 由输入文本生成确定性 4 维向量（模拟嵌入服务） */
function makeVector(text: string): number[] {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return [h / 1e9, 0.1, 0.2, 0.3];
}

interface MockState {
  /** 返回顺序：是否乱序（靠 index 重排） */
  scramble: boolean;
  /** 前 N 次请求返回 500 */
  fail500Times: number;
  /** 是否返回 401 */
  authFail: boolean;
  /** 返回数量与输入不符（模拟坏响应） */
  wrongCount: boolean;
  calls: number;
  lastAuth?: string;
  lastBody?: unknown;
}

function createMockServer(state: MockState): Promise<{ server: Server; port: number; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        state.calls++;
        state.lastAuth = req.headers.authorization;
        state.lastBody = JSON.parse(body);

        if (state.authFail) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid token' } }));
          return;
        }
        if (state.calls <= state.fail500Times) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
          return;
        }

        const input = (state.lastBody as { input: string[] }).input;
        const count = state.wrongCount ? input.length + 1 : input.length;
        // 乱序时：data[i] 的 embedding 属于 index 指向的输入（模拟真实网关乱序返回）
        const data = Array.from({ length: count }, (_, i) => {
          const idx = state.scramble ? count - 1 - i : i;
          return {
            index: idx,
            embedding: makeVector(input[idx] ?? ''),
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data, usage: { total_tokens: count * 2 } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function embedderFor(port: number, overrides: Partial<ConstructorParameters<typeof OpenAICompatibleEmbedder>[0]> = {}) {
  return new OpenAICompatibleEmbedder({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'sk-test',
    model: 'Pro/BAAI/bge-m3',
    maxRetries: 2,
    ...overrides,
  });
}

describe('embedding: OpenAI 兼容适配器', () => {
  const state: MockState = {
    scramble: false,
    fail500Times: 0,
    authFail: false,
    wrongCount: false,
    calls: 0,
  };
  let server: Server;
  let port = 0;

  before(async () => {
    const s = await createMockServer(state);
    server = s.server;
    port = s.port;
  });
  after(() => server.close());

  it('基本调用：批量返回、维度一致、鉴权头正确', async () => {
    const e = embedderFor(port);
    const vectors = await e.embed(['你好', '世界']);
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0]!.length, 4);
    assert.equal(state.lastAuth, 'Bearer sk-test');
  });

  it('baseUrl 带 /embeddings 后缀也可用', async () => {
    const e = new OpenAICompatibleEmbedder({
      baseUrl: `http://127.0.0.1:${port}/v1/embeddings`,
      apiKey: 'sk-test',
      model: 'm',
    });
    const vectors = await e.embed(['x']);
    assert.equal(vectors.length, 1);
  });

  it('响应乱序时按 index 重排', async () => {
    state.scramble = true;
    try {
      const e = embedderFor(port);
      const texts = ['甲', '乙', '丙'];
      const vectors = await e.embed(texts);
      // 与顺序调用结果一致
      const expect = texts.map((t) => makeVector(t));
      assert.deepEqual(vectors, expect);
    } finally {
      state.scramble = false;
    }
  });

  it('401 抛 auth 错误且不重试', async () => {
    state.authFail = true;
    state.calls = 0;
    try {
      const e = embedderFor(port);
      await assert.rejects(e.embed(['x']), (err: unknown) => {
        assert.ok(err instanceof EmbeddingError);
        assert.equal((err as EmbeddingError).category, 'auth');
        return true;
      });
      assert.equal(state.calls, 1, '401 不应重试');
    } finally {
      state.authFail = false;
    }
  });

  it('500 自动重试后成功', async () => {
    state.fail500Times = 2;
    state.calls = 0;
    try {
      const e = embedderFor(port);
      const vectors = await e.embed(['ok']);
      assert.equal(vectors.length, 1);
      assert.equal(state.calls, 3, '前 2 次 500 + 第 3 次成功');
    } finally {
      state.fail500Times = 0;
    }
  });

  it('持续 500 最终抛 upstream 错误', async () => {
    state.fail500Times = 99;
    state.calls = 0;
    try {
      const e = embedderFor(port);
      await assert.rejects(e.embed(['x']), (err: unknown) => {
        assert.ok(err instanceof EmbeddingError);
        assert.equal((err as EmbeddingError).category, 'upstream');
        return true;
      });
      assert.equal(state.calls, 3, '重试 2 次共 3 次请求');
    } finally {
      state.fail500Times = 0;
    }
  });

  it('响应数量不符抛 bad_response', async () => {
    state.wrongCount = true;
    try {
      const e = embedderFor(port);
      await assert.rejects(e.embed(['x']), (err: unknown) => {
        assert.equal((err as EmbeddingError).category, 'bad_response');
        return true;
      });
    } finally {
      state.wrongCount = false;
    }
  });

  it('dimensions 配置校验', async () => {
    const e = embedderFor(port, { dimensions: 1024 });
    await assert.rejects(e.embed(['x']), (err: unknown) => {
      assert.equal((err as EmbeddingError).category, 'bad_response');
      return true;
    });
  });

  it('空输入返回空数组', async () => {
    const e = embedderFor(port);
    assert.deepEqual(await e.embed([]), []);
  });

  it('缺少必填配置抛错', () => {
    assert.throws(
      () => new OpenAICompatibleEmbedder({ baseUrl: '', apiKey: 'k', model: 'm' }),
      /必填/,
    );
  });
});
