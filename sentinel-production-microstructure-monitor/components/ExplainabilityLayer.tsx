import React from 'react';
import { DecisionTrace, StressScore, SignalOutput, StressLevel, ConfidenceLevel } from '../types';

interface ExplainabilityLayerProps {
  trace:   DecisionTrace | null;
  stress:  StressScore   | null;
  signals: Record<string, SignalOutput> | null;
}

// Safe number: if the value is undefined/NaN/Infinity, return 0.
// This is the defensive layer between runtime data and .toFixed() calls.
// TypeScript says trace fields are numbers, but if a future engine build
// returns an incomplete object, undefined.toFixed() would crash the app.
const n = (v: number | undefined | null, fallback = 0): number =>
  typeof v === 'number' && isFinite(v) && !isNaN(v) ? v : fallback;

export const ExplainabilityLayer: React.FC<ExplainabilityLayerProps> = ({ trace, stress, signals }) => {
  if (!trace || !stress || !signals) {
    return (
      <div className="bg-[#0d1117] border border-gray-800 rounded-xl p-8 flex flex-col items-center justify-center min-h-[400px]">
        <div className="w-12 h-12 border-2 border-dashed border-gray-700 rounded-full animate-spin mb-4" />
        <span className="text-gray-500 font-mono text-[10px] uppercase tracking-[0.3em]">Awaiting first tick...</span>
      </div>
    );
  }

  const getSignalShort = (name: string) => {
    if (name.includes('Liquidity'))  return 'LIQ';
    if (name.includes('Flow'))       return 'FLOW';
    if (name.includes('Volatility')) return 'VOL';
    if (name.includes('Forced'))     return 'SELL';
    return 'UNK';
  };

  const getLevelColor = (level: StressLevel) => {
    switch (level) {
      case StressLevel.STABLE:   return 'text-emerald-400';
      case StressLevel.ELEVATED: return 'text-yellow-400';
      case StressLevel.STRESSED: return 'text-orange-400';
      case StressLevel.UNSTABLE:
      case StressLevel.CRITICAL: return 'text-red-500';
      default:                   return 'text-gray-400';
    }
  };

  const getConfidenceColor = (conf: ConfidenceLevel | string) => {
    if (conf === ConfidenceLevel.HIGH)   return 'text-emerald-400 bg-emerald-400/10';
    if (conf === ConfidenceLevel.MEDIUM) return 'text-yellow-400 bg-yellow-400/10';
    return 'text-gray-500 bg-gray-500/10';
  };

  // Re-derive the EMA for independent verification of the engine's output.
  // All trace fields wrapped in n() so undefined/NaN fields never crash this calculation.
  const smoothingAlpha   = n(trace.smoothing_alpha, 0.35);
  const preSmooth        = n(trace.pre_smooth_score, 0);
  const previousScore    = n(trace.previous_score,   0);
  const rawScore         = n(trace.raw_score,        0);
  const shockMultiplier  = n(trace.shock_multiplier, 1);

  const derivedSmoothed  = smoothingAlpha * preSmooth + (1 - smoothingAlpha) * previousScore;
  const derivedFinal     = Math.round(derivedSmoothed);
  const verified         = derivedFinal === n(trace.final_score, -1);

  return (
    <div className="bg-[#0d1117] border border-gray-800 rounded-xl overflow-hidden flex flex-col shadow-2xl animate-in fade-in duration-500">

      {/* ── Header ── */}
      <div className="px-6 py-3 border-b border-gray-800 flex justify-between items-center bg-[#151a23]">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee]" />
          <h2 className="text-[10px] font-black text-cyan-400 uppercase tracking-[0.3em] font-mono">Score Computation Trace</h2>
        </div>
        <div className="flex items-center gap-6 font-mono text-[10px]">
          <span className="text-gray-600 uppercase">
            Prev <span className="text-gray-400">{previousScore.toFixed(1)}</span>
            <span className="text-gray-700 mx-2">→</span>
            Final <span className="text-white font-bold">{n(trace.final_score, 0)}</span>
          </span>
          <span className={`text-[8px] font-black px-2 py-0.5 rounded uppercase tracking-widest border ${verified ? 'text-emerald-400 bg-emerald-400/10 border-emerald-800' : 'text-red-400 bg-red-400/10 border-red-900'}`}>
            {verified ? '✓ Math verified' : '⚠ Mismatch'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 p-6">

        {/* ── 01: Weight Decomposition ── */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-4">
          <h3 className="text-[8px] text-cyan-400/60 uppercase tracking-widest font-mono">01 · Weight Decomposition</h3>
          <div className="space-y-4">
            {(Array.isArray(trace.weight_contributions) ? [...trace.weight_contributions] : [])
              .sort((a, b) => n(b.contribution) - n(a.contribution))
              .map((contrib, i) => {
                const sigData       = signals[contrib.signal];
                // Re-derive from first principles so display is verifiable independently
                const weight        = n(contrib.weight,    0);
                const rawVal        = n(contrib.raw_value, 0);
                const derivedContrib = weight * rawVal;
                const derivedPct     = rawScore > 0 ? (derivedContrib / rawScore) * 100 : 0;
                return (
                  <div key={i} className="flex flex-col gap-1.5">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${sigData?.triggered ? 'bg-red-500 animate-pulse' : 'bg-gray-800'}`} />
                        <span className="text-[9px] font-black text-white font-mono">{getSignalShort(contrib.signal)}</span>
                      </div>
                      <span className="text-[9px] font-mono text-gray-500 italic">
                        {(weight * 100).toFixed(0)}% × {rawVal} = <span className="text-gray-300">{derivedContrib.toFixed(1)}</span>
                        <span className="text-gray-700 ml-1">({derivedPct.toFixed(0)}%)</span>
                      </span>
                    </div>
                    <div className="h-1.5 bg-gray-900 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-cyan-500/80 transition-all duration-700"
                        style={{ width: `${Math.min(100, Math.max(0, n(derivedPct, 0)))}%` }}
                      />
                    </div>
                  </div>
                );
              })}
          </div>
          <div className="mt-2 pt-3 border-t border-gray-800/50 flex justify-between items-center">
            <span className="text-[9px] text-gray-500 font-mono uppercase">Σ Raw Weighted Score</span>
            <span className="text-sm font-black text-white font-mono">
              {rawScore.toFixed(1)} <span className="text-[10px] font-normal text-gray-600">pts</span>
            </span>
          </div>
        </div>

        {/* ── 02: Score Pipeline ── */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">
          <h3 className="text-[8px] text-cyan-400/60 uppercase tracking-widest font-mono">02 · Score Pipeline</h3>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 scrollbar-none">

            {/* Raw */}
            <div className="flex-1 min-w-[82px] bg-gray-900/50 border border-gray-800 rounded p-2.5 flex flex-col items-center">
              <span className="text-[7px] text-gray-500 uppercase mb-1">Raw Weighted</span>
              <span className="text-base font-black text-white font-mono">{rawScore.toFixed(1)}</span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">Σ(val × wt)</span>
            </div>

            <span className="text-gray-700 text-[10px]">×</span>

            {/* Shock */}
            <div className={`flex-1 min-w-[82px] border rounded p-2.5 flex flex-col items-center ${(trace.signals_aligned ?? 0) > 0 ? 'bg-orange-500/10 border-orange-500/30' : 'bg-gray-900/50 border-gray-800'}`}>
              <span className="text-[7px] text-gray-500 uppercase mb-1">Shock</span>
              <span className={`text-base font-black font-mono ${(trace.signals_aligned ?? 0) > 0 ? 'text-orange-400' : 'text-white'}`}>
                {shockMultiplier.toFixed(2)}×
              </span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">
                1+({trace.signals_aligned ?? 0}×0.08)
              </span>
            </div>

            <span className="text-gray-700 text-[10px]">=</span>

            {/* Pre-Smooth */}
            <div className="flex-1 min-w-[82px] bg-gray-900/50 border border-gray-800 rounded p-2.5 flex flex-col items-center">
              <span className="text-[7px] text-gray-500 uppercase mb-1">Pre-Smooth</span>
              <span className="text-base font-black text-white font-mono">{preSmooth.toFixed(1)}</span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">cap 100</span>
            </div>

            <span className="text-gray-700 text-[9px] font-mono">EMA↓</span>

            {/* Prev Score */}
            <div className="flex-1 min-w-[82px] bg-gray-900/30 border border-gray-700/40 rounded p-2.5 flex flex-col items-center">
              <span className="text-[7px] text-gray-500 uppercase mb-1">Prev Score</span>
              <span className="text-base font-black text-gray-400 font-mono">{previousScore.toFixed(1)}</span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">last tick</span>
            </div>

            <span className="text-gray-700 text-[10px]">→</span>

            {/* Alpha */}
            <div className={`flex-1 min-w-[82px] border rounded p-2.5 flex flex-col items-center ${smoothingAlpha === 0.35 ? 'bg-red-500/10 border-red-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}>
              <span className="text-[7px] text-gray-500 uppercase mb-1">Alpha α</span>
              <span className={`text-base font-black font-mono ${smoothingAlpha === 0.35 ? 'text-red-400' : 'text-emerald-400'}`}>
                {smoothingAlpha}
              </span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">
                {smoothingAlpha === 0.35 ? 'Fast-Attack' : 'Slow-Decay'}
              </span>
            </div>

            <span className="text-gray-700 text-[10px]">=</span>

            {/* Final */}
            <div className="flex-1 min-w-[82px] bg-cyan-400/10 border border-cyan-400/40 rounded p-2.5 flex flex-col items-center shadow-[0_0_15px_rgba(34,211,238,0.1)]">
              <span className="text-[7px] text-cyan-400/80 uppercase mb-1">Final Score</span>
              <span className="text-base font-black text-white font-mono">{n(trace.final_score, 0)}</span>
              <span className="text-[7px] text-cyan-400/60 uppercase mt-1">rounded</span>
            </div>
          </div>

          {/* EMA formula — all values computed through n() so never crash */}
          <div className="text-[9px] font-mono text-gray-600 bg-gray-900/40 rounded px-3 py-2 border border-gray-800/60">
            <span className="text-gray-500">EMA = </span>
            <span className="text-gray-300">{smoothingAlpha}</span>
            <span className="text-gray-600"> × </span>
            <span className="text-gray-300">{preSmooth.toFixed(1)}</span>
            <span className="text-gray-600"> + </span>
            <span className="text-gray-300">{(1 - smoothingAlpha).toFixed(2)}</span>
            <span className="text-gray-600"> × </span>
            <span className="text-gray-300">{previousScore.toFixed(1)}</span>
            <span className="text-gray-600"> = </span>
            <span className="text-cyan-400 font-black">{derivedSmoothed.toFixed(2)}</span>
            <span className="text-gray-600"> → round → </span>
            <span className="text-white font-black">{derivedFinal}</span>
            <span className={`ml-2 ${verified ? 'text-emerald-500' : 'text-red-500'}`}>{verified ? '✓' : '⚠'}</span>
          </div>
        </div>

        {/* ── 03: Signal Confidence ── */}
        <div className="col-span-12 lg:col-span-6 flex flex-col gap-4">
          <h3 className="text-[8px] text-cyan-400/60 uppercase tracking-widest font-mono">03 · Signal Confidence</h3>
          <div className="grid grid-cols-1 gap-2">
            {Object.entries(trace.confidence_reasons ?? {}).map(([sigName, reason], i) => {
              const sig = signals[sigName];
              return (
                <div key={i} className="bg-gray-900/30 border border-gray-800/50 rounded-lg p-3 flex items-center justify-between group hover:border-gray-700 transition-all">
                  <div className="flex items-center gap-4">
                    <div className={`w-2 h-2 rounded-full ${sig?.triggered ? 'bg-red-500' : 'bg-emerald-500'}`} />
                    <div className="flex flex-col">
                      <span className="text-[9px] font-black text-gray-400 font-mono uppercase tracking-tighter">{getSignalShort(sigName)}</span>
                      <span className="text-[8px] text-gray-600 font-mono italic">{reason}</span>
                    </div>
                  </div>
                  <span className={`text-[8px] font-black px-2 py-0.5 rounded ${getConfidenceColor(sig?.confidence || 'LOW')}`}>
                    {sig?.confidence || 'LOW'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── 04: Computation Summary ── */}
        <div className="col-span-12 lg:col-span-6 flex flex-col gap-4">
          <h3 className="text-[8px] text-cyan-400/60 uppercase tracking-widest font-mono">04 · Computation Summary</h3>
          <div className="bg-[#151a23] border border-gray-800 rounded-xl p-4 flex-1 shadow-inner relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity">
              <svg className="w-12 h-12 text-cyan-400" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
              </svg>
            </div>
            <p className="text-[11px] font-mono leading-relaxed text-gray-400 relative z-10">
              {(trace.audit_narrative || 'No computation summary available.')
                .split(/(\d+\.?\d*|STABLE|ELEVATED|STRESSED|UNSTABLE|CRITICAL|HIGH|MEDIUM|LOW)/g)
                .map((part, i) => {
                  const isNum   = !isNaN(parseFloat(part)) && isFinite(Number(part));
                  const isLevel = ['STABLE','ELEVATED','STRESSED','UNSTABLE','CRITICAL'].includes(part);
                  const isConf  = ['HIGH','MEDIUM','LOW'].includes(part);
                  if (isNum)   return <span key={i} className="text-cyan-400 font-black">{part}</span>;
                  if (isLevel) return <span key={i} className={`font-black ${getLevelColor(part as StressLevel)}`}>{part}</span>;
                  if (isConf)  return <span key={i} className={`font-black ${part === 'HIGH' ? 'text-emerald-400' : part === 'MEDIUM' ? 'text-yellow-400' : 'text-gray-500'}`}>{part}</span>;
                  return part;
                })}
            </p>
          </div>
        </div>

      </div>

      {/* ── Footer ── */}
      <div className="px-6 py-2 border-t border-gray-800 flex justify-between items-center bg-[#0a0e14]/50">
        <span className="text-[8px] text-gray-700 font-black uppercase tracking-widest font-mono">Sentinel · Score Computation Trace v1.0</span>
        <span className="text-[8px] text-gray-700 font-mono tracking-tighter">
          TIMESTAMP: {trace.timestamp ? new Date(trace.timestamp).toISOString() : '--'}
        </span>
      </div>
    </div>
  );
};
