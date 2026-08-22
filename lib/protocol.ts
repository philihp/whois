// Wire protocol shared by the streaming API route and the browser client.
//
// The route responds with NDJSON: one JSON object per line, flushed as the
// workflow produces it. Every message carries a `type` discriminator.

export type Price = { amount: number; currency: string } | null;

export type TldEntry = {
  domain: string;
  tld: string;
  price: Price;
};

// Sent once, immediately, by the route — before the workflow has produced
// anything — so the client can start its throttle timer.
export type MetaMessage = {
  type: 'meta';
  kind: 'single' | 'bulk';
  throttleMs: number;
};

// Bulk only: the full TLD list with prices, in popularity order. Availability
// for each row arrives later as `status` messages.
export type TldsMessage = {
  type: 'tlds';
  word: string;
  entries: TldEntry[];
};

// One per domain checked, emitted as each parallel step resolves.
export type StatusMessage = {
  type: 'status';
  domain: string;
  status: string;
};

// Single-domain only: availability and price for the one domain asked about.
export type SingleMessage = {
  type: 'single';
  domain: string;
  status: string;
  price: Price;
};

export type ErrorMessage = {
  type: 'error';
  error: string;
};

export type ScanMessage =
  | MetaMessage
  | TldsMessage
  | StatusMessage
  | SingleMessage
  | ErrorMessage;

const encoder = new TextEncoder();

export const encodeMessage = (message: ScanMessage): Uint8Array =>
  encoder.encode(`${JSON.stringify(message)}\n`);

// Splits a chunk of NDJSON text into whole messages plus whatever partial
// line is left over for the next chunk.
export const splitLines = (
  buffer: string,
): { lines: string[]; rest: string } => {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.trim().length > 0), rest };
};

export const parseMessage = (line: string): ScanMessage | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') return null;
    const type = (parsed as { type?: unknown }).type;
    return typeof type === 'string' ? (parsed as ScanMessage) : null;
  } catch {
    return null;
  }
};
