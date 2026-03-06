import { useState, useEffect, useRef, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// ORACLE INTELLIGENCE — Sentinel Forensic AI Layer
// ─────────────────────────────────────────────────────────────────────────────
// INTEGRATION: Drop <OracleTriggerButton /> inside Sentinel's Causality Engine
// panel. Wrap your App root with <OracleProvider>. Done.
//
// API KEY: Replace YOUR_KEY_HERE with your Anthropic API key.
// WARNING: Do not commit this file to any public repo.
// ═══════════════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = "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";
const MODEL             = "claude-haiku-4-5-20251001";
const RATE_LIMIT_MS     = 13_000; // 5 calls/min → 1 per 13s with buffer

// ── Mock snapshot (mirrors Sentinel's real MarketSnapshot shape) ───────────
const MOCK_SNAPSHOT = {
  stress: {
    score: 78, raw_score: 52.4, level: "UNSTABLE",
    signals_aligned: 3, confidence: "HIGH",
    breakdown: { liquidity: 84, flow: 71, volatility: 38, forcedSelling: 62 }
  },
  causal: {
    pattern_label: "WHALE EXECUTION INTO THIN BOOK",
    stress_velocity: 4.2,
    steps: [
      { signal: "Liquidity Fragility",  type: "CATALYST",  signal_intensity: 84, stress_contribution_pct: 42 },
      { signal: "Forced Selling",       type: "AMPLIFIER", signal_intensity: 62, stress_contribution_pct: 28 },
      { signal: "Order Flow Imbalance", type: "SYSTEMIC",  signal_intensity: 71, stress_contribution_pct: 24 },
    ],
    risk_assessment: "UNSTABLE: 3-vector convergence. Structural failure imminent.",
  },
  trace: {
    raw_score: 52.4, signals_aligned: 3, shock_multiplier: 1.35,
    pre_smooth_score: 70.7, smoothing_alpha: 0.35, previous_score: 61.2, final_score: 78,
    weight_contributions: [
      { signal: "Liquidity Fragility",  weight: 0.35, raw_value: 84, contribution: 29.4, pct_of_total: 56 },
      { signal: "Order Flow Imbalance", weight: 0.25, raw_value: 71, contribution: 17.75, pct_of_total: 34 },
      { signal: "Forced Selling",       weight: 0.15, raw_value: 62, contribution: 9.3,  pct_of_total: 18 },
      { signal: "Volatility",           weight: 0.25, raw_value: 38, contribution: 9.5,  pct_of_total: 18 },
    ]
  },
  tick: {
    price: 94218.50, total_depth: 42.3, spread_bps: 4.2, data_quality: "GOOD",
    trades: {
      sell_volume: 18.4, buy_volume: 6.1,
      large_trades: [{ quantity: 8.2 }, { quantity: 6.4 }, { quantity: 3.8 }]
    }
  }
};

// ── Build prompt ───────────────────────────────────────────────────────────
function buildPrompt(snap) {
  const { stress, causal, trace, tick } = snap;
  const depthDrop   = stress.breakdown.liquidity;
  const whaleVol    = tick.trades.large_trades.reduce((s, t) => s + (t.quantity || 0), 0).toFixed(1);
  const dom         = [...trace.weight_contributions].sort((a, b) => b.contribution - a.contribution)[0];
  const seqStr      = causal.steps.map(s => `${s.type}(${s.signal}, ${s.signal_intensity}/100)`).join(" → ");

  return `You are ORACLE, the forensic AI layer of Sentinel, a BTC market microstructure monitor.
Analyze this breach event and return ONLY valid JSON with no extra text.

BREACH DATA:
Pattern: ${causal.pattern_label}
Stress: ${stress.score}/100 (${stress.level}), velocity +${causal.stress_velocity.toFixed(1)} pts/s
Signals: ${stress.signals_aligned}/4 active, shock multiplier ${trace.shock_multiplier}x
Sequence: ${seqStr}
Dominant: ${dom?.signal} (${dom?.pct_of_total?.toFixed(0)}% of stress)
Liquidity: collapsed ${depthDrop}% below 60s baseline
Depth: ${tick.total_depth.toFixed(1)} BTC total (normal ~200 BTC)
Whale blocks: ${whaleVol} BTC across ${tick.trades.large_trades.length} blocks
Price: $${tick.price.toLocaleString()}
Spread: ${tick.spread_bps.toFixed(1)} bps

Return ONLY this JSON structure, no markdown, no explanation:
{
  "verdict": "One punchy sentence — the single most critical thing a trader must know right now.",
  "causal_chain": [
    {"label": "SHORT UPPERCASE LABEL", "detail": "One specific metric or fact", "role": "TRIGGER"},
    {"label": "SHORT UPPERCASE LABEL", "detail": "One specific metric or fact", "role": "AMPLIFIER"},
    {"label": "SHORT UPPERCASE LABEL", "detail": "One specific metric or fact", "role": "CONSEQUENCE"}
  ],
  "watch": {
    "signal": "Exact signal name",
    "condition": "If X crosses Y without Z recovering",
    "outcome": "what happens next"
  }
}
Roles must be exactly: TRIGGER, AMPLIFIER, or CONSEQUENCE.`;
}

// ── API call ───────────────────────────────────────────────────────────────
async function fetchOracle(snapshot) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: buildPrompt(snapshot) }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  const raw  = (data.content || []).map(b => b.text || "").join("").trim();
  // Strip any markdown fences Haiku might sneak in
  const clean = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
  const parsed = JSON.parse(clean);
  // Validate shape
  if (!parsed.verdict || !Array.isArray(parsed.causal_chain) || !parsed.watch) {
    throw new Error("Malformed Oracle response");
  }
  return parsed;
}

