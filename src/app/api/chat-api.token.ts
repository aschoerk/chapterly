import { InjectionToken, inject } from '@angular/core';
import { ChatApiPort } from './chat-api.port';
import { ChatApiService } from './chat-api.service';
import { IdbChatApiService } from './idb-chat-api.service';
import { getServerConfig } from '../core/server-config';

export const CHAT_API = new InjectionToken<ChatApiPort>('CHAT_API');

export function provideChatApi() {
  return {
    provide: CHAT_API,
    useFactory: () =>
      getServerConfig().mode === 'cloud'
        ? inject(IdbChatApiService)
        : inject(ChatApiService)
  };
}
