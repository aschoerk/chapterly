export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openrouter' | 'openai' | 'custom';
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export type Modality = 'text' | 'image' | 'audio' | 'video' | 'file';

export interface ModelArchitecture {
  modality?: string;
  input_modalities: string[];
  output_modalities: string[];
  tokenizer?: string;
  instruct_type?: string | null;
}

export interface ModelPricing {
  prompt?: string;
  completion?: string;
  request?: string;
  image?: string;
  web_search?: string;
  internal_reasoning?: string;
  input_cache_read?: string;
  input_cache_write?: string;
}

export interface ModelTopProvider {
  context_length?: number;
  max_completion_tokens?: number | null;
  is_moderated?: boolean;
}

export interface ModelReasoning {
  mandatory?: boolean;
  default_enabled?: boolean;
  supported_efforts?: string[];
  default_effort?: string;
}

export interface ModelPerRequestLimits {
  prompt_tokens?: string | number | null;
  completion_tokens?: string | number | null;
}

export interface ModelEntry {
  id: string;
  displayName: string;
  modelId: string;
  providerId: string;
  type: 'fetched' | 'preset' | 'discontinued';
  enabled: boolean;
  chatParametersId?: string | null;

  // official OpenAI /models
  object?: 'model';
  created?: number;
  ownedBy?: string;
  shutdownDate?: string | null;

  // OpenRouter-compatible catalog
  canonicalSlug?: string;
  description?: string;
  contextLength?: number;
  architecture?: ModelArchitecture;
  pricing?: ModelPricing;
  topProvider?: ModelTopProvider;
  supportedParameters?: string[];
  reasoning?: ModelReasoning;
  knowledgeCutoff?: string | null;
  expirationDate?: string | null;
  perRequestLimits?: ModelPerRequestLimits | null;

  // keep your flattened fields if the UI already binds them
  pricing_prompt?: string;
  pricing_completion?: string;
  pricing_input_cache_read?: string;
  supported_parameters?: string[];
}

export interface AppSettings {
  providers: ProviderConfig[];
  models: ModelEntry[];
}
