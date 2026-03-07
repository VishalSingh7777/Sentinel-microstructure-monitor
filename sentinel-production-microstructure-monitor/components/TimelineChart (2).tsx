import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import {
  ComposedChart, Area, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceLine
} from 'recharts';
import { TimelineDataPoint } from '../types';
import { TYPOGRAPHY } from '../constants';

// ─────────────────────────────────────────────────────────────────────────────
// WHY ResponsiveContainer WAS REMOVED
// ─────────────────────────────────────────────────────────────────────────────
// Recharts 2.x ResponsiveContainer uses its own ResizeObserver. In React 19's
// concurrent renderer, that observer callback fires mid-render when the container
// still has width=0. Recharts calls getNiceTickValues(0,0,n) → step=0 →
// invariant(step > 0) throws "Invariant failed". Race is random → random crash.
//
// FIX: Removed ResponsiveContainer. We measure width via ResizeObserver ourselves
// (useLayoutEffect for synchronous first measurement so the chart renders on the
// very first paint). Height is a constant — no percentage chains that could
// silently collapse to 0 in a flex/grid ancestor context.
//
// SECONDARY FIX: XAxis domain is now an explicit [minTs, maxTs+1] instead of
// ['dataMin','dataMax'] — if all timestamps happen to be equal during a reset
// transition, dataMin===dataMax → same step=0 invariant crash.
//
// BUG FIX: ReferenceArea CRITICAL band was y1=85. Engine classifies score≥80 as
// CRITICAL. Fixed to y1=80 so the chart matches the gauge and breach log.
// ─────────────────────────────────────────────────────────────────────────────

const CHART_HEIGHT = 330; // fixed — no percentage calc chains

interface TimelineChartProps {
  data: TimelineDataPoint[];
}

export const TimelineChart: React.FC<TimelineChartProps> = ({ data }) => {

  // ── Width measurement ──────────────────────────────────────────────────────
  // useLayoutEffect fires synchronously after DOM commit, so the chart gets
  // real pixel width on the very first paint rather than rendering invisible.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);

  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    // Measure immediately after mount
    const w = el.getBoundingClientRect().width;
    if (w > 10) setChartWidth(Math.floor(w));
  }, []);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (w > 10) setChartWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Data sanitisation ──────────────────────────────────────────────────────
  const cleanData = data.filter(d =>
    d != null &&
    typeof d.price     === 'number' && isFinite(d.price)     && d.price > 0 &&
    typeof d.stress    === 'number' && isFinite(d.stress) &&
    typeof d.timestamp === 'number' && isFinite(d.timestamp)
  );

  const markers = cleanData.filter(d => d.label);

  // ── Price domain — explicit, never 'auto' ──────────────────────────────────
  const prices     = cleanData.map(d => d.price);
  const minPrice   = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice   = prices.length > 0 ? Math.max(...prices) : 1;
  const pricePad   = (maxPrice - minPrice) * 0.05 || 500;
  const priceDomain: [number, number] = [
    Math.floor(minPrice - pricePad),
    Math.ceil(maxPrice  + pricePad),
  ];

  // ── Timestamp domain — guaranteed min < max ────────────────────────────────
  const tss    = cleanData.map(d => d.timestamp);
  const minTs  = tss.length > 0 ? Math.min(...tss) : 0;
  const maxTs  = tss.length > 0 ? Math.max(...tss) : 1;
  const tsDomain: [number, number] = [minTs, maxTs > minTs ? maxTs : minTs + 1];

  // pointOfNoReturn resolved once outside JSX
  const ponrPoint = cleanData.find(d => d.pointOfNoReturn) ?? null;

  // ── Guard ──────────────────────────────────────────────────────────────────
  if (cleanData.length < 2) {
    return (
      <div className="w-full h-[400px] bg-[#151a23] rounded-xl p-4 border border-gray-800 flex items-center justify-center">
        <span className="text-gray-700 font-mono text-[10px] uppercase tracking-widest">
          Awaiting market data...
        </span>
      </div>
    );
  }

  return (
    <div className="w-full h-[400px] bg-[#151a23] rounded-xl p-4 border border-gray-800 relative">
      <h2 className={`${TYPOGRAPHY.h2} mb-3 text-gray-400 text-sm tracking-widest uppercase`}>
        Market Structure vs. Price
      </h2>

      {/* Width-measuring wrapper — full width, fixed height, no calc percentages */}
      <div ref={wrapperRef} style={{ width: '100%', height: CHART_HEIGHT }}>
        {chartWidth > 10 && (
          <ComposedChart
            width={chartWidth}
            height={CHART_HEIGHT}
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
              tickFormatter={t => new Date(t as number).toLocaleTimeString([], {
                hour12: false, minute: '2-digit', second: '2-digit',
              })}
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

            {/* UNSTABLE zone 60-79, CRITICAL zone 80-100 — matches engine thresholds */}
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
