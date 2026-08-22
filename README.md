# domain-check

Minimal Next.js app that checks domain availability and registration price using the AWS Route 53 Domains API.

## Stack

- Next.js 16 (App Router, Turbopack) + TypeScript 7
- [Vercel Workflows](https://vercel.com/docs/workflows) (`workflow`) for the parallel fan-out
- AWS SDK v3 (`@aws-sdk/client-route-53-domains`)
- Ramda for the pure helpers
- Vitest for tests
- oxlint for linting
- GitHub Actions for CI (lint · typecheck · test · build)
- Vercel for hosting + deploy

## Local development

```bash
npm install
cp .env.example .env.local   # fill in your AWS keys
npm run dev
```

Open http://localhost:3000.

## How it works

The front end posts `{ domain }` to `/api/check-domain`. The route validates and
normalizes the input (`lib/domain.ts`), starts a Vercel Workflow, and streams the
workflow's output back to the browser as NDJSON — one JSON message per line
(`lib/protocol.ts`), flushed as soon as it is produced.

Two workflows live in `workflows/domain-scan.ts`:

- **`checkDomainWorkflow(domain)`** — a full domain. Availability
  (`CheckDomainAvailability`) and pricing (`ListPrices`) are independent, so they
  run as two parallel steps.
- **`scanWordWorkflow(word)`** — a bare word. One step pages the whole Route 53
  price list and streams the TLD table (sorted by popularity) so the UI can paint
  every row immediately. Then **every TLD is checked in parallel** — one
  `"use step"` per domain, all launched from a single `Promise.all`. Each step
  writes its `{ domain, status }` row to the run's stream the moment it resolves,
  so rows fill in as they land rather than in list order.

Because each check is its own step, AWS throttling is handled per-domain instead
of stalling the whole scan: a throttled call throws a `RetryableError` with
exponential backoff and is retried on a fresh invocation, while the rest of the
fan-out keeps going. Any other failure marks that single row `ERROR`.

Pricing is only available for TLDs Amazon Registrar supports. If pricing is
missing, the UI shows "price unavailable" but still shows availability.

### Streaming protocol

| message | when |
| --- | --- |
| `{ type: "meta", kind, throttleMs }` | first line, sent by the route |
| `{ type: "tlds", word, entries }` | bulk scan: the TLD table with prices |
| `{ type: "status", domain, status }` | one per parallel availability check |
| `{ type: "single", domain, status, price }` | single-domain lookup result |
| `{ type: "error", error }` | the run failed; the stream then closes |

Aborting the request client-side (navigating away, hiding the tab, or starting a
new query) cancels the response; `vercel.json` sets `supportsCancellation` on the
route so Vercel tears the invocation down instead of billing it to the max
duration.

### Inspecting runs

```bash
npx workflow web       # observability web UI
npx workflow inspect runs
```

## Setup checklist

### 1. Push to GitHub

```bash
cd domain-check
git init
git add .
git commit -m "initial"
gh repo create domain-check --private --source=. --push
# or create the repo on github.com and:
# git remote add origin git@github.com:<you>/domain-check.git
# git push -u origin main
```

### 2. Create AWS IAM credentials

Create an IAM user with **only** these permissions (least-privilege):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "route53domains:CheckDomainAvailability",
        "route53domains:ListPrices"
      ],
      "Resource": "*"
    }
  ]
}
```

Generate an access key for the user. You'll paste these into Vercel.

### 3. Connect to Vercel

1. Go to https://vercel.com/new and import the GitHub repo.
2. Framework preset: **Next.js** (auto-detected).
3. Under **Environment Variables**, add:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION` = `us-east-1`
4. Deploy. Vercel will redeploy automatically on every push to `main`.

> Route 53 Domains is a us-east-1-only service. The region must be `us-east-1` even if your other infrastructure is elsewhere.

### 4. CI

The included `.github/workflows/ci.yml` runs lint, typecheck, tests, and a build on every push and PR. It does **not** deploy — Vercel's own GitHub integration handles that.

## Notes

- `validate` strips protocols, paths, and `www.`, then checks against an RFC-flavored regex.
- `next.config.ts` is wrapped in `withWorkflow()`, which is what enables the `"use workflow"` and `"use step"` directives.
- A bulk scan runs one function invocation per TLD. That is the cost of true parallelism — expect a few hundred short invocations per scan.
- TLD matching uses longest-suffix match so `example.co.uk` correctly maps to the `co.uk` price entry, not `uk`.
- Failures in pricing are swallowed; availability still returns.
- AWS errors return HTTP 502 with `{ error, detail }`.
