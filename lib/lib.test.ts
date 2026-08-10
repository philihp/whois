import { describe, expect, it } from 'vitest';
import {
  normalizeDomain,
  isValidDomain,
  isValidWord,
  parseInput,
} from './domain';
import { getTld, pickPriceForDomain } from './pricing';
import { compareByPopularity, tldRank } from './popularity';

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
