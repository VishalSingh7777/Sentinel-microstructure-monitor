
import React from 'react';
import { DecisionTrace, StressScore, SignalOutput, StressLevel, ConfidenceLevel } from '../types';

interface ExplainabilityLayerProps {
  trace: DecisionTrace | null;
  stress: StressScore | null;
  signals: Record<string, SignalOutput> | null;
}

export const ExplainabilityLayer: React.FC<ExplainabilityLayerProps> = ({ trace, stress, signals }) => {
  if (!trace || !stress || !signals) {
    return (
      <div className="bg-[#0d1117] border border-gray-800 rounded-xl p-8 flex flex-col items-center justify-center min-h-[400px]">
        <div className="w-12 h-12 border-2 border-dashed border-gray-700 rounded-full animate-spin mb-4" />
        <span className="text-gray-500 font-mono text-[10px] uppercase tracking-[0.3em]">Awaiting first tick logic audit...</span>
      </div>
    );
  }

  const getSignalShort = (name: string) => {
    if (name.includes('Liquidity')) return 'LIQ';
    if (name.includes('Flow')) return 'FLOW';
    if (name.includes('Volatility')) return 'VOL';
    if (name.includes('Forced')) return 'SELL';
    return 'UNK';
  };

  const getLevelColor = (level: StressLevel) => {
    switch (level) {
      case StressLevel.STABLE: return 'text-emerald-400';
      case StressLevel.ELEVATED: return 'text-yellow-400';
      case StressLevel.STRESSED: return 'text-orange-400';
      case StressLevel.UNSTABLE:
      case StressLevel.CRITICAL: return 'text-red-500';
      default: return 'text-gray-400';
    }
  };

  const getConfidenceColor = (conf: ConfidenceLevel | string) => {
    if (conf === ConfidenceLevel.HIGH) return 'text-emerald-400 bg-emerald-400/10';
    if (conf === ConfidenceLevel.MEDIUM) return 'text-yellow-400 bg-yellow-400/10';
    return 'text-gray-500 bg-gray-500/10';
  };

  return (
    <div className="bg-[#0d1117] border border-gray-800 rounded-xl overflow-hidden flex flex-col shadow-2xl animate-in fade-in duration-500">
      {/* Header Bar */}
      <div className="px-6 py-3 border-b border-gray-800 flex justify-between items-center bg-[#151a23]">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_8px_#22d3ee]" />
          <h2 className="text-[10px] font-black text-cyan-400 uppercase tracking-[0.3em] font-mono">Reasoning Engine Audit</h2>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px]">
          <span className="text-gray-600 uppercase">State Vector:</span>
          <span className="text-gray-400">{trace.previous_score.toFixed(1)} → <span className="text-white font-bold">{trace.final_score}</span></span>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 p-6">
        {/* Section 01: Weight Decomposition */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-4">
          <h3 className="text-[8px] text-cyan-400/60 uppercase tracking-widest font-mono">01 · Weight Decomposition</h3>
          <div className="space-y-4">
            {[...trace.weight_contributions].sort((a,b) => b.contribution - a.contribution).map((contrib, i) => {
              const sigData = signals[contrib.signal];
              return (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${sigData?.triggered ? 'bg-red-500 animate-pulse' : 'bg-gray-800'}`} />
                      <span className="text-[9px] font-black text-white font-mono">{getSignalShort(contrib.signal)}</span>
                    </div>
                    <span className="text-[9px] font-mono text-gray-500 italic">
                      {(contrib.weight * 100).toFixed(0)}% × {contrib.raw_value} = <span className="text-gray-300">{contrib.contribution.toFixed(1)}</span>
                    </span>
                  </div>
                  <div className="h-1.5 bg-gray-900 rounded-full overflow-hidden flex">
                    <div 
                      className="h-full bg-cyan-500/80 transition-all duration-700"
                      style={{ width: `${contrib.pct_of_total}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-2 pt-3 border-t border-gray-800/50 flex justify-between items-center">
            <span className="text-[9px] text-gray-500 font-mono uppercase">Σ Raw Weighted Score</span>
            <span className="text-sm font-black text-white font-mono">{trace.raw_score.toFixed(1)} <span className="text-[10px] font-normal text-gray-600">PTS</span></span>
          </div>
        </div>

        {/* Section 02: Score Pipeline */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-4">
          <h3 className="text-[8px] text-cyan-400/60 uppercase tracking-widest font-mono">02 · Score Pipeline</h3>
          <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-none">
            {/* Box 1: Raw */}
            <div className="flex-1 min-w-[100px] bg-gray-900/50 border border-gray-800 rounded p-3 flex flex-col items-center">
              <span className="text-[7px] text-gray-500 uppercase mb-1">Raw Weighted</span>
              <span className="text-lg font-black text-white font-mono">{trace.raw_score.toFixed(1)}</span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">Base Aggregation</span>
            </div>
            
            <div className="text-gray-700">→</div>

            {/* Box 2: Shock */}
            <div className={`flex-1 min-w-[100px] border rounded p-3 flex flex-col items-center transition-colors ${trace.signals_aligned > 0 ? 'bg-orange-500/10 border-orange-500/30' : 'bg-gray-900/50 border-gray-800'}`}>
              <span className="text-[7px] text-gray-500 uppercase mb-1">Shock Multiplier</span>
              <span className={`text-lg font-black font-mono ${trace.signals_aligned > 0 ? 'text-orange-400' : 'text-white'}`}>{trace.shock_multiplier.toFixed(2)}×</span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">{trace.signals_aligned} Aligned Signals</span>
            </div>

            <div className="text-gray-700">→</div>

            {/* Box 3: Pre-Smooth */}
            <div className="flex-1 min-w-[100px] bg-gray-900/50 border border-gray-800 rounded p-3 flex flex-col items-center">
              <span className="text-[7px] text-gray-500 uppercase mb-1">Pre-Smooth</span>
              <span className="text-lg font-black text-white font-mono">{trace.pre_smooth_score.toFixed(1)}</span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">Post-Multiplication</span>
            </div>

            <div className="text-gray-700">→</div>

            {/* Box 4: Alpha */}
            <div className={`flex-1 min-w-[100px] border rounded p-3 flex flex-col items-center transition-colors ${trace.smoothing_alpha === 0.35 ? 'bg-red-500/10 border-red-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}>
              <span className="text-[7px] text-gray-500 uppercase mb-1">Smoothing Alpha</span>
              <span className={`text-lg font-black font-mono ${trace.smoothing_alpha === 0.35 ? 'text-red-400' : 'text-emerald-400'}`}>{trace.smoothing_alpha}</span>
              <span className="text-[7px] text-gray-600 uppercase mt-1">{trace.smoothing_alpha === 0.35 ? 'Fast-Attack' : 'Slow-Decay'}</span>
            </div>

            <div className="text-gray-700">→</div>

            {/* Box 5: Final */}
            <div className="flex-1 min-w-[100px] bg-cyan-400/10 border border-cyan-400/40 rounded p-3 flex flex-col items-center shadow-[0_0_15px_rgba(34,211,238,0.1)]">
              <span className="text-[7px] text-cyan-400/80 uppercase mb-1">Final Score</span>
              <span className="text-lg font-black text-white font-mono">{trace.final_score}</span>
              <span className="text-[7px] text-cyan-400/60 uppercase mt-1">Audited Output</span>
            </div>
          </div>
        </div>

        {/* Section 03: Signal Confidence */}
        <div className="col-span-12 lg:col-span-6 flex flex-col gap-4">
          <h3 className="text-[8px] text-cyan-400/60 uppercase tracking-widest font-mono">03 · Signal Confidence Analysis</h3>
          <div className="grid grid-cols-1 gap-2">
            {Object.entries(trace.confidence_reasons).map(([sigName, reason], i) => {
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

        {/* Section 04: Decision Narrative */}
        <div className="col-span-12 lg:col-span-6 flex flex-col gap-4">
          <h3 className="text-[8px] text-cyan-400/60 uppercase tracking-widest font-mono">04 · Audit Narrative Summary</h3>
          <div className="bg-[#151a23] border border-gray-800 rounded-xl p-4 flex-1 shadow-inner relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-2 opacity-10 group-hover:opacity-20 transition-opacity">
              <svg className="w-12 h-12 text-cyan-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>
            </div>
            <p className="text-[11px] font-mono leading-relaxed text-gray-400 relative z-10 whitespace-pre-wrap">
              {trace.audit_narrative.split(/(\d+\.?\d*|STABLE|ELEVATED|STRESSED|UNSTABLE|CRITICAL|HIGH|MEDIUM|LOW)/g).map((part, i) => {
                const isNum = !isNaN(parseFloat(part)) && isFinite(Number(part));
                const isLevel = ['STABLE', 'ELEVATED', 'STRESSED', 'UNSTABLE', 'CRITICAL'].includes(part);
                const isConf = ['HIGH', 'MEDIUM', 'LOW'].includes(part);

                if (isNum) return <span key={i} className="text-cyan-400 font-black">{part}</span>;
                if (isLevel) return <span key={i} className={`font-black ${getLevelColor(part as StressLevel)}`}>{part}</span>;
                if (isConf) return <span key={i} className={`font-black ${part === 'HIGH' ? 'text-emerald-400' : part === 'MEDIUM' ? 'text-yellow-400' : 'text-gray-500'}`}>{part}</span>;
                return part;
              })}
            </p>
          </div>
        </div>
      </div>

      {/* Footer Audit Stamp */}
      <div className="px-6 py-2 border-t border-gray-800 flex justify-between items-center bg-[#0a0e14]/50">
        <span className="text-[8px] text-gray-700 font-black uppercase tracking-widest font-mono">Sentinel · Reasoning Audit v1.0</span>
        <span className="text-[8px] text-gray-700 font-mono tracking-tighter">TIMESTAMP: {new Date(trace.timestamp).toISOString()}</span>
      </div>
    </div>
  );
};
