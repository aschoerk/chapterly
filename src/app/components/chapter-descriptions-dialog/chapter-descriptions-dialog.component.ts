import { Component, HostListener, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings.service';
import { ChapterDescriptionsDialogService } from '../../core/chapter-descriptions-dialog.service';

/**
 * "Create chapter descriptions" dialog — asks for the parameters of a chapter
 * description list (number of chapters, sentences per description, first
 * chapter number, heading model, and what the chapters should achieve), then
 * the caller generates the list as a new branch. The LAST input parameters
 * are remembered per chat, so a second press of the button provides them
 * again (with the first chapter number continuing after the last generated
 * one).
 */
@Component({
  selector: 'app-chapter-descriptions-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './chapter-descriptions-dialog.component.html',
  styleUrl: './chapter-descriptions-dialog.component.css'
})
export class ChapterDescriptionsDialogComponent {
  readonly dialog = inject(ChapterDescriptionsDialogService);
  readonly i18n = inject(I18nService);
  private readonly settings = inject(SettingsService);

  /** Number of chapter headings / descriptions to create. */
  readonly chapterCount = signal(5);
  /** Number of sentences each chapter description should contain. */
  readonly sentencesPerChapter = signal(1);
  /** Number of the first chapter (default 1 or the last generated + 1). */
  readonly firstChapter = signal(1);
  /** What the chapters are meant to achieve (free text). */
  readonly goal = signal('');
  /** Selected heading model (default: the current model). */
  readonly modelId = signal('');
  readonly providerId = signal('');

  readonly enabledModels = computed(() => this.settings.enabledModels());

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      // Seed the fields from the latest input parameters (prefilled by the
      // service — including the bumped first chapter number).
      this.chapterCount.set(s.chapterCount);
      this.sentencesPerChapter.set(s.sentencesPerChapter);
      this.firstChapter.set(s.firstChapter);
      this.goal.set(s.goal);
      this.modelId.set(s.modelId);
      this.providerId.set(s.providerId);
    });
  }

  /** Keep the provider in sync with the model chosen in the dropdown. */
  onModelChange(modelId: string): void {
    this.modelId.set(modelId);
    const match = this.enabledModels().find(m => m.modelId === modelId || m.id === modelId);
    this.providerId.set(match?.providerId ?? '');
  }

  submit(): void {
    const count = Math.max(1, Math.floor(+this.chapterCount() || 1));
    const sentences = Math.max(1, Math.floor(+this.sentencesPerChapter() || 1));
    const first = Math.max(1, Math.floor(+this.firstChapter() || 1));
    if (!this.modelId()) {
      alert(this.i18n.t('chapterDescriptionsDialog.modelMissing'));
      return;
    }
    this.dialog.submit({
      chapterCount: count,
      sentencesPerChapter: sentences,
      firstChapter: first,
      goal: this.goal().trim(),
      modelId: this.modelId(),
      providerId: this.providerId()
    });
  }

  onBackdrop(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget) this.dialog.cancel();
  }

  onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') this.dialog.cancel();
  }

  /**
   * Escape cancels the dialog. Handled at document level so it works even
   * when focus is outside the dialog (the backdrop only catches keys once
   * an inner control has focus). Guarded by the open state, so it never
   * interferes while the dialog is closed.
   */
  @HostListener('document:keydown', ['$event'])
  onDocumentKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && this.dialog.current()) {
      ev.preventDefault();
      this.dialog.cancel();
    }
  }
}