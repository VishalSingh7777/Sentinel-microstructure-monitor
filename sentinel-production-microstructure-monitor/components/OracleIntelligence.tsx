import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MarketSnapshot, SignalType } from '../types';

// ═══════════════════════════════════════════════════════════════════════════
// ORACLE INTELLIGENCE — Sentinel AI Forensic Layer
// ─────────────────────────────────────────────────────────────────────────
// Usage in App.tsx (Causality Engine header):
//   import { OracleTriggerButton } from './components/OracleIntelligence';
//   <OracleTriggerButton snapshot={activeCausal?.active ? currentSnapshot : null}
//                        stressScore={activeStress?.score ?? 0} />
//
// Where currentSnapshot is the latest MarketSnapshot from enrichAndLog.
// See App.tsx modification comments below.
//
// API KEY: Add to .env.local → VITE_ANTHROPIC_API_KEY=sk-ant-...
// ⚠ .env.local is in .gitignore — never commit it.
// ═══════════════════════════════════════════════════════════════════════════

const API_KEY      = import.meta.env.VITE_ANTHROPIC_API_KEY as string;
const MODEL        = 'claude-haiku-4-5-20251001';
const RATE_LIMIT_MS = 13_000; // 5 calls/min — 1 per 13s with buffer

// ── Oracle response shape ─────────────────────────────────────────────────
interface OracleChainStep {
  label:  string;  // SHORT UPPERCASE — e.g. "DEPTH FLOOR HIT"
  detail: string;  // One precise metric — e.g. "42.3 BTC vs 200 BTC normal"
  role:   'CATALYST' | 'AMPLIFIER' | 'SYSTEMIC'; // matches Sentinel's CausalStep types
}

interface OracleWatch {
  signal:    string;
  condition: string;  // "If X crosses Y without Z recovering"
  outcome:   string;  // "what structurally happens next"
}

interface OracleIntelligence {
  verdict:      string;            // one sentence — the single most critical insight
  causal_chain: OracleChainStep[]; // always exactly 3 steps
  watch:        OracleWatch;       // the one thing to monitor
}

