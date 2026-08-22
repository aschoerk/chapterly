import { Routes } from '@angular/router';
import { ConfigComponent } from './pages/config/config';

export const routes: Routes = [
  { path: 'config', component: ConfigComponent },
  { path: '', redirectTo: 'config', pathMatch: 'full' }
];
