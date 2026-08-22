import { Injectable, signal, computed } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { AppSettings, ProviderConfig, ModelEntry } from '../models/chat-config';

const STORAGE_KEY = 'chat-client-settings';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {
  private readonly http = inject(HttpClient);

  // Internal state
  private readonly _settings = signal<AppSettings>(this.loadFromStorage());

  // Public readonly signals
  readonly providers = computed(() => this._settings().providers);
  readonly models = computed(() => this._settings().models);
  readonly enabledModels = computed(() =>
    this._settings().models.filter(m => m.enabled)
  );

  constructor() {}

  // ---------- Persistence ----------
  private loadFromStorage(): AppSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch {}
    return { providers: [], models: [] };
  }

  private save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings()));
  }

  // ---------- Providers ----------
  addProvider(provider: Omit<ProviderConfig, 'id'>) {
    const newProvider: ProviderConfig = {
      ...provider,
      id: crypto.randomUUID()
    };

    this._settings.update(s => ({
      ...s,
      providers: [...s.providers, newProvider]
    }));
    this.save();
    return newProvider;
  }

  updateProvider(id: string, changes: Partial<ProviderConfig>) {
    this._settings.update(s => ({
      ...s,
      providers: s.providers.map(p =>
        p.id === id ? { ...p, ...changes } : p
      )
    }));
    this.save();
  }

  deleteProvider(id: string) {
    this._settings.update(s => ({
      providers: s.providers.filter(p => p.id !== id),
      models: s.models.filter(m => m.providerId !== id)
    }));
    this.save();
  }

  // ---------- Models / Presets ----------
  addPreset(displayName: string, modelId: string, providerId: string) {
    const entry: ModelEntry = {
      id: crypto.randomUUID(),
      displayName,
      modelId,
      providerId,
      type: 'preset',
      enabled: true
    };

    this._settings.update(s => ({
      ...s,
      models: [...s.models, entry]
    }));
    this.save();
  }

  deleteModel(id: string) {
    this._settings.update(s => ({
      ...s,
      models: s.models.filter(m => m.id !== id)
    }));
    this.save();
  }

  toggleModelEnabled(id: string) {
    this._settings.update(s => ({
      ...s,
      models: s.models.map(m =>
        m.id === id ? { ...m, enabled: !m.enabled } : m
      )
    }));
    this.save();
  }

  // ---------- OpenRouter specific ----------
  async testProvider(provider: ProviderConfig): Promise<{ ok: boolean; message: string }> {
    try {
      const headers = new HttpHeaders({
        Authorization: `Bearer ${provider.apiKey}`
      });

      await firstValueFrom(
        this.http.get(`${provider.baseUrl}/models`, { headers })
      );

      return { ok: true, message: 'Connection successful' };
    } catch (err: any) {
      return {
        ok: false,
        message: err?.error?.error?.message || err.message || 'Connection failed'
      };
    }
  }

  async fetchModels(provider: ProviderConfig): Promise<void> {
    const headers = new HttpHeaders({
      Authorization: `Bearer ${provider.apiKey}`
    });

    const response: any = await firstValueFrom(
      this.http.get(`${provider.baseUrl}/models`, { headers })
    );

    const fetched: ModelEntry[] = (response.data || []).map((m: any) => ({
      id: crypto.randomUUID(),
      displayName: m.name || m.id,
      modelId: m.id,
      providerId: provider.id,
      type: 'fetched' as const,
      enabled: false,
      contextLength: m.context_length
    }));

    // Keep existing presets, replace old fetched models of this provider
    this._settings.update(s => {
      const presets = s.models.filter(
        m => m.type === 'preset' || m.providerId !== provider.id
      );
      return {
        ...s,
        models: [...presets, ...fetched]
      };
    });

    this.save();
  }
}

// helper for inject
import { inject } from '@angular/core';
