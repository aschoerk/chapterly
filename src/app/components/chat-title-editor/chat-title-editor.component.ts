import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { I18nService } from '../../core/i18n/i18n.service';

@Component({
  selector: 'chat-title-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-title-editor.component.html',
  styleUrls: ['./chat-title-editor.component.css']
})
export class ChatTitleEditorComponent {
  private readonly chatService = inject(ChatService);
  readonly i18n = inject(I18nService);

  readonly chats = this.chatService.chats;
  readonly currentChatId = this.chatService.currentChatId;

  readonly editingTitle = signal(false);
  readonly titleDraft = signal('');

  currentChatTitle = computed(() => {
    const id = this.currentChatId();
    const chat = this.chats().find(c => c.id === id);
    this.i18n.locale();
    return chat?.title || this.i18n.t('common.untitled');
  });

  startEditTitle() {
    this.titleDraft.set(this.currentChatTitle());
    this.editingTitle.set(true);
  }

  cancelEditTitle() {
    this.editingTitle.set(false);
  }

  async saveTitle() {
    const id = this.currentChatId();
    const title = this.titleDraft().trim();
    if (!id || !title) return;

    await this.chatService.updateChatTitle(id, title);
    this.editingTitle.set(false);
  }
}
