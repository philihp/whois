'use client';

import { useState, useEffect } from 'react';
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
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownTotal, setCooldownTotal] = useState<number>(0);
  const [progress, setProgress] = useState<number>(0);

  useEffect(() => {
    if (cooldownUntil === null) {
      setProgress(0);
      return;
    }
    let rafId: number;
    const tick = () => {
      const remaining = cooldownUntil - Date.now();
      if (remaining <= 0) {
        setProgress(0);
        setCooldownUntil(null);
        return;
      }
      setProgress((remaining / cooldownTotal) * 100);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [cooldownUntil, cooldownTotal]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/check-domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: value }),
      });
      const data: unknown = await res.json();
      if (res.status === 429 && isThrottleError(data)) {
        setError(data.error);
        setCooldownTotal(data.retryAfter);
        setCooldownUntil(Date.now() + data.retryAfter);
      } else if (!res.ok) {
        setError((data as ApiError).error ?? 'Something went wrong.');
      } else if (isCheckResult(data)) {
        setResult(data);
        setCooldownTotal(data.throttleMs);
        setCooldownUntil(Date.now() + data.throttleMs);
      } else {
        setError('Unexpected response.');
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const isCoolingDown = cooldownUntil !== null && Date.now() < cooldownUntil;
  const isDisabled = loading || isCoolingDown || value.trim().length === 0;

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
              disabled={isDisabled}
              style={{
                padding: '0 1.5rem',
                background: 'var(--ink)',
                color: 'var(--bg)',
                border: 'none',
                fontSize: '0.875rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                opacity: isDisabled ? 0.5 : 1,
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                transition: 'opacity 120ms',
              }}
            >
              {loading ? '…' : isCoolingDown ? 'wait' : 'check'}
            </button>
          </div>
        </form>

        {isCoolingDown && (
          <div className="throttle-bar-track">
            <div className="throttle-bar-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

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
