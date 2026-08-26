export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openrouter' | 'openai' | 'custom';
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

// In your models/chat-config.ts
export interface ModelArchitecture {
  modality: string; // e.g., "text+image+file+audio+video->text"
  input_modalities: string[]; // e.g., ["text", "image", "audio", "video", "file"]
  output_modalities: string[]; // e.g., ["text"]
}

export interface Reasoning {
  mandatory: boolean;
  default_enabled: boolean;
  supported_efforts: string[];
  default_effort: string;
}


export interface ModelEntry {
  id: string;
  displayName: string;
  modelId: string;
  providerId: string;
  type: 'fetched' | 'preset' | 'discontinued';
  enabled: boolean;
  contextLength?: number;
  description: string;
  supported_parameters: string[]
  pricing_prompt: string;
  pricing_completion: string;
  pricing_input_cache_read: string;
  reasoning: Reasoning;
  architecture?: ModelArchitecture; // Add this field
}



export interface AppSettings {
  providers: ProviderConfig[];
  models: ModelEntry[];
}
