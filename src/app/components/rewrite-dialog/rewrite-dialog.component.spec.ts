import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { CHAT_API } from '../../api/chat-api.token';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { seedApi, makeNode } from '../../../../test-helpers/factories';
import { I18nService } from '../../core/i18n/i18n.service';
import { SettingsService } from '../../core/settings.service';
import { LlmUseCaseRunner } from '../../core/llm/orchestration';
import { RewriteDialogService } from '../../core/rewrite-dialog.service';
import { RewriteDialogComponent } from './rewrite-dialog.component';

describe('RewriteDialogComponent', () => {
  let fixture: ComponentFixture<RewriteDialogComponent>;
  let component: RewriteDialogComponent;
  let dialog: RewriteDialogService;
  let runner: { run: ReturnType<typeof vi.fn> };

  function openState(overrides: Partial<Parameters<RewriteDialogService['open']>[0]> = {}) {
    return dialog.open({
      fragment: 'the old tower',
      directions: '',
      contextMode: 'node',
      selectionEnd: 28,
      node: makeNode({ id: 'a1', role: 'assistant', content: 'The hero enters the old tower.', modelId: 'alpha/model', providerId: 'prov-1' }),
      chat: { id: 'chat-1', title: 'Story', projectId: null, node_number: 1, created_at: '', updated_at: '' },
      modelId: 'alpha/model',
      providerId: 'prov-1',
      ...overrides
    });
  }

  beforeEach(async () => {
    const api = new InMemoryChatApi();
    seedApi(api, {
      providers: [{ id: 'prov-1' }],
      models: [
        { id: 'm-1', displayName: 'Alpha', modelId: 'alpha/model' },
        { id: 'm-2', displayName: 'Beta', modelId: 'beta/model' }
      ]
    });
    await TestBed.configureTestingModule({
      imports: [RewriteDialogComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api },
        {
          provide: LlmUseCaseRunner,
          useValue: {
            run: vi.fn(async () => ({
              text: { status: 'ok', value: '["a shorter tower.","a clearer tower.","a scary keep."]' }
            }))
          }
        }
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');
    const settings = TestBed.inject(SettingsService);
    await settings.loadAll();
    dialog = TestBed.inject(RewriteDialogService);
    runner = TestBed.inject(LlmUseCaseRunner) as unknown as { run: ReturnType<typeof vi.fn> };
    fixture = TestBed.createComponent(RewriteDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('is hidden when the dialog is closed', () => {
    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).toBeNull();
  });

  it('opens prefilled with the marked fragment + default node model/context', async () => {
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).not.toBeNull();
    expect(component.fragment()).toBe('the old tower');
    expect(component.contextMode()).toBe('node');
    expect(component.modelId()).toBe('alpha/model');
    const textareas = fixture.nativeElement.querySelectorAll('textarea') as NodeListOf<HTMLTextAreaElement>;
    expect(textareas[0].value).toBe('the old tower');
    dialog.cancel();
    await p;
  });

  it('seeds directions and context mode from the state', async () => {
    const p = openState({ directions: 'make it scary', contextMode: 'none' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.directions()).toBe('make it scary');
    expect(component.contextMode()).toBe('none');
    dialog.cancel();
    await p;
  });

  it('rewrite() calls the rewrite-selection use case with fragment + directions + context + chosen model', async () => {
    const p = openState({ directions: 'make it scary' });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The user picks another model in the dialog.
    component.onModelChange('beta/model');
    await component.rewrite();
    fixture.detectChanges();

    expect(runner.run).toHaveBeenCalledTimes(1);
    const build = runner.run.mock.calls[0][0] as {
      usecase?: string;
      vars?: {
        content?: string; directions?: string; contextMode?: string; selectionEnd?: number; modelId?: string; providerId?: string;
      };
      node?: { id?: string };
    };
    expect(build.usecase).toBe('rewrite-selection');
    expect(build.vars?.content).toBe('the old tower');
    expect(build.vars?.directions).toBe('make it scary');
    expect(build.vars?.contextMode).toBe('node');
    expect(build.vars?.selectionEnd).toBe(28);
    expect(build.vars?.modelId).toBe('beta/model');
    expect(build.vars?.providerId).toBe('prov-1');
    expect(build.node?.id).toBe('a1');

    // The 3 parsed variants are shown.
    expect(component.suggestions()).toEqual(['a shorter tower.', 'a clearer tower.', 'a scary keep.']);
    expect(component.loading()).toBe(false);
    dialog.cancel();
    await p;
  });

  it('useVariant resolves the dialog with the chosen suggestion', async () => {
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    await component.rewrite();
    fixture.detectChanges();
    component.useVariant('a scary keep.');
    fixture.detectChanges();

    await expect(p).resolves.toBe('a scary keep.');
    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).toBeNull();
  });

  it('clamps long suggestions to a preview with a read-full-text toggle', async () => {
    const long = 'A very long suggested rewrite. '.repeat(30);
    const short = 'short rewrite.';
    runner.run.mockResolvedValueOnce({
      text: { status: 'ok', value: JSON.stringify([long, short, 'another short one.']) }
    });
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    await component.rewrite();
    fixture.detectChanges();

    const texts = [...fixture.nativeElement.querySelectorAll('.rewrite-suggestion-text')] as HTMLElement[];
    // Long suggestion is shown only as a preview (clamped)…
    expect(texts[0].classList.contains('preview')).toBe(true);
    // …short ones are not clamped.
    expect(texts[1].classList.contains('preview')).toBe(false);

    // Only the long suggestion offers a toggle.
    const toggles = [...fixture.nativeElement.querySelectorAll('.rewrite-suggestion-toggle')] as HTMLElement[];
    expect(toggles.length).toBe(1);
    expect(toggles[0].textContent).toContain('Read full text');

    dialog.cancel();
    await p;
  });

  it('expands a long suggestion to read it in full and collapses it again', async () => {
    const long = 'A very long suggested rewrite. '.repeat(30);
    runner.run.mockResolvedValueOnce({ text: { status: 'ok', value: JSON.stringify([long]) } });
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    await component.rewrite();
    fixture.detectChanges();

    const texts = () => [...fixture.nativeElement.querySelectorAll('.rewrite-suggestion-text')] as HTMLElement[];
    expect(texts()[0].classList.contains('preview')).toBe(true);

    const toggle = fixture.nativeElement.querySelector('.rewrite-suggestion-toggle') as HTMLElement;
    toggle.click();
    fixture.detectChanges();

    // Expanded: full text is shown (no clamp) and the label switches.
    expect(texts()[0].classList.contains('preview')).toBe(false);
    expect(toggle.textContent).toContain('Show less');
    expect(fixture.nativeElement.querySelector('.rewrite-suggestion')?.classList.contains('expanded')).toBe(true);

    toggle.click();
    fixture.detectChanges();
    expect(texts()[0].classList.contains('preview')).toBe(true);

    dialog.cancel();
    await p;
  });

  it('applyEdited resolves with the edited fragment as-is (no model call)', async () => {
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.fragment.set('a ruined keep');
    component.applyEdited();
    fixture.detectChanges();

    await expect(p).resolves.toBe('a ruined keep');
    expect(runner.run).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).toBeNull();
  });

  it('cancel resolves null without applying anything', async () => {
    const p = openState();
    fixture.detectChanges();
    dialog.cancel();
    await expect(p).resolves.toBeNull();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).toBeNull();
  });

  it('Escape closes the dialog and resolves null (same as cancel)', async () => {
    const p = openState();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).not.toBeNull();

    component.onDocumentKey({
      key: 'Escape',
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent);
    fixture.detectChanges();

    await expect(p).resolves.toBeNull();
    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).toBeNull();
  });

  it('ignores Escape while the dialog is closed', () => {
    const preventDefault = vi.fn();
    component.onDocumentKey({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).toBeNull();
  });

  it('does not cancel on Escape while a rewrite is loading', async () => {
    runner.run.mockResolvedValueOnce(new Promise(resolve => {
      setTimeout(() => resolve({ text: { status: 'ok', value: '["a tower."]' } }), 50);
    }));
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const pending = component.rewrite(); // keep it in flight
    fixture.detectChanges();
    expect(component.loading()).toBe(true);

    const preventDefault = vi.fn();
    component.onDocumentKey({ key: 'Escape', preventDefault } as unknown as KeyboardEvent);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.rewrite-dialog')).not.toBeNull();

    await pending; // let the in-flight rewrite settle
    dialog.cancel();
    await p;
  });

  it('surfaces an alert when the model returns no suggestions', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    runner.run.mockResolvedValueOnce({ text: { status: 'refused', value: null, reason: 'moderated' } });
    const p = openState();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    await component.rewrite();
    fixture.detectChanges();

    expect(alertSpy).toHaveBeenCalled();
    expect(component.suggestions()).toBeNull();
    dialog.cancel();
    await p;
    alertSpy.mockRestore();
  });
});