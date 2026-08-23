import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ProviderConfig, ModelEntry } from '../models/chat-config';
import { getServerConfig } from './server-config';

const API_BASE = 'http://localhost:3847/api';   // we can make this dynamic later

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly http = inject(HttpClient);

  private readonly _providers = signal<ProviderConfig[]>([]);
  private readonly _models = signal<ModelEntry[]>([]);

  readonly providers = computed(() => this._providers());
  readonly models = computed(() => this._models());
  readonly enabledModels = computed(() =>
    this._models().filter(m => m.enabled)
  );

  constructor() {
    this.loadAll();
  }

  private readonly serverConfig = getServerConfig();

// Replace the old hardcoded constants with:
  private get API_BASE() {
    return this.serverConfig.apiBase;
  }

  private get PROXY_BASE() {
    return this.serverConfig.proxyBase;
  }

  // ---------- Load data from the server ----------
  async loadAll() {
    try {
      const [providers, models] = await Promise.all([
        firstValueFrom(this.http.get<ProviderConfig[]>(`${API_BASE}/providers`)),
        firstValueFrom(this.http.get<ModelEntry[]>(`${API_BASE}/models`))
      ]);

      this._providers.set(providers);
      this._models.set(models);
    } catch (err) {
      console.error('Failed to load settings from server', err);
    }
  }

  // ---------- Providers ----------
  async addProvider(provider: Omit<ProviderConfig, 'id'>): Promise<ProviderConfig> {
    const created = await firstValueFrom(
      this.http.post<ProviderConfig>(`${API_BASE}/providers`, provider)
    );
    this._providers.update(list => [...list, created]);
    return created;
  }

  async updateProvider(id: string, changes: Partial<ProviderConfig>): Promise<void> {
    const updated = await firstValueFrom(
      this.http.put<ProviderConfig>(`${API_BASE}/providers/${id}`, changes)
    );
    this._providers.update(list =>
      list.map(p => (p.id === id ? updated : p))
    );
  }

  async deleteProvider(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${API_BASE}/providers/${id}`));
    this._providers.update(list => list.filter(p => p.id !== id));
    this._models.update(list => list.filter(m => m.providerId !== id));
  }

  // ---------- Models / Presets ----------
  async addPreset(displayName: string, modelId: string, providerId: string): Promise<void> {
    const created = await firstValueFrom(
      this.http.post<ModelEntry>(`${API_BASE}/models`, {
        displayName,
        modelId,
        providerId,
        type: 'preset',
        enabled: true
      })
    );
    this._models.update(list => [...list, created]);
  }

  async deleteModel(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${API_BASE}/models/${id}`));
    this._models.update(list => list.filter(m => m.id !== id));
  }

  async toggleModelEnabled(id: string): Promise<void> {
    const result = await firstValueFrom(
      this.http.patch<{ id: string; enabled: boolean }>(`${API_BASE}/models/${id}/toggle`, {})
    );
    this._models.update(list =>
      list.map(m => (m.id === id ? { ...m, enabled: result.enabled } : m))
    );
  }


  async testProvider(provider: ProviderConfig): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await firstValueFrom(
        this.http.get(`${this.PROXY_BASE}/models`, {
          headers: {
            'Authorization': `Bearer ${provider.apiKey}`,
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
        this.http.post(`${this.PROXY_BASE}/chat/completions`, {
          model: modelId,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        }, {
          headers: {
            'Authorization': `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
            'x-target-base': provider.baseUrl,
            'HTTP-Referer': 'https://chat-client.local',
            'X-Title': 'Chat Client'
          }
        })
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
      // 1. Get current models of this provider from the local state
      const currentModels = this._models().filter(m => m.providerId === provider.id);

      // 2. Fetch the fresh list from the provider
      const response: any = await firstValueFrom(
        this.http.get(`${this.PROXY_BASE}/models`, {
          headers: {
            'Authorization': `Bearer ${provider.apiKey}`,
            'x-target-base': provider.baseUrl
          }
        })
      );

      const freshList = (response.data || []).map((m: any) => ({
        displayName: m.name || m.id,
        modelId: m.id,
        providerId: provider.id,
        type: 'fetched' as const,
        enabled: false,
        contextLength: m.context_length
      }));

      const freshModelIds = new Set(freshList.map((m: any) => m.modelId));

      // 3. Handle existing models
      for (const existing of currentModels) {
        // Never touch presets
        if (existing.type === 'preset') {
          continue;
        }

        const stillExists = freshModelIds.has(existing.modelId);

        if (!stillExists) {
          if (existing.enabled) {
            // Mark as discontinued
            await firstValueFrom(
              this.http.put(`${this.API_BASE}/models/${existing.id}`, {
                type: 'discontinued'
              })
            );
          } else {
            // Not enabled → delete
            await firstValueFrom(
              this.http.delete(`${this.API_BASE}/models/${existing.id}`)
            );
          }
        }
      }

      // 4. Add models that are completely new
      const existingModelIds = new Set(currentModels.map(m => m.modelId));
      const newModels = freshList.filter((m: any) => !existingModelIds.has(m.modelId));

      for (const model of newModels) {
        await firstValueFrom(
          this.http.post(`${this.API_BASE}/models`, model)
        );
      }

      // 5. Reload everything from the server to have a clean state
      await this.loadAll();

    } catch (err: any) {
      console.error('Failed to fetch models', err);
      throw err;
    }
  }
}
