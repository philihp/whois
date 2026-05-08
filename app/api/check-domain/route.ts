import { NextRequest, NextResponse } from 'next/server';
import {
  Route53DomainsClient,
  CheckDomainAvailabilityCommand,
  ListPricesCommand,
} from '@aws-sdk/client-route-53-domains';
import { awsCredentialsProvider } from '@vercel/functions/oidc';
import * as R from 'ramda';
import { validate } from '@/lib/domain';
import { pickPriceForDomain } from '@/lib/pricing';

// Route 53 Domains is only available in us-east-1.
const region = 'us-east-1';

// awsCredentialsProvider from @vercel/functions/oidc fetches a fresh OIDC
// token per-request via Vercel's IPC socket and exchanges it for short-lived
// AWS credentials via STS AssumeRoleWithWebIdentity.
const makeClient = () =>
  new Route53DomainsClient({
    region,
    credentials: awsCredentialsProvider({
      roleArn: process.env.AWS_ROLE_ARN!,
    }),
  });

type PriceShape = {
  amount: number;
  currency: string;
} | null;

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

  if (!process.env.AWS_ROLE_ARN) {
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

    return NextResponse.json({ domain, status, price });
  } catch (err) {
    const message = toMessage(err);
    return NextResponse.json(
      { error: `AWS error: ${message}`, detail: message },
      { status: 502 },
    );
  }
}
