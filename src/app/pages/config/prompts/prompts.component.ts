import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PromptDefaultsService } from '../../../core/prompt-defaults.service';
import { PROMPT_DEFAULT_CATEGORIES } from '../../../models/prompt-default';
import type { PromptDefaultCategory, PromptDefaultDef } from '../../../models/prompt-default';

/** English-only heading (per project decision — prompts stay in English). */
const CATEGORY_TITLES: Record<PromptDefaultCategory, { title: string; hint: string }> = {
  structure: {
    title: 'Structure & writing',
    hint: 'Prompts for titles, introductions, headings and chapter elaboration.'
  },
  image: {
    title: 'Image generation',
    hint: 'Prompts for the picture-description planning pass and every image-generation mode.'
  },
  language: {
    title: 'Language',
    hint: 'Prompts for the grammar / language check of writing directions.'
  }
};

@Component({
  selector: 'app-config-prompts',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './prompts.component.html',
  styleUrls: ['../config-shared.css', './prompts.component.css']
})
export class PromptsComponent {
  private readonly defaults = inject(PromptDefaultsService);

  readonly categories = PROMPT_DEFAULT_CATEGORIES;

  categoryMeta(category: PromptDefaultCategory): { title: string; hint: string } {
    return CATEGORY_TITLES[category];
  }

  defsOf(category: PromptDefaultCategory): PromptDefaultDef[] {
    return this.defaults.byCategory(category);
  }

  isCustom(id: string): boolean {
    return this.defaults.isCustom(id);
  }

  effective(id: string): string {
    return this.defaults.effective(id);
  }

  customizedCount(): number {
    return this.defaults.customized().length;
  }

  onInput(id: string, value: string): void {
    this.defaults.update(id, value);
  }

  reset(id: string): void {
    this.defaults.reset(id);
  }

  resetAll(): void {
    this.defaults.resetAll();
  }
}