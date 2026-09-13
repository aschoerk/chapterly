import { InjectionToken, inject } from '@angular/core';
import { ChatApiPort } from './chat-api.port';
import { CompositeChatApiService } from './composite-chat-api.service';

export const CHAT_API = new InjectionToken<ChatApiPort>('CHAT_API');

export function provideChatApi() {
  return {
    provide: CHAT_API,
    useFactory: () => inject(CompositeChatApiService)
  };
}
