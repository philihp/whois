// Rough popularity ranking for new domain registration. Anything not in this
// list sorts after the listed TLDs (caller uses alphabetical as secondary).
const POPULARITY: ReadonlyArray<string> = [
  'com',
  'net',
  'org',
  'co',
  'io',
  'ai',
  'dev',
  'app',
  'me',
  'info',
  'biz',
  'xyz',
  'tv',
  'us',
  'uk',
  'co.uk',
  'de',
  'ca',
  'eu',
  'fr',
  'nl',
  'es',
  'it',
  'au',
  'com.au',
  'tech',
  'online',
  'store',
  'shop',
  'site',
  'blog',
  'cloud',
  'page',
  'link',
  'live',
  'news',
  'design',
  'studio',
  'agency',
  'media',
  'pro',
  'name',
  'cc',
  'fm',
  'ly',
];

const POPULARITY_INDEX: ReadonlyMap<string, number> = new Map(
  POPULARITY.map((tld, i) => [tld, i]),
);

// Lower rank = more popular. Unlisted TLDs receive a sentinel rank that
// sorts them after every listed TLD.
export const tldRank = (tld: string): number =>
  POPULARITY_INDEX.get(tld) ?? POPULARITY.length;

export const compareByPopularity = (a: string, b: string): number => {
  const r = tldRank(a) - tldRank(b);
  return r !== 0 ? r : a.localeCompare(b);
};
