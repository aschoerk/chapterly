import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { ConfigShellComponent } from './config-shell.component';
import { I18nService } from '../../core/i18n/i18n.service';

describe('ConfigShellComponent', () => {
  let fixture: ComponentFixture<ConfigShellComponent>;
  let component: ConfigShellComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConfigShellComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([])
      ]
    }).compileComponents();

    TestBed.inject(I18nService).setLocale('en');

    fixture = TestBed.createComponent(ConfigShellComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders three sidebar nav entries', () => {
    const links = (fixture.nativeElement as HTMLElement).querySelectorAll('.config-nav-item');
    expect(links.length).toBe(3);
    expect(component.tabs.map(t => t.path)).toEqual([
      '/config/appearance',
      '/config/providers',
      '/config/tasks'
    ]);
  });

  it('labels match the expected subpages', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Appearance');
    expect(text).toContain('Providers / Models');
    expect(text).toContain('Generation Tasks');
  });
});