/**
 * 密钥存储加密（DESIGN.md §8：api_key 加密落库）
 *
 * AES-256-GCM，密钥来自环境变量 ASSEMBLE_SECRET_KEY（sha256 派生）。
 * 格式：`e1:{iv}:{tag}:{ciphertext}`（base64）
 * 未配置密钥时明文透传（MVP 兼容，启动日志给出警告）。
 * 已存在的明文数据无需迁移：解密时非 e1: 前缀视为明文。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'e1:';
let key: Buffer | null = null;
let configured = false;

/** 从环境变量初始化密钥（可在测试中注入） */
export function configureSecretKey(secret?: string): void {
  const s = secret ?? process.env.ASSEMBLE_SECRET_KEY;
  if (s) {
    key = createHash('sha256').update(s).digest();
    configured = true;
  } else {
    key = null;
    configured = false;
  }
}

export function isSecretConfigured(): boolean {
  return configured;
}

/** 加密（未配置密钥时返回原文） */
export function encryptSecret(plain: string): string {
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // PREFIX 已含冒号，手工拼接（勿用 join）
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** 解密（明文或密钥缺失时原样返回） */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // 明文兼容
  if (!key) return stored; // 有密钥需求但未配置：原样返回（避免启动即崩）
  const parts = stored.split(':');
  if (parts.length !== 4) return stored;
  try {
    const [, ivB, tagB, ctB] = parts;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB!, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB!, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB!, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return stored; // 解密失败（密钥变更等）：原样返回，不掩盖
  }
}
