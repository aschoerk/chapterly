import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService } from '../../core/chat.service';
import { Router } from '@angular/router';
import {LastModelService} from '../../core/last-model.service';
import {SettingsService} from '../../core/settings.service';
import {Chat} from '../../models/chat';

@Component({
  selector: 'side-bar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './side-bar.component.html',
  styleUrls: ['./side-bar.component.css']
})
export class SideBarComponent {
  private readonly chatService = inject(ChatService);
  private readonly settings = inject(SettingsService);
  private readonly lastModelService = inject(LastModelService);
  private readonly router = inject(Router);
  readonly chats = this.chatService.chats;
  readonly currentChatId = this.chatService.currentChatId;

  async ngOnInit() {
    await this.chatService.loadChats();
    await this.settings.loadAll();
  }

  async createChat() {
    const chat = await this.chatService.createChat();
    await this.chatService.selectChat(chat.id);

    if (this.lastModelService.lastUsedModelId()) {
      this.lastModelService.setLastModel(this.lastModelService.lastUsedModelId());
    } else {
      this.lastModelService.setSelectedModel('');
    }
  }

  async selectChat(chat: Chat) {
    await this.chatService.selectChat(chat.id);
    this.lastModelService.setLastUsedModel();
  }

  async deleteChat(chat: Chat, event: Event) {
    event.stopPropagation();
    if (confirm(`Delete chat "${chat.title}"?`)) {
      await this.chatService.deleteChat(chat.id);
    }
  }

  async goToConfig() {
    await this.router.navigate(['/config']);
  }

}
