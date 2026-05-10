import { NextRequest, NextResponse } from 'next/server';
import {
  Route53DomainsClient,
  CheckDomainAvailabilityCommand,
  ListPricesCommand,
} from '@aws-sdk/client-route-53-domains';
import { awsCredentialsProvider } from '@vercel/functions/oidc';
import { fromEnv } from '@aws-sdk/credential-providers';
import * as R from 'ramda';
import { parseInput } from '@/lib/domain';
import { pickPriceForDomain } from '@/lib/pricing';

// Bulk gTLD scans fan out one CheckDomainAvailability call per TLD.
export const maxDuration = 60;

// Route 53 Domains is only available in us-east-1.
const region = 'us-east-1';

// Use static key credentials locally when present; fall back to Vercel OIDC
// in production (VERCEL_OIDC_TOKEN is fetched dynamically per-request by the
// library, so it never appears as a static process.env var to check against).
const makeClient = () =>
  new Route53DomainsClient({
    region,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? fromEnv()
      : awsCredentialsProvider({ roleArn: process.env.AWS_ROLE_ARN! }),
  });

type PriceShape = {
  amount: number;
  currency: string;
} | null;

type PriceEntry = {
  Name?: string;
  RegistrationPrice?: { Price?: number; Currency?: string };
};

type ThrottleResult =
  | { throttled: false }
  | { throttled: true; retryAfter: number };

type BulkResultEntry = {
  domain: string;
  tld: string;
  status: string;
  price: PriceShape;
};

type SingleSuccessBody = {
  kind: 'single';
  domain: string;
  status: string;
  price: PriceShape;
  throttleMs: number;
};

type BulkSuccessBody = {
  kind: 'bulk';
  word: string;
  results: BulkResultEntry[];
  throttleMs: number;
};

const THROTTLE_COOKIE = 'last_check';

const checkThrottle = (req: NextRequest): ThrottleResult => {
  const throttleMs = parseInt(process.env.THROTTLE_SECONDS ?? '5', 10) * 1000;
  const raw = req.cookies.get(THROTTLE_COOKIE)?.value;
  if (!raw) return { throttled: false };
  const lastCheck = parseInt(raw, 10);
  if (Number.isNaN(lastCheck)) return { throttled: false };
  const elapsed = Date.now() - lastCheck;
  if (elapsed >= throttleMs) return { throttled: false };
  return { throttled: true, retryAfter: throttleMs - elapsed };
};

const setThrottleCookie = (response: NextResponse): void => {
  response.cookies.set(THROTTLE_COOKIE, String(Date.now()), {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    // No `secure`: works on http://localhost in dev; Vercel enforces HTTPS in prod
  });
};

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Unknown error from AWS';

// Pure: pulls registration price out of the AWS price entry shape.
const extractRegistrationPrice = (entry: unknown): PriceShape => {
  const price = R.path(['RegistrationPrice'], entry) as
    | { Price?: number; Currency?: string }
    | undefined;
  if (!price || typeof price.Price !== 'number' || !price.Currency) return null;
  return { amount: price.Price, currency: price.Currency };
};

const getThrottleMs = (): number =>
  parseInt(process.env.THROTTLE_SECONDS ?? '5', 10) * 1000;

const listAllTldPrices = async (
  client: Route53DomainsClient,
): Promise<PriceEntry[]> => {
  const all: PriceEntry[] = [];
  let marker: string | undefined;
  do {
    const resp = await client.send(
      new ListPricesCommand({ Marker: marker, MaxItems: 100 }),
    );
    for (const p of resp.Prices ?? []) all.push(p as PriceEntry);
    marker = resp.NextPageMarker;
  } while (marker);
  return all;
};

const handleSingle = async (
  client: Route53DomainsClient,
  domain: string,
): Promise<NextResponse> => {
  try {
    const availability = await client.send(
      new CheckDomainAvailabilityCommand({ DomainName: domain }),
    );
    const status = availability.Availability ?? 'UNKNOWN';

    let price: PriceShape = null;
    try {
      const labels = domain.split('.');
      const candidateTlds = R.range(1, labels.length).map((i) =>
        labels.slice(i).join('.'),
      );
      for (const tld of candidateTlds) {
        const resp = await client.send(new ListPricesCommand({ Tld: tld }));
        const match = pickPriceForDomain(domain, resp.Prices ?? []);
        if (match) {
          price = extractRegistrationPrice(match);
          if (price) break;
        }
      }
    } catch {
      // Pricing is optional; swallow and return availability only.
    }

    const body: SingleSuccessBody = {
      kind: 'single',
      domain,
      status,
      price,
      throttleMs: getThrottleMs(),
    };
    const response = NextResponse.json(body);
    setThrottleCookie(response);
    return response;
  } catch (err) {
    const message = toMessage(err);
    return NextResponse.json(
      { error: `AWS error: ${message}`, detail: message },
      { status: 502 },
    );
  }
};

const handleBulk = async (
  client: Route53DomainsClient,
  word: string,
): Promise<NextResponse> => {
  let prices: PriceEntry[];
  try {
    prices = await listAllTldPrices(client);
  } catch (err) {
    const message = toMessage(err);
    return NextResponse.json(
      { error: `AWS error: ${message}`, detail: message },
      { status: 502 },
    );
  }

  const tlds = prices
    .map((p) => p.Name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  const priceByTld = new Map<string, PriceShape>(
    prices.map((p) => [p.Name ?? '', extractRegistrationPrice(p)]),
  );

  const settled = await Promise.allSettled(
    tlds.map(async (tld) => {
      const domain = `${word}.${tld}`;
      const resp = await client.send(
        new CheckDomainAvailabilityCommand({ DomainName: domain }),
      );
      return {
        domain,
        tld,
        status: resp.Availability ?? 'UNKNOWN',
        price: priceByTld.get(tld) ?? null,
      } satisfies BulkResultEntry;
    }),
  );

  const results: BulkResultEntry[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          domain: `${word}.${tlds[i]}`,
          tld: tlds[i],
          status: 'ERROR',
          price: priceByTld.get(tlds[i]) ?? null,
        },
  );

  const body: BulkSuccessBody = {
    kind: 'bulk',
    word,
    results,
    throttleMs: getThrottleMs(),
  };
  const response = NextResponse.json(body);
  setThrottleCookie(response);
  return response;
};

export async function POST(req: NextRequest) {
  const throttle = checkThrottle(req);
  if (throttle.throttled) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait.', retryAfter: throttle.retryAfter },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = parseInput(R.path(['domain'], body));
  if (parsed.kind === 'error') {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  if (!process.env.AWS_ROLE_ARN && process.env.VERCEL_OIDC_TOKEN !== undefined) {
    return NextResponse.json(
      { error: 'AWS_ROLE_ARN is not configured' },
      { status: 500 },
    );
  }

  const client = makeClient();

  return parsed.kind === 'word'
    ? handleBulk(client, parsed.word)
    : handleSingle(client, parsed.domain);
}
