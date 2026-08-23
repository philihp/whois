import { Route53DomainsClient } from '@aws-sdk/client-route-53-domains';
import { awsCredentialsProvider } from '@vercel/functions/oidc';
import { fromEnv } from '@aws-sdk/credential-providers';

// Route 53 Domains is only available in us-east-1.
const region = 'us-east-1';

// Use static key credentials locally when present; fall back to Vercel OIDC
// in production (VERCEL_OIDC_TOKEN is fetched dynamically per-request by the
// library, so it never appears as a static process.env var to check against).
export const makeClient = (): Route53DomainsClient =>
  new Route53DomainsClient({
    region,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? fromEnv()
      : awsCredentialsProvider({ roleArn: process.env.AWS_ROLE_ARN! }),
  });

export const isOidcConfigured = (): boolean =>
  Boolean(process.env.AWS_ROLE_ARN) || process.env.VERCEL_OIDC_TOKEN === undefined;

export const toAwsErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Unknown error from AWS';
