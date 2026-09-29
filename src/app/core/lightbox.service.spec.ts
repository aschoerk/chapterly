import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LightboxService } from './lightbox.service';

describe('LightboxService', () => {
  let lightbox: LightboxService;

  beforeEach(() => {
    TestBed.resetTestingModule();
    lightbox = TestBed.inject(LightboxService);
    lightbox.close();
  });

  it('opens with the given list and index', () => {
    lightbox.open(['a.png', 'b.png', 'c.png'], 1);
    expect(lightbox.current()).toEqual({ urls: ['a.png', 'b.png', 'c.png'], index: 1 });
  });

  it('clamps an out-of-range index', () => {
    lightbox.open(['a.png', 'b.png'], 99);
    expect(lightbox.current()!.index).toBe(1);
    lightbox.open(['a.png']);
    expect(lightbox.current()!.index).toBe(0);
  });

  it('is a no-op when opening an empty list', () => {
    lightbox.open([]);
    expect(lightbox.current()).toBeNull();
  });

  it('next() and prev() wrap around', () => {
    lightbox.open(['a.png', 'b.png', 'c.png']);
    lightbox.next();
    expect(lightbox.current()!.index).toBe(1);
    lightbox.next();
    expect(lightbox.current()!.index).toBe(2);
    lightbox.next();
    expect(lightbox.current()!.index).toBe(0);
    lightbox.prev();
    expect(lightbox.current()!.index).toBe(2);
  });

  it('next()/prev() are no-ops for a single image', () => {
    lightbox.open(['a.png']);
    lightbox.next();
    expect(lightbox.current()!.index).toBe(0);
    lightbox.prev();
    expect(lightbox.current()!.index).toBe(0);
  });

  it('close() clears the state', () => {
    lightbox.open(['a.png']);
    lightbox.close();
    expect(lightbox.current()).toBeNull();
  });
});