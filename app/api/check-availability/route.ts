import { NextRequest, NextResponse } from 'next/server';
import { CheckDomainAvailabilityCommand } from '@aws-sdk/client-route-53-domains';
import * as R from 'ramda';
import { parseInput } from '@/lib/domain';
import { isOidcConfigured, makeClient, toAwsErrorMessage } from '@/lib/aws';
import { Semaphore } from '@/lib/semaphore';

// Module-level: caps in-flight CheckDomainAvailability calls per Lambda
// instance. Sized to stay comfortably below AWS Route 53 Domains throttling.
const awsConcurrency = new Semaphore(4);

type AvailabilityResponse = {
  domain: string;
  status: string;
};

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = parseInput(R.path(['domain'], body));
  if (parsed.kind !== 'domain') {
    const error =
      parsed.kind === 'error' ? parsed.error : 'Expected a full domain.';
    return NextResponse.json({ error }, { status: 400 });
  }

  if (!isOidcConfigured()) {
    return NextResponse.json(
      { error: 'AWS_ROLE_ARN is not configured' },
      { status: 500 },
    );
  }

  try {
    const status = await awsConcurrency.run(async () => {
      const client = makeClient();
      const resp = await client.send(
        new CheckDomainAvailabilityCommand({ DomainName: parsed.domain }),
      );
      return resp.Availability ?? 'UNKNOWN';
    });

    const responseBody: AvailabilityResponse = {
      domain: parsed.domain,
      status,
    };
    return NextResponse.json(responseBody);
  } catch (err) {
    const message = toAwsErrorMessage(err);
    return NextResponse.json(
      { error: `AWS error: ${message}`, detail: message },
      { status: 502 },
    );
  }
}
