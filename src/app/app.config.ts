import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import {provideRouter, withHashLocation} from '@angular/router';
import { provideHttpClient } from '@angular/common/http';

import { routes } from './app.routes';
import {provideChatApi} from './api/chat-api.token';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withHashLocation()),
    provideHttpClient(),
    provideChatApi()
  ]
};
