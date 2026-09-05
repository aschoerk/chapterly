import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { ChatComponent } from './chat.component';
import { CHAT_API } from '../../api/chat-api.token';
import { ChatApiPort } from '../../api/chat-api.port';
import {
  CreateProjectRequest,
  UpdateProjectRequest,
  CreateTopicRequest,
  UpdateTopicRequest,
  CreateProviderRequest,
  UpdateProviderRequest,
  CreateModelRequest,
  UpdateModelRequest
} from '../../api/chat-api.types';
import {
  Chat, ChatNode, CreateNodeRequest, Project, Persona, Topic, NodeAttachment
} from '../../models/chat';
import { ProviderConfig, ModelEntry } from '../../models/chat-config';
import { ChatParameters, ChatParametersDraft } from '../../models/chat-parameters';

import { InMemoryChatApi } from '../../../../test-helpers/in-memory-chat-api'


describe('Chat', () => {
  let component: ChatComponent;
  let fixture: ComponentFixture<ChatComponent>;
  let api: InMemoryChatApi;

  beforeEach(async () => {
    api = new InMemoryChatApi();
    localStorage.removeItem('chat.currentChatId');
    localStorage.removeItem('chat.scrollByChatId');

    await TestBed.configureTestingModule({
      imports: [ChatComponent],
      providers: [
        provideHttpClient(),
        { provide: CHAT_API, useValue: api }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(ChatComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
