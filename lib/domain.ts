import * as R from 'ramda';

// Normalize: trim, lowercase, strip protocol/path/leading-www.
const stripProtocol = R.replace(/^https?:\/\//, '');
const stripPath = R.replace(/\/.*$/, '');
const stripLeadingWww = R.replace(/^www\./, '');
const trim = R.trim;
const toLower = R.toLower;

export const normalizeDomain: (input: string) => string = R.pipe(
  trim,
  toLower,
  stripProtocol,
  stripPath,
  stripLeadingWww,
);

// A reasonable RFC-flavored domain regex (label.label, 2+ labels, valid chars).
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const isValidDomain: (d: string) => boolean = R.test(DOMAIN_RE);

// A single DNS label: 1-63 chars, alphanumeric with optional internal hyphens.
const WORD_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isValidWord: (s: string) => boolean = R.test(WORD_RE);

export type ParsedInput =
  | { kind: 'domain'; domain: string }
  | { kind: 'word'; word: string }
  | { kind: 'error'; error: string };

export const parseInput = (raw: unknown): ParsedInput => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { kind: 'error', error: 'Please enter a domain name.' };
  }
  const value = normalizeDomain(raw);
  if (!value.includes('.')) {
    return isValidWord(value)
      ? { kind: 'word', word: value }
      : { kind: 'error', error: 'That does not look like a valid name.' };
  }
  return isValidDomain(value)
    ? { kind: 'domain', domain: value }
    : { kind: 'error', error: 'That does not look like a valid domain name.' };
};
