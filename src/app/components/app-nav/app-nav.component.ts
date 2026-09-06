import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/auth.service';

interface AppNavLink {
  path: string;
  label: string;
  title: string;
  icon: 'chat' | 'read' | 'projects' | 'personas' | 'import' | 'config' | 'claims';
}

@Component({
  selector: 'app-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './app-nav.component.html',
  styleUrl: './app-nav.component.css'
})
export class AppNavComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly links: AppNavLink[] = [
    { path: '/chat', label: 'Stories', title: 'Stories', icon: 'chat' },
    { path: '/read', label: 'Read', title: 'Book view', icon: 'read' },
    { path: '/projects', label: 'Environments', title: 'Environments & topics', icon: 'projects' },
    { path: '/personas', label: 'Personas', title: 'Personas', icon: 'personas' },
    { path: '/import', label: 'Import', title: 'Import & export', icon: 'import' },
    { path: '/claims', label: 'Claims', title: 'Workspace and wallet grants', icon: 'claims' },
    { path: '/config', label: 'Settings', title: 'Settings', icon: 'config' }
  ];

  logout(): void {
    this.auth.logout();
    void this.router.navigateByUrl('/login');
  }
}
