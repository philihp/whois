'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as R from 'ramda';
import type { Price, ScanMessage, TldEntry } from '@/lib/protocol';
import { parseMessage, splitLines } from '@/lib/protocol';

type SingleResult = {
  kind: 'single';
  domain: string;
  status: string;
  price: Price;
};

type BulkEntry = TldEntry & {
  status: string; // 'PENDING' until the parallel workflow step resolves
};

type BulkResult = {
  kind: 'bulk';
  word: string;
  results: BulkEntry[];
};

type CheckResult = SingleResult | BulkResult;

type ApiError = { error: string; detail?: string };

type ThrottleErrorBody = { error: string; retryAfter: number };

const isThrottleError = (v: unknown): v is ThrottleErrorBody =>
  R.has('retryAfter', v as object);

const formatPrice = (p: Price): string =>
  p ? `${p.amount.toFixed(2)} ${p.currency}` : 'price unavailable';

type Tone = 'available' | 'taken' | 'warn' | 'pending';

const statusLabel = (status: string): { text: string; tone: Tone } => {
  const map: Record<string, { text: string; tone: Tone }> = {
    PENDING: { text: 'checking…', tone: 'pending' },
    AVAILABLE: { text: 'available', tone: 'available' },
    AVAILABLE_RESERVED: { text: 'reserved', tone: 'warn' },
    AVAILABLE_PREORDER: { text: 'preorder only', tone: 'warn' },
    UNAVAILABLE: { text: 'taken', tone: 'taken' },
    UNAVAILABLE_PREMIUM: { text: 'premium / unavailable', tone: 'taken' },
    UNAVAILABLE_RESTRICTED: { text: 'restricted', tone: 'taken' },
    RESERVED: { text: 'reserved', tone: 'warn' },
    DONT_KNOW: { text: 'unknown — try again', tone: 'warn' },
    INVALID_NAME_FOR_TLD: { text: 'invalid for this TLD', tone: 'taken' },
    ERROR: { text: 'lookup failed', tone: 'warn' },
  };
  return map[status] ?? { text: status.toLowerCase(), tone: 'warn' };
};

const toneToColor = (tone: Tone): string => {
  switch (tone) {
    case 'available':
      return 'var(--accent)';
    case 'taken':
      return 'var(--error)';
    case 'warn':
      return 'var(--warn)';
    case 'pending':
      return 'var(--muted)';
  }
};

