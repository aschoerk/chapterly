import { Routes } from '@angular/router';
import { ConfigShellComponent } from './pages/config/config-shell.component';
import { AppearanceComponent } from './pages/config/appearance/appearance.component';
import { ProvidersComponent } from './pages/config/providers/providers.component';
import { TasksComponent } from './pages/config/tasks/tasks.component';
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
  {
    path: 'config',
    component: ConfigShellComponent,
    children: [
      { path: '', redirectTo: 'appearance', pathMatch: 'full' },
      { path: 'appearance', component: AppearanceComponent },
      { path: 'providers', component: ProvidersComponent },
      { path: 'tasks', component: TasksComponent }
    ]
  },
  { path: 'chat', component: ChatComponent},
  { path: 'read', component: ChatReaderComponent},
  { path: 'personas', component: PersonasComponent},
  { path: 'topics', component: TopicsComponent},
  { path: 'import', component: ImportComponent},
  { path: 'projects', component: ProjectsComponent},
  { path: '', redirectTo: 'chat', pathMatch: 'full' }
];
