import { Component, effect, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ChatParametersDraft,
  ResolvedChatParameters,
  THINKING_LEVELS,
  ThinkingLevel,
  emptyParametersDraft,
  formatParametersSummary
} from '../../models/chat-parameters';

export type ParamHintKey =
  | 'override'
  | 'effective'
  | 'temperature'
  | 'topK'
  | 'topM'
  | 'stream'
  | 'thinking'
  | 'thinkingLevel';

@Component({
  selector: 'app-chat-parameters-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-parameters-editor.component.html',
  styleUrl: './chat-parameters-editor.component.css'
})
export class ChatParametersEditorComponent {
  readonly compact = input(false);
  readonly inherited = input<ResolvedChatParameters | null>(null);
  readonly initial = input<ChatParametersDraft | null>(null);
  readonly initialOverride = input(false);

  readonly changed = output<{ override: boolean; draft: ChatParametersDraft }>();

  readonly overrideEnabled = signal(false);
  readonly draft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly openHint = signal<ParamHintKey | null>(null);

  readonly levels = THINKING_LEVELS;

  readonly hints: Record<ParamHintKey, { title: string; body: string }> = {
    override: {
      title: 'Override generation settings',
      body: 'Off: this topic, project, model or chat inherits values from the next parent (model → topic → project → chat). On: store a dedicated parameter set on this item. Empty fields still inherit.'
    },
    effective: {
      title: 'Effective values',
      body: 'What will actually be sent after merging parents. The label in parentheses is the closest owner that set a value. Built-in defaults are temperature 0.7 and streaming on.'
    },
    temperature: {
      title: 'Temperature',
      body: 'OpenAI temperature, usually 0–2. Lower is more deterministic; higher is more varied. Leave empty to inherit. Default if nothing is set: 0.7.'
    },
    topK: {
      title: 'top_k',
      body: 'Limits sampling to the K most likely tokens. Used by many OpenAI-compatible providers (OpenRouter, Groq, local servers). OpenAI itself ignores this. Empty means inherit / omit.'
    },
    topM: {
      title: 'top_m / top_p',
      body: 'Nucleus sampling. Stored as top_m and sent as OpenAI top_p (0–1). 0.9 keeps the smallest set of tokens whose probabilities add up to 90%. Empty means inherit / omit.'
    },
    stream: {
      title: 'Stream',
      body: 'Yes streams tokens as they arrive. No waits for the full reply as one JSON message — useful for models that mishandle SSE. Inherit uses the parent, then streaming on.'
    },
    thinking: {
      title: 'Thinking',
      body: 'Ask the model for a reasoning / thinking trace (include_reasoning). Shown on the answer node when the provider returns it. No disables reasoning extras even if the model supports them.'
    },
    thinkingLevel: {
      title: 'Thinking level',
      body: 'Maps to OpenAI reasoning_effort: none, minimal, low, medium, high. Used when thinking is on. none turns reasoning off. Empty inherits the model catalog default if any.'
    }
  };

  constructor() {
    effect(() => {
      const init = this.initial();
      const on = this.initialOverride();
      this.overrideEnabled.set(on);
      this.draft.set(init ? { ...init } : emptyParametersDraft());
    });
  }

  summary(): string {
    return formatParametersSummary(this.inherited());
  }

  sourceLabel(): string {
    const src = this.inherited()?.source;
    if (!src || src === 'default') return 'built-in defaults';
    return src.replace('_', ' ');
  }

  toggleHint(key: ParamHintKey, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    this.openHint.update(current => current === key ? null : key);
  }

  hint(key: ParamHintKey) {
    return this.hints[key];
  }

  setOverride(on: boolean) {
    this.overrideEnabled.set(on);
    this.emit();
  }

  patch<K extends keyof ChatParametersDraft>(key: K, value: ChatParametersDraft[K]) {
    this.draft.update(d => ({ ...d, [key]: value }));
    this.emit();
  }

  setNumber(key: 'temperature' | 'topK' | 'topM', raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      this.patch(key, null);
      return;
    }
    const n = Number(trimmed);
    this.patch(key, Number.isFinite(n) ? n : null);
  }

  setTriState(key: 'stream' | 'thinking', raw: string) {
    if (raw === 'inherit') this.patch(key, null);
    else this.patch(key, raw === 'yes');
  }

  setLevel(raw: string) {
    if (!raw) this.patch('thinkingLevel', null);
    else this.patch('thinkingLevel', raw as ThinkingLevel);
  }

  triValue(value: boolean | null): string {
    if (value == null) return 'inherit';
    return value ? 'yes' : 'no';
  }

  private emit() {
    this.changed.emit({
      override: this.overrideEnabled(),
      draft: { ...this.draft() }
    });
  }
}