// ── Prompt — uses Sentinel's exact field names ─────────────────────────────
function buildPrompt(snap: MarketSnapshot): string {
  const { stress, causal, trace, tick } = snap;

  const whaleVol = (tick.trades.large_trades || [])
    .reduce((s, t) => s + (t.quantity || 0), 0).toFixed(1);

  const dom = [...(trace.weight_contributions || [])]
    .sort((a, b) => b.contribution - a.contribution)[0];

  // Map Sentinel's SignalType enum → short name for the prompt
  const sigShort = (sig: string) => {
    if (sig.includes('Liquidity'))  return 'LIQUIDITY';
    if (sig.includes('Flow'))       return 'FLOW';
    if (sig.includes('Volatility')) return 'VOLATILITY';
    if (sig.includes('Forced'))     return 'FORCED SELLING';
    return sig.toUpperCase();
  };

  const seqStr = (causal.steps || [])
    .map(s => `${s.type}(${sigShort(s.signal)}, ${s.signal_intensity}/100)`)
    .join(' → ');

  return `You are ORACLE, the forensic AI layer of Sentinel — a professional BTC/USDT market microstructure monitor used by institutional traders.

A critical stress breach just fired. Analyze the precise market state and return structured intelligence.

BREACH DATA:
Pattern: ${causal.pattern_label || 'UNCLASSIFIED'}
Stress Score: ${stress.score}/100 (${stress.level}) — raw ${trace.raw_score.toFixed(1)} × ${trace.shock_multiplier}× shock = ${trace.pre_smooth_score.toFixed(1)} pre-smooth → EMA → ${stress.final_score}
Stress Velocity: +${(causal.stress_velocity || 0).toFixed(1)} pts/s
Signals Active: ${stress.signals_aligned}/4 vectors triggered
Causal Sequence: ${seqStr}
Dominant Driver: ${sigShort(dom?.signal || '')} (${dom?.pct_of_total?.toFixed(0) || 0}% of total stress)

SIGNAL READINGS:
- Liquidity Fragility: ${stress.breakdown.liquidity || 0}/100 (${(stress.breakdown.liquidity || 0) > 65 ? 'TRIGGERED' : 'normal'})
- Order Flow Imbalance: ${stress.breakdown.flow || 0}/100 (${(stress.breakdown.flow || 0) > 65 ? 'TRIGGERED' : 'normal'})
- Volatility Regime Shift: ${stress.breakdown.volatility || 0}/100
- Forced Selling: ${stress.breakdown.forcedSelling || 0}/100

MARKET MICROSTRUCTURE:
- Mark Price: $${tick.price.toLocaleString()}
- Book Depth: ${tick.total_depth.toFixed(1)} BTC total (${((tick.total_depth / 200) * 100).toFixed(0)}% of normal ~200 BTC)
- Spread: ${tick.spread_bps.toFixed(1)} bps
- Whale Blocks: ${whaleVol} BTC across ${tick.trades.large_trades.length} institutional-size trades
- Sell Volume: ${tick.trades.sell_volume.toFixed(1)} BTC vs Buy Volume: ${tick.trades.buy_volume.toFixed(1)} BTC

Return ONLY valid JSON with no markdown fences, no explanation:
{
  "verdict": "One punchy sentence — the single most critical structural insight for a trader right now. Be specific, use the actual numbers.",
  "causal_chain": [
    {"label": "MAX 4 UPPERCASE WORDS", "detail": "One precise metric or data point from the breach", "role": "CATALYST"},
    {"label": "MAX 4 UPPERCASE WORDS", "detail": "One precise metric or data point", "role": "AMPLIFIER"},
    {"label": "MAX 4 UPPERCASE WORDS", "detail": "One precise metric or data point", "role": "SYSTEMIC"}
  ],
  "watch": {
    "signal": "Name of the exact signal to monitor next",
    "condition": "If [signal metric] crosses [specific threshold] without [specific recovery]",
    "outcome": "The structural consequence in one precise phrase"
  }
}

Use roles exactly: CATALYST (what triggered first), AMPLIFIER (what made it worse), SYSTEMIC (the market-wide consequence).`;
}

// ── API call with AbortController support ─────────────────────────────────
async function fetchOracle(
  snapshot: MarketSnapshot,
  abortSignal: AbortSignal
): Promise<OracleIntelligence> {
  // ── Key guard ────────────────────────────────────────────────────────────
  const key = API_KEY;
  if (!key || key === 'undefined' || key.length < 20) {
    const msg = `[Oracle] API key missing. Make sure .env.local exists in your project folder with: VITE_ANTHROPIC_API_KEY=sk-ant-...`;
    console.error(msg);
    throw new Error('API key not found — check .env.local and restart npm run dev');
  }

  console.log('[Oracle] Sending request to Claude Haiku...');

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      signal: abortSignal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        messages: [{ role: 'user', content: buildPrompt(snapshot) }]
      })
    });
  } catch (netErr: any) {
    // Network failure (CORS preflight blocked, no internet, etc.)
    const msg = netErr?.message || String(netErr);
    console.error('[Oracle] Network error:', msg);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      throw new Error('CORS or network error — make sure anthropic-dangerous-direct-browser-access header is accepted');
    }
    throw new Error(`Network error: ${msg}`);
  }

  // ── Read raw body regardless of status ──────────────────────────────────
  const rawBody = await res.text();
  console.log('[Oracle] HTTP status:', res.status);
  console.log('[Oracle] Raw response:', rawBody.slice(0, 400));

  if (!res.ok) {
    let apiMsg = `HTTP ${res.status}`;
    try {
      const errJson = JSON.parse(rawBody);
      apiMsg = errJson?.error?.message || errJson?.error?.type || apiMsg;
    } catch (_) {}
    const fullMsg = `${res.status} — ${apiMsg}`;
    console.error('[Oracle] API error:', fullMsg);
    throw new Error(fullMsg);
  }

  // ── Parse success response ───────────────────────────────────────────────
  let data: any;
  try { data = JSON.parse(rawBody); }
  catch (_) { throw new Error('API returned non-JSON success response'); }

  const raw   = (data.content || []).map((b: any) => b.text || '').join('').trim();
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  console.log('[Oracle] Model output:', clean.slice(0, 300));

  let parsed: OracleIntelligence;
  try { parsed = JSON.parse(clean); }
  catch (_) {
    console.error('[Oracle] JSON parse failed. Raw:', clean);
    throw new Error('Claude returned malformed JSON — retry');
  }

  if (!parsed.verdict || !Array.isArray(parsed.causal_chain) || !parsed.watch) {
    console.error('[Oracle] Missing required fields in:', parsed);
    throw new Error('Response missing verdict / causal_chain / watch fields');
  }

  const validRoles = new Set<string>(['CATALYST', 'AMPLIFIER', 'SYSTEMIC']);
  parsed.causal_chain = parsed.causal_chain.slice(0, 3).map(step => ({
    label:  (step.label  || 'UNKNOWN').slice(0, 40).toUpperCase(),
    detail: (step.detail || '').slice(0, 120),
    role:   (validRoles.has(step.role) ? step.role : 'AMPLIFIER') as OracleChainStep['role'],
  }));
  parsed.verdict = parsed.verdict.slice(0, 300);

  console.log('[Oracle] Success — verdict:', parsed.verdict.slice(0, 80));
  return parsed;
}

