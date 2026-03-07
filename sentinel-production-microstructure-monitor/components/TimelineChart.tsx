import React, { useState, useEffect, useRef } from 'react';
import {
  ComposedChart, Area, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceLine
} from 'recharts';
import { TimelineDataPoint } from '../types';
import { TYPOGRAPHY } from '../constants';

// ─────────────────────────────────────────────────────────────────────────────
// THE CRASH — ROOT CAUSE AND FIX
// ─────────────────────────────────────────────────────────────────────────────
// Bug: Recharts 2.x <ResponsiveContainer> uses its own ResizeObserver internally.
// In React 19's concurrent renderer, that observer callback can fire mid-render
// when the chart container still has width=0 (layout not yet committed to DOM).
// Recharts then calls getNiceTickValues(0, 0, n) → step=0 →
// invariant(isFinite(step) && step > 0) throws → "Invariant failed" crash.
//
// Why it's RANDOM (not at a fixed position): it's a scheduler race between
// React's concurrent renderer and the ResizeObserver callback — not tied to
// data values. It fires on both forward playback (rapid setTimelineData every
// 40-1000ms) AND on seek (synchronous replay + single setState) for the same
// reason: both cause fast re-renders that can catch the container at width=0.
//
// FIX: Remove <ResponsiveContainer> entirely. Use our own ResizeObserver via
// useRef + useEffect. Only mount <ComposedChart> once we have confirmed real
// pixel dimensions (>10). Pass explicit width/height numbers to the chart.
// Recharts never receives width=0 again.
//
// SECONDARY FIX: Replace domain={['dataMin','dataMax']} on the XAxis with an
// explicit computed domain that guarantees min < max unconditionally. If all
// timestamps are identical (edge case during a reset/transition batch), the
// 'dataMin'/'dataMax' strategy collapses to [t,t] → same step=0 crash.
// Our domain adds a +1ms fallback so the invariant can never fire from data.
//
// BUG FIX: ReferenceArea CRITICAL zone was y1=85. Engine classifies score>=80
// as CRITICAL. The zone boundary must be 80, not 85. The old value left a
// 5-point gap (80-84) where the gauge showed CRITICAL but the chart showed
// nothing highlighted — a silent visual lie.
// ─────────────────────────────────────────────────────────────────────────────

interface TimelineChartProps {
  data: TimelineDataPoint[];
}

