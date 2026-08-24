import { Routes } from '@angular/router';
import { ConfigComponent } from './pages/config/config.component';
import { ChatComponent } from './pages/chat/chat.component';
import { ImportComponent } from './pages/import/import.component';
import {PersonasComponent} from './pages/personas/personas.component';
import {ProjectsComponent} from './pages/projects/projects.component';

export const routes: Routes = [
  { path: 'config', component: ConfigComponent },
  { path: 'chat', component: ChatComponent },
  { path: 'personas', component: PersonasComponent },
  { path: 'import', component: ImportComponent },
  { path: 'projects', component: ProjectsComponent },
  { path: '', redirectTo: 'chat', pathMatch: 'full' }
];
