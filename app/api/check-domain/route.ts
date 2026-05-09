import { NextRequest, NextResponse } from 'next/server';
import {
  Route53DomainsClient,
  CheckDomainAvailabilityCommand,
  ListPricesCommand,
} from '@aws-sdk/client-route-53-domains';
import { awsCredentialsProvider } from '@vercel/functions/oidc';
import { fromEnv } from '@aws-sdk/credential-providers';
import * as R from 'ramda';
import { validate } from '@/lib/domain';
import { pickPriceForDomain } from '@/lib/pricing';

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

type ThrottleResult =
  | { throttled: false }
  | { throttled: true; retryAfter: number };

type SuccessBody = {
  domain: string;
  status: string;
  price: PriceShape;
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

  const result = validate(R.path(['domain'], body));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const { domain } = result;

  if (!process.env.AWS_ROLE_ARN && process.env.VERCEL_OIDC_TOKEN !== undefined) {
    return NextResponse.json(
      { error: 'AWS_ROLE_ARN is not configured' },
      { status: 500 },
    );
  }

  const client = makeClient();

  try {
    // Availability check.
    const availability = await client.send(
      new CheckDomainAvailabilityCommand({ DomainName: domain }),
    );
    const status = availability.Availability ?? 'UNKNOWN';

    // Price lookup is best-effort and runs in parallel-friendly fashion;
    // failures here should not break the availability response.
    let price: PriceShape = null;
    try {
      const labels = domain.split('.');
      // Ask AWS only for the TLDs that could match this domain.
      const candidateTlds = R.range(1, labels.length).map((i) =>
        labels.slice(i).join('.'),
      );
      // ListPrices supports filtering by Tld (one at a time), so try the
      // longest suffix first; fall back to shorter ones.
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

    const throttleMs = parseInt(process.env.THROTTLE_SECONDS ?? '5', 10) * 1000;
    const responseBody: SuccessBody = { domain, status, price, throttleMs };
    const response = NextResponse.json(responseBody);
    setThrottleCookie(response);
    return response;
  } catch (err) {
    const message = toMessage(err);
    return NextResponse.json(
      { error: `AWS error: ${message}`, detail: message },
      { status: 502 },
    );
  }
}
