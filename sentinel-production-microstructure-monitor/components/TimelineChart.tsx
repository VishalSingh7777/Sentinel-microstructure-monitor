import React from 'react';
import { 
  ResponsiveContainer, ComposedChart, Area, Line, 
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea, ReferenceLine 
} from 'recharts';
import { TimelineDataPoint, StressLevel } from '../types';
import { THEME, TYPOGRAPHY } from '../constants';

interface TimelineChartProps {
  data: TimelineDataPoint[];
}

export const TimelineChart: React.FC<TimelineChartProps> = ({ data }) => {
  // Sanitize before recharts sees it — NaN/Infinity causes "Invariant failed" crash
  const cleanData = data.filter(d => 
    d != null &&
    typeof d.price === 'number' && isFinite(d.price) && !isNaN(d.price) && d.price > 0 &&
    typeof d.stress === 'number' && isFinite(d.stress) && !isNaN(d.stress) &&
    typeof d.timestamp === 'number' && isFinite(d.timestamp)
  );

  const markers = cleanData.filter(d => d.label);

  // Compute explicit price domain from clean data — never use 'auto' with potentially bad data
  const prices = cleanData.map(d => d.price);
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 1;
  const pricePadding = (maxPrice - minPrice) * 0.05 || 100;
  const priceDomain: [number, number] = [
    Math.floor(minPrice - pricePadding),
    Math.ceil(maxPrice + pricePadding)
  ];

  if (cleanData.length === 0) {
    return (
      <div className="w-full h-[400px] bg-[#151a23] rounded-xl p-4 border border-gray-800 relative flex items-center justify-center">
        <span className="text-gray-700 font-mono text-[10px] uppercase tracking-widest">Awaiting market data...</span>
      </div>
    );
  }

  return (
    <div className="w-full h-[400px] bg-[#151a23] rounded-xl p-4 border border-gray-800 relative">
      <h2 className={`${TYPOGRAPHY.h2} mb-4 text-gray-400 text-sm tracking-widest uppercase`}>
        Market Structure vs. Price
      </h2>
      <ResponsiveContainer width="100%" height="90%">
        <ComposedChart data={cleanData}>
          <defs>
            <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4b5563" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#4b5563" stopOpacity={0} />
            </linearGradient>
          </defs>
          
          <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
          
          <XAxis 
            dataKey="timestamp" 
            type="number" 
            domain={['dataMin', 'dataMax']}
            tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}
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
            tickFormatter={(v) => `$${Math.round(v).toLocaleString()}`}
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
            contentStyle={{ backgroundColor: '#0a0e14', border: '1px solid #374151', borderRadius: '8px', fontSize: '11px' }}
            labelFormatter={(t) => new Date(t).toLocaleTimeString()}
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

          <ReferenceArea yAxisId="stress" y1={70} y2={85} fill="#f97316" fillOpacity={0.05} />
          <ReferenceArea yAxisId="stress" y1={85} y2={100} fill="#dc2626" fillOpacity={0.05} />

          {markers.map((m, idx) => (
            <ReferenceLine
              key={idx}
              x={m.timestamp}
              stroke="#4b5563"
              strokeDasharray="3 3"
              label={{ 
                value: m.label, 
                position: 'insideTopLeft', 
                fill: '#9ca3af', 
                fontSize: 9, 
                fontWeight: 'bold',
                fontFamily: 'JetBrains Mono',
                dy: 10
              }}
            />
          ))}

          {cleanData.find(d => d.pointOfNoReturn) && (
            <ReferenceLine
              yAxisId="stress"
              x={cleanData.find(d => d.pointOfNoReturn)?.timestamp}
              stroke="#dc2626"
              strokeDasharray="5 5"
              label={{ value: 'INSTABILITY LOCK-IN', position: 'top', fill: '#dc2626', fontSize: 10, fontWeight: 'bold' }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};
