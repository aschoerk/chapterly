import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings.service';
import { LlmUseCaseRunner, parseSuggestionVariants } from '../../core/llm/orchestration';
import type { RewriteContextMode } from '../../core/llm/orchestration';
import { RewriteDialogService } from '../../core/rewrite-dialog.service';

@Component({
  selector: 'app-rewrite-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './rewrite-dialog.component.html',
  styleUrl: './rewrite-dialog.component.css'
})
export class RewriteDialogComponent {
  readonly dialog = inject(RewriteDialogService);
  readonly settings = inject(SettingsService);
  readonly i18n = inject(I18nService);
  private readonly runner = inject(LlmUseCaseRunner);

  /** The text to be rewritten (editable — prefilled from the selection). */
  readonly fragment = signal('');
  /** Free-form directions / hints how the text should change. */
  readonly directions = signal('');
  /** How much surrounding context the model should see. */
  readonly contextMode = signal<RewriteContextMode>('node');
  /** Selected model (defaults to the one that created the node). */
  readonly modelId = signal('');
  readonly providerId = signal('');

  readonly loading = signal(false);
  /** The 3 suggested variants returned by the model (null until run). */
  readonly suggestions = signal<string[] | null>(null);

  readonly enabledModels = computed(() => this.settings.enabledModels());

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      this.fragment.set(s.fragment);
      this.directions.set(s.directions);
      this.contextMode.set(s.contextMode);
      this.modelId.set(s.modelId);
      this.providerId.set(s.providerId);
      this.suggestions.set(null);
      this.loading.set(false);
    });
  }

  onModelChange(v: string): void {
    this.modelId.set(v);
    const model = this.enabledModels().find(m => m.modelId === v || m.id === v);
    this.providerId.set(model?.providerId ?? '');
  }

  /** The selectable context scopes with labels + hints. */
  contextOptions(): { mode: RewriteContextMode; label: string; hint: string }[] {
    return [
      { mode: 'none', label: this.i18n.t('rewriteDialog.contextNone'), hint: this.i18n.t('rewriteDialog.contextNoneHint') },
      { mode: 'node', label: this.i18n.t('rewriteDialog.contextNode'), hint: this.i18n.t('rewriteDialog.contextNodeHint') },
      { mode: 'upto', label: this.i18n.t('rewriteDialog.contextUpto'), hint: this.i18n.t('rewriteDialog.contextUptoHint') },
      { mode: 'all', label: this.i18n.t('rewriteDialog.contextAll'), hint: this.i18n.t('rewriteDialog.contextAllHint') }
    ];
  }

  suggestionTag(index: number): string {
    return this.i18n.t(
      ['rewriteDialog.suggestionMinimal', 'rewriteDialog.suggestionClearer', 'rewriteDialog.suggestionRewritten'][index]
    );
  }

  /** Run the rewrite use case for the current fragment + directions + context. */
  async rewrite(): Promise<void> {
    const d = this.dialog.current();
    if (!d || this.loading()) return;
    const fragment = this.fragment().trim();
    if (!fragment) {
      alert(this.i18n.t('rewriteDialog.empty'));
      return;
    }
    const model = this.enabledModels().find(m => m.modelId === this.modelId() || m.id === this.modelId());
    if (!model || !model.providerId) {
      alert(this.i18n.t('rewriteDialog.modelMissing'));
      return;
    }

    this.loading.set(true);
    try {
      const slots = await this.runner.run({
        chat: d.chat,
        node: d.node,
        usecase: 'rewrite-selection',
        vars: {
          content: fragment,
          directions: this.directions().trim(),
          contextMode: this.contextMode(),
          selectionEnd: d.selectionEnd,
          modelId: model.modelId,
          providerId: model.providerId
        }
      });
      if (slots.error?.status === 'error') {
        const reason = (slots.error.reason ?? '').trim();
        throw new Error(reason || this.i18n.t('rewriteDialog.failed'));
      }
      const variants = parseSuggestionVariants(slots.text?.value ?? '');
      if (variants.length === 0) {
        alert(this.i18n.t('rewriteDialog.failed', {
          error: this.i18n.t('rewriteDialog.noVariants')
        }));
        return;
      }
      this.suggestions.set(variants);
    } catch (err: any) {
      console.error(err);
      alert(this.i18n.t('rewriteDialog.failed', { error: err?.message || err }));
    } finally {
      this.loading.set(false);
    }
  }

  /** Apply a suggested variant as the replacement for the marked range. */
  useVariant(text: string): void {
    const t = (text ?? '').trim();
    if (t) this.dialog.close(t);
  }

  /** Apply the edited fragment as-is, without further LLM changes. */
  applyEdited(): void {
    const t = this.fragment().trim();
    if (t) this.dialog.close(t);
  }

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.dialog.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && !this.loading()) this.dialog.cancel();
  }
}