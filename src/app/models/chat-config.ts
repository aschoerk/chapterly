export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openrouter' | 'openai' | 'custom';
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface ModelEntry {
  id: string;                 // internal unique id
  displayName: string;
  modelId: string;            // e.g. "anthropic/claude-3.5-sonnet"
  providerId: string;
  type: 'fetched' | 'preset' | 'discontinued';
  enabled: boolean;
  contextLength?: number;
}

export interface AppSettings {
  providers: ProviderConfig[];
  models: ModelEntry[];
}
