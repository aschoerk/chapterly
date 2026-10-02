import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { IllustrateDialogService } from '../../core/illustrate-dialog.service';
import { SettingsService } from '../../core/settings.service';
import { GenerationSettingsService } from '../../core/generation-settings.service';
import { canGenerateImages, ModelEntry } from '../../models/chat-config';
import { ILLUSTRATE_COUNT_MIN } from '../../models/illustrate-options';

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
  readonly showStoryboard = computed(() => this.count() > 1);

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

  submit(): void {
    this.dialog.submit({
      count: this.count(),
      style: this.style(),
      storyboardPrompt: this.storyboardPrompt(),
      purePictures: this.purePictures(),
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
}