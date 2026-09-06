import { Routes } from '@angular/router';
import { ConfigComponent } from './pages/config/config.component';
import { ChatComponent } from './pages/chat/chat.component';
import { ImportComponent } from './pages/import/import.component';
import {PersonasComponent} from './pages/personas/personas.component';
import {ProjectsComponent} from './pages/projects/projects.component';
import { ChatReaderComponent } from './pages/chat-reader/chat-reader.component';
import { LoginComponent } from './pages/login/login.component';
import { ClaimsComponent } from './pages/claims/claims.component';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: 'login', component: LoginComponent },
  { path: 'claims', component: ClaimsComponent, canActivate: [authGuard] },
  { path: 'config', component: ConfigComponent, canActivate: [authGuard] },
  { path: 'chat', component: ChatComponent, canActivate: [authGuard] },
  { path: 'read', component: ChatReaderComponent, canActivate: [authGuard] },
  { path: 'personas', component: PersonasComponent, canActivate: [authGuard] },
  { path: 'import', component: ImportComponent, canActivate: [authGuard] },
  { path: 'projects', component: ProjectsComponent, canActivate: [authGuard] },
  { path: '', redirectTo: 'chat', pathMatch: 'full' }
];
