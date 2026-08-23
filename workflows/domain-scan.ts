import { RetryableError, getStepMetadata, getWritable } from 'workflow';
import {
  CheckDomainAvailabilityCommand,
  ListPricesCommand,
} from '@aws-sdk/client-route-53-domains';
import * as R from 'ramda';
import { isThrottlingError, makeClient, toAwsErrorMessage } from '@/lib/aws';
import { compareByPopularity } from '@/lib/popularity';
import { pickPriceForDomain } from '@/lib/pricing';
import {
  encodeMessage,
  type Price,
  type ScanMessage,
  type TldEntry,
} from '@/lib/protocol';

type PriceEntry = {
  Name?: string;
  RegistrationPrice?: { Price?: number; Currency?: string };
};

type Sink = WritableStream<Uint8Array>;

// AWS throttles CheckDomainAvailability aggressively. Because every check is
// its own step, a throttled call only backs off itself — the rest of the fan-out
// keeps going — and the step is retried on a fresh invocation.
const MAX_AVAILABILITY_RETRIES = 8;

// How many availability checks may be in flight at once.
//
// Firing all ~400 TLDs at once does not work: Route 53 throttles the burst so
// hard that steps exhaust their retry budget and give up. A measured run of an
// unbounded fan-out returned 168 ERROR rows out of 301 — worse than useless,
// since an ERROR row is indistinguishable from "we did not check".
//
// Striping the work across a fixed number of concurrent lanes keeps the scan
// parallel (and far faster than the serial version this replaced) while staying
// inside what AWS will actually serve.
const FANOUT_LANES = 12;

const backoffMs = (attempt: number): number =>
  Math.min(2 ** attempt * 250, 20_000) + Math.floor(Math.random() * 250);

// Pure: pulls the registration price out of the AWS price entry shape.
const extractRegistrationPrice = (entry: unknown): Price => {
  const price = R.path(['RegistrationPrice'], entry) as
    | { Price?: number; Currency?: string }
    | undefined;
  if (!price || typeof price.Price !== 'number' || !price.Currency) return null;
  return { amount: price.Price, currency: price.Currency };
};

const write = async (writable: Sink, message: ScanMessage): Promise<void> => {
  const writer = writable.getWriter();
  try {
    await writer.write(encodeMessage(message));
  } finally {
    writer.releaseLock();
  }
};

/* ------------------------------- steps -------------------------------- */

// Pages the full Route 53 price list and returns one entry per TLD, sorted by
// registration popularity.
async function listTldEntries(word: string): Promise<TldEntry[]> {
  'use step';

  const client = makeClient();
  const prices: PriceEntry[] = [];
  let marker: string | undefined;
  do {
    const resp = await client.send(
      new ListPricesCommand({ Marker: marker, MaxItems: 100 }),
    );
    for (const p of resp.Prices ?? []) prices.push(p as PriceEntry);
    marker = resp.NextPageMarker;
  } while (marker);

  return prices
    .filter(
      (p): p is PriceEntry & { Name: string } =>
        typeof p.Name === 'string' && p.Name.length > 0,
    )
    .map(
      (p): TldEntry => ({
        domain: `${word}.${p.Name}`,
        tld: p.Name,
        price: extractRegistrationPrice(p),
      }),
    )
    .toSorted((a, b) => compareByPopularity(a.tld, b.tld));
}

// One availability lookup. Each invocation of this step is a separate function
// call, so the workflow's `Promise.all` runs every domain concurrently.
async function checkAvailability(domain: string, writable: Sink): Promise<void> {
  'use step';

  const { attempt } = getStepMetadata();
  let status: string;
  try {
    const client = makeClient();
    const resp = await client.send(
      new CheckDomainAvailabilityCommand({ DomainName: domain }),
    );
    status = resp.Availability ?? 'UNKNOWN';
  } catch (err) {
    // Back off and retry throttling, until the retry budget runs out. Any other
    // failure is reported as ERROR for that one row rather than failing the run.
    if (isThrottlingError(err) && attempt <= MAX_AVAILABILITY_RETRIES) {
      throw new RetryableError(`Throttled by AWS on ${domain}`, {
        retryAfter: backoffMs(attempt),
      });
    }
    status = 'ERROR';
  }

  await write(writable, { type: 'status', domain, status });
}
checkAvailability.maxRetries = MAX_AVAILABILITY_RETRIES;

