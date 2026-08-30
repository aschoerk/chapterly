import { describe, expect, it } from 'vitest';
import {
  LlmSseParser,
  asText,
  dataPayload,
  extractLlmDelta,
  openaiData,
  parseSseNaive
} from './llm-sse';

function feed(parser: LlmSseParser, pieces: Array<string | Uint8Array>, flush = true): string {
  for (const piece of pieces) {
    if (typeof piece === 'string') parser.pushText(piece);
    else parser.pushBytes(piece);
  }
  if (flush) parser.flush();
  return parser.result().content;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('dataPayload', () => {
  it('accepts data with the conventional space', () => {
    expect(dataPayload('data: {"a":1}')).toBe('{"a":1}');
  });

  it('accepts data without a space (CN gateways)', () => {
    expect(dataPayload('data:{"a":1}')).toBe('{"a":1}');
  });

  it('rejects comment and control lines', () => {
    expect(dataPayload(': keep-alive')).toBeNull();
    expect(dataPayload('event: message')).toBeNull();
    expect(dataPayload('id: 12')).toBeNull();
  });
});

describe('asText / extractLlmDelta', () => {
  it('joins array content parts', () => {
    expect(asText([{ text: 'Ner' }, { text: 'vous' }])).toBe('Nervous');
  });

  it('reads OpenAI delta.content', () => {
    expect(extractLlmDelta({
      choices: [{ delta: { content: 'e' } }]
    })).toEqual({ content: 'e', thinking: '' });
  });

  it('reads reasoning_content beside an empty content delta', () => {
    expect(extractLlmDelta({
      choices: [{ delta: { content: '', reasoning_content: 'plan' } }]
    })).toEqual({ content: '', thinking: 'plan' });
  });

  it('falls back to message.content and result', () => {
    expect(extractLlmDelta({
      choices: [{ message: { content: 'hello' } }]
    }).content).toBe('hello');
    expect(extractLlmDelta({ result: 'qianfan' }).content).toBe('qianfan');
  });
});

describe('LlmSseParser — happy path', () => {
  it('concatenates ordinary OpenAI deltas', () => {
    const parser = new LlmSseParser();
    const text = [
      openaiData('Sterling '),
      openaiData('walks'),
      'data: [DONE]'
    ].join('\n\n') + '\n\n';

    expect(feed(parser, [text])).toBe('Sterling walks');
  });

  it('keeps single-letter tokens that make English words', () => {
    const parser = new LlmSseParser();
    const tokens = ['N', 'e', 'r', 'v', 'ous', ' ', 'e', 'nergy'];
    const body = tokens.map(t => openaiData(t)).join('\n\n') + '\n\n';
    expect(feed(parser, [body])).toBe('Nervous energy');
  });
});

describe('LlmSseParser — framing edge cases that drop letters', () => {
  it('does not lose the last event when the stream has no trailing blank line', () => {
    const parser = new LlmSseParser();
    // last frame is complete JSON but the TCP stream ends without \n\n
    const body = `${openaiData('postur')}\n\n${openaiData('e')}`;
    expect(feed(parser, [body])).toBe('posture');
  });

  it('reassembles a JSON frame split across two TCP chunks', () => {
    const parser = new LlmSseParser();
    const full = `${openaiData('pressure')}\n\n`;
    const cut = full.indexOf('pressure') + 3; // split inside the word, inside JSON
    expect(feed(parser, [full.slice(0, cut), full.slice(cut)])).toBe('pressure');
  });

  it('reassembles a frame split immediately after "data:"', () => {
    const parser = new LlmSseParser();
    const json = JSON.stringify({ choices: [{ delta: { content: 'e' } }] });
    expect(
      feed(parser, ['data:', ` ${json}\n\n`])
    ).toBe('e');
  });

  it('accepts data: without a space, which the old parser skipped', () => {
    const frame = `data:${JSON.stringify({ choices: [{ delta: { content: 'e' } }] })}\n\n`;
    const parser = new LlmSseParser();
    expect(feed(parser, [frame])).toBe('e');

    expect(parseSseNaive(frame)).toEqual({ content: '', thinking: '' });
  });

  it('handles CRLF separators used by some proxies', () => {
    const parser = new LlmSseParser();
    const body = `${openaiData('phy')}\r\n\r\n${openaiData('sical')}\r\n\r\n`;
    expect(feed(parser, [body])).toBe('physical');
  });

  it('parses several events coalesced into one TCP packet', () => {
    const parser = new LlmSseParser();
    const body = ['pr', 'e', 'ssure'].map(t => openaiData(t) + '\n\n').join('');
    expect(feed(parser, [body])).toBe('pressure');
  });

  it('joins multi-line data: fields split mid-string', () => {
    const parser = new LlmSseParser();
    const json = JSON.stringify({ choices: [{ delta: { content: 'nervously' } }] });
    const mid = json.indexOf('nervously') + 3; // split inside the string value
    const body = `data: ${json.slice(0, mid)}\ndata: ${json.slice(mid)}\n\n`;
    expect(feed(parser, [body])).toBe('nervously');
  });

  it('joins multi-line data: fields split on a JSON token boundary', () => {
    const parser = new LlmSseParser();
    const json = JSON.stringify({ choices: [{ delta: { content: 'nervously' } }] });
    const mid = json.indexOf(':') + 1;
    const body = `data: ${json.slice(0, mid)}\ndata: ${json.slice(mid)}\n\n`;
    expect(feed(parser, [body])).toBe('nervously');
  });

  it('ignores comment and keep-alive lines between tokens', () => {
    const parser = new LlmSseParser();
    const body = [
      openaiData('N'),
      ': keep-alive',
      'event: message',
      openaiData('e'),
      openaiData('rvous')
    ].join('\n\n') + '\n\n';
    expect(feed(parser, [body])).toBe('Nervous');
  });

  it('does not treat a parse error as fatal; later tokens still arrive', () => {
    const parser = new LlmSseParser();
    const body = [
      openaiData('phy'),
      'data: {not-json',
      openaiData('sical')
    ].join('\n\n') + '\n\n';
    expect(feed(parser, [body])).toBe('physical');
    expect(parser.result().parseErrors).toBe(1);
  });
});

describe('LlmSseParser — encoding and content shapes', () => {
  it('does not drop a multibyte character split across byte chunks', () => {
    const parser = new LlmSseParser();
    const frame = bytes(`${openaiData('café')}\n\n`);
    // é is C3 A9 — cut between the two bytes of the letter
    const eAcute = [...frame].findIndex((b, i, arr) => b === 0xc3 && arr[i + 1] === 0xa9);
    expect(eAcute).toBeGreaterThan(0);
    parser.pushBytes(frame.slice(0, eAcute + 1));
    parser.pushBytes(frame.slice(eAcute + 1));
    parser.flush();
    expect(parser.result().content).toBe('café');
  });

  it('interleaves content and thinking without stealing letters', () => {
    const parser = new LlmSseParser();
    const body = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'look' } }] })}`,
      openaiData('heat'),
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: ' closer' } }] })}`
    ].join('\n\n') + '\n\n';
    feed(parser, [body]);
    expect(parser.result()).toMatchObject({ content: 'heat', thinking: 'look closer' });
  });

  it('optionally diffs cumulative snapshot fields', () => {
    const parser = new LlmSseParser({ cumulativeSnapshots: true });
    const snap = (text: string) =>
      `data: ${JSON.stringify({ output: { text } })}\n\n`;
    expect(feed(parser, [snap('Ner'), snap('Nervous')])).toBe('Nervous');
  });
});

