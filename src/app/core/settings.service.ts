import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ProviderConfig, ModelEntry, ModelArchitecture } from '../models/chat-config';
import { getServerConfig } from './server-config';
import { CHAT_API } from '../api/chat-api.token';
import { ChatApiPort } from '../api/chat-api.port';
import {
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateModelRequest,
  UpdateModelRequest
} from '../api/chat-api.types';

function mapProviderModel(raw: any, providerId: string): Omit<ModelEntry, 'id' | 'enabled'> & { enabled?: boolean } {
  const architecture: ModelArchitecture | undefined = raw.architecture
    ? {
      modality: raw.architecture.modality,
      input_modalities: raw.architecture.input_modalities ?? [],
      output_modalities: raw.architecture.output_modalities ?? []
    }
    : undefined;

  const pricing = raw.pricing
    ? {
      prompt: raw.pricing.prompt,
      completion: raw.pricing.completion,
      request: raw.pricing.request,
      image: raw.pricing.image,
      web_search: raw.pricing.web_search,
      internal_reasoning: raw.pricing.internal_reasoning,
      input_cache_read: raw.pricing.input_cache_read,
      input_cache_write: raw.pricing.input_cache_write
    }
    : undefined;

  return {
    displayName: raw.name || raw.id,
    modelId: raw.id,
    providerId,
    type: 'fetched',
    contextLength: raw.context_length ?? raw.top_provider?.context_length ?? undefined,
    description: raw.description ?? '',
    architecture,
    pricing,
    topProvider: raw.top_provider
      ? {
        context_length: raw.top_provider.context_length,
        max_completion_tokens: raw.top_provider.max_completion_tokens ?? null,
        is_moderated: raw.top_provider.is_moderated
      }
      : undefined,
    supportedParameters: raw.supported_parameters ?? [],
    supported_parameters: raw.supported_parameters ?? [],
    reasoning: raw.reasoning,
    created: raw.created,
    ownedBy: raw.owned_by,
    shutdownDate: raw.shutdown_date ?? null,
    canonicalSlug: raw.canonical_slug,
    knowledgeCutoff: raw.knowledge_cutoff ?? null,
    expirationDate: raw.expiration_date ?? null,
    perRequestLimits: raw.per_request_limits ?? null,
    pricing_prompt: raw.pricing?.prompt,
    pricing_completion: raw.pricing?.completion,
    pricing_input_cache_read: raw.pricing?.input_cache_read
  };
}

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly http = inject(HttpClient);
  private readonly serverConfig = getServerConfig();
  private readonly api = inject(CHAT_API);

  private readonly _providers = signal<ProviderConfig[]>([]);
  private readonly _models = signal<ModelEntry[]>([]);

  readonly providers = computed(() => this._providers());
  readonly models = computed(() => this._models());
  readonly enabledModels = computed(() => this._models().filter(m => m.enabled));

  constructor() {
    this.loadAll();
  }

  private get API_BASE(): string {
    return this.serverConfig.apiBase;
  }

  private get PROXY_BASE(): string {
    return this.serverConfig.proxyBase;
  }

  async loadAll(): Promise<void> {
    try {
      const [providers, models] = await Promise.all([
        this.api.getProviders(),
        this.api.getModels()
      ]);
      this._providers.set(providers);
      this._models.set(models);
    } catch (err) {
      console.error('Failed to load settings from server', err);
    }
  }

  async addProvider(provider: Omit<ProviderConfig, 'id'>): Promise<ProviderConfig> {
    const created = await this.api.createProvider(provider as CreateProviderRequest);
    this._providers.update(list => [...list, created]);
    return created;
  }

  async updateProvider(id: string, changes: Partial<ProviderConfig>): Promise<void> {
    const updated = await this.api.updateProvider(id, changes as UpdateProviderRequest);
    this._providers.update(list => list.map(p => (p.id === id ? updated : p)));
  }

  async deleteProvider(id: string): Promise<void> {
    await this.api.deleteProvider(id);
    this._providers.update(list => list.filter(p => p.id !== id));
    this._models.update(list => list.filter(m => m.providerId !== id));
  }

  async addPreset(
    displayName: string,
    modelId: string,
    providerId: string,
    architecture?: ModelArchitecture,
    chatParametersId?: string | null
  ): Promise<ModelEntry> {
    const created = await this.api.createModel({
      displayName,
      modelId,
      providerId,
      type: 'preset',
      enabled: true,
      architecture,
      chatParametersId: chatParametersId ?? null
    } as CreateModelRequest);
    this._models.update(list => [...list, created]);
    return created;
  }

  async updateModel(id: string, changes: UpdateModelRequest): Promise<ModelEntry> {
    const updated = await this.api.updateModel(id, changes);
    this._models.update(list => list.map(m => (m.id === id ? updated : m)));
    return updated;
  }

  async deleteModel(id: string): Promise<void> {
    await this.api.deleteModel(id);
    this._models.update(list => list.filter(m => m.id !== id));
  }

  async toggleModelEnabled(id: string): Promise<void> {
    const result = await this.api.toggleModelEnabled(id);
    this._models.update(list =>
      list.map(m => (m.id === id ? { ...m, enabled: result.enabled } : m))
    );
  }

  async testProvider(provider: ProviderConfig): Promise<{ ok: boolean; message: string }> {
    try {
      await firstValueFrom(
        this.http.get(`${this.PROXY_BASE}/models`, {
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'x-target-base': provider.baseUrl
          }
        })
      );
      return { ok: true, message: 'Connection successful' };
    } catch (err: any) {
      return {
        ok: false,
        message: err?.error?.error?.message || err?.message || 'Connection failed'
      };
    }
  }

  async testModel(provider: ProviderConfig, modelId: string): Promise<{ ok: boolean; message: string }> {
    try {
      const response: any = await firstValueFrom(
        this.http.post(
          `${this.PROXY_BASE}/chat/completions`,
          {
            model: modelId,
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 5
          },
          {
            headers: {
              Authorization: `Bearer ${provider.apiKey}`,
              'Content-Type': 'application/json',
              'x-target-base': provider.baseUrl,
              'HTTP-Referer': 'https://chat-client.local',
              'X-Title': 'Chat Client'
            }
          }
        )
      );

      if (response?.choices?.length > 0) {
        return { ok: true, message: `Model "${modelId}" works` };
      }
      return { ok: false, message: 'Unexpected response from model' };
    } catch (err: any) {
      return {
        ok: false,
        message: err?.error?.error?.message || err?.message || 'Test failed'
      };
    }
  }

  async fetchModels(provider: ProviderConfig): Promise<void> {
    try {
      const currentModels = this._models().filter(m => m.providerId === provider.id);

      const response: any = await firstValueFrom(
        this.http.get(`${this.PROXY_BASE}/models`, {
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'x-target-base': provider.baseUrl
          }
        })
      );

      const freshList = (response.data || []).map((m: any) => mapProviderModel(m, provider.id));
      const freshById = new Map<string, ReturnType<typeof mapProviderModel>>(
        freshList.map((m: ReturnType<typeof mapProviderModel>) => [m.modelId, m])
      );

      for (const existing of currentModels) {
        if (existing.type === 'preset') {
          continue;
        }

        const fresh = freshById.get(existing.modelId);
        if (!fresh) {
          if (existing.enabled) {
            await this.api.updateModel(existing.id, { type: 'discontinued' } as UpdateModelRequest);
          } else {
            await this.api.deleteModel(existing.id);
          }
          continue;
        }

        await this.api.updateModel(existing.id, {
          ...fresh,
          type: existing.type === 'discontinued' ? 'fetched' : existing.type
        } as UpdateModelRequest);
      }

      const existingIds = new Set(currentModels.map(m => m.modelId));
      for (const model of freshList) {
        if (existingIds.has(model.modelId)) {
          continue;
        }
        await this.api.createModel({
          ...model,
          enabled: false
        } as CreateModelRequest);
      }

      await this.loadAll();
    } catch (err: any) {
      console.error('Failed to fetch models', err);
      throw err;
    }
  }
}
