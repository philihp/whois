import { NextRequest, NextResponse } from 'next/server';
import {
  Route53DomainsClient,
  CheckDomainAvailabilityCommand,
  ListPricesCommand,
} from '@aws-sdk/client-route-53-domains';
import { fromWebToken } from '@aws-sdk/credential-providers';
import * as R from 'ramda';
import { validate } from '@/lib/domain';
import { pickPriceForDomain } from '@/lib/pricing';

// Route 53 Domains is only available in us-east-1.
const region = 'us-east-1';

// When AWS_ROLE_ARN is set (Vercel + OIDC), credentials are obtained by
// exchanging the per-invocation VERCEL_OIDC_TOKEN for short-lived STS creds.
// Locally, the default credential chain (AWS profile / env vars) is used.
const client = new Route53DomainsClient({
  region,
  ...(process.env.AWS_ROLE_ARN &&
    process.env.VERCEL_OIDC_TOKEN && {
      credentials: fromWebToken({
        roleArn: process.env.AWS_ROLE_ARN,
        webIdentityToken: process.env.VERCEL_OIDC_TOKEN,
      }),
    }),
});

type PriceShape = {
  amount: number;
  currency: string;
} | null;

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
    const message =
      err instanceof Error ? err.message : 'Unknown error from AWS';
    return NextResponse.json(
      { error: `AWS error: ${message}`, detail: message },
      { status: 502 },
    );
  }
}