// ── Role config ────────────────────────────────────────────────────────────
const ROLE_CONFIG = {
  TRIGGER:     { color: "#f97316", bg: "rgba(249,115,22,0.12)",  border: "rgba(249,115,22,0.35)", label: "TRIGGER"     },
  AMPLIFIER:   { color: "#eab308", bg: "rgba(234,179,8,0.10)",   border: "rgba(234,179,8,0.35)",  label: "AMPLIFIER"   },
  CONSEQUENCE: { color: "#ef4444", bg: "rgba(239,68,68,0.10)",   border: "rgba(239,68,68,0.35)",  label: "CONSEQUENCE" },
};

// ── Typewriter hook ────────────────────────────────────────────────────────
function useTypewriter(text, run, speed = 18) {
  const [out, setOut]   = useState("");
  const [done, setDone] = useState(false);
  const ref = useRef(0);
  useEffect(() => {
    if (!run || !text) { setOut(""); setDone(false); ref.current = 0; return; }
    ref.current = 0; setOut(""); setDone(false);
    const iv = setInterval(() => {
      ref.current++;
      setOut(text.slice(0, ref.current));
      if (ref.current >= text.length) { clearInterval(iv); setDone(true); }
    }, speed);
    return () => clearInterval(iv);
  }, [text, run, speed]);
  return { out, done };
}

