import { Injectable, signal, computed, inject } from '@angular/core';
import { SettingsService } from './settings.service';
import {ChatService} from './chat.service';

@Injectable({
  providedIn: 'root'
})
export class LastModelService {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly LAST_MODEL_KEY = 'chat.lastUsedModelId';
  readonly lastUsedModelId = signal<string>('');
  readonly nodes = this.chatService.currentNodes;
  readonly enabledModels = this.settings.enabledModels;
  readonly selectedModelId = signal<string>('');

  async ngOnInit() {
    this.loadLastUsedModel();
    await this.chatService.loadChats();
    await this.settings.loadAll();
  }


  // ------------------------------------------------------------------
  // Last-used model persistence
  // ------------------------------------------------------------------

  setLastUsedModel() {
    const nodes = this.nodes();
    const lastQuestion = [...nodes]
      .filter(n => n.type === 'question' && n.modelId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (!lastQuestion?.modelId) return;

    const model = this.enabledModels().find(
      m => m.modelId === lastQuestion.modelId || m.id === lastQuestion.modelId
    );

    const id = model ? model.id : lastQuestion.modelId;
    this.selectedModelId.set(id);
    this.saveLastUsedModel(id);
  }

  private loadLastUsedModel() {
    const saved = localStorage.getItem(this.LAST_MODEL_KEY);
    if (saved) {
      this.lastUsedModelId.set(saved);
    }
  }

  public saveLastUsedModel(modelId: string) {
    this.lastUsedModelId.set(modelId);
    localStorage.setItem(this.LAST_MODEL_KEY, modelId);
  }

  setLastModel(lastUsedModelId: any) {
    this.lastUsedModelId.set(lastUsedModelId);
  }
  setSelectedModel(selectedModelId: any) {
    this.selectedModelId.set(selectedModelId);
  }
}
