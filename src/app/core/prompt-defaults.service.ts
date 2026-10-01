import { Injectable, signal } from '@angular/core';
import {
  PROMPT_DEFAULTS,
  promptDefaultById,
  type PromptDefaultCategory,
  type PromptDefaultDef
} from '../models/prompt-default';

const LS_KEY = 'chat.promptDefaults';

function readStored(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && promptDefaultById(id)) {
        out[id] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * User-editable overrides for the auto-generated LLM prompt templates.
 *
 * Each template has a built-in default (see `models/prompt-default.ts`) and a
 * per-browser override stored in localStorage (like the theme). `effective(id)`
 * returns the override when present, otherwise the built-in default, so the
 * LLM call sites always use the user's latest value. Empty overrides and
 * overrides that equal the default are pruned automatically so a reset is a
 * clean delete.
 *
 * Prompts are English-only (not i18n).
 */
@Injectable({ providedIn: 'root' })
export class PromptDefaultsService {
  /** Map of id → user override for templates the user has customized. */
  private readonly _overrides = signal<Record<string, string>>(readStored());

  /** Public readonly override map (reactive, for the settings UI). */
  readonly overrides = this._overrides.asReadonly();

  /** All customized override ids (reactive, for the settings UI). */
  readonly customized = signal<string[]>([]);

  constructor() {
    this.syncCustomized();
  }

  /** All prompt default definitions. */
  all(): PromptDefaultDef[] {
    return PROMPT_DEFAULTS;
  }

  /** Definitions grouped by category, in display order. */
  byCategory(category: PromptDefaultCategory): PromptDefaultDef[] {
    return PROMPT_DEFAULTS.filter(d => d.category === category);
  }

  /** A definition by id (or undefined). */
  def(id: string): PromptDefaultDef | undefined {
    return promptDefaultById(id);
  }

  /** Effective template: the user override when set, otherwise the default. */
  effective(id: string): string {
    const d = promptDefaultById(id);
    if (!d) return '';
    return this.overrides()[id] ?? d.default;
  }

  /** True when the user has customized this template. */
  isCustom(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.overrides(), id);
  }

  /**
   * Set (or clear) the override for one template. Passing the exact default
   * text removes the override. Empty text restores the default as well.
   */
  update(id: string, text: string): void {
    if (!promptDefaultById(id)) return;
    this._overrides.update(map => {
      const next = { ...map };
      const trimmed = text ?? '';
      if (!trimmed.trim() || trimmed === promptDefaultById(id)!.default) {
        delete next[id];
      } else {
        next[id] = trimmed;
      }
      return next;
    });
    this.persist();
  }

  /** Restore one template to its built-in default. */
  reset(id: string): void {
    if (!promptDefaultById(id)) return;
    this._overrides.update(map => {
      const next = { ...map };
      delete next[id];
      return next;
    });
    this.persist();
  }

  /** Restore every template to its built-in default. */
  resetAll(): void {
    this._overrides.set({});
    this.persist();
  }

  /**
   * Render the effective template for `id`, replacing `{{key}}` placeholders
   * with the given values. Unknown placeholders are left as-is.
   */
  render(id: string, vars: Record<string, string | number>): string {
    let text = this.effective(id);
    for (const [key, value] of Object.entries(vars)) {
      text = text.split(`{{${key}}}`).join(String(value));
    }
    return text;
  }

  private persist(): void {
    this.syncCustomized();
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.overrides()));
    } catch {
      // storage may be unavailable (private mode / SSR) — ignore.
    }
  }

  private syncCustomized(): void {
    this.customized.set(
      PROMPT_DEFAULTS
        .map(d => d.id)
        .filter(id => this.isCustom(id))
    );
  }
}