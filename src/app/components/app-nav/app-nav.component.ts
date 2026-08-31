import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

interface AppNavLink {
  path: string;
  label: string;
  title: string;
  icon: 'chat' | 'read' | 'projects' | 'personas' | 'import' | 'config';
}

@Component({
  selector: 'app-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './app-nav.component.html',
  styleUrl: './app-nav.component.css'
})
export class AppNavComponent {
  readonly links: AppNavLink[] = [
    { path: '/chat', label: 'Stories', title: 'Stories', icon: 'chat' },
    { path: '/read', label: 'Read', title: 'Book view', icon: 'read' },
    { path: '/projects', label: 'Environments', title: 'Environments & topics', icon: 'projects' },
    { path: '/personas', label: 'Personas', title: 'Personas', icon: 'personas' },
    { path: '/import', label: 'Import', title: 'Import & export', icon: 'import' },
    { path: '/config', label: 'Settings', title: 'Settings', icon: 'config' }
  ];
}
