import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';

@Component({
  selector: 'chat-title-editor',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat-title-editor.component.html',
  styleUrls: ['./chat-title-editor.component.css']
})
export class ChatTitleEditorComponent {
  private readonly chatService = inject(ChatService);

  readonly chats = this.chatService.chats;
  readonly currentChatId = this.chatService.currentChatId;

  readonly editingTitle = signal(false);
  readonly titleDraft = signal('');

  currentChatTitle = computed(() => {
    const id = this.currentChatId();
    const chat = this.chats().find(c => c.id === id);
    return chat?.title || 'Untitled';
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
