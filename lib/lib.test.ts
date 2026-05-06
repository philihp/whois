import { describe, expect, it } from 'vitest';
import { normalizeDomain, isValidDomain, validate } from './domain';
import { getTld, pickPriceForDomain } from './pricing';

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

describe('validate', () => {
  it('returns ok with normalized domain', () => {
    expect(validate(' Example.com ')).toEqual({
      ok: true,
      domain: 'example.com',
    });
  });
  it('returns error for non-string', () => {
    expect(validate(undefined).ok).toBe(false);
  });
  it('returns error for invalid', () => {
    expect(validate('nope').ok).toBe(false);
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
