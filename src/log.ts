/**
 * 结构化日志（DESIGN.md §8）：JSON lines 输出到 stdout
 *
 * 字段约定：ts / level / msg / requestId / agent / durationMs / 业务字段
 * 敏感信息（api_key / MCP headers / 请求体）一律不记录。
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

let requestSeq = 0;

/** 生成请求 ID（时间戳 + 随机，日志与排查用） */
export function newRequestId(): string {
  requestSeq = (requestSeq + 1) % 0xffff;
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${requestSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  // eslint-disable-next-line no-console
  console.log(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log('error', msg, fields),
};
