import { Routes } from '@angular/router';
import { ConfigComponent } from './pages/config/config.component';
import { ChatComponent } from './pages/chat/chat.component';
import { ImportComponent } from './pages/import/import.component';

export const routes: Routes = [
  { path: 'config', component: ConfigComponent },
  { path: 'chat', component: ChatComponent },
  { path: 'import', component: ImportComponent },
  { path: '', redirectTo: 'chat', pathMatch: 'full' }
];