// ── Role visual config — matches Sentinel's type colors ───────────────────
const ROLE_CFG: Record<string, { color: string; bg: string; border: string }> = {
  CATALYST:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.09)',  border: 'rgba(245,158,11,0.28)'  },
  AMPLIFIER: { color: '#6b7280', bg: 'rgba(107,114,128,0.08)', border: 'rgba(107,114,128,0.25)' },
  SYSTEMIC:  { color: '#ef4444', bg: 'rgba(239,68,68,0.09)',   border: 'rgba(239,68,68,0.28)'   },
};

// ── Typewriter hook ────────────────────────────────────────────────────────
function useTypewriter(text: string, run: boolean, speed = 18) {
  const [out,  setOut]  = useState('');
  const [done, setDone] = useState(false);
  const idxRef = useRef(0);
  const ivRef  = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (ivRef.current) { clearInterval(ivRef.current); ivRef.current = null; }
    idxRef.current = 0;
    setOut('');
    setDone(false);
    if (!run || !text) return;

    ivRef.current = setInterval(() => {
      idxRef.current++;
      setOut(text.slice(0, idxRef.current));
      if (idxRef.current >= text.length) {
        clearInterval(ivRef.current!);
        ivRef.current = null;
        setDone(true);
      }
    }, speed);

    return () => { if (ivRef.current) { clearInterval(ivRef.current); ivRef.current = null; } };
  }, [text, run, speed]);

  return { out, done };
}

// ═══════════════════════════════════════════════════════════════════════════
// ORACLE DRAWER — slides in from right over Sentinel UI
// ═══════════════════════════════════════════════════════════════════════════
interface OracleDrawerProps {
  snapshot: MarketSnapshot | null;
  open:     boolean;
  onClose:  () => void;
}

