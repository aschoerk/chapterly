import { Component, computed, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { IllustrateDialogService } from '../../core/illustrate-dialog.service';
import { SettingsService } from '../../core/settings.service';
import { GenerationSettingsService } from '../../core/generation-settings.service';
import { canGenerateImages, ModelEntry } from '../../models/chat-config';
import {
  ILLUSTRATE_COUNT_MIN,
  IllustrateHistoryMode
} from '../../models/illustrate-options';

@Component({
  selector: 'app-illustrate-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './illustrate-dialog.component.html',
  styleUrl: './illustrate-dialog.component.css'
})
export class IllustrateDialogComponent {
  readonly dialog = inject(IllustrateDialogService);
  readonly i18n = inject(I18nService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);

  readonly count = signal(1);
  readonly style = signal('');
  readonly storyboardPrompt = signal('');
  readonly purePictures = signal(false);
  readonly modelId = signal('');
  readonly providerId = signal('');
  readonly historyMode = signal<IllustrateHistoryMode>('single');
  readonly planDescriptions = signal(true);
  readonly showStoryboard = computed(() => this.count() > 1);
  /**
   * Full-chat context is only meaningful for a SINGLE picture (count 1) and
   * never in pure picture mode (which by design sends descriptions only, not
   * the raw story text). The "Full chat" radio is disabled then.
   */
  readonly showContextMode = computed(() => !this.showStoryboard());
  readonly fullContextDisabled = computed(() => this.purePictures());
  /**
   * Picture-description planning can be turned off — except in pure picture
   * mode, where the derived descriptions ARE what reaches the image model
   * (raw story prose is never sent).
   */
  readonly planningDisabled = computed(() => this.purePictures());

  /**
   * Models the user can render with: every enabled image-capable model, plus
   * the configured "image-create" task model when it is not among them (so a
   * task model that lacks an image-modality declaration still shows up).
   */
  readonly imageModels = computed<ModelEntry[]>(() => {
    const enabled = this.settings.enabledModels().filter(canGenerateImages);
    const task = this.generation.modelFor('image-create');
    if (task && !enabled.some(m => m.providerId === task.providerId && m.modelId === task.modelId)) {
      return [task, ...enabled];
    }
    return enabled;
  });

  constructor() {
    effect(() => {
      const s = this.dialog.current();
      if (!s) return;
      // Seed the editor from the options the dialog was opened with.
      this.count.set(s.count);
      this.style.set(s.style);
      this.storyboardPrompt.set(s.storyboardPrompt);
      this.purePictures.set(s.purePictures);
      this.modelId.set(s.modelId);
      this.providerId.set(s.providerId);
      this.historyMode.set(s.historyMode);
      this.planDescriptions.set(s.planDescriptions);
    });
  }

  onCountInput(value: string): void {
    const n = Number(value);
    if (Number.isFinite(n) && n >= ILLUSTRATE_COUNT_MIN) {
      this.count.set(Math.floor(n));
    }
  }

  /** Keep the provider in sync with the model chosen in the dropdown. */
  onModelChange(modelId: string): void {
    this.modelId.set(modelId);
    const match = this.imageModels().find(
      m => m.modelId === modelId || m.id === modelId
    );
    this.providerId.set(match?.providerId ?? '');
  }

  /** Only 'single' is a valid full-context choice in pure picture mode. */
  onHistoryMode(value: string): void {
    this.historyMode.set(value === 'full' && !this.purePictures() ? 'full' : 'single');
  }

  onPureChange(checked: boolean): void {
    this.purePictures.set(!!checked);
  }

  /**
   * Planning stays on in pure picture mode (forced — see submit). Unchecking
   * it for a single picture means the raw story text is sent to the image
   * model directly instead of being distilled by a text model first.
   */
  onPlanChange(value: boolean): void {
    this.planDescriptions.set(this.purePictures() ? true : value);
  }

  submit(): void {
    this.dialog.submit({
      count: this.count(),
      style: this.style(),
      storyboardPrompt: this.storyboardPrompt(),
      purePictures: this.purePictures(),
      modelId: this.modelId(),
      providerId: this.providerId(),
      // Pure picture mode never forwards the raw chat, so a remembered 'full'
      // selection is clamped back to 'single'.
      historyMode: this.purePictures() ? 'single' : this.historyMode(),
      // Pure picture mode REQUIRES the derived descriptions — raw story prose
      // must never reach the image model — so planning is forced back on.
      planDescriptions: this.purePictures() ? true : this.planDescriptions()
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