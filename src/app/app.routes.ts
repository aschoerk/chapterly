import { Routes } from '@angular/router';
import { ConfigComponent } from './pages/config/config.component';
import { ChatComponent } from './pages/chat/chat.component';
import { ImportComponent } from './pages/import/import.component';
import {PersonasComponent} from './pages/personas/personas.component';
import {ProjectsComponent} from './pages/projects/projects.component';
import { TopicsComponent } from './pages/topics/topics.component';
import { ChatReaderComponent } from './pages/chat-reader/chat-reader.component';
import { LoginComponent } from './pages/login/login.component';
import { ClaimsComponent } from './pages/claims/claims.component';

export const routes: Routes = [
  // { path: 'login', component: LoginComponent },
  // { path: 'claims', component: ClaimsComponent, canActivate: [authGuard] },
  { path: 'config', component: ConfigComponent},
  { path: 'chat', component: ChatComponent},
  { path: 'read', component: ChatReaderComponent},
  { path: 'personas', component: PersonasComponent},
  { path: 'topics', component: TopicsComponent},
  { path: 'import', component: ImportComponent},
  { path: 'projects', component: ProjectsComponent},
  { path: '', redirectTo: 'chat', pathMatch: 'full' }
];
