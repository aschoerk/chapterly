import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { I18nService } from '../../core/i18n/i18n.service';

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
  readonly i18n = inject(I18nService);
  private readonly router = inject(Router);

  readonly links = computed<AppNavLink[]>(() => {
    this.i18n.locale();
    const t = (k: string) => this.i18n.t(k);
    return [
      { path: '/chat', label: t('nav.stories'), title: t('nav.storiesTitle'), icon: 'chat' },
      { path: '/read', label: t('nav.read'), title: t('nav.readTitle'), icon: 'read' },
      { path: '/projects', label: t('nav.environments'), title: t('nav.environmentsTitle'), icon: 'projects' },
      { path: '/personas', label: t('nav.personas'), title: t('nav.personasTitle'), icon: 'personas' },
      { path: '/import', label: t('nav.import'), title: t('nav.importTitle'), icon: 'import' },
      { path: '/claims', label: t('nav.claims'), title: t('nav.claimsTitle'), icon: 'claims' },
      { path: '/config', label: t('nav.settings'), title: t('nav.settingsTitle'), icon: 'config' }
    ];
  });

  logout(): void {
    this.auth.logout();
    void this.router.navigateByUrl('/login');
  }
}
