/**
 * OpenAI 风格错误（DESIGN.md §5.1.5）
 *
 * 注意：不用 TS 参数属性（parameter properties），Node 原生类型剥离不支持。
 */

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;

  constructor(status: number, type: string, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.code = code;
  }

  toBody() {
    return { error: { message: this.message, type: this.type, code: this.code } };
  }
}

export const ApiErrors = {
  modelNotFound: (model: string) =>
    new ApiError(404, 'invalid_request_error', 'model_not_found', `模型不存在: ${model}`),
  invalidRequest: (message: string) =>
    new ApiError(400, 'invalid_request_error', 'invalid_request_error', message),
  internal: (message = '服务器内部错误') =>
    new ApiError(500, 'server_error', 'internal_error', message),
  upstreamUnavailable: (message = '上游模型服务不可用') =>
    new ApiError(503, 'server_error', 'upstream_unavailable', message),
  rateLimit: (message = '请求过于频繁') =>
    new ApiError(429, 'server_error', 'rate_limit_error', message),
};