export function OracleDrawer({ snapshot, open, onClose }: OracleDrawerProps) {
  type Phase = 'idle' | 'loading' | 'done' | 'error';
  const [phase,        setPhase]        = useState<Phase>('idle');
  const [intel,        setIntel]        = useState<OracleIntelligence | null>(null);
  const [latencyMs,    setLatencyMs]    = useState<number | null>(null);
  const [errMsg,       setErrMsg]       = useState('');
  const [chainVisible, setChainVisible] = useState<number[]>([]);
  const [watchVisible, setWatchVisible] = useState(false);

  const timeoutRefs = useRef<ReturnType<typeof setTimeout>[]>([]);
  const abortRef    = useRef<AbortController | null>(null);

  const verdict = useTypewriter(intel?.verdict || '', phase === 'done', 20);

  // Reveal chain + watch sequentially after verdict types out
  useEffect(() => {
    if (!verdict.done || !intel?.causal_chain?.length) return;
    timeoutRefs.current.forEach(clearTimeout);
    timeoutRefs.current = [];

    intel.causal_chain.forEach((_, i) => {
      const t = setTimeout(
        () => setChainVisible(prev => prev.includes(i) ? prev : [...prev, i]),
        i * 380 + 180
      );
      timeoutRefs.current.push(t);
    });
    const tw = setTimeout(
      () => setWatchVisible(true),
      intel.causal_chain.length * 380 + 520
    );
    timeoutRefs.current.push(tw);
    return () => { timeoutRefs.current.forEach(clearTimeout); };
  }, [verdict.done, intel]);

  // Fetch on open, abort + reset on close
  useEffect(() => {
    if (!open) {
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      timeoutRefs.current.forEach(clearTimeout);
      const t = setTimeout(() => {
        setPhase('idle'); setIntel(null); setLatencyMs(null);
        setErrMsg(''); setChainVisible([]); setWatchVisible(false);
      }, 420);
      return () => clearTimeout(t);
    }
    if (!snapshot) return;

    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    const t0 = Date.now();
    setPhase('loading');
    setIntel(null); setChainVisible([]); setWatchVisible(false); setErrMsg('');

    fetchOracle(snapshot, abortRef.current.signal)
      .then(data  => { setIntel(data); setLatencyMs(Date.now() - t0); setPhase('done'); })
      .catch(err  => {
        if ((err as Error).name === 'AbortError') return;
        setErrMsg((err as Error).message || 'Unknown error');
        setPhase('error');
      });

    return () => { if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; } };
  }, [open, snapshot]);

  const stress     = snapshot?.stress;
  const causal     = snapshot?.causal;
  const tick       = snapshot?.tick;
  const levelColor = (stress?.score ?? 0) >= 80 ? '#ef4444'
                   : (stress?.score ?? 0) >= 60 ? '#f97316' : '#eab308';

  return (
    <>
      {/* ── Backdrop ── */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
          opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.35s ease',
        }}
      />

      {/* ── Drawer ── */}
      <div style={{
        position: 'fixed', top: 0, right: 0, bottom: 0,
        width: 'min(500px, 44vw)', zIndex: 51,
        background: 'linear-gradient(160deg,#0c0a14 0%,#0a0810 60%,#0d0b18 100%)',
        borderLeft: '1px solid rgba(139,92,246,0.22)',
        boxShadow: '-24px 0 80px rgba(0,0,0,0.7),-2px 0 20px rgba(109,40,217,0.06)',
        transform: open ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 0.42s cubic-bezier(0.16,1,0.3,1)',
        display: 'flex', flexDirection: 'column',
        fontFamily: "'JetBrains Mono','Fira Code',monospace",
        overflow: 'hidden',
      }}>
        {/* keyframes injected once */}
        <style>{`
          @keyframes orc-fadein{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
          @keyframes orc-pulse{0%,100%{opacity:1}50%{opacity:0.4}}
          @keyframes orc-spin{to{transform:rotate(360deg)}}
          @keyframes orc-blink{0%,100%{opacity:1}50%{opacity:0}}
          .orc-enter{animation:orc-fadein 0.42s cubic-bezier(0.2,0.8,0.2,1) forwards}
          .orc-cursor{animation:orc-blink 0.9s step-end infinite;display:inline-block}
          .orc-scroll::-webkit-scrollbar{width:3px}
          .orc-scroll::-webkit-scrollbar-track{background:transparent}
          .orc-scroll::-webkit-scrollbar-thumb{background:#1f2937;border-radius:2px}
        `}</style>

        {/* ── Header ── */}
        <div style={{
          padding: '0 18px', height: 46, flexShrink: 0,
          background: 'rgba(109,40,217,0.07)',
          borderBottom: '1px solid rgba(109,40,217,0.18)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <OracleOrb phase={phase} />
            <div>
              <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.32em', color: '#a78bfa' }}>ORACLE</div>
              <div style={{ fontSize: 7, color: '#3b2760', letterSpacing: '0.18em', marginTop: 1.5 }}>
                AI FORENSIC LAYER · CLAUDE HAIKU
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {latencyMs && (
              <div style={{ fontSize: 7.5, color: '#5b21b6', letterSpacing: '0.15em' }}>{latencyMs}ms</div>
            )}
            <button
              onClick={onClose}
              style={{
                width: 26, height: 26, borderRadius: 5, cursor: 'pointer',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                color: '#6b7280', fontSize: 12, fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background='rgba(239,68,68,0.1)'; (e.currentTarget as HTMLButtonElement).style.color='#f87171'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background='rgba(255,255,255,0.04)'; (e.currentTarget as HTMLButtonElement).style.color='#6b7280'; }}
            >✕</button>
          </div>
        </div>

        {/* ── Context bar ── */}
        <div style={{
          padding: '9px 18px', flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          display: 'flex', gap: 0,
        }}>
          {([
            { label: 'STRESS',  value: stress?.score ?? '—',      color: levelColor,  suffix: '/100' },
            { label: 'REGIME',  value: stress?.level ?? '—',      color: levelColor                  },
            { label: 'VECTORS', value: `${stress?.signals_aligned ?? 0}/4`, color: '#c4b5fd'        },
            { label: 'PRICE',   value: `$${(tick?.price ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`, color: '#9ca3af' },
          ] as { label: string; value: string | number; color: string; suffix?: string }[]).map((item, i) => (
            <div key={i} style={{
              flex: 1, padding: '4px 0',
              borderRight: i < 3 ? '1px solid rgba(255,255,255,0.04)' : 'none',
              paddingLeft: i > 0 ? 12 : 0,
            }}>
              <div style={{ fontSize: 7, color: '#3b2760', letterSpacing: '0.22em', marginBottom: 3 }}>{item.label}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: item.color, letterSpacing: '0.03em' }}>
                {item.value}<span style={{ fontSize: 7.5, color: '#374151', fontWeight: 400 }}>{item.suffix ?? ''}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Pattern label */}
        {causal?.pattern_label && (
          <div style={{
            padding: '6px 18px', flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.025)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <div style={{
              width: 5, height: 5, borderRadius: '50%', background: levelColor, flexShrink: 0,
              animation: 'orc-pulse 1.3s infinite',
            }} />
            <div style={{ fontSize: 8.5, fontWeight: 700, color: '#6b7280', letterSpacing: '0.16em' }}>
              {causal.pattern_label}
            </div>
          </div>
        )}

        {/* ── Scrollable body ── */}
        <div className="orc-scroll" style={{ flex: 1, overflowY: 'auto', padding: '18px 18px 32px' }}>

          {phase === 'loading' && <OracleLoading />}
          {phase === 'error'   && <OracleError message={errMsg} />}

          {phase === 'done' && intel && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

              {/* ── VERDICT ── */}
              <section>
                <SectionLabel text="VERDICT" color="#a78bfa" />
                <div style={{
                  background: 'rgba(109,40,217,0.06)',
                  border: '1px solid rgba(109,40,217,0.18)',
                  borderRadius: 9, padding: '14px 16px',
                  position: 'relative', overflow: 'hidden',
                }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
                    background: 'linear-gradient(180deg,#a78bfa,#6d28d9)',
                    borderRadius: '4px 0 0 4px',
                  }} />
                  <div style={{ fontSize: 13.5, lineHeight: 1.65, fontWeight: 600, color: '#e5e7eb' }}>
                    {verdict.out}
                    {!verdict.done && <span className="orc-cursor" style={{ color: '#a78bfa', marginLeft: 2 }}>█</span>}
                  </div>
                </div>
              </section>

              {/* ── CAUSAL CHAIN ── */}
              {verdict.done && chainVisible.length > 0 && (
                <section>
                  <SectionLabel text="CAUSAL CHAIN" color="#f59e0b" />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {intel.causal_chain.map((step, i) => {
                      if (!chainVisible.includes(i)) return null;
                      const cfg = ROLE_CFG[step.role] || ROLE_CFG.AMPLIFIER;
                      return (
                        <div key={i} className="orc-enter">
                          <div style={{
                            background: cfg.bg, border: `1px solid ${cfg.border}`,
                            borderRadius: 8, padding: '11px 13px',
                            display: 'flex', alignItems: 'center', gap: 11,
                          }}>
                            <div style={{
                              width: 24, height: 24, borderRadius: '50%', flexShrink: 0,
                              background: cfg.bg, border: `1.5px solid ${cfg.border}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 8.5, fontWeight: 800, color: cfg.color,
                            }}>{i + 1}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                                <div style={{ fontSize: 9.5, fontWeight: 800, color: cfg.color, letterSpacing: '0.1em' }}>
                                  {step.label}
                                </div>
                                <div style={{
                                  fontSize: 7, fontWeight: 700, letterSpacing: '0.18em',
                                  color: cfg.color, padding: '2px 6px', borderRadius: 3,
                                  background: cfg.bg, border: `1px solid ${cfg.border}`, flexShrink: 0,
                                }}>{step.role}</div>
                              </div>
                              <div style={{ fontSize: 9.5, color: '#9ca3af', marginTop: 4, lineHeight: 1.45 }}>
                                {step.detail}
                              </div>
                            </div>
                          </div>
                          {i < intel.causal_chain.length - 1 && (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', paddingLeft: 31 }}>
                              <div style={{ width: 1.5, height: 8, background: 'rgba(255,255,255,0.06)' }} />
                              <div style={{ fontSize: 9, color: '#374151' }}>↓</div>
                              <div style={{ width: 1.5, height: 4, background: 'rgba(255,255,255,0.06)' }} />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* ── WATCH ── */}
              {watchVisible && intel.watch && (
                <section className="orc-enter">
                  <SectionLabel text="WATCH" color="#22d3ee" />
                  <WatchBlock watch={intel.watch} />
                </section>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: '8px 18px', flexShrink: 0,
          borderTop: '1px solid rgba(255,255,255,0.04)',
          background: 'rgba(0,0,0,0.25)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontSize: 7, color: '#1e1540', letterSpacing: '0.22em' }}>SENTINEL ORACLE · 5/MIN RATE LIMIT</div>
          {phase === 'done' && (
            <div style={{ fontSize: 7, color: '#1f5a3a', letterSpacing: '0.15em' }}>✓ BRIEF COMPLETE</div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────
function SectionLabel({ text, color }: { text: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <div style={{ width: 16, height: 1.5, background: color, borderRadius: 1, opacity: 0.5 }} />
      <div style={{ fontSize: 7.5, fontWeight: 800, color, letterSpacing: '0.32em', opacity: 0.75 }}>{text}</div>
      <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.03)' }} />
    </div>
  );
}

function WatchBlock({ watch }: { watch: OracleWatch }) {
  return (
    <div style={{ background: 'rgba(34,211,238,0.04)', border: '1px solid rgba(34,211,238,0.18)', borderRadius: 9, overflow: 'hidden' }}>
      <div style={{
        padding: '7px 14px', borderBottom: '1px solid rgba(34,211,238,0.1)',
        background: 'rgba(34,211,238,0.07)', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#22d3ee', animation: 'orc-pulse 1.2s infinite', flexShrink: 0 }} />
        <div style={{ fontSize: 8, fontWeight: 700, color: '#22d3ee', letterSpacing: '0.22em' }}>
          ARMED · {watch.signal.toUpperCase()}
        </div>
      </div>
      <div style={{ padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 7.5, color: '#164e63', letterSpacing: '0.2em', marginBottom: 4 }}>IF THIS HAPPENS</div>
          <div style={{ fontSize: 10.5, color: '#e5e7eb', lineHeight: 1.55, fontWeight: 500 }}>{watch.condition}</div>
        </div>
        <div style={{ height: 1, background: 'rgba(34,211,238,0.07)' }} />
        <div>
          <div style={{ fontSize: 7.5, color: '#164e63', letterSpacing: '0.2em', marginBottom: 4 }}>THEN EXPECT</div>
          <div style={{ fontSize: 10.5, color: '#f87171', lineHeight: 1.55, fontWeight: 600 }}>→ {watch.outcome}</div>
        </div>
      </div>
    </div>
  );
}

function OracleOrb({ phase }: { phase: string }) {
  const active = phase === 'loading';
  const done   = phase === 'done';
  const c      = done ? '#10b981' : active ? '#a78bfa' : '#2d1f5e';
  return (
    <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%', position: 'absolute',
        border: `1px solid ${c}60`,
        animation: active ? 'orc-spin 1.8s linear infinite' : 'none',
        borderTopColor: active ? c : `${c}60`,
      }} />
      <div style={{
        width: 14, height: 14, borderRadius: '50%',
        background: `${c}18`, border: `1px solid ${c}50`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ width: 5, height: 5, borderRadius: '50%', background: c }} />
      </div>
    </div>
  );
}

function OracleLoading() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 700);
    return () => clearInterval(iv);
  }, []);
  const lines = [
    'Parsing signal convergence pattern...',
    'Mapping causal sequence...',
    'Evaluating structural failure modes...',
    'Generating intelligence brief...',
  ];
  return (
    <div style={{ paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 70 }}>
        <div style={{ position: 'relative', width: 52, height: 52, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {[0, 1, 2].map(i => (
            <div key={i} style={{
              position: 'absolute', width: 16 + i * 14, height: 16 + i * 14, borderRadius: '50%',
              border: '1px solid', borderColor: `rgba(167,139,250,${0.5 - i * 0.12})`,
              animation: `orc-spin ${1.6 + i * 0.6}s linear infinite${i % 2 ? ' reverse' : ''}`,
            }} />
          ))}
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#a78bfa' }} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {lines.map((line, i) => {
          const isDone   = tick > i;
          const isActive = tick === i;
          return (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              opacity: isDone ? 0.35 : isActive ? 1 : 0.12,
              transition: 'opacity 0.5s',
            }}>
              <div style={{ fontSize: 9, width: 13, textAlign: 'center', color: isDone ? '#10b981' : isActive ? '#a78bfa' : '#374151' }}>
                {isDone ? '✓' : isActive ? '›' : '·'}
              </div>
              <div style={{ fontSize: 9.5, letterSpacing: '0.04em', color: isActive ? '#c4b5fd' : '#4b5563' }}>{line}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function OracleError({ message }: { message: string }) {
  const is401 = message.includes('401') || message.includes('invalid') || message.includes('auth');
  const is404 = message.includes('404') || message.includes('model');
  const isCors = message.includes('CORS') || message.includes('fetch') || message.includes('Network');
  const isKey  = message.includes('key') || message.includes('env');

  const hint = is401  ? 'API key invalid or expired — check .env.local'
             : is404  ? 'Model not found — MODEL string may be wrong'
             : isCors ? 'CORS blocked — check browser Console for details'
             : isKey  ? 'Add VITE_ANTHROPIC_API_KEY to .env.local, restart npm run dev'
             : 'Open browser DevTools → Console for full error details';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', padding: '28px 18px', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 16, color: '#374151' }}>⊘</div>
        <div style={{ fontSize: 9.5, color: '#ef4444', letterSpacing: '0.22em', fontWeight: 800 }}>ORACLE OFFLINE</div>
      </div>
      {/* Exact error message — visible in drawer */}
      <div style={{
        background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
        borderRadius: 7, padding: '10px 12px',
      }}>
        <div style={{ fontSize: 7.5, color: '#7f1d1d', letterSpacing: '0.18em', marginBottom: 5 }}>ERROR</div>
        <div style={{ fontSize: 9.5, color: '#fca5a5', lineHeight: 1.6, fontFamily: 'monospace', wordBreak: 'break-word' }}>
          {message}
        </div>
      </div>
      {/* Hint */}
      <div style={{
        background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)',
        borderRadius: 7, padding: '10px 12px',
      }}>
        <div style={{ fontSize: 7.5, color: '#78350f', letterSpacing: '0.18em', marginBottom: 5 }}>HOW TO FIX</div>
        <div style={{ fontSize: 9.5, color: '#d97706', lineHeight: 1.6 }}>{hint}</div>
      </div>
      {/* Console reminder */}
      <div style={{ fontSize: 7.5, color: '#374151', letterSpacing: '0.12em', lineHeight: 1.7 }}>
        Press F12 → Console → look for <span style={{ color: '#6b7280' }}>[Oracle]</span> logs for full details.
        <br />
        .env.local must be in <span style={{ color: '#6b7280' }}>sentinel-production-microstructure-monitor/</span>
        <br />
        Restart <span style={{ color: '#6b7280' }}>npm run dev</span> after editing .env.local
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ORACLE TRIGGER BUTTON
// Drop into Sentinel's Causality Engine panel header.
// Self-contained — manages the drawer, rate limit, and AbortController.
// ═══════════════════════════════════════════════════════════════════════════
interface OracleTriggerButtonProps {
  snapshot:    MarketSnapshot | null;
  stressScore: number;
}

export function OracleTriggerButton({ snapshot, stressScore }: OracleTriggerButtonProps) {
  const [drawerOpen,   setDrawerOpen]   = useState(false);
  const [cooldown,     setCooldown]     = useState(false);
  const [cooldownSecs, setCooldownSecs] = useState(0);
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleOpen = useCallback(() => {
    if (cooldown || !snapshot) return;
    setDrawerOpen(true);
    setCooldown(true);
    let r = Math.ceil(RATE_LIMIT_MS / 1000);
    setCooldownSecs(r);
    ivRef.current = setInterval(() => {
      r--;
      setCooldownSecs(r);
      if (r <= 0) {
        if (ivRef.current) clearInterval(ivRef.current);
        setCooldown(false);
        setCooldownSecs(0);
      }
    }, 1000);
  }, [cooldown, snapshot]);

  useEffect(() => () => { if (ivRef.current) clearInterval(ivRef.current); }, []);

  const isHot      = stressScore >= 60;
  const hasData    = !!snapshot;
  const isDisabled = cooldown || !hasData;

  return (
    <>
      <button
        onClick={handleOpen}
        disabled={isDisabled}
        title={
          !hasData  ? 'No breach snapshot to analyze' :
          cooldown  ? `Rate limit: ${cooldownSecs}s remaining` :
          'Run Oracle AI forensic analysis on this breach'
        }
        className="font-mono"
        style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '5px 12px', borderRadius: 6,
          cursor: isDisabled ? 'not-allowed' : 'pointer',
          opacity: !hasData ? 0.25 : cooldown ? 0.6 : 1,
          transition: 'all 0.2s',
          fontSize: '8.5px', fontWeight: 700, letterSpacing: '0.18em',
          background: isHot && !cooldown && hasData ? 'rgba(109,40,217,0.14)' : 'rgba(55,65,81,0.35)',
          border: `1px solid ${isHot && !cooldown && hasData ? 'rgba(167,139,250,0.4)' : 'rgba(55,65,81,0.5)'}`,
          color: isHot && !cooldown && hasData ? '#c4b5fd' : '#6b7280',
          boxShadow: isHot && !cooldown && hasData ? '0 0 14px rgba(109,40,217,0.14)' : 'none',
          fontFamily: "'JetBrains Mono','Fira Code',monospace",
        }}
        onMouseEnter={e => {
          if (!isDisabled && isHot) {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(109,40,217,0.22)';
            (e.currentTarget as HTMLButtonElement).style.boxShadow  = '0 0 22px rgba(109,40,217,0.22)';
          }
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.background = isHot && !cooldown && hasData ? 'rgba(109,40,217,0.14)' : 'rgba(55,65,81,0.35)';
          (e.currentTarget as HTMLButtonElement).style.boxShadow  = isHot && !cooldown && hasData ? '0 0 14px rgba(109,40,217,0.14)' : 'none';
        }}
      >
        <div style={{
          width: 5.5, height: 5.5, borderRadius: '50%', flexShrink: 0,
          background: !hasData ? '#374151' : cooldown ? '#4b5563' : isHot ? '#a78bfa' : '#6b7280',
          animation: isHot && !cooldown && hasData ? 'orc-pulse 1.4s infinite' : 'none',
        }} />
        {cooldown ? `COOLDOWN ${cooldownSecs}s` : 'ORACLE ANALYSIS'}
      </button>

      <OracleDrawer
        snapshot={snapshot}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  );
}