export const TimelineChart: React.FC<TimelineChartProps> = ({ data }) => {
  // ── Container measurement (replaces ResponsiveContainer) ──────────────────
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.floor(entry.contentRect.width);
      const h = Math.floor(entry.contentRect.height);
      // Never let width=0 or height=0 reach Recharts
      if (w > 10 && h > 10) setDims({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Data sanitisation ──────────────────────────────────────────────────────
  const cleanData = data.filter(d =>
    d != null &&
    typeof d.price     === 'number' && isFinite(d.price)     && !isNaN(d.price)     && d.price > 0 &&
    typeof d.stress    === 'number' && isFinite(d.stress)    && !isNaN(d.stress) &&
    typeof d.timestamp === 'number' && isFinite(d.timestamp) && !isNaN(d.timestamp)
  );

  const markers = cleanData.filter(d => d.label);

  // ── Price domain — explicit, never 'auto' ──────────────────────────────────
  const prices   = cleanData.map(d => d.price);
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 1;
  const pricePad = (maxPrice - minPrice) * 0.05 || 500;
  const priceDomain: [number, number] = [
    Math.floor(minPrice - pricePad),
    Math.ceil(maxPrice  + pricePad),
  ];

  // ── Timestamp domain — guaranteed min < max ────────────────────────────────
  // SECONDARY FIX: compute explicitly instead of using 'dataMin'/'dataMax'.
  // +1ms fallback ensures domain[0] !== domain[1] even if all points share a ts.
  const timestamps = cleanData.map(d => d.timestamp);
  const minTs      = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxTs      = timestamps.length > 0 ? Math.max(...timestamps) : 1;
  const tsDomain: [number, number] = [minTs, maxTs > minTs ? maxTs : minTs + 1];

  // ── Guard: require ≥2 points ───────────────────────────────────────────────
  if (cleanData.length < 2) {
    return (
      <div className="w-full h-[400px] bg-[#151a23] rounded-xl p-4 border border-gray-800 flex items-center justify-center">
        <span className="text-gray-700 font-mono text-[10px] uppercase tracking-widest">
          Awaiting market data...
        </span>
      </div>
    );
  }

  // pointOfNoReturn marker — resolved once, not inside JSX map
  const ponrPoint = cleanData.find(d => d.pointOfNoReturn) ?? null;

  return (
    <div className="w-full h-[400px] bg-[#151a23] rounded-xl p-4 border border-gray-800 relative">
      <h2 className={`${TYPOGRAPHY.h2} mb-4 text-gray-400 text-sm tracking-widest uppercase`}>
        Market Structure vs. Price
      </h2>

      {/* Measured wrapper — our ResizeObserver watches this div, not Recharts */}
      <div ref={wrapperRef} style={{ width: '100%', height: 'calc(100% - 44px)' }}>

        {/* Only render once we have confirmed real pixel dimensions */}
        {dims.w > 10 && dims.h > 10 && (
          <ComposedChart
            width={dims.w}
            height={dims.h}
            data={cleanData}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#4b5563" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#4b5563" stopOpacity={0}   />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />

            <XAxis
              dataKey="timestamp"
              type="number"
              domain={tsDomain}
              tickFormatter={t =>
                new Date(t as number).toLocaleTimeString([], {
                  hour12: false, minute: '2-digit', second: '2-digit',
                })
              }
              stroke="#4b5563"
              fontSize={10}
              fontFamily="JetBrains Mono"
              hide
            />

            <YAxis
              yAxisId="price"
              domain={priceDomain}
              stroke="#9ca3af"
              fontSize={10}
              fontFamily="JetBrains Mono"
              tickFormatter={v => `$${Math.round(v as number).toLocaleString()}`}
            />

            <YAxis
              yAxisId="stress"
              orientation="right"
              domain={[0, 100]}
              stroke="#ef4444"
              fontSize={10}
              fontFamily="JetBrains Mono"
            />

            <Tooltip
              contentStyle={{
                backgroundColor: '#0a0e14',
                border: '1px solid #374151',
                borderRadius: '8px',
                fontSize: '11px',
              }}
              labelFormatter={t => new Date(t as number).toLocaleTimeString()}
              isAnimationActive={false}
            />

            <Area
              yAxisId="price"
              type="monotone"
              dataKey="price"
              stroke="#6b7280"
              fill="url(#priceGradient)"
              isAnimationActive={false}
            />

            <Line
              yAxisId="stress"
              type="monotone"
              dataKey="stress"
              stroke="#ef4444"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />

            {/*
              BUG FIX: y1 was 85, corrected to 80.
              Engine's classifyLevel: score < 80 = UNSTABLE, >= 80 = CRITICAL.
              The orange zone covers UNSTABLE (60-79).
              The red zone covers CRITICAL (80-100).
              Previous y1=85 caused a 5pt gap (80-84) where the gauge showed
              CRITICAL but the chart rendered no highlight — incorrect.
            */}
            <ReferenceArea yAxisId="stress" y1={60} y2={80}  fill="#f97316" fillOpacity={0.05} />
            <ReferenceArea yAxisId="stress" y1={80} y2={100} fill="#dc2626" fillOpacity={0.05} />

            {markers.map((m, idx) => (
              <ReferenceLine
                key={idx}
                x={m.timestamp}
                stroke="#4b5563"
                strokeDasharray="3 3"
                label={{
                  value:      m.label ?? '',
                  position:   'insideTopLeft',
                  fill:       '#9ca3af',
                  fontSize:   9,
                  fontWeight: 'bold',
                  fontFamily: 'JetBrains Mono',
                  dy:         10,
                }}
              />
            ))}

            {ponrPoint && (
              <ReferenceLine
                yAxisId="stress"
                x={ponrPoint.timestamp}
                stroke="#dc2626"
                strokeDasharray="5 5"
                label={{
                  value:      'INSTABILITY LOCK-IN',
                  position:   'top',
                  fill:       '#dc2626',
                  fontSize:   10,
                  fontWeight: 'bold',
                }}
              />
            )}
          </ComposedChart>
        )}
      </div>
    </div>
  );
};
