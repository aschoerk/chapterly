import { Injectable, inject, signal } from '@angular/core';
import { SettingsService } from './settings.service';
import {
  GenerationTaskConfig,
  GenerationTaskKind,
  GENERATION_TASK_KINDS,
  emptyGenerationTaskConfig
} from '../models/generation-task';
import { ModelEntry, ProviderConfig } from '../models/chat-config';

const LS_KEY = 'chat.generationTasks';

function defaults(): Record<GenerationTaskKind, GenerationTaskConfig> {
  const map = {} as Record<GenerationTaskKind, GenerationTaskConfig>;
  for (const kind of GENERATION_TASK_KINDS) {
    map[kind] = emptyGenerationTaskConfig(kind);
  }
  return map;
}

function readStored(): Record<GenerationTaskKind, GenerationTaskConfig> {
  const base = defaults();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    for (const kind of GENERATION_TASK_KINDS) {
      const entry = parsed[kind];
      if (entry && typeof entry === 'object') {
        base[kind] = {
          kind,
          providerId: typeof entry.providerId === 'string' ? entry.providerId : '',
          modelId: typeof entry.modelId === 'string' ? entry.modelId : '',
          prompt: typeof entry.prompt === 'string' ? entry.prompt : ''
        };
      }
    }
    return base;
  } catch {
    return base;
  }
}

/**
 * Per-authoring-task AI settings (provider/model + prompt).
 *
 * Persisted in localStorage (like the theme), so it survives reloads on this
 * browser. The actual providers/models live in SettingsService; we only keep
 * references (providerId + provider model string) plus an optional prompt
 * template.
 */
@Injectable({ providedIn: 'root' })
export class GenerationSettingsService {
  private readonly settings = inject(SettingsService);

  private readonly _configs = signal<Record<GenerationTaskKind, GenerationTaskConfig>>(readStored());

  /** All per-task configs (read-only signal). */
  readonly configs = this._configs.asReadonly();

  get(kind: GenerationTaskKind): GenerationTaskConfig {
    return this._configs()[kind];
  }

  update(kind: GenerationTaskKind, patch: Partial<Omit<GenerationTaskConfig, 'kind'>>): void {
    this._configs.update(map => ({
      ...map,
      [kind]: { ...map[kind], ...patch }
    }));
    this.persist();
  }

  reset(kind: GenerationTaskKind): void {
    this._configs.update(map => ({ ...map, [kind]: emptyGenerationTaskConfig(kind) }));
    this.persist();
  }

  persist(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this._configs()));
    } catch {
      // storage may be unavailable (private mode / SSR) — ignore.
    }
  }

  /** Enabled models belonging to a provider (current catalog). */
  modelsForProvider(providerId: string): ModelEntry[] {
    if (!providerId) return [];
    return this.settings.enabledModels().filter(m => m.providerId === providerId);
  }

  /** Resolve the provider config for a task, or null if unset/unknown. */
  providerFor(kind: GenerationTaskKind): ProviderConfig | null {
    const cfg = this.get(kind);
    if (!cfg.providerId) return null;
    return this.settings.providers().find(p => p.id === cfg.providerId) ?? null;
  }

  /** Resolve the enabled model entry matching a task config, if any. */
  modelFor(kind: GenerationTaskKind): ModelEntry | null {
    const cfg = this.get(kind);
    if (!cfg.providerId || !cfg.modelId) return null;
    return this.settings.enabledModels().find(
      m => m.providerId === cfg.providerId && m.modelId === cfg.modelId
    ) ?? null;
  }
}