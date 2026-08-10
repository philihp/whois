# domain-check

Minimal Next.js app that checks domain availability and registration price using the AWS Route 53 Domains API.

## Stack

- Next.js 16 (App Router, Turbopack) + TypeScript 7
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

The front end posts `{ domain }` to `/api/check-domain`. The route handler:

1. Validates and normalizes the input (`lib/domain.ts`).
2. Calls `CheckDomainAvailabilityCommand` against Route 53 Domains (us-east-1).
3. Best-effort calls `ListPricesCommand` for the matching TLD and returns the registration price.

Pricing is only available for TLDs Amazon Registrar supports. If pricing is missing, the UI shows "price unavailable" but still shows availability.

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
- TLD matching uses longest-suffix match so `example.co.uk` correctly maps to the `co.uk` price entry, not `uk`.
- Failures in pricing are swallowed; availability still returns.
- AWS errors return HTTP 502 with `{ error, detail }`.
