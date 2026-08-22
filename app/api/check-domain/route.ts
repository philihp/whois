import { NextRequest, NextResponse } from 'next/server';
import { start } from 'workflow/api';
import * as R from 'ramda';
import { parseInput } from '@/lib/domain';
import { isOidcConfigured } from '@/lib/aws';
import { encodeMessage, type MetaMessage } from '@/lib/protocol';
import { checkDomainWorkflow, scanWordWorkflow } from '@/workflows/domain-scan';

// Next.js App Router reads maxDuration from a route segment export; the
// `functions` glob in vercel.json does not reliably apply to it. Without this the
// route died at the 120s default mid-scan and truncated the stream.
export const maxDuration = 300;

type ThrottleResult =
  | { throttled: false }
  | { throttled: true; retryAfter: number };

const THROTTLE_COOKIE = 'last_check';

const getThrottleMs = (): number =>
  parseInt(process.env.THROTTLE_SECONDS ?? '5', 10) * 1000;

const checkThrottle = (req: NextRequest): ThrottleResult => {
  const throttleMs = getThrottleMs();
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

// Emits the meta line immediately, then everything the workflow writes to its
// run stream. The client gets rows as the parallel steps resolve.
//
// Uses pipeTo rather than a manual reader loop: when the client disconnects, the
// readable is cancelled, which errors the transform's writable and aborts the
// source. Cancelling a stream a reader still holds a lock on throws
// "Invalid state: ReadableStream is locked".
const ndjson = (
  meta: MetaMessage,
  workflowStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

  void (async () => {
    const writer = writable.getWriter();
    try {
      await writer.write(encodeMessage(meta));
    } finally {
      writer.releaseLock();
    }
    await workflowStream.pipeTo(writable);
  })().catch(() => {
    // Client hung up, or the run stream failed. Either way the response is
    // already torn down; nothing left to report here.
  });

  return readable;
};

export async function POST(req: NextRequest) {
  const throttle = checkThrottle(req);
  if (throttle.throttled) {
    return NextResponse.json(
      {
        error: 'Too many requests. Please wait.',
        retryAfter: throttle.retryAfter,
      },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = parseInput(R.path(['domain'], body));
  if (parsed.kind === 'error') {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  if (!isOidcConfigured()) {
    return NextResponse.json(
      { error: 'AWS_ROLE_ARN is not configured' },
      { status: 500 },
    );
  }

  const run =
    parsed.kind === 'word'
      ? await start(scanWordWorkflow, [parsed.word])
      : await start(checkDomainWorkflow, [parsed.domain]);

  const meta: MetaMessage = {
    type: 'meta',
    kind: parsed.kind === 'word' ? 'bulk' : 'single',
    throttleMs: getThrottleMs(),
  };

  const response = new NextResponse(ndjson(meta, run.readable), {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
  setThrottleCookie(response);
  return response;
}