const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const domainParam = searchParams.get('domain') ?? '';

  const [value, setValue] = useState(domainParam);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [throttleProgress, setThrottleProgress] = useState(0);
  const [throttleEndsAt, setThrottleEndsAt] = useState<number | null>(null);
  const [throttleTotalMs, setThrottleTotalMs] = useState(0);
  const rafRef = useRef<number>(0);
  const lastFetchedRef = useRef<string | null>(null);
  // Single controller for the whole query lifecycle. Aborting it drops the
  // NDJSON stream, which cancels the route and stops the scan server-side.
  const queryAbortRef = useRef<AbortController | null>(null);

  const isThrottled = throttleEndsAt !== null;

  useEffect(() => {
    if (!throttleEndsAt) return;
    const tick = () => {
      const remaining = throttleEndsAt - Date.now();
      if (remaining <= 0) {
        setThrottleProgress(1);
        setThrottleEndsAt(null);
        return;
      }
      setThrottleProgress(1 - remaining / throttleTotalMs);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [throttleEndsAt, throttleTotalMs]);

  const startThrottle = useCallback((ms: number) => {
    setThrottleTotalMs(ms);
    setThrottleEndsAt(Date.now() + ms);
    setThrottleProgress(0);
  }, []);

  const runQuery = useCallback(
    async (domain: string) => {
      queryAbortRef.current?.abort();
      const ac = new AbortController();
      queryAbortRef.current = ac;
      setLoading(true);
      setError(null);
      setResult(null);

      // Rows arrive one message at a time, out of order, as each parallel
      // workflow step resolves. Fold each message into the current result.
      const apply = (msg: ScanMessage) => {
        switch (msg.type) {
          case 'meta':
            startThrottle(msg.throttleMs);
            break;
          case 'tlds':
            setResult({
              kind: 'bulk',
              word: msg.word,
              results: msg.entries.map((e) => ({ ...e, status: 'PENDING' })),
            });
            break;
          case 'status':
            setResult((prev) =>
              prev && prev.kind === 'bulk'
                ? {
                    ...prev,
                    results: prev.results.map((r) =>
                      r.domain === msg.domain ? { ...r, status: msg.status } : r,
                    ),
                  }
                : prev,
            );
            break;
          case 'single':
            setResult({
              kind: 'single',
              domain: msg.domain,
              status: msg.status,
              price: msg.price,
            });
            break;
          case 'error':
            setError(msg.error);
            break;
        }
      };

      try {
        const res = await fetch('/api/check-domain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;

        // Errors (throttle, validation, config) still come back as plain JSON.
        if (!res.ok) {
          const data: unknown = await res.json().catch(() => null);
          if (res.status === 429 && isThrottleError(data)) {
            startThrottle(data.retryAfter);
          } else {
            setError((data as ApiError | null)?.error ?? 'Something went wrong.');
          }
          return;
        }

        if (!res.body) {
          setError('Unexpected response.');
          return;
        }

        // The first message lands quickly; keep the spinner only until then.
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          buffer += chunk;
          const { lines, rest } = splitLines(buffer);
          buffer = rest;
          for (const line of lines) {
            const msg = parseMessage(line);
            if (msg) apply(msg);
          }
          setLoading(false);
        }
        const trailing = parseMessage(buffer.trim());
        if (trailing) apply(trailing);
      } catch (err) {
        if (isAbortError(err)) return;
        setError('Network error. Try again.');
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    },
    [startThrottle],
  );

  // URL is the source of truth: react to changes (initial load, back/forward).
  useEffect(() => {
    setValue(domainParam);
    if (!domainParam) {
      queryAbortRef.current?.abort();
      setResult(null);
      setError(null);
      lastFetchedRef.current = null;
      return;
    }
    if (lastFetchedRef.current === domainParam) return;
    lastFetchedRef.current = domainParam;
    runQuery(domainParam);
  }, [domainParam, runQuery]);

  // Stop running queries when the user navigates away: route change /
  // unmount via cleanup, and tab hidden / pagehide via these listeners.
  useEffect(() => {
    const stop = () => queryAbortRef.current?.abort();
    const onVisibility = () => {
      if (document.hidden) stop();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', stop);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, []);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed === domainParam) {
      lastFetchedRef.current = trimmed;
      runQuery(trimmed);
      return;
    }
    router.push(`/?domain=${encodeURIComponent(trimmed)}`);
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem 1.5rem',
      }}
    >
      <div style={{ width: '100%', maxWidth: 540 }}>
        <h1
          style={{
            fontFamily: "'Fraunces', serif",
            fontSize: 'clamp(2.5rem, 8vw, 4rem)',
            fontWeight: 600,
            letterSpacing: '-0.02em',
            marginBottom: '0.25rem',
            lineHeight: 1,
          }}
        >
          domain<span style={{ color: 'var(--muted)' }}>·</span>check
        </h1>
        <p
          style={{
            color: 'var(--muted)',
            fontSize: '0.8125rem',
            textTransform: 'uppercase',
            letterSpacing: '0.15em',
            marginBottom: '2.5rem',
          }}
        >
          via aws route 53
        </p>

        <form onSubmit={onSubmit}>
          <div
            style={{
              display: 'flex',
              border: '1.5px solid var(--line)',
              background: '#fff',
              borderRadius: 2,
            }}
          >
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="example.com  or  example"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              style={{
                flex: 1,
                padding: '0.875rem 1rem',
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontSize: '1rem',
              }}
            />
            <button
              type="submit"
              disabled={loading || isThrottled || value.trim().length === 0}
              style={{
                padding: '0 1.5rem',
                background: isThrottled
                  ? `linear-gradient(to right, var(--ink) ${Math.round(throttleProgress * 100)}%, rgba(26,26,26,0.3) ${Math.round(throttleProgress * 100)}%)`
                  : 'var(--ink)',
                color: 'var(--bg)',
                border: 'none',
                fontSize: '0.875rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                opacity: loading || (!isThrottled && value.trim().length === 0) ? 0.5 : 1,
                transition: isThrottled ? 'none' : 'opacity 120ms',
                cursor: isThrottled ? 'default' : undefined,
              }}
            >
              {loading || isThrottled ? '…' : 'check'}
            </button>
          </div>
          <p
            style={{
              marginTop: '0.5rem',
              color: 'var(--muted)',
              fontSize: '0.75rem',
              letterSpacing: '0.05em',
            }}
          >
            tip: enter a word without a dot to scan every TLD amazon offers.
          </p>
        </form>

        <div style={{ minHeight: 120, marginTop: '2rem' }}>
          {loading && (
            <div style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>
              checking…
            </div>
          )}
          {error && (
            <div
              style={{
                color: 'var(--error)',
                fontSize: '0.875rem',
                borderLeft: '2px solid var(--error)',
                paddingLeft: '0.75rem',
              }}
            >
              {error}
            </div>
          )}
          {result && result.kind === 'single' && <SingleBlock result={result} />}
          {result && result.kind === 'bulk' && <BulkBlock result={result} />}
        </div>

        <footer
          style={{
            marginTop: '4rem',
            paddingTop: '1.5rem',
            borderTop: '1px solid rgba(0,0,0,0.1)',
            fontSize: '0.75rem',
            color: 'var(--muted)',
            letterSpacing: '0.05em',
          }}
        >
          prices are aws registration prices, exclusive of taxes & privacy.
        </footer>
      </div>
    </main>
  );
}

function SingleBlock({ result }: { result: SingleResult }) {
  const label = statusLabel(result.status);
  const toneColor = toneToColor(label.tone);

  return (
    <div style={{ animation: 'fadeIn 200ms ease-out' }}>
      <div
        style={{
          fontFamily: "'Fraunces', serif",
          fontSize: '1.5rem',
          marginBottom: '0.5rem',
          wordBreak: 'break-all',
        }}
      >
        {result.domain}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            color: toneColor,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontSize: '0.875rem',
            fontWeight: 700,
          }}
        >
          {label.text}
        </span>
        <span style={{ color: 'var(--muted)' }}>—</span>
        <span style={{ fontSize: '0.875rem' }}>{formatPrice(result.price)}</span>
      </div>
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}

