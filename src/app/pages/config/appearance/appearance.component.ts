import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ThemeService } from '../../../core/theme.service';
import { I18nService } from '../../../core/i18n/i18n.service';

@Component({
  selector: 'app-config-appearance',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './appearance.component.html',
  styleUrl: '../config-shared.css'
})
export class AppearanceComponent {
  readonly theme = inject(ThemeService);
  readonly i18n = inject(I18nService);
}