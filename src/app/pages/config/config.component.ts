import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../core/settings.service';
import { ProviderConfig, ModelEntry } from '../../models/chat-config';
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

  readonly testingPreset = signal(false);
  readonly presetTestResult = signal<{ ok: boolean; message: string } | null>(null);
  readonly filteredModels = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();

    const allModels = this.models();

    // 1. Enabled models – always visible, ignore search
    const enabledModels = allModels
      .filter(m => m.enabled)
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
      );

    // 2. Disabled models – apply search filter
    let disabledModels = allModels.filter(m => !m.enabled);

    if (term) {
      disabledModels = disabledModels.filter(m =>
        m.displayName.toLowerCase().includes(term) ||
        m.modelId.toLowerCase().includes(term)
      );
    }

    disabledModels = disabledModels.sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    );

    // 3. Enabled first, then disabled
    return [...enabledModels, ...disabledModels];
  });

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

    this.settings.addPreset(
      this.newPreset.displayName.trim(),
      this.newPreset.modelId.trim(),
      this.newPreset.providerId
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
}
