import { Component, computed, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings.service';
import { LlmUseCaseRunner, parseSuggestionVariants } from '../../core/llm/orchestration';
import type { RewriteContextMode } from '../../core/llm/orchestration';
import { RewriteDialogService } from '../../core/rewrite-dialog.service';

/**
 * Suggestions longer than this (characters) are shown only as a short
 * beginning with a “read full text” toggle, so a huge proposal cannot blow up
 * the dialog.
 */
const REWRITE_PREVIEW_LIMIT = 180;

/**
 * localStorage key remembering the model the user last chose in this dialog.
 * When set (and the model is still enabled) it takes precedence over the node
 * default; otherwise the model that generated the node is pre-selected.
 */
export const REWRITE_MODEL_KEY = 'rewriteDialog.lastModelId';

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
  /**
   * Index of the suggestion whose FULL text is currently expanded so it can be
   * read separately; -1 when every suggestion shows only its preview.
   */
  readonly expandedVariant = signal(-1);

  readonly enabledModels = computed(() => this.settings.enabledModels());

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      this.fragment.set(s.fragment);
      this.directions.set(s.directions);
      this.contextMode.set(s.contextMode);
      this.suggestions.set(null);
      this.expandedVariant.set(-1);
      this.loading.set(false);
      // Default: the model that generated the node — unless a previously
      // remembered model choice (still enabled) should be restored.
      this.applyModelSelection(this.initialModelId(s.modelId), s.providerId);
    });
  }

  /**
   * The model to pre-select when the dialog opens: the remembered choice when
   * it is still enabled, otherwise the model that generated the node.
   */
  initialModelId(nodeModelId: string): string {
    const remembered = this.rememberedModelId();
    const rememberedEnabled = this.enabledModels().some(
      m => m.modelId === remembered || m.id === remembered
    );
    return rememberedEnabled ? remembered : nodeModelId;
  }

  /**
   * Set modelId + providerId from a model id, resolving the provider for the
   * matched (or first) enabled model.
   */
  applyModelSelection(modelId: string, fallbackProvider = ''): void {
    const model = this.enabledModels().find(m => m.modelId === modelId || m.id === modelId)
      ?? (!modelId ? this.enabledModels()[0] : undefined);
    this.modelId.set(model ? model.modelId : modelId);
    this.providerId.set(model?.providerId ?? fallbackProvider);
  }

  private rememberedModelId(): string {
    try {
      return localStorage.getItem(REWRITE_MODEL_KEY) ?? '';
    } catch {
      return '';
    }
  }

  private rememberModel(modelId: string): void {
    if (!modelId) return;
    try {
      localStorage.setItem(REWRITE_MODEL_KEY, modelId);
    } catch {
      /* non-fatal — memory is best-effort */
    }
  }

  onModelChange(v: string): void {
    this.applyModelSelection(v);
    this.rememberModel(this.modelId());
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

  /** Whether a suggestion is long enough that only its beginning should be shown. */
  isLongSuggestion(text: string): boolean {
    return text.length > REWRITE_PREVIEW_LIMIT;
  }

  /** Expand a suggestion to read it in full, or collapse it back to the preview. */
  toggleVariant(index: number): void {
    this.expandedVariant.set(this.expandedVariant() === index ? -1 : index);
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

  /**
   * Escape cancels the dialog. Handled at document level so it works even
   * when focus is outside the dialog (the backdrop only catches keys once
   * an inner control has focus). Guarded by the open state, so it never
   * interferes while the dialog is closed; a running rewrite is not
   * cancelled (mirrors the backdrop/keydown handling).
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current() && !this.loading()) {
      ev.preventDefault();
      this.dialog.cancel();
    }
  }
}