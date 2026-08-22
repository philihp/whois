import { Route53DomainsClient } from '@aws-sdk/client-route-53-domains';
import { fromEnv, fromWebToken } from '@aws-sdk/credential-providers';

// Route 53 Domains is only available in us-east-1.
const region = 'us-east-1';

// Use static key credentials locally when present; otherwise exchange Vercel's
// per-invocation OIDC token for the role via STS AssumeRoleWithWebIdentity.
//
// This deliberately avoids `awsCredentialsProvider` from `@vercel/functions/oidc`.
// That module's barrel pulls in `@vercel/oidc` -> `jose`, which is CommonJS; the
// Workflow bundler inlines it into an ESM bundle where `require` is undefined, so
// merely importing it crashes every step at module load. `fromWebToken` performs
// the same STS exchange with no `jose` in the graph.
export const makeClient = (): Route53DomainsClient =>
  new Route53DomainsClient({
    region,
    credentials: process.env.AWS_ACCESS_KEY_ID
      ? fromEnv()
      : fromWebToken({
          roleArn: process.env.AWS_ROLE_ARN!,
          // Read per call: each step invocation gets a fresh short-lived token.
          webIdentityToken: process.env.VERCEL_OIDC_TOKEN!,
        }),
  });

export const isOidcConfigured = (): boolean =>
  Boolean(process.env.AWS_ACCESS_KEY_ID) || Boolean(process.env.AWS_ROLE_ARN);

export const toAwsErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Unknown error from AWS';

// Route 53 Domains rejects bursts with a throttling error; those are worth
// retrying with backoff, unlike validation or auth failures.
export const isThrottlingError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  const status = (
    err as { $metadata?: { httpStatusCode?: number } }
  ).$metadata?.httpStatusCode;
  return (
    status === 429 ||
    name === 'ThrottlingException' ||
    name === 'TooManyRequestsException' ||
    name === 'RequestLimitExceeded'
  );
};
