import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { SortPreferencesService } from './sort-preferences.service';

describe('SortPreferencesService', () => {
  let service: SortPreferencesService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()]
    });
    service = TestBed.inject(SortPreferencesService);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults to the newest-first ordering (by age, most recent on top)', () => {
    expect(service.modeFor('projects')()).toBe('updated');
    expect(service.updatedDescFor('projects')()).toBe(true);
    expect(service.alphaAscFor('projects')()).toBe(true);
  });

  it('keeps per-page sort preferences independent', () => {
    service.setMode('projects', 'alpha');
    service.setAlphaAsc('projects', false); // Z–A on the Projects page
    service.setUpdatedDesc('topics', false); // oldest first on the Topics page

    expect(service.modeFor('projects')()).toBe('alpha');
    expect(service.alphaAscFor('projects')()).toBe(false);

    // The other page keeps its own (default) value.
    expect(service.modeFor('topics')()).toBe('updated');
    expect(service.updatedDescFor('topics')()).toBe(false);
    expect(service.alphaAscFor('topics')()).toBe(true);
  });

  it('persists preferences to localStorage so they survive page switches', () => {
    service.setMode('sidebar', 'alpha');
    service.setUpdatedDesc('sidebar', false);

    // Simulate navigating away and back: a fresh service instance reads storage.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()]
    });
    const again = TestBed.inject(SortPreferencesService);

    expect(again.modeFor('sidebar')()).toBe('alpha');
    expect(again.updatedDescFor('sidebar')()).toBe(false);
    expect(again.alphaAscFor('sidebar')()).toBe(true);
  });

  it('falls back to the default ordering for pages without stored preferences', () => {
    service.setMode('topics', 'updated');
    service.setUpdatedDesc('topics', false);
    expect(service.modeFor('topics')()).toBe('updated');

    // A page never touched keeps the default.
    expect(service.modeFor('projects')()).toBe('updated');
    expect(service.updatedDescFor('projects')()).toBe(true);
  });
});