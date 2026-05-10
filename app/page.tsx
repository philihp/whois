'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import * as R from 'ramda';

type CheckResult = {
  domain: string;
  status: string;
  price: { amount: number; currency: string } | null;
  throttleMs: number;
};

type ApiError = { error: string; detail?: string };

type ThrottleErrorBody = { error: string; retryAfter: number };

const isCheckResult = (v: unknown): v is CheckResult =>
  R.has('status', v as object) &&
  R.has('domain', v as object) &&
  R.has('throttleMs', v as object);

const isThrottleError = (v: unknown): v is ThrottleErrorBody =>
  R.has('retryAfter', v as object);

const formatPrice = (p: CheckResult['price']): string =>
  p ? `${p.amount.toFixed(2)} ${p.currency}` : 'price unavailable';

const statusLabel = (status: string): { text: string; tone: string } => {
  const map: Record<string, { text: string; tone: string }> = {
    AVAILABLE: { text: 'available', tone: 'available' },
    AVAILABLE_RESERVED: { text: 'reserved', tone: 'warn' },
    AVAILABLE_PREORDER: { text: 'preorder only', tone: 'warn' },
    UNAVAILABLE: { text: 'taken', tone: 'taken' },
    UNAVAILABLE_PREMIUM: { text: 'premium / unavailable', tone: 'taken' },
    UNAVAILABLE_RESTRICTED: { text: 'restricted', tone: 'taken' },
    RESERVED: { text: 'reserved', tone: 'warn' },
    DONT_KNOW: { text: 'unknown — try again', tone: 'warn' },
    INVALID_NAME_FOR_TLD: { text: 'invalid for this TLD', tone: 'taken' },
  };
  return map[status] ?? { text: status.toLowerCase(), tone: 'warn' };
};

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
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        const res = await fetch('/api/check-domain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });
        const data: unknown = await res.json();
        if (res.status === 429 && isThrottleError(data)) {
          startThrottle(data.retryAfter);
        } else if (!res.ok) {
          setError((data as ApiError).error ?? 'Something went wrong.');
        } else if (isCheckResult(data)) {
          setResult(data);
          startThrottle(data.throttleMs);
        } else {
          setError('Unexpected response.');
        }
      } catch {
        setError('Network error. Try again.');
      } finally {
        setLoading(false);
      }
    },
    [startThrottle],
  );

  // URL is the source of truth: react to changes (initial load, back/forward).
  useEffect(() => {
    setValue(domainParam);
    if (!domainParam) {
      setResult(null);
      setError(null);
      lastFetchedRef.current = null;
      return;
    }
    if (lastFetchedRef.current === domainParam) return;
    lastFetchedRef.current = domainParam;
    runQuery(domainParam);
  }, [domainParam, runQuery]);

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
              placeholder="example.com"
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
        </form>

        <div style={{ minHeight: 120, marginTop: '2rem' }}>
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
          {result && <ResultBlock result={result} />}
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

function ResultBlock({ result }: { result: CheckResult }) {
  const label = statusLabel(result.status);
  const toneColor =
    label.tone === 'available'
      ? 'var(--accent)'
      : label.tone === 'taken'
      ? 'var(--error)'
      : 'var(--warn)';

  return (
    <div
      style={{
        animation: 'fadeIn 200ms ease-out',
      }}
    >
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
