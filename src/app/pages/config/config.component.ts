import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../core/settings.service';
import { ProviderConfig, ModelEntry, ModelArchitecture } from '../../models/chat-config';
import { Router } from '@angular/router';

@Component({
  selector: 'app-config',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './config.component.html',
  styleUrl: './config.component.css'
})
export class ConfigComponent {
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);

  // Signals from service
  readonly providers = this.settings.providers;
  readonly models = this.settings.models;

  // UI state
  readonly showAddProvider = signal(false);
  readonly showAddPreset = signal(false);
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
    providerId: ''
  };

  // Architecture form fields for new presets
  presetArchitecture = {
    input_modalities: [] as string[],
    output_modalities: [] as string[]
  };

  // Available modality options
  readonly modalityOptions = [
    { value: 'text', label: 'Text' },
    { value: 'image', label: 'Image' },
    { value: 'audio', label: 'Audio' },
    { value: 'video', label: 'Video' },
    { value: 'file', label: 'File' }
  ];

  readonly testingPreset = signal(false);
  readonly presetTestResult = signal<{ ok: boolean; message: string } | null>(null);

  readonly filteredModels = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const enabledOnly = this.showEnabledOnly();
    const disabledOnly = this.showDisabledOnly();
    const allModels = this.models();

    const matchesSearch = (m: ModelEntry) =>
      !term ||
      m.displayName.toLowerCase().includes(term) ||
      m.modelId.toLowerCase().includes(term);

    const sortFn = (a: ModelEntry, b: ModelEntry) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });

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
      alert('API Key is required');
      return;
    }
    this.settings.addProvider({ ...this.newProvider });
    this.showAddProvider.set(false);
  }

  async testProvider(provider: ProviderConfig) {
    this.testingId.set(provider.id);
    this.testResult.set(null);

    const result = await this.settings.testProvider(provider);
    this.testResult.set({ id: provider.id, ...result });
    this.testingId.set(null);
  }

  async fetchModels(provider: ProviderConfig) {
    this.fetchingId.set(provider.id);
    try {
      await this.settings.fetchModels(provider);
    } catch (err: any) {
      alert('Failed to fetch models: ' + (err.message || err));
    } finally {
      this.fetchingId.set(null);
    }
  }

  deleteProvider(id: string) {
    if (confirm('Delete this provider and all its models/presets?')) {
      this.settings.deleteProvider(id);
    }
  }

  // ---------- Preset actions ----------
  openAddPreset() {
    const firstProvider = this.providers()[0];
    this.newPreset = {
      displayName: '',
      modelId: '',
      providerId: firstProvider?.id || ''
    };
    // Reset architecture form
    this.presetArchitecture = {
      input_modalities: [],
      output_modalities: []
    };
    this.showAddPreset.set(true);
  }

  async testPreset() {
    console.log('Test button clicked');
    console.log('Model ID:', this.newPreset.modelId);
    console.log('Provider ID:', this.newPreset.providerId);
    if (!this.newPreset.modelId.trim() || !this.newPreset.providerId) {
      this.presetTestResult.set({
        ok: false,
        message: 'Please enter a Model ID and select a provider first'
      });
      return;
    }

    const provider = this.providers().find(p => p.id === this.newPreset.providerId);
    if (!provider) {
      this.presetTestResult.set({ ok: false, message: 'Provider not found' });
      return;
    }

    this.testingPreset.set(true);
    this.presetTestResult.set(null);

    const result = await this.settings.testModel(provider, this.newPreset.modelId.trim());
    this.presetTestResult.set(result);
    this.testingPreset.set(false);
  }

  savePreset() {
    if (!this.newPreset.displayName.trim() || !this.newPreset.modelId.trim()) {
      alert('Display Name and Model ID are required');
      return;
    }
    if (!this.newPreset.providerId) {
      alert('Please select a provider');
      return;
    }

    // Create architecture object
    const architecture: ModelArchitecture = {
      modality: this.createModalityString(
        this.presetArchitecture.input_modalities,
        this.presetArchitecture.output_modalities
      ),
      input_modalities: [...this.presetArchitecture.input_modalities],
      output_modalities: [...this.presetArchitecture.output_modalities]
    };

    // Pass architecture to addPreset
    this.settings.addPreset(
      this.newPreset.displayName.trim(),
      this.newPreset.modelId.trim(),
      this.newPreset.providerId,
      architecture
    );
    this.showAddPreset.set(false);
  }

  deleteModel(id: string) {
    this.settings.deleteModel(id);
  }

  async toggleEnabled(id: string) {
    await this.settings.toggleModelEnabled(id);
  }

  getProviderName(providerId: string): string {
    return this.providers().find(p => p.id === providerId)?.name ?? 'Unknown';
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
    if (!architecture) return 'Not specified';
    return architecture.modality ||
      `${architecture.input_modalities.join('+')}->${architecture.output_modalities.join('+')}`;
  }

  // Get readable labels for modalities
  getModalityLabel(modality: string): string {
    const labels: Record<string, string> = {
      'text': 'Text',
      'image': 'Image',
      'audio': 'Audio',
      'video': 'Video',
      'file': 'File'
    };
    return labels[modality] || modality;
  }

  formatPerMillion(raw?: string | null): string {
    if (raw == null || raw === '') return '—';
    const n = Number(raw);
    if (!Number.isFinite(n)) return '—';
    return `$${(n * 1_000_000).toFixed(2)}`;
  }
}