// ═══════════════════════════════════════════════════════════════════════════
// ORACLE DRAWER
// ═══════════════════════════════════════════════════════════════════════════
export function OracleDrawer({ snapshot, open, onClose }) {
  // phase: idle | loading | done | error
  const [phase,       setPhase]      = useState("idle");
  const [intel,       setIntel]      = useState(null);
  const [latencyMs,   setLatencyMs]  = useState(null);
  const [errMsg,      setErrMsg]     = useState("");
  const [chainVisible, setChainVisible] = useState([]);   // which chain steps are visible
  const [watchVisible, setWatchVisible] = useState(false);

  // Verdict typewriter — runs once phase=done
  const verdictWriter = useTypewriter(intel?.verdict || "", phase === "done", 22);

  // Reveal chain steps sequentially after verdict done
  useEffect(() => {
    if (!verdictWriter.done || !intel?.causal_chain?.length) return;
    intel.causal_chain.forEach((_, i) => {
      setTimeout(() => setChainVisible(prev => [...prev, i]), i * 350 + 200);
    });
    setTimeout(() => setWatchVisible(true), intel.causal_chain.length * 350 + 500);
  }, [verdictWriter.done, intel]);

  // Trigger fetch whenever drawer opens
  useEffect(() => {
    if (!open) {
      // Reset on close
      setTimeout(() => {
        setPhase("idle"); setIntel(null); setLatencyMs(null);
        setErrMsg(""); setChainVisible([]); setWatchVisible(false);
      }, 400);
      return;
    }
    if (!snapshot) return;
    const t0 = Date.now();
    setPhase("loading");
    setChainVisible([]); setWatchVisible(false);
    fetchOracle(snapshot)
      .then(data => { setIntel(data); setLatencyMs(Date.now() - t0); setPhase("done"); })
      .catch(e  => { setErrMsg(e.message || "Unknown error"); setPhase("error"); });
  }, [open, snapshot]);

  const stress = snapshot?.stress || MOCK_SNAPSHOT.stress;
  const causal = snapshot?.causal || MOCK_SNAPSHOT.causal;
  const tick   = snapshot?.tick   || MOCK_SNAPSHOT.tick;

  const levelColor = stress.score >= 80 ? "#ef4444"
                   : stress.score >= 60 ? "#f97316"
                   : "#eab308";

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(2px)",
        opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none",
        transition: "opacity 0.35s ease",
      }} />

      {/* Drawer */}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: "min(520px, 46vw)",
        zIndex: 51,
        background: "linear-gradient(160deg, #0c0a14 0%, #0a0810 60%, #0d0b18 100%)",
        borderLeft: "1px solid rgba(139,92,246,0.25)",
        boxShadow: "-24px 0 80px rgba(0,0,0,0.7), -2px 0 20px rgba(109,40,217,0.08)",
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.4s cubic-bezier(0.16,1,0.3,1)",
        display: "flex", flexDirection: "column",
        fontFamily: "'JetBrains Mono','Fira Code',monospace",
        overflow: "hidden",
      }}>
        <style>{`
          @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;600;700;800&display=swap');
          @keyframes oracle-fadein { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
          @keyframes oracle-pulse  { 0%,100%{opacity:1} 50%{opacity:0.5} }
          @keyframes oracle-spin   { to{transform:rotate(360deg)} }
          @keyframes oracle-draw   { from{width:0} to{width:100%} }
          @keyframes oracle-blink  { 0%,100%{opacity:1} 50%{opacity:0} }
          .oracle-step-enter { animation: oracle-fadein 0.4s cubic-bezier(0.2,0.8,0.2,1) forwards; }
          .oracle-cursor     { animation: oracle-blink 0.9s step-end infinite; display:inline-block; }
        `}</style>

        {/* ── Top strip ── */}
        <div style={{
          padding: "0 20px",
          height: 48,
          background: "rgba(109,40,217,0.08)",
          borderBottom: "1px solid rgba(109,40,217,0.2)",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <OracleOrb phase={phase} />
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.3em", color: "#a78bfa" }}>ORACLE</div>
              <div style={{ fontSize: 7.5, color: "#4c3272", letterSpacing: "0.2em", marginTop: 1 }}>
                AI FORENSIC LAYER · {MODEL.toUpperCase()}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {latencyMs && (
              <div style={{ fontSize: 8, color: "#6d28d9", letterSpacing: "0.15em" }}>{latencyMs}ms</div>
            )}
            <button onClick={onClose} style={{
              width: 28, height: 28, borderRadius: 6,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
              color: "#6b7280", cursor: "pointer", fontSize: 13, fontFamily: "inherit",
              display: "flex", alignItems: "center", justifyContent: "center",
              transition: "all 0.15s",
            }}
              onMouseEnter={e => { e.currentTarget.style.background = "rgba(239,68,68,0.1)"; e.currentTarget.style.color = "#f87171"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.04)"; e.currentTarget.style.color = "#6b7280"; }}
            >✕</button>
          </div>
        </div>

        {/* ── Context bar ── */}
        <div style={{
          padding: "10px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          display: "flex", gap: 0, flexShrink: 0,
        }}>
          {[
            { label: "STRESS", value: stress.score, valueColor: levelColor, suffix: "/100" },
            { label: "REGIME", value: stress.level, valueColor: levelColor },
            { label: "VECTORS", value: `${stress.signals_aligned}/4`, valueColor: "#c4b5fd" },
            { label: "PRICE", value: `$${(tick.price||0).toLocaleString(undefined,{maximumFractionDigits:0})}`, valueColor: "#9ca3af" },
          ].map((item, i) => (
            <div key={i} style={{
              flex: 1, padding: "6px 0",
              borderRight: i < 3 ? "1px solid rgba(255,255,255,0.05)" : "none",
              paddingLeft: i > 0 ? 12 : 0,
            }}>
              <div style={{ fontSize: 7.5, color: "#3b2d6b", letterSpacing: "0.25em", marginBottom: 3 }}>{item.label}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: item.valueColor, letterSpacing: "0.04em" }}>
                {item.value}<span style={{ fontSize: 8, color: "#374151", fontWeight: 400 }}>{item.suffix || ""}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Pattern label */}
        {causal.pattern_label && (
          <div style={{
            padding: "7px 20px",
            borderBottom: "1px solid rgba(255,255,255,0.03)",
            display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
          }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: levelColor,
              animation: "oracle-pulse 1.2s infinite", flexShrink: 0 }} />
            <div style={{ fontSize: 9, fontWeight: 700, color: "#6b7280", letterSpacing: "0.18em" }}>
              {causal.pattern_label}
            </div>
          </div>
        )}

        {/* ── Scrollable body ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 28px" }}>

          {/* LOADING */}
          {phase === "loading" && <OracleLoading />}

          {/* ERROR */}
          {phase === "error" && <OracleError message={errMsg} />}

          {/* DONE */}
          {phase === "done" && intel && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

              {/* ── VERDICT ── */}
              <section>
                <SectionLabel text="VERDICT" color="#a78bfa" />
                <div style={{
                  background: "rgba(109,40,217,0.06)",
                  border: "1px solid rgba(109,40,217,0.2)",
                  borderRadius: 10,
                  padding: "16px 18px",
                  position: "relative", overflow: "hidden",
                }}>
                  {/* accent bar */}
                  <div style={{
                    position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
                    background: "linear-gradient(180deg, #a78bfa, #6d28d9)",
                    borderRadius: "4px 0 0 4px",
                  }} />
                  <div style={{
                    fontSize: 14, lineHeight: 1.65, fontWeight: 600,
                    color: "#e5e7eb", letterSpacing: "0.01em",
                  }}>
                    {verdictWriter.out}
                    {!verdictWriter.done && <span className="oracle-cursor" style={{ color: "#a78bfa", marginLeft: 1 }}>█</span>}
                  </div>
                </div>
              </section>

              {/* ── CAUSAL CHAIN ── */}
              {verdictWriter.done && (
                <section>
                  <SectionLabel text="CAUSAL CHAIN" color="#f97316" />
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    {intel.causal_chain.map((step, i) => {
                      const cfg  = ROLE_CONFIG[step.role] || ROLE_CONFIG.TRIGGER;
                      const show = chainVisible.includes(i);
                      if (!show) return null;
                      return (
                        <div key={i} className="oracle-step-enter">
                          {/* Step card */}
                          <div style={{
                            background: cfg.bg,
                            border: `1px solid ${cfg.border}`,
                            borderRadius: 8,
                            padding: "12px 14px",
                            display: "flex", alignItems: "center", gap: 12,
                          }}>
                            {/* Index circle */}
                            <div style={{
                              width: 26, height: 26, borderRadius: "50%",
                              background: cfg.bg, border: `1.5px solid ${cfg.border}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              flexShrink: 0,
                              fontSize: 9, fontWeight: 800, color: cfg.color,
                            }}>{i + 1}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                                <div style={{ fontSize: 10, fontWeight: 800, color: cfg.color, letterSpacing: "0.12em" }}>
                                  {step.label}
                                </div>
                                <div style={{
                                  fontSize: 7.5, fontWeight: 700, letterSpacing: "0.2em",
                                  color: cfg.color, background: cfg.bg,
                                  border: `1px solid ${cfg.border}`,
                                  padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap", flexShrink: 0,
                                }}>{cfg.label}</div>
                              </div>
                              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4, lineHeight: 1.45 }}>
                                {step.detail}
                              </div>
                            </div>
                          </div>

                          {/* Connector arrow (between steps) */}
                          {i < intel.causal_chain.length - 1 && (
                            <div style={{
                              display: "flex", flexDirection: "column", alignItems: "flex-start",
                              paddingLeft: 33, gap: 0,
                            }}>
                              <div style={{ width: 1.5, height: 10, background: "rgba(255,255,255,0.08)" }} />
                              <div style={{ fontSize: 10, color: "#374151", lineHeight: 1 }}>↓</div>
                              <div style={{ width: 1.5, height: 4, background: "rgba(255,255,255,0.08)" }} />
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
                <section className="oracle-step-enter">
                  <SectionLabel text="WATCH" color="#22d3ee" />
                  <WatchBlock watch={intel.watch} />
                </section>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          padding: "10px 20px",
          borderTop: "1px solid rgba(255,255,255,0.04)",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: "rgba(0,0,0,0.3)", flexShrink: 0,
        }}>
          <div style={{ fontSize: 7.5, color: "#2d1f5e", letterSpacing: "0.25em" }}>
            SENTINEL ORACLE · RATE LIMIT 5/MIN
          </div>
          {phase === "done" && (
            <div style={{ fontSize: 7.5, color: "#374151", letterSpacing: "0.15em" }}>
              ✓ ANALYSIS COMPLETE
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Section label ─────────────────────────────────────────────────────────
function SectionLabel({ text, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
      <div style={{ width: 18, height: 1.5, background: color, borderRadius: 1, opacity: 0.5 }} />
      <div style={{ fontSize: 8, fontWeight: 800, color, letterSpacing: "0.35em", opacity: 0.8 }}>{text}</div>
      <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.04)" }} />
    </div>
  );
}

// ── Watch block ───────────────────────────────────────────────────────────
function WatchBlock({ watch }) {
  return (
    <div style={{
      background: "rgba(34,211,238,0.05)",
      border: "1px solid rgba(34,211,238,0.2)",
      borderRadius: 10,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "8px 14px",
        background: "rgba(34,211,238,0.08)",
        borderBottom: "1px solid rgba(34,211,238,0.12)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: "50%", background: "#22d3ee",
          animation: "oracle-pulse 1.2s infinite",
        }} />
        <div style={{ fontSize: 8.5, fontWeight: 700, color: "#22d3ee", letterSpacing: "0.25em" }}>
          ARMED · {watch.signal?.toUpperCase()}
        </div>
      </div>
      {/* Body */}
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 7.5, color: "#164e63", letterSpacing: "0.2em", marginBottom: 4 }}>CONDITION</div>
          <div style={{ fontSize: 11, color: "#e5e7eb", lineHeight: 1.5, fontWeight: 500 }}>{watch.condition}</div>
        </div>
        <div style={{ height: 1, background: "rgba(34,211,238,0.08)" }} />
        <div>
          <div style={{ fontSize: 7.5, color: "#164e63", letterSpacing: "0.2em", marginBottom: 4 }}>OUTCOME</div>
          <div style={{ fontSize: 11, color: "#f87171", lineHeight: 1.5, fontWeight: 600 }}>→ {watch.outcome}</div>
        </div>
      </div>
    </div>
  );
}

// ── Oracle orb ────────────────────────────────────────────────────────────
function OracleOrb({ phase }) {
  const active = phase === "loading";
  const done   = phase === "done";
  const color  = done ? "#10b981" : active ? "#a78bfa" : "#3b2d6b";
  return (
    <div style={{ width: 28, height: 28, position: "relative", display:"flex",alignItems:"center",justifyContent:"center" }}>
      <div style={{
        width: 28, height: 28, borderRadius: "50%",
        border: `1px solid ${color}`,
        position: "absolute",
        animation: active ? "oracle-spin 2s linear infinite" : "none",
        borderTopColor: active ? "#7c3aed" : color,
        opacity: 0.6,
      }} />
      <div style={{
        width: 16, height: 16, borderRadius: "50%",
        background: `${color}18`,
        border: `1px solid ${color}60`,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      </div>
    </div>
  );
}

// ── Loading state ─────────────────────────────────────────────────────────
function OracleLoading() {
  const [tick, setTick] = useState(0);
  useEffect(() => { const iv = setInterval(() => setTick(t => t+1), 600); return () => clearInterval(iv); }, []);
  const lines = [
    "Reading signal convergence pattern...",
    "Tracing causal sequence...",
    "Evaluating structural failure modes...",
    "Generating intelligence brief...",
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, paddingTop: 12 }}>
      {/* Spinner cluster */}
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 80 }}>
        <div style={{ position: "relative", width: 56, height: 56, display:"flex",alignItems:"center",justifyContent:"center" }}>
          {[0,1,2].map(i => (
            <div key={i} style={{
              position: "absolute",
              width: 18 + i*14, height: 18 + i*14,
              borderRadius: "50%",
              border: "1px solid",
              borderColor: `rgba(${["167,139,250","139,92,246","109,40,217"][i]},${0.5-i*0.1})`,
              animation: `oracle-spin ${2+i*0.7}s linear infinite ${i%2===1?"reverse":""}`,
            }} />
          ))}
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#a78bfa" }} />
        </div>
      </div>

      {/* Progress lines */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {lines.map((line, i) => {
          const done = tick > i;
          const active = tick === i;
          return (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 10,
              opacity: done ? 0.4 : active ? 1 : 0.15,
              transition: "opacity 0.4s",
            }}>
              <div style={{
                fontSize: 9, width: 14, textAlign: "center",
                color: done ? "#10b981" : active ? "#a78bfa" : "#374151",
              }}>{done ? "✓" : active ? "›" : "·"}</div>
              <div style={{ fontSize: 9.5, color: active ? "#c4b5fd" : "#4b5563", letterSpacing: "0.05em" }}>{line}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Error state ───────────────────────────────────────────────────────────
function OracleError({ message }) {
  return (
    <div style={{ display:"flex",flexDirection:"column",alignItems:"center",padding:"40px 20px",gap:14 }}>
      <div style={{ fontSize:22, color:"#374151" }}>⊘</div>
      <div style={{ fontSize:10, color:"#ef4444", letterSpacing:"0.25em" }}>ORACLE OFFLINE</div>
      <div style={{ fontSize:9, color:"#6b7280", letterSpacing:"0.1em", textAlign:"center", lineHeight:1.6 }}>
        {message}
      </div>
      <div style={{ fontSize:8, color:"#374151", letterSpacing:"0.15em", marginTop:4 }}>
        CHECK API KEY · RATE LIMIT: 5/MIN
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER BUTTON — Drop this inside Sentinel's Causality Engine panel
// Usage: <OracleTriggerButton snapshot={event.snapshot} stressScore={78} />
// ═══════════════════════════════════════════════════════════════════════════
export function OracleTriggerButton({ snapshot, stressScore = 0 }) {
  const [drawerOpen,   setDrawerOpen]   = useState(false);
  const [cooldown,     setCooldown]     = useState(false);
  const [cooldownSecs, setCooldownSecs] = useState(0);
  const cooldownRef = useRef(null);

  const isHot = stressScore >= 60;

  const handleOpen = useCallback(() => {
    if (cooldown || !snapshot) return;
    setDrawerOpen(true);
    // Start rate-limit cooldown
    setCooldown(true);
    let remaining = Math.ceil(RATE_LIMIT_MS / 1000);
    setCooldownSecs(remaining);
    cooldownRef.current = setInterval(() => {
      remaining--;
      setCooldownSecs(remaining);
      if (remaining <= 0) {
        clearInterval(cooldownRef.current);
        setCooldown(false);
        setCooldownSecs(0);
      }
    }, 1000);
  }, [cooldown, snapshot]);

  useEffect(() => () => cooldownRef.current && clearInterval(cooldownRef.current), []);

  return (
    <>
      <button
        onClick={handleOpen}
        disabled={cooldown || !snapshot}
        title={
          !snapshot  ? "No breach snapshot to analyze" :
          cooldown   ? `Rate limit cooldown: ${cooldownSecs}s` :
          "Run Oracle AI forensic analysis"
        }
        style={{
          fontFamily: "'JetBrains Mono','Fira Code',monospace",
          display: "flex", alignItems: "center", gap: 7,
          padding: "6px 14px", borderRadius: 6,
          fontSize: 9, fontWeight: 700, letterSpacing: "0.2em",
          cursor: cooldown || !snapshot ? "not-allowed" : "pointer",
          opacity: !snapshot ? 0.3 : 1,
          transition: "all 0.2s",
          background: isHot && !cooldown
            ? "rgba(109,40,217,0.15)"
            : "rgba(55,65,81,0.4)",
          border: isHot && !cooldown
            ? "1px solid rgba(167,139,250,0.45)"
            : "1px solid rgba(55,65,81,0.6)",
          color: isHot && !cooldown ? "#c4b5fd" : "#6b7280",
          boxShadow: isHot && !cooldown ? "0 0 16px rgba(109,40,217,0.15)" : "none",
        }}
        onMouseEnter={e => {
          if (!cooldown && snapshot && isHot) {
            e.currentTarget.style.background = "rgba(109,40,217,0.25)";
            e.currentTarget.style.boxShadow  = "0 0 24px rgba(109,40,217,0.25)";
          }
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = isHot && !cooldown ? "rgba(109,40,217,0.15)" : "rgba(55,65,81,0.4)";
          e.currentTarget.style.boxShadow  = isHot && !cooldown ? "0 0 16px rgba(109,40,217,0.15)" : "none";
        }}
      >
        {/* Orb indicator */}
        <div style={{
          width: 6, height: 6, borderRadius: "50%",
          background: !snapshot ? "#374151" : cooldown ? "#4b5563" : isHot ? "#a78bfa" : "#6b7280",
          animation: isHot && !cooldown ? "oracle-pulse 1.5s infinite" : "none",
        }} />

        {cooldown ? `COOLDOWN ${cooldownSecs}s` : "ORACLE ANALYSIS"}

        {/* Hot pulse ring */}
        {isHot && !cooldown && snapshot && (
          <div style={{
            width: 5, height: 5, borderRadius: "50%",
            border: "1px solid rgba(167,139,250,0.6)",
            animation: "oracle-pulse 1s infinite",
          }} />
        )}
      </button>

      <OracleDrawer
        snapshot={snapshot}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STANDALONE DEMO — renders the full experience with mock data
// Remove this in production and use OracleTriggerButton directly.
// ═══════════════════════════════════════════════════════════════════════════
export default function OracleDemo() {
  const [open, setOpen] = useState(false);
  const [cooldown, setCooldown]     = useState(false);
  const [cooldownSecs, setCooldownSecs] = useState(0);
  const cooldownRef = useRef(null);

  const handleOpen = () => {
    if (cooldown) return;
    setOpen(true);
    setCooldown(true);
    let r = Math.ceil(RATE_LIMIT_MS / 1000);
    setCooldownSecs(r);
    cooldownRef.current = setInterval(() => {
      r--;
      setCooldownSecs(r);
      if (r <= 0) { clearInterval(cooldownRef.current); setCooldown(false); setCooldownSecs(0); }
    }, 1000);
  };

  useEffect(() => () => cooldownRef.current && clearInterval(cooldownRef.current), []);

  return (
    <div style={{
      minHeight: "100vh",
      background: "#0a0e14",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      fontFamily: "'JetBrains Mono','Fira Code',monospace",
      padding: 32, gap: 28,
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap');
        @keyframes oracle-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes oracle-spin  { to{transform:rotate(360deg)} }
        @keyframes oracle-fadein { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes oracle-blink  { 0%,100%{opacity:1} 50%{opacity:0} }
        .oracle-step-enter { animation: oracle-fadein 0.4s cubic-bezier(0.2,0.8,0.2,1) forwards; }
        .oracle-cursor     { animation: oracle-blink 0.9s step-end infinite; display:inline-block; }
      `}</style>

      {/* Mock Causality Panel */}
      <div style={{
        width: "100%", maxWidth: 720,
        background: "#151a23", border: "1px solid #1f2937",
        borderRadius: 12, overflow: "hidden",
      }}>
        {/* Panel header */}
        <div style={{
          padding: "12px 20px",
          borderBottom: "1px solid #1f2937",
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#f59e0b",
                animation: "oracle-pulse 1.2s infinite" }} />
              <span style={{ fontSize: 10, fontWeight: 800, color: "#f59e0b", letterSpacing: "0.3em" }}>
                CAUSALITY ENGINE
              </span>
            </div>
            <span style={{
              fontSize: 8, fontWeight: 700, color: "#92400e", letterSpacing: "0.2em",
              marginLeft: 14, background: "rgba(245,158,11,0.1)",
              padding: "2px 8px", borderRadius: 3, display: "inline-block", width: "fit-content",
            }}>
              {MOCK_SNAPSHOT.causal.pattern_label}
            </span>
          </div>

          {/* THE BUTTON — this is where it lives in Sentinel */}
          <OracleTriggerButton snapshot={MOCK_SNAPSHOT} stressScore={78} />
        </div>

        {/* Mock causal steps */}
        <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
          <div style={{ position: "absolute", left: 37, top: 20, bottom: 20, width: 1,
            background: "linear-gradient(rgba(245,158,11,0.4),rgba(55,65,81,0.1))" }} />
          {MOCK_SNAPSHOT.causal.steps.map((step, i) => (
            <div key={i} style={{ display: "flex", gap: 20, alignItems: "flex-start", paddingLeft: 28, paddingBottom: i < 2 ? 20 : 0 }}>
              <div style={{
                width: 20, height: 20, borderRadius: "50%", border: "2px solid",
                borderColor: i===0 ? "#f59e0b" : i===1 ? "#eab308" : "#ef4444",
                background: "#151a23", display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0, zIndex: 1,
              }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%",
                  background: i===0 ? "#f59e0b" : i===1 ? "#eab308" : "#ef4444" }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{
                      fontSize: 7.5, fontWeight: 800, color: "black", letterSpacing: "0.1em",
                      padding: "2px 6px", borderRadius: 3,
                      background: i===0 ? "#f59e0b" : i===1 ? "#374151" : "#ef4444",
                    }}>{step.type}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", letterSpacing: "0.04em" }}>{step.signal}</span>
                  </div>
                  <span style={{ fontSize: 9, color: "#6b7280" }}>{step.signal_intensity}/100</span>
                </div>
                <div style={{ marginTop: 6, height: 2, background: "#1f2937", borderRadius: 1, overflow: "hidden", width: "70%" }}>
                  <div style={{
                    height: "100%", borderRadius: 1,
                    background: i===0 ? "#f59e0b" : i===1 ? "#eab308" : "#ef4444",
                    width: `${step.stress_contribution_pct}%`,
                  }} />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{
          padding: "10px 20px",
          borderTop: "1px solid #1f2937",
          fontSize: 9, color: "#10b981", fontWeight: 700, letterSpacing: "0.12em",
          display: "flex", alignItems: "center", gap: 6,
          animation: "oracle-pulse 2s infinite",
        }}>
          <svg width="10" height="10" viewBox="0 0 20 20" fill="#10b981">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" />
          </svg>
          {MOCK_SNAPSHOT.causal.risk_assessment}
        </div>
      </div>

      <div style={{ fontSize: 8, color: "#1f2937", letterSpacing: "0.25em" }}>
        CLICK "ORACLE ANALYSIS" IN THE PANEL ABOVE TO ACTIVATE
      </div>

      {/* The drawer renders at fixed position over everything */}
      <OracleDrawer
        snapshot={MOCK_SNAPSHOT}
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}
