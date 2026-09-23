import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { I18nService } from '../../core/i18n/i18n.service';

interface ConfigTab {
  path: string;
  labelKey: string;
}

@Component({
  selector: 'app-config-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './config-shell.component.html',
  styleUrl: './config-shell.component.css'
})
export class ConfigShellComponent {
  readonly i18n = inject(I18nService);

  readonly tabs: ConfigTab[] = [
    { path: '/config/appearance', labelKey: 'config.nav.appearance' },
    { path: '/config/providers', labelKey: 'config.nav.providers' },
    { path: '/config/tasks', labelKey: 'config.nav.tasks' }
  ];
}