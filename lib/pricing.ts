import * as R from 'ramda';

// "example.co.uk" -> "co.uk" is hard in general, but Route 53 prices TLDs
// using the last label or known compound TLDs. We try the longest suffix
// match against the price list returned by AWS, which is the correct
// strategy regardless of label count.

export const getTld: (domain: string) => string = R.pipe(
  R.split('.'),
  R.tail,
  R.join('.'),
);

// Given a domain and a list of price entries from AWS, pick the entry whose
// TLD ("Name") matches the longest suffix of the domain.
type PriceEntry = { Name?: string };

export const pickPriceForDomain = <T extends PriceEntry>(
  domain: string,
  prices: ReadonlyArray<T>,
): T | undefined => {
  const labels = domain.split('.');
  // Try longest suffix first: "co.uk", then "uk".
  const suffixes = R.range(1, labels.length).map((i) =>
    labels.slice(i).join('.'),
  );
  return R.find(
    (entry: T) => Boolean(entry.Name && suffixes.includes(entry.Name)),
    prices,
  );
};
