import { Routes } from '@angular/router';
import { ConfigComponent } from './pages/config/config.component';
import { ChatComponent } from './pages/chat/chat.component';
import { ImportComponent } from './pages/import/import.component';
import {PersonasComponent} from './pages/persona/personas.component';

export const routes: Routes = [
  { path: 'config', component: ConfigComponent },
  { path: 'chat', component: ChatComponent },
  { path: 'persona', component: PersonasComponent },
  { path: 'import', component: ImportComponent },
  { path: '', redirectTo: 'chat', pathMatch: 'full' }
];
