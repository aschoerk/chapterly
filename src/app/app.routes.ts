import { Routes } from '@angular/router';
import { ConfigComponent } from './pages/config/config.component';
import { ChatComponent } from './pages/chat/chat.component';

export const routes: Routes = [
  { path: 'config', component: ConfigComponent },
  { path: 'chat', component: ChatComponent },
  { path: '', redirectTo: 'chat', pathMatch: 'full' }
];
