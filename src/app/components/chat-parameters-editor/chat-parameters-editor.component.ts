import { Component, effect, inject, input, output, signal } from '@angular/core';
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
import { I18nService } from '../../core/i18n/i18n.service';

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
  readonly i18n = inject(I18nService);
  readonly compact = input(false);
  readonly inherited = input<ResolvedChatParameters | null>(null);
  readonly initial = input<ChatParametersDraft | null>(null);
  readonly initialOverride = input(false);

  readonly changed = output<{ override: boolean; draft: ChatParametersDraft }>();

  readonly overrideEnabled = signal(false);
  readonly draft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly openHint = signal<ParamHintKey | null>(null);

  readonly levels = THINKING_LEVELS;

  hint(key: ParamHintKey) {
    const map: Record<ParamHintKey, { title: string; body: string }> = {
      override: { title: this.i18n.t('params.hintOverrideTitle'), body: this.i18n.t('params.hintOverrideBody') },
      effective: { title: this.i18n.t('params.hintEffectiveTitle'), body: this.i18n.t('params.hintEffectiveBody') },
      temperature: { title: this.i18n.t('params.hintTemperatureTitle'), body: this.i18n.t('params.hintTemperatureBody') },
      topK: { title: this.i18n.t('params.hintTopKTitle'), body: this.i18n.t('params.hintTopKBody') },
      topM: { title: this.i18n.t('params.hintTopMTitle'), body: this.i18n.t('params.hintTopMBody') },
      stream: { title: this.i18n.t('params.hintStreamTitle'), body: this.i18n.t('params.hintStreamBody') },
      thinking: { title: this.i18n.t('params.hintThinkingTitle'), body: this.i18n.t('params.hintThinkingBody') },
      thinkingLevel: { title: this.i18n.t('params.hintThinkingLevelTitle'), body: this.i18n.t('params.hintThinkingLevelBody') }
    };
    return map[key];
  }

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
    if (!src || src === 'default') return this.i18n.t('params.sourceDefault');
    return src.replace('_', ' ');
  }

  toggleHint(key: ParamHintKey, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    this.openHint.update(current => current === key ? null : key);
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
