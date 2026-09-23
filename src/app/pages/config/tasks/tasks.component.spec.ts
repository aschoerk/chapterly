import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { TasksComponent } from './tasks.component';
import { CHAT_API } from '../../../api/chat-api.token';
import { SettingsService } from '../../../core/settings.service';
import { GenerationSettingsService } from '../../../core/generation-settings.service';
import { I18nService } from '../../../core/i18n/i18n.service';
import { InMemoryChatApi } from '../../../../../test-helpers/in-memory-chat-api';
import { makeProvider, makeModel } from '../../../../../test-helpers/factories';

describe('TasksComponent', () => {
  let fixture: ComponentFixture<TasksComponent>;
  let component: TasksComponent;
  let api: InMemoryChatApi;
  let settings: SettingsService;
  let generation: GenerationSettingsService;

  beforeEach(async () => {
    localStorage.removeItem('chat.generationTasks');
    api = new InMemoryChatApi();
    api.providers.push(makeProvider());
    api.models.push(
      makeModel({ id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model', providerId: 'prov-1', enabled: true })
    );

    await TestBed.configureTestingModule({
      imports: [TasksComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    settings = TestBed.inject(SettingsService);
    generation = TestBed.inject(GenerationSettingsService);
    TestBed.inject(I18nService).setLocale('en');
    await settings.loadAll();

    fixture = TestBed.createComponent(TasksComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    localStorage.removeItem('chat.generationTasks');
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the five generation task cards', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Titles');
    expect(text).toContain('Headings');
    expect(text).toContain('Overviews');
    expect(text).toContain('Image creation');
    expect(text).toContain('Image interpretation');
  });

  it('persists a prompt and enables the reset button', () => {
    component.onTaskPromptChange('Make a title', 'title');
    fixture.detectChanges();
    expect(generation.get('title').prompt).toBe('Make a title');

    const stored = JSON.parse(localStorage.getItem('chat.generationTasks') ?? '{}');
    expect(stored.title.prompt).toBe('Make a title');

    // reset clears only this task
    component.resetTask('title');
    expect(generation.get('title').prompt).toBe('');
    expect(generation.get('overview').prompt).toBe('');
  });

  it('picks a provider and resolves its enabled models for the datalist', () => {
    component.onTaskProviderChange('prov-1', 'overview');
    expect(generation.get('overview').providerId).toBe('prov-1');
    expect(component.modelsForTask('overview').map(m => m.modelId)).toEqual(['alpha/model']);
  });

  it('switches tasks chrome to German', () => {
    component.i18n.setLocale('de');
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Generierungsaufgaben');
    expect(text).toContain('Titel');
  });
});