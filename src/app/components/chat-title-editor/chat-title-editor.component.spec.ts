import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { ChatTitleEditorComponent } from './chat-title-editor.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatService } from '../../core/chat.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api';
import { makeChat } from '../../../../test-helpers/factories';

/**
 * ChatTitleEditorComponent has no buttons — all interaction happens through
 * the clickable `.chat-title` heading and the inline `<input class="title-input">`
 * (Enter / Escape / blur). These tests cover every interaction point and signal.
 */
describe('ChatTitleEditorComponent', () => {
  let fixture: ComponentFixture<ChatTitleEditorComponent>;
  let component: ChatTitleEditorComponent;
  let api: InMemoryChatApi;
  let chatService: ChatService;
  let i18n: I18nService;

  const seedChat = makeChat;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    api = new InMemoryChatApi();
    localStorage.clear();

    await TestBed.configureTestingModule({
      imports: [ChatTitleEditorComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    chatService = TestBed.inject(ChatService);
    i18n = TestBed.inject(I18nService);
    i18n.setLocale('en');

    fixture = TestBed.createComponent(ChatTitleEditorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  /** Seed a chat, load it and make it the active chat (mirrors real navigation). */
  async function openChat(title = 'My Story'): Promise<void> {
    api.chats.push(seedChat({ title }));
    await chatService.loadChats();
    await chatService.selectChat('chat-1');
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function titleEl(): HTMLElement | null {
    return fixture.nativeElement.querySelector('.chat-title');
  }

  function inputEl(): HTMLInputElement | null {
    return fixture.nativeElement.querySelector('.title-input');
  }

  /** Click the displayed heading to enter edit mode. */
  function clickTitle(): void {
    titleEl()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
  }

  /** Type into the inline input, simulating a real keystroke through ngModel. */
  function typeDraft(text: string): void {
    const input = inputEl()!;
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  }

  /** Send a keyup (Enter / Escape) to the inline input. */
  function keyUp(key: string): void {
    inputEl()!.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }

  /** Blur the inline input. */
  function blurInput(): void {
    inputEl()!.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  // ------------------------------------------------------------------
  // Display
  // ------------------------------------------------------------------

  describe('display', () => {
    it('shows the title of the currently selected chat', async () => {
      await openChat('My Story');
      expect(component.currentChatTitle()).toBe('My Story');
      expect(titleEl()?.textContent?.trim()).toBe('My Story');
    });

    it('does not show the input while not editing', async () => {
      await openChat('My Story');
      expect(inputEl()).toBeNull();
    });

    it('falls back to the untitled label when no chat is selected', () => {
      expect(component.currentChatId()).toBeNull();
      expect(component.currentChatTitle()).toBe('Untitled');
      expect(titleEl()?.textContent?.trim()).toBe('Untitled');
    });

    it('falls back to the untitled label when the chat has an empty title', async () => {
      await openChat('');
      expect(component.currentChatTitle()).toBe('Untitled');
      expect(titleEl()?.textContent?.trim()).toBe('Untitled');
    });

    it('uses the translated untitled label', async () => {
      await openChat('');
      i18n.setLocale('de');
      fixture.detectChanges();
      expect(component.currentChatTitle()).toBe('Ohne Titel');
      expect(titleEl()?.textContent?.trim()).toBe('Ohne Titel');
    });

    it('reflects title changes made through the chat service', async () => {
      await openChat('Before');
      await chatService.updateChatTitle('chat-1', 'After');
      fixture.detectChanges();
      expect(component.currentChatTitle()).toBe('After');
      expect(titleEl()?.textContent?.trim()).toBe('After');
    });

    it('picks the title of the currently selected chat out of several', async () => {
      api.chats.push(seedChat({ id: 'chat-a', title: 'First' }));
      api.chats.push(seedChat({ id: 'chat-b', title: 'Second' }));
      await chatService.loadChats();
      await chatService.selectChat('chat-b');
      await settle();
      expect(component.currentChatTitle()).toBe('Second');
      await chatService.selectChat('chat-a');
      await settle();
      expect(component.currentChatTitle()).toBe('First');
    });
  });

  // ------------------------------------------------------------------
  // Start editing
  // ------------------------------------------------------------------

  describe('start editing', () => {
    it('enters edit mode when the title is clicked', async () => {
      await openChat('My Story');
      expect(component.editingTitle()).toBe(false);

      clickTitle();

      expect(component.editingTitle()).toBe(true);
      expect(inputEl()).not.toBeNull();
      expect(titleEl()).toBeNull();
    });

    it('prefills the draft with the current title', async () => {
      await openChat('My Story');
      clickTitle();
      expect(component.titleDraft()).toBe('My Story');

      // ngModel writes the model back to the DOM input during change detection.
      await settle();
      expect(inputEl()?.value).toBe('My Story');
    });

    it('prefills the draft with the untitled fallback for a titled chat in German', async () => {
      await openChat('');
      i18n.setLocale('de');
      fixture.detectChanges();
      clickTitle();
      expect(component.titleDraft()).toBe('Ohne Titel');
    });

    it('keeps a separate draft untouched by external title changes', async () => {
      await openChat('A');
      clickTitle();
      await chatService.updateChatTitle('chat-1', 'B');
      expect(component.titleDraft()).toBe('A');
      expect(component.editingTitle()).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Typing (inserting) into the input
  // ------------------------------------------------------------------

  describe('typing (ngModel binding)', () => {
    it('updates the draft when the user types into the input', async () => {
      await openChat('My Story');
      clickTitle();
      typeDraft('Typed title');
      expect(component.titleDraft()).toBe('Typed title');
    });

    it('allows replacing the whole title text', async () => {
      await openChat('My Story');
      clickTitle();
      typeDraft('A completely new title');
      expect(component.titleDraft()).toBe('A completely new title');
    });
  });

  // ------------------------------------------------------------------
  // Saving
  // ------------------------------------------------------------------

  describe('save title', () => {
    it('saves with Enter and exits edit mode', async () => {
      await openChat('My Story');
      clickTitle();
      typeDraft('Renamed');

      keyUp('Enter');
      await settle();

      expect(chatService.chats().find(c => c.id === 'chat-1')?.title).toBe('Renamed');
      expect(component.editingTitle()).toBe(false);
      expect(inputEl()).toBeNull();
      expect(titleEl()?.textContent?.trim()).toBe('Renamed');
    });

    it('saves with blur and exits edit mode', async () => {
      await openChat('My Story');
      clickTitle();
      typeDraft('Via blur');

      blurInput();
      await settle();

      expect(chatService.chats().find(c => c.id === 'chat-1')?.title).toBe('Via blur');
      expect(component.editingTitle()).toBe(false);
      expect(titleEl()?.textContent?.trim()).toBe('Via blur');
    });

    it('trims surrounding whitespace before saving', async () => {
      await openChat('My Story');
      clickTitle();
      typeDraft('   Padded title   ');

      keyUp('Enter');
      await settle();

      expect(chatService.chats().find(c => c.id === 'chat-1')?.title).toBe('Padded title');
      expect(component.editingTitle()).toBe(false);
    });

    it('keeps editing open and does not save when the draft is blank', async () => {
      await openChat('My Story');
      const spy = vi.spyOn(chatService, 'updateChatTitle');
      clickTitle();
      typeDraft('   ');

      keyUp('Enter');
      await settle();

      expect(spy).not.toHaveBeenCalled();
      expect(component.editingTitle()).toBe(true);
      expect(inputEl()).not.toBeNull();
      expect(chatService.chats().find(c => c.id === 'chat-1')?.title).toBe('My Story');
    });

    it('does nothing when saving without a selected chat', async () => {
      const spy = vi.spyOn(chatService, 'updateChatTitle');
      clickTitle();
      expect(component.titleDraft()).toBe('Untitled');

      typeDraft('Lonely');
      keyUp('Enter');
      await settle();

      expect(spy).not.toHaveBeenCalled();
      expect(component.editingTitle()).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Cancel
  // ------------------------------------------------------------------

  describe('cancel title editing', () => {
    it('cancels with Escape without saving', async () => {
      const spy = vi.spyOn(chatService, 'updateChatTitle');
      await openChat('My Story');
      clickTitle();
      typeDraft('This should be discarded');

      keyUp('Escape');
      await settle();

      expect(component.editingTitle()).toBe(false);
      expect(inputEl()).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      expect(chatService.chats().find(c => c.id === 'chat-1')?.title).toBe('My Story');
      expect(titleEl()?.textContent?.trim()).toBe('My Story');
    });

    it('cancelEdit keeps the original draft value intact for the next edit', async () => {
      await openChat('My Story');
      clickTitle();
      typeDraft('Temp');
      keyUp('Escape');
      await settle();

      clickTitle();
      expect(component.titleDraft()).toBe('My Story');
    });
  });
});