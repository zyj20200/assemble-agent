/**
 * 模型层（pi-ai 包装）
 *
 * 把 DESIGN.md 的 Provider/Model 组件映射到 pi-ai：
 * - 任意 OpenAI 兼容端点（DeepSeek/通义/Kimi/vLLM/Ollama/网关）→ createProvider + openAICompletionsApi
 * - Provider 的 api_key 通过 auth.resolve 闭包注入（DB 配置驱动，多租户可换 getApiKey）
 * - 模型级默认 temperature 通过包装 stream 注入（pi-ai 的 stream 选项支持）
 */

import { createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Context, StreamOptions } from '@earendil-works/pi-ai';
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai';

/** DESIGN.md providers 表 */
export interface ProviderConfig {
  id: string;
  name: string;
  /** OpenAI 兼容端点，如 https://api.deepseek.com/v1 */
  baseUrl: string;
  apiKey?: string;
}

/** DESIGN.md models 表（运行时形态） */
export interface ModelConfig {
  /** 上游真实模型 ID（getModel(providerId, id) 的 id） */
  id: string;
  /** 展示名，默认 id */
  name?: string;
  providerId: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  reasoning?: boolean;
}

type CompletionsApi = ReturnType<typeof openAICompletionsApi>;

/** 模型级默认 temperature：调用方未显式传时才注入 */
function withModelDefaults(api: CompletionsApi, configs: ModelConfig[]): CompletionsApi {
  const byId = new Map(configs.map((m) => [m.id, m]));
  const merge = (
    model: Model<any>,
    options?: StreamOptions,
  ): StreamOptions | undefined => {
    const mc = byId.get(model.id);
    if (!mc?.temperature || options?.temperature !== undefined) return options;
    return { ...options, temperature: mc.temperature };
  };
  return {
    stream: (model, context, options) =>
      api.stream(model, context, merge(model, options)) as AssistantMessageEventStream,
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, merge(model, options)) as AssistantMessageEventStream,
  };
}

/** 模型注册表：持有全部 Provider 与模型，运行时唯一入口 */
export class ModelRegistry {
  private readonly models = createModels();

  /** 注册一个 OpenAI 兼容 Provider（含其模型列表），幂等（同名覆盖） */
  registerProvider(provider: ProviderConfig, modelConfigs: ModelConfig[]): void {
    const models: Model<'openai-completions'>[] = modelConfigs.map((mc) => ({
      id: mc.id,
      name: mc.name ?? mc.id,
      api: 'openai-completions',
      provider: provider.id,
      baseUrl: provider.baseUrl,
      reasoning: mc.reasoning ?? false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: mc.contextWindow ?? 128_000,
      maxTokens: mc.maxTokens ?? 8192,
    }));

    const p = createProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      auth: {
        apiKey: {
          name: provider.name,
          // DB 里的 api_key 直接注入；无 key（本地服务如 Ollama）返回空 auth
          resolve: async () =>
            provider.apiKey
              ? { auth: { apiKey: provider.apiKey }, source: 'assemble-provider-config' }
              : { auth: {}, source: 'assemble-provider-no-key' },
        },
      },
      models,
      api: withModelDefaults(openAICompletionsApi(), modelConfigs),
    });

    this.models.setProvider(p);
  }

  /** 注册外部 Provider 实例（测试用 faux provider / 内置 provider） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerProviderInstance(provider: any): void {
    this.models.setProvider(provider);
  }

  getModel(providerId: string, modelId: string): Model<any> | undefined {
    return this.models.getModel(providerId, modelId);
  }

  listProviders(): string[] {
    return this.models.getProviders().map((p) => p.id);
  }

  /** Agent 的 streamFn */
  get streamSimple() {
    return this.models.streamSimple.bind(this.models);
  }

  /** 供测试/管理面直接访问底层 Models */
  get raw() {
    return this.models;
  }
}

// 重新导出，供调用方使用
export type { Context };
