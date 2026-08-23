import { describe, expect, it } from 'vitest';
import {
  normalizeDomain,
  isValidDomain,
  isValidWord,
  parseInput,
} from './domain';
import { getTld, pickPriceForDomain } from './pricing';
import { compareByPopularity, tldRank } from './popularity';
import { encodeMessage, parseMessage, splitLines } from './protocol';
import { isThrottlingError, toAwsErrorMessage } from './aws';

describe('normalizeDomain', () => {
  it('lowercases and trims', () => {
    expect(normalizeDomain('  Example.COM  ')).toBe('example.com');
  });
  it('strips protocol, path, and leading www', () => {
    expect(normalizeDomain('https://www.example.com/path')).toBe('example.com');
  });
});

describe('isValidDomain', () => {
  it('accepts standard domains', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('foo.co.uk')).toBe(true);
  });
  it('rejects junk', () => {
    expect(isValidDomain('not a domain')).toBe(false);
    expect(isValidDomain('example')).toBe(false);
    expect(isValidDomain('-bad.com')).toBe(false);
  });
});

describe('isValidWord', () => {
  it('accepts single labels', () => {
    expect(isValidWord('example')).toBe(true);
    expect(isValidWord('a')).toBe(true);
    expect(isValidWord('foo-bar')).toBe(true);
  });
  it('rejects labels with dots, spaces, or edge hyphens', () => {
    expect(isValidWord('example.com')).toBe(false);
    expect(isValidWord('-bad')).toBe(false);
    expect(isValidWord('bad-')).toBe(false);
    expect(isValidWord('bad word')).toBe(false);
  });
});

describe('parseInput', () => {
  it('parses a full domain', () => {
    expect(parseInput(' Example.com ')).toEqual({
      kind: 'domain',
      domain: 'example.com',
    });
  });
  it('parses a bare word as a bulk-scan request', () => {
    expect(parseInput('Example')).toEqual({
      kind: 'word',
      word: 'example',
    });
  });
  it('errors on non-string input', () => {
    expect(parseInput(undefined).kind).toBe('error');
  });
  it('errors on invalid dotted input', () => {
    expect(parseInput('-bad.com').kind).toBe('error');
  });
  it('errors on invalid bare word', () => {
    expect(parseInput('-bad').kind).toBe('error');
  });
});

describe('getTld', () => {
  it('returns last label for simple domains', () => {
    expect(getTld('example.com')).toBe('com');
  });
  it('returns trailing labels for compound domains', () => {
    expect(getTld('foo.bar.co.uk')).toBe('bar.co.uk');
  });
});

describe('tldRank / compareByPopularity', () => {
  it('ranks com before less popular TLDs', () => {
    expect(tldRank('com')).toBeLessThan(tldRank('io'));
    expect(tldRank('io')).toBeLessThan(tldRank('xyz'));
  });
  it('sends unlisted TLDs to the end', () => {
    expect(tldRank('com')).toBeLessThan(tldRank('zzz'));
    expect(tldRank('zzz')).toBe(tldRank('aaa'));
  });
  it('sorts a mixed list popularity-first, alphabetical otherwise', () => {
    const sorted = ['xyz', 'aaa', 'com', 'io', 'bbb'].sort(compareByPopularity);
    expect(sorted).toEqual(['com', 'io', 'xyz', 'aaa', 'bbb']);
  });
});

describe('pickPriceForDomain', () => {
  const prices = [
    { Name: 'com', RegistrationPrice: { Price: 12, Currency: 'USD' } },
    { Name: 'co.uk', RegistrationPrice: { Price: 9, Currency: 'USD' } },
    { Name: 'uk', RegistrationPrice: { Price: 7, Currency: 'USD' } },
  ];
  it('matches simple TLD', () => {
    expect(pickPriceForDomain('example.com', prices)?.Name).toBe('com');
  });
  it('prefers longest suffix match', () => {
    expect(pickPriceForDomain('example.co.uk', prices)?.Name).toBe('co.uk');
  });
  it('returns undefined when no match', () => {
    expect(pickPriceForDomain('example.zzz', prices)).toBeUndefined();
  });
});

describe('splitLines', () => {
  it('returns whole lines and keeps the partial tail', () => {
    expect(splitLines('{"a":1}\n{"b":2}\n{"c":')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c":',
    });
  });
  it('returns no lines when nothing is complete yet', () => {
    expect(splitLines('{"a"')).toEqual({ lines: [], rest: '{"a"' });
  });
  it('drops blank lines', () => {
    expect(splitLines('{"a":1}\n\n\n').lines).toEqual(['{"a":1}']);
  });
});

describe('parseMessage', () => {
  it('parses a typed message', () => {
    expect(parseMessage('{"type":"status","domain":"a.com","status":"AVAILABLE"}')).toEqual({
      type: 'status',
      domain: 'a.com',
      status: 'AVAILABLE',
    });
  });
  it('returns null on malformed JSON', () => {
    expect(parseMessage('{"type":')).toBeNull();
  });
  it('returns null when the type discriminator is missing', () => {
    expect(parseMessage('{"domain":"a.com"}')).toBeNull();
  });
});

describe('encodeMessage', () => {
  it('emits one newline-terminated JSON line', () => {
    const text = new TextDecoder().decode(
      encodeMessage({ type: 'meta', kind: 'bulk', throttleMs: 5000 }),
    );
    expect(text.endsWith('\n')).toBe(true);
    expect(parseMessage(text.trim())).toEqual({
      type: 'meta',
      kind: 'bulk',
      throttleMs: 5000,
    });
  });
});

describe('isThrottlingError', () => {
  it('detects AWS throttling by error name', () => {
    expect(isThrottlingError({ name: 'ThrottlingException' })).toBe(true);
    expect(isThrottlingError({ name: 'TooManyRequestsException' })).toBe(true);
  });
  it('detects throttling by HTTP status', () => {
    expect(isThrottlingError({ $metadata: { httpStatusCode: 429 } })).toBe(true);
  });
  it('ignores other failures', () => {
    expect(isThrottlingError(new Error('boom'))).toBe(false);
    expect(isThrottlingError({ name: 'AccessDeniedException' })).toBe(false);
    expect(isThrottlingError(null)).toBe(false);
  });
});

describe('toAwsErrorMessage', () => {
  it('reads the message off an Error', () => {
    expect(toAwsErrorMessage(new Error('boom'))).toBe('boom');
  });
  it('reads the message off a rehydrated step error (plain object)', () => {
    // Errors crossing a step boundary arrive serialized, not as Error instances.
    expect(toAwsErrorMessage({ name: 'ThrottlingException', message: 'Rate exceeded' }))
      .toBe('Rate exceeded');
  });
  it('accepts a bare string', () => {
    expect(toAwsErrorMessage('nope')).toBe('nope');
  });
  it('falls back when there is nothing to read', () => {
    expect(toAwsErrorMessage({})).toBe('Unknown error from AWS');
    expect(toAwsErrorMessage(null)).toBe('Unknown error from AWS');
  });
});
