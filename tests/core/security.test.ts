import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { configureSecretKey, encryptSecret, decryptSecret, isSecretConfigured } from '../../src/security.ts';

describe('security: api_key 加密', () => {
  before(() => configureSecretKey('test-secret-key'));

  it('加密 → 解密 roundtrip', () => {
    const plain = 'sk-abcdef123456';
    const enc = encryptSecret(plain);
    assert.ok(enc.startsWith('e1:'), '应带 e1: 前缀');
    assert.notEqual(enc, plain);
    assert.equal(decryptSecret(enc), plain);
  });

  it('每次加密产生不同密文（随机 IV）', () => {
    const a = encryptSecret('same-key');
    const b = encryptSecret('same-key');
    assert.notEqual(a, b);
  });

  it('明文兼容：无前缀原样返回', () => {
    assert.equal(decryptSecret('plain-key-123'), 'plain-key-123');
  });

  it('密钥不匹配时原样返回（不掩盖）', () => {
    const enc = encryptSecret('secret-1');
    configureSecretKey('different-key');
    assert.equal(decryptSecret(enc), enc, '密钥变更后应原样返回密文');
  });

  it('未配置密钥：明文透传', () => {
    configureSecretKey();
    assert.equal(isSecretConfigured(), false);
    assert.equal(encryptSecret('raw'), 'raw');
    assert.equal(decryptSecret('raw'), 'raw');
  });

  it('配置标记', () => {
    configureSecretKey('k');
    assert.equal(isSecretConfigured(), true);
  });
});
