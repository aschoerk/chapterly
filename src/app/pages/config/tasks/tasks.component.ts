import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../../core/settings.service';
import { GenerationSettingsService } from '../../../core/generation-settings.service';
import { ModelEntry } from '../../../models/chat-config';
import { GenerationTaskKind, GENERATION_TASK_KINDS } from '../../../models/generation-task';
import { I18nService } from '../../../core/i18n/i18n.service';

@Component({
  selector: 'app-config-tasks',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './tasks.component.html',
  styleUrl: '../config-shared.css'
})
export class TasksComponent {
  private readonly settings = inject(SettingsService);
  private readonly generation = inject(GenerationSettingsService);
  readonly i18n = inject(I18nService);

  readonly providers = this.settings.providers;
  readonly generationTasks = GENERATION_TASK_KINDS;

  generationTaskLabel(kind: GenerationTaskKind): string {
    return this.i18n.t('config.generation.tasks.' + kind);
  }

  generationHint(kind: GenerationTaskKind): string {
    return this.i18n.t('config.generation.hints.' + kind);
  }

  generationConfig(kind: GenerationTaskKind) {
    return this.generation.get(kind);
  }

  modelsForTask(kind: GenerationTaskKind): ModelEntry[] {
    return this.generation.modelsForProvider(this.generation.get(kind).providerId);
  }

  onTaskProviderChange(providerId: string, kind: GenerationTaskKind): void {
    const cfg = this.generation.get(kind);
    const stillMatches =
      !!cfg.modelId &&
      this.generation.modelsForProvider(providerId).some(m => m.modelId === cfg.modelId);
    this.generation.update(kind, { providerId, modelId: stillMatches ? cfg.modelId : '' });
  }

  onTaskModelChange(modelId: string, kind: GenerationTaskKind): void {
    const cfg = this.generation.get(kind);
    let providerId = cfg.providerId;
    const matched = this.settings.enabledModels().find(m => m.modelId === modelId);
    if (matched) providerId = matched.providerId;
    this.generation.update(kind, { providerId, modelId });
  }

  onTaskPromptChange(prompt: string, kind: GenerationTaskKind): void {
    this.generation.update(kind, { prompt });
  }

  resetTask(kind: GenerationTaskKind): void {
    this.generation.reset(kind);
  }
}