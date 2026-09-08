import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../core/settings.service';
import { ProviderConfig, ModelEntry, ModelArchitecture } from '../../models/chat-config';
import { Router } from '@angular/router';
import { ThemeService } from '../../core/theme.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { ChatParametersService } from '../../core/chat-parameters.service';
import { ChatParametersEditorComponent } from '../../components/chat-parameters-editor/chat-parameters-editor.component';
import { ChatParametersDraft, ResolvedChatParameters, draftFromParameters, emptyParametersDraft } from '../../models/chat-parameters';

@Component({
  selector: 'app-config',
  standalone: true,
  imports: [CommonModule, FormsModule, ChatParametersEditorComponent],
  templateUrl: './config.component.html',
  styleUrl: './config.component.css'
})
export class ConfigComponent {
  private readonly settings = inject(SettingsService);
  private readonly parameters = inject(ChatParametersService);
  private readonly router = inject(Router);
  readonly theme = inject(ThemeService);
  readonly i18n = inject(I18nService);

  // Signals from service
  readonly providers = this.settings.providers;
  readonly models = this.settings.models;

  // UI state
  readonly showAddProvider = signal(false);
  readonly showAddPreset = signal(false);
  readonly editingPresetId = signal<string | null>(null);
  readonly showFetchedParams = signal(false);
  readonly fetchedModel = signal<ModelEntry | null>(null);
  readonly searchTerm = signal('');
  readonly showEnabledOnly = signal(false);
  readonly showDisabledOnly = signal(false);
  readonly testingId = signal<string | null>(null);
  readonly testResult = signal<{ id: string; ok: boolean; message: string } | null>(null);
  readonly fetchingId = signal<string | null>(null);

  // Form models
  newProvider = {
    name: 'OpenRouter',
    type: 'openrouter' as const,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    enabled: true
  };

  newPreset = {
    displayName: '',
    modelId: '',
    providerId: '',
    chatParametersId: null as string | null
  };

  readonly presetParamsOverride = signal(false);
  readonly presetParamsDraft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly presetParamsInherited = signal<ResolvedChatParameters | null>(null);
  readonly fetchedParamsOverride = signal(false);
  readonly fetchedParamsDraft = signal<ChatParametersDraft>(emptyParametersDraft());
  readonly fetchedParamsInherited = signal<ResolvedChatParameters | null>(null);

  // Architecture form fields for new presets
  presetArchitecture = {
    input_modalities: [] as string[],
    output_modalities: [] as string[]
  };

  // Available modality options
  readonly modalityOptions = [
    { value: 'text', labelKey: 'config.modality.text' },
    { value: 'image', labelKey: 'config.modality.image' },
    { value: 'audio', labelKey: 'config.modality.audio' },
    { value: 'video', labelKey: 'config.modality.video' },
    { value: 'file', labelKey: 'config.modality.file' }
  ];

  readonly testingPreset = signal(false);
  readonly presetTestResult = signal<{ ok: boolean; message: string } | null>(null);

  readonly filteredModels = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const enabledOnly = this.showEnabledOnly();
    const disabledOnly = this.showDisabledOnly();
    const allModels = this.models();
    const locale = this.i18n.localeId();

    const matchesSearch = (m: ModelEntry) =>
      !term ||
      m.displayName.toLowerCase().includes(term) ||
      m.modelId.toLowerCase().includes(term);

    const sortFn = (a: ModelEntry, b: ModelEntry) =>
      a.displayName.localeCompare(b.displayName, locale, { sensitivity: 'base' });

    // Enabled only → search applies to enabled models
    if (enabledOnly) {
      return allModels
        .filter(m => m.enabled && matchesSearch(m))
        .sort(sortFn);
    }

    // Not enabled only → search applies to disabled models
    if (disabledOnly) {
      return allModels
        .filter(m => !m.enabled && matchesSearch(m))
        .sort(sortFn);
    }

    // Default: enabled always on top (ignore search), disabled filtered by search
    const enabledModels = allModels
      .filter(m => m.enabled)
      .sort(sortFn);

    const disabledModels = allModels
      .filter(m => !m.enabled && matchesSearch(m))
      .sort(sortFn);

