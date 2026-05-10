import { NextRequest, NextResponse } from 'next/server';
import {
  Route53DomainsClient,
  CheckDomainAvailabilityCommand,
  ListPricesCommand,
} from '@aws-sdk/client-route-53-domains';
import * as R from 'ramda';
import { parseInput } from '@/lib/domain';
import { pickPriceForDomain } from '@/lib/pricing';
import { isOidcConfigured, makeClient, toAwsErrorMessage } from '@/lib/aws';

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
  status: 'PENDING';
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
    const message = toAwsErrorMessage(err);
    return NextResponse.json(
      { error: `AWS error: ${message}`, detail: message },
      { status: 502 },
    );
  }
};

// Bulk path returns the TLD list and prices but does NOT check availability.
// Clients fan out per-TLD calls to /api/check-availability, which is globally
// concurrency-limited to avoid AWS throttling.
const handleBulk = async (
  client: Route53DomainsClient,
  word: string,
): Promise<NextResponse> => {
  let prices: PriceEntry[];
  try {
    prices = await listAllTldPrices(client);
  } catch (err) {
    const message = toAwsErrorMessage(err);
    return NextResponse.json(
      { error: `AWS error: ${message}`, detail: message },
      { status: 502 },
    );
  }

  const results: BulkResultEntry[] = prices
    .filter((p): p is PriceEntry & { Name: string } =>
      typeof p.Name === 'string' && p.Name.length > 0,
    )
    .map((p) => ({
      domain: `${word}.${p.Name}`,
      tld: p.Name,
      status: 'PENDING',
      price: extractRegistrationPrice(p),
    }));

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

  if (!isOidcConfigured()) {
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