describe('naive parser vs robust parser — the missing-letter demo', () => {
  it('drops a single-letter token when data: has no space', () => {
    const e = `data:${JSON.stringify({ choices: [{ delta: { content: 'e' } }] })}\n\n`;
    const n = `${openaiData('N')}\n\n`;
    const rest = `${openaiData('rvous')}\n\n`;
    const stream = n + e + rest;

    expect(parseSseNaive(stream).content).toBe('Nrvous');
    const parser = new LlmSseParser();
    expect(feed(parser, [stream])).toBe('Nervous');
  });

  it('drops the last letter when the stream ends without a newline', () => {
    const stream = `${openaiData('postur')}\n\n${openaiData('e')}`;

    expect(parseSseNaive(stream).content).toBe('postur');
    const parser = new LlmSseParser();
    expect(feed(parser, [stream])).toBe('posture');
  });

  it('drops a token if JSON is split after a premature newline inside the packet', () => {
    const first = openaiData('pr') + '\n\n';
    const broken = 'data: {"choices":[{"delta":{"content":"e"}}\n';
    const rest = openaiData('ssure') + '\n\n';
    const stream = first + broken + rest;

    expect(parseSseNaive(stream).content).toBe('prssure');
  });

  it('rebuilds the reported paragraph tokens without losing vowels', () => {
    const tokens = [
      'Sterling walks the line, stopping in front of each girl. ',
      'He tilts his head, says nothing, just looks. ',
      'When he reaches Krystal, she giggles ',
      'n', 'e', 'rvously', '. ',
      'He places a fing', 'e', 'r under her chin and tilts her face up. ',
      '“', 'N', 'e', 'rvous', ' energy has no place here. Turn it into heat.” ',
      'He moves on. He stops in front of me. His eyes, a dark amber col',
      'o', 'r', ', rake over me without any change in expression. ',
      'He notes my postur', 'e', ', my long neck, my broad-ish but lean athletic frame. ',
      'He walks around me, and I feel his gaze like a phy',
      'sical', ' pr', 'e', 'ssure', ' on my lower back, my hips, my calves.'
    ];

    const withSpace = tokens.map(t => openaiData(t) + '\n\n').join('');
    const parser = new LlmSseParser();
    const assembled = feed(parser, [withSpace]);
    expect(assembled).toContain('giggles nervously');
    expect(assembled).toContain('Nervous energy');
    expect(assembled).toContain('posture');
    expect(assembled).toContain('physical pressure');
    expect(assembled).not.toMatch(/nrvously|Nrvous|postur,|phyisical|prssure/);
  });

  it('shows how mixing no-space frames produces the exact user sample holes', () => {
    const frame = (text: string, spaced: boolean) => {
      const json = JSON.stringify({ choices: [{ delta: { content: text } }] });
      return spaced ? `data: ${json}\n\n` : `data:${json}\n\n`;
    };

    // every lone "e" arrives as data:{...} without a space
    const stream =
      frame('giggles n', true) +
      frame('e', false) +
      frame('rvously. N', true) +
      frame('e', false) +
      frame('rvous energy. postur', true) +
      frame('e', false) +
      frame('. phyisical pr', true) +
      frame('e', false) +
      frame('ssure', true);

    expect(parseSseNaive(stream).content).toBe(
      'giggles nrvously. Nrvous energy. postur. phyisical prssure'
    );

    const parser = new LlmSseParser();
    expect(feed(parser, [stream])).toBe(
      'giggles nervously. Nervous energy. posture. phyisical pressure'
    );
  });
});
