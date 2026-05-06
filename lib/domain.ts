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

export type ValidationResult =
  | { ok: true; domain: string }
  | { ok: false; error: string };

export const validate = (raw: unknown): ValidationResult => {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'Please enter a domain name.' };
  }
  const domain = normalizeDomain(raw);
  return isValidDomain(domain)
    ? { ok: true, domain }
    : { ok: false, error: 'That does not look like a valid domain name.' };
};
