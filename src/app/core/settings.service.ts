import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import {ProviderConfig, ModelEntry, ModelArchitecture} from '../models/chat-config';
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
  async addPreset(displayName: string, modelId: string, providerId: string, architecture?: ModelArchitecture): Promise<void> {
    const created = await firstValueFrom(
      this.http.post<ModelEntry>(`${API_BASE}/models`, {
        displayName,
        modelId,
        providerId,
        type: 'preset',
        enabled: true,
        architecture
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

  private createModalityString(inputs: string[], outputs: string[]): string {
    const inputStr = inputs.length > 0 ? inputs.join('+') : 'none';
    const outputStr = outputs.length > 0 ? outputs.join('+') : 'none';
    return `${inputStr}->${outputStr}`;
  }

  async fetchModels(provider: ProviderConfig): Promise<void> {
    try {
      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const fetchedModels: ModelEntry[] = data.data.map((model: any) => {
        // Handle different possible API response structures
        let architecture: ModelArchitecture | undefined;

        // Case 1: Direct architecture object
        if (model.architecture) {
            architecture = {
            modality: model.architecture.modality || this.createModalityString(
              model.architecture.input_modalities || [],
              model.architecture.output_modalities || []
            ),
            input_modalities: model.architecture.input_modalities || [],
            output_modalities: model.architecture.output_modalities || []
          };
        }
        // Case 2: Separate modality fields
        else if (model.input_modalities || model.output_modalities) {
          const inputs = model.input_modalities || [];
          const outputs = model.output_modalities || [];
          architecture = {
            modality: this.createModalityString(inputs, outputs),
            input_modalities: inputs,
            output_modalities: outputs
          };
        }
        // Case 3: Just a modality string
        else if (model.modality) {
          // Parse modality string like "text+image->text"
          const [inputStr, outputStr] = model.modality.split('->');
          const inputs = inputStr ? inputStr.split('+').filter(Boolean) : [];
          const outputs = outputStr ? outputStr.split('+').filter(Boolean) : [];

          architecture = {
            modality: model.modality,
            input_modalities: inputs,
            output_modalities: outputs
          };
        }

        return {
          displayName: model.displayName || model.id,
          modelId: model.id,
          providerId: provider.id,
          enabled: false,
          type: 'fetched',
          architecture
        };
      });

      this._models.update(models => [...models, ...fetchedModels]);
      // this.saveToStorage();
    } catch (error) {
      console.error('Failed to fetch models:', error);
      throw error;
    }
  }
}
