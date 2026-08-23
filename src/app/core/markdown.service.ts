// markdown.service.ts
import { Injectable } from '@angular/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

@Injectable({ providedIn: 'root' })
export class MarkdownService {
  constructor() {
    marked.setOptions({
      gfm: true,
      breaks: true,
    });
  }

  toHtml(markdown: string): string {
    if (!markdown) return '';
    const raw = marked.parse(markdown) as string;
    return DOMPurify.sanitize(raw);
  }
}