    return [...enabledModels, ...disabledModels];
  });

  setEnabledOnly(value: boolean) {
    this.showEnabledOnly.set(value);
    if (value) this.showDisabledOnly.set(false);
  }

  setDisabledOnly(value: boolean) {
    this.showDisabledOnly.set(value);
    if (value) this.showEnabledOnly.set(false);
  }


  // ---------- Provider actions ----------
  openAddProvider() {
    this.newProvider = {
      name: 'OpenRouter',
      type: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      enabled: true
    };
    this.showAddProvider.set(true);
  }

  saveProvider() {
    if (!this.newProvider.apiKey.trim()) {
      alert(this.i18n.t('config.providers.apiKeyRequired'));
      return;
    }
    this.settings.addProvider({ ...this.newProvider });
    this.showAddProvider.set(false);
  }

  async testProvider(provider: ProviderConfig) {
    this.testingId.set(provider.id);
    this.testResult.set(null);

    const result = await this.settings.testProvider(provider);
    this.testResult.set({
      id: provider.id,
      ok: result.ok,
      message: result.ok ? this.i18n.t('config.providers.testOk') : (result.message || this.i18n.t('config.providers.testFail'))
    });
    this.testingId.set(null);
  }

  async fetchModels(provider: ProviderConfig) {
    this.fetchingId.set(provider.id);
    try {
      await this.settings.fetchModels(provider);
    } catch (err: any) {
      alert(this.i18n.t('config.providers.fetchFailed', { error: err.message || err }));
    } finally {
      this.fetchingId.set(null);
    }
  }

  deleteProvider(id: string) {
    if (confirm(this.i18n.t('config.providers.deleteConfirm'))) {
      this.settings.deleteProvider(id);
    }
  }

  // ---------- Preset actions ----------
  openAddPreset() {
    const firstProvider = this.providers()[0];
    this.editingPresetId.set(null);
    this.newPreset = {
      displayName: '',
      modelId: '',
      providerId: firstProvider?.id || '',
      chatParametersId: null
    };
    this.presetParamsOverride.set(false);
    this.presetParamsDraft.set(emptyParametersDraft());
    this.presetParamsInherited.set(this.parameters.resolveForChat({}));
    // Reset architecture form
    this.presetArchitecture = {
      input_modalities: [],
      output_modalities: []
    };
    this.showAddPreset.set(true);
  }

  async testPreset() {
    if (!this.newPreset.modelId.trim() || !this.newPreset.providerId) {
      this.presetTestResult.set({
        ok: false,
        message: this.i18n.t('config.models.needModelAndProvider')
      });
      return;
    }

    const provider = this.providers().find(p => p.id === this.newPreset.providerId);
    if (!provider) {
      this.presetTestResult.set({ ok: false, message: this.i18n.t('config.models.providerMissing') });
      return;
    }

    this.testingPreset.set(true);
    this.presetTestResult.set(null);

    const result = await this.settings.testModel(provider, this.newPreset.modelId.trim());
    this.presetTestResult.set({
      ok: result.ok,
      message: result.ok
        ? this.i18n.t('config.models.modelWorks', { modelId: this.newPreset.modelId.trim() })
        : (result.message || this.i18n.t('config.models.testFailed'))
    });
    this.testingPreset.set(false);
  }

  async savePreset() {
    if (!this.newPreset.displayName.trim() || !this.newPreset.modelId.trim()) {
      alert(this.i18n.t('config.models.needNameAndId'));
      return;
    }
    if (!this.newPreset.providerId) {
      alert(this.i18n.t('config.models.needProvider'));
      return;
    }

    const architecture: ModelArchitecture = {
      modality: this.createModalityString(
        this.presetArchitecture.input_modalities,
        this.presetArchitecture.output_modalities
      ),
      input_modalities: [...this.presetArchitecture.input_modalities],
      output_modalities: [...this.presetArchitecture.output_modalities]
    };

    const chatParametersId = await this.parameters.persistDraft(
      this.newPreset.chatParametersId,
      this.presetParamsOverride(),
      this.presetParamsDraft()
    );

    const editingId = this.editingPresetId();
    if (editingId) {
      await this.settings.updateModel(editingId, {
        displayName: this.newPreset.displayName.trim(),
        modelId: this.newPreset.modelId.trim(),
        providerId: this.newPreset.providerId,
        architecture,
        chatParametersId
      });
    } else {
      await this.settings.addPreset(
        this.newPreset.displayName.trim(),
        this.newPreset.modelId.trim(),
        this.newPreset.providerId,
        architecture,
        chatParametersId
      );
    }
    this.showAddPreset.set(false);
    this.editingPresetId.set(null);
  }

  async openEditPreset(model: ModelEntry) {
    this.editingPresetId.set(model.id);
    this.newPreset = {
      displayName: model.displayName,
      modelId: model.modelId,
      providerId: model.providerId,
      chatParametersId: model.chatParametersId || null
    };
    this.presetArchitecture = {
      input_modalities: [...(model.architecture?.input_modalities ?? [])],
      output_modalities: [...(model.architecture?.output_modalities ?? [])]
    };
    const row = model.chatParametersId ? await this.parameters.get(model.chatParametersId) : null;
    this.presetParamsOverride.set(!!row);
    this.presetParamsDraft.set(draftFromParameters(row));
    this.presetParamsInherited.set(this.parameters.resolveForChat({}));
    this.showAddPreset.set(true);
  }

  async openFetchedParams(model: ModelEntry) {
    this.fetchedModel.set(model);
    const row = model.chatParametersId ? await this.parameters.get(model.chatParametersId) : null;
    this.fetchedParamsOverride.set(!!row);
    this.fetchedParamsDraft.set(draftFromParameters(row));
    this.fetchedParamsInherited.set(this.parameters.resolveForChat({}));
    this.showFetchedParams.set(true);
  }

  async saveFetchedParams() {
    const model = this.fetchedModel();
    if (!model) return;
    const chatParametersId = await this.parameters.persistDraft(
      model.chatParametersId,
      this.fetchedParamsOverride(),
      this.fetchedParamsDraft()
    );
    await this.settings.updateModel(model.id, { chatParametersId });
    this.showFetchedParams.set(false);
    this.fetchedModel.set(null);
  }

  onPresetParamsChanged(event: { override: boolean; draft: ChatParametersDraft }) {
    this.presetParamsOverride.set(event.override);
    this.presetParamsDraft.set(event.draft);
  }

  onFetchedParamsChanged(event: { override: boolean; draft: ChatParametersDraft }) {
    this.fetchedParamsOverride.set(event.override);
    this.fetchedParamsDraft.set(event.draft);
  }

  deleteModel(id: string) {
    this.settings.deleteModel(id);
  }

  async toggleEnabled(id: string) {
    await this.settings.toggleModelEnabled(id);
  }

  getProviderName(providerId: string): string {
    return this.providers().find(p => p.id === providerId)?.name ?? this.i18n.t('config.models.unknownProvider');
  }

  async goToChat() {
    await this.router.navigate(['/chat']);
  }

  // ---------- Architecture helper methods ----------

  // Check if a modality is selected for input
  isInputModalitySelected(modality: string): boolean {
    return this.presetArchitecture.input_modalities.includes(modality);
  }

  // Check if a modality is selected for output
  isOutputModalitySelected(modality: string): boolean {
    return this.presetArchitecture.output_modalities.includes(modality);
  }

  // Toggle input modality selection
  toggleInputModality(modality: string): void {
    const current = this.presetArchitecture.input_modalities;
    if (current.includes(modality)) {
      this.presetArchitecture.input_modalities = current.filter(m => m !== modality);
    } else {
      this.presetArchitecture.input_modalities = [...current, modality];
    }
  }

  // Toggle output modality selection
  toggleOutputModality(modality: string): void {
    const current = this.presetArchitecture.output_modalities;
    if (current.includes(modality)) {
      this.presetArchitecture.output_modalities = current.filter(m => m !== modality);
    } else {
      this.presetArchitecture.output_modalities = [...current, modality];
    }
  }

  // Create modality string like "text+image->text"
  createModalityString(inputs: string[], outputs: string[]): string {
    const inputStr = inputs.length > 0 ? inputs.join('+') : 'none';
    const outputStr = outputs.length > 0 ? outputs.join('+') : 'none';
    return `${inputStr}->${outputStr}`;
  }

  // Format architecture for display
  formatArchitecture(architecture?: ModelArchitecture): string {
    if (!architecture) return this.i18n.t('config.models.architectureUnset');
    return architecture.modality ||
      `${architecture.input_modalities.join('+')}->${architecture.output_modalities.join('+')}`;
  }

  formatCount(value: number): string {
    return this.i18n.formatNumber(value, { maximumFractionDigits: 0 });
  }

  formatPerMillion(raw?: string | null): string {
    if (raw == null || raw === '') return '—';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '—';
    return this.i18n.formatNumber(n * 1_000_000, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
}
