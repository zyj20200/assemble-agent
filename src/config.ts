/** 环境变量配置（DESIGN.md §8 相关项） */

const env = (key: string, fallback?: string): string | undefined => process.env[key] ?? fallback;

export const config = {
  /** 服务端口 */
  port: Number(env('PORT', '8787')),
  /** /v1/* 可选鉴权：设置后要求 Authorization: Bearer <key> */
  apiKey: env('ASSEMBLE_API_KEY'),
  /** CORS 允许来源（逗号分隔），默认关闭 */
  allowOrigins: env('ASSEMBLE_ALLOW_ORIGINS'),
  /** 默认 LLM 配置（seed 用，正式版由 DB Provider 表驱动） */
  llm: {
    baseUrl: env('LLM_BASE_URL'),
    apiKey: env('LLM_API_KEY'),
    model: env('LLM_MODEL'),
  },
  /** 嵌入配置（seed 的 RAG Agent 用） */
  embedding: {
    baseUrl: env('EMBEDDING_BASE_URL'),
    apiKey: env('EMBEDDING_API_KEY'),
    model: env('EMBEDDING_MODEL'),
  },
};