// Best-effort price for a single domain: tries the longest TLD suffix first.
async function lookupPrice(domain: string): Promise<Price> {
  'use step';

  try {
    const client = makeClient();
    const labels = domain.split('.');
    const candidateTlds = R.range(1, labels.length).map((i) =>
      labels.slice(i).join('.'),
    );
    for (const tld of candidateTlds) {
      const resp = await client.send(new ListPricesCommand({ Tld: tld }));
      const match = pickPriceForDomain(domain, resp.Prices ?? []);
      const price = match ? extractRegistrationPrice(match) : null;
      if (price) return price;
    }
  } catch {
    // Pricing is optional; availability still gets reported.
  }
  return null;
}

// Availability for exactly one domain, without touching the shared stream.
async function availabilityOf(domain: string): Promise<string> {
  'use step';

  const { attempt } = getStepMetadata();
  try {
    const client = makeClient();
    const resp = await client.send(
      new CheckDomainAvailabilityCommand({ DomainName: domain }),
    );
    return resp.Availability ?? 'UNKNOWN';
  } catch (err) {
    if (isThrottlingError(err) && attempt <= MAX_AVAILABILITY_RETRIES) {
      throw new RetryableError(`Throttled by AWS on ${domain}`, {
        retryAfter: backoffMs(attempt),
      });
    }
    throw new Error(`AWS error: ${toAwsErrorMessage(err)}`, { cause: err });
  }
}
availabilityOf.maxRetries = MAX_AVAILABILITY_RETRIES;

async function emit(writable: Sink, message: ScanMessage): Promise<void> {
  'use step';
  await write(writable, message);
}

async function closeSink(writable: Sink): Promise<void> {
  'use step';
  await writable.close();
}

/* ----------------------------- workflows ------------------------------ */

// Scans every TLD Amazon sells for a bare word. The TLD list streams out
// first, then every availability check runs as its own parallel step and
// streams its row the moment it resolves.
export async function scanWordWorkflow(word: string) {
  'use workflow';

  const writable = getWritable<Uint8Array>();

  let checked = 0;
  try {
    const entries = await listTldEntries(word);
    await emit(writable, { type: 'tlds', word, entries });

    // Lane w handles entries w, w+LANES, w+2*LANES, ... Indexing by position
    // rather than draining a shared queue keeps the workflow deterministic on
    // replay, and striping the popularity-sorted list means the TLDs people
    // actually care about resolve in the first wave.
    await Promise.all(
      R.range(0, Math.min(FANOUT_LANES, entries.length)).map(async (lane) => {
        for (let i = lane; i < entries.length; i += FANOUT_LANES) {
          await checkAvailability(entries[i].domain, writable);
        }
      }),
    );
    checked = entries.length;
  } catch (err) {
    // Always tell the client something went wrong rather than leaving the
    // stream hanging open until it is closed below.
    await emit(writable, { type: 'error', error: toAwsErrorMessage(err) });
  }

  await closeSink(writable);
  return { word, checked };
}

// Single domain: availability and price are independent, so they run in
// parallel too.
export async function checkDomainWorkflow(domain: string) {
  'use workflow';

  const writable = getWritable<Uint8Array>();

  let status = 'ERROR';
  try {
    const [availability, price] = await Promise.all([
      availabilityOf(domain),
      lookupPrice(domain),
    ]);
    status = availability;
    await emit(writable, { type: 'single', domain, status, price });
  } catch (err) {
    await emit(writable, { type: 'error', error: toAwsErrorMessage(err) });
  }

  await closeSink(writable);
  return { domain, status };
}
