import { Component, computed, effect, inject, signal, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings.service';
import { GenerationSettingsService } from '../../core/generation-settings.service';
import { CreateImageDialogService } from '../../core/create-image-dialog.service';
import { canGenerateImages, ModelEntry } from '../../models/chat-config';
import { NodeAttachment } from '../../models/chat';
import { newId } from '../../core/common/helpers';
import { inferMimeType } from '../../core/llm/llm-message';

@Component({
  selector: 'app-create-image-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './create-image-dialog.component.html',
  styleUrl: './create-image-dialog.component.css'
})
export class CreateImageDialogComponent {
  readonly dialog = inject(CreateImageDialogService);
  readonly i18n = inject(I18nService);
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);

  /** Chat-specific constant — per-chat, always pre-filled (editable). */
  readonly constant = signal('');
  /** The marked text (editable); combined with the constant it creates the image. */
  readonly script = signal('');
  /** Reference images attached in the dialog — sent occasionally, as references. */
  readonly images = signal<NodeAttachment[]>([]);
  readonly modelId = signal('');
  readonly providerId = signal('');

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
      // Seed the editor from the state the dialog was opened with (constant +
      // images come from the per-chat store, script from the marked text).
      this.constant.set(s.constant);
      this.script.set(s.script);
      this.images.set(s.images ?? []);
      this.modelId.set(s.modelId);
      this.providerId.set(s.providerId);
    });
  }

  /** Keep the provider in sync with the model chosen in the dropdown. */
  onModelChange(modelId: string): void {
    this.modelId.set(modelId);
    const match = this.imageModels().find(m => m.modelId === modelId || m.id === modelId);
    this.providerId.set(match?.providerId ?? '');
  }

  /** Add the chosen image files as reference attachments. */
  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input?.files;
    if (!files || files.length === 0) return;
    const additions: NodeAttachment[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : '';
        if (!dataUrl) return;
        this.images.update(list => [
          ...list,
          {
            id: newId(),
            name: file.name,
            mimeType: file.type || inferMimeType(file.name),
            size: file.size,
            dataUrl
          }
        ]);
      };
      reader.readAsDataURL(file);
    }
    input.value = '';
  }

  removeImage(id: string): void {
    this.images.update(list => list.filter(a => a.id !== id));
  }

  /** The combined text (constant + script) that creates the image. */
  combinedPrompt(): string {
    return [this.constant().trim(), this.script().trim()]
      .filter(Boolean)
      .join('\n\n');
  }

  submit(): void {
    // Text is the primary image-creating input; reference images alone also
    // work (e.g. "make a variant of this picture").
    if (!this.combinedPrompt() && this.images().length === 0) {
      alert(this.i18n.t('createImageDialog.empty'));
      return;
    }
    this.dialog.submit({
      constant: this.constant(),
      script: this.script(),
      images: this.images(),
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