import { Route53DomainsClient } from '@aws-sdk/client-route-53-domains';
import { fromEnv, fromWebToken } from '@aws-sdk/credential-providers';

// Route 53 Domains is only available in us-east-1.
const region = 'us-east-1';

// Vercel exposes the per-invocation OIDC token on the request context, not as a
// plain env var — `process.env.VERCEL_OIDC_TOKEN` is only populated by `vercel dev`.
// This is the same lookup `@vercel/functions/oidc` performs, inlined to keep that
// package out of the workflow bundle (see the note on makeClient below).
const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');

type RequestContext = { headers?: Record<string, string | undefined> };

const readOidcToken = (): string => {
  const store = (
    globalThis as Record<symbol, { get?: () => RequestContext } | undefined>
  )[SYMBOL_FOR_REQ_CONTEXT];
  const token =
    store?.get?.()?.headers?.['x-vercel-oidc-token'] ??
    process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    throw new Error(
      'No Vercel OIDC token on the request. Is OIDC enabled for this project?',
    );
  }
  return token;
};

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
      : // Resolved lazily so the token is read while the request context is live.
        async () =>
          fromWebToken({
            roleArn: process.env.AWS_ROLE_ARN!,
            webIdentityToken: readOidcToken(),
          })(),
  });

export const isOidcConfigured = (): boolean =>
  Boolean(process.env.AWS_ACCESS_KEY_ID) || Boolean(process.env.AWS_ROLE_ARN);

// Errors thrown inside a step are serialized and rehydrated before the workflow
// sees them, so they are usually plain objects rather than Error instances.
// Checking only `instanceof Error` collapsed every one of them to "Unknown error"
// and hid the real cause.
export const toAwsErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return typeof err === 'string' && err.length > 0
    ? err
    : 'Unknown error from AWS';
};

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