function BulkBlock({ result }: { result: BulkResult }) {
  // Server returns results in popularity order — render as given.
  const entries = result.results;
  const total = entries.length;
  const pending = entries.filter((r) => r.status === 'PENDING').length;
  const checked = total - pending;
  const availableCount = entries.filter((r) => r.status === 'AVAILABLE').length;

  return (
    <div style={{ animation: 'fadeIn 200ms ease-out' }}>
      <div
        style={{
          fontFamily: "'Fraunces', serif",
          fontSize: '1.5rem',
          marginBottom: '0.25rem',
          wordBreak: 'break-all',
        }}
      >
        {result.word}
      </div>
      <div
        style={{
          color: 'var(--muted)',
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: '1rem',
        }}
      >
        {availableCount} available · {checked} of {total} checked
      </div>
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          borderTop: '1px solid rgba(0,0,0,0.1)',
        }}
      >
        {entries.map((entry) => {
          const label = statusLabel(entry.status);
          const toneColor = toneToColor(label.tone);
          return (
            <li
              key={entry.tld}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto',
                alignItems: 'baseline',
                gap: '0.75rem',
                padding: '0.5rem 0',
                borderBottom: '1px solid rgba(0,0,0,0.06)',
                fontSize: '0.875rem',
                opacity: entry.status === 'PENDING' ? 0.55 : 1,
                transition: 'opacity 200ms',
              }}
            >
              <span style={{ wordBreak: 'break-all' }}>{entry.domain}</span>
              <span
                style={{
                  color: toneColor,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                }}
              >
                {label.text}
              </span>
              <span style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>
                {formatPrice(entry.price)}
              </span>
            </li>
          );
        })}
      </ul>
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
