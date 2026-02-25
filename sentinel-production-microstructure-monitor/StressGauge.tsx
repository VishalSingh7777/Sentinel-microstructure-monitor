
import React, { useMemo, useEffect, useRef } from 'react';
import { StressScore, StressLevel } from '../types';
import { THEME } from '../constants';

interface StressGaugeProps {
  stress: StressScore;
}

export const StressGauge: React.FC<StressGaugeProps> = ({ stress }) => {
  const { score, level, breakdown } = stress;
  const activeColor = THEME.stress[level] || '#10b981';
  
  const size = 320;
  const center = size / 2;
  const radius = 115;
  const strokeWidth = 12;
  
  const startAngle = 135;
  const endAngle = 405; 
  const angleRange = endAngle - startAngle;

  const toRad = (deg: number) => (deg * Math.PI) / 180;
  
  const getCoords = (angle: number, r: number) => {
    const rad = toRad(angle);
    return {
      x: center + r * Math.cos(rad),
      y: center + r * Math.sin(rad),
    };
  };

  const arcPath = useMemo(() => {
    const start = getCoords(startAngle, radius);
    const end = getCoords(endAngle, radius);
    const largeArcFlag = angleRange <= 180 ? 0 : 1;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
  }, [center, radius, startAngle, endAngle, angleRange]);

  // Momentum Tracking for UI feedback
  const prevScoreRef = useRef(score);
  const delta = score - prevScoreRef.current;
  useEffect(() => {
    prevScoreRef.current = score;
  }, [score]);

  const ticks = useMemo(() => {
    const tickElements = [];
    const count = 60;
    for (let i = 0; i <= count; i++) {
      const angle = startAngle + (i / count) * angleRange;
      const isMajor = i % 10 === 0;
      const innerR = radius - (isMajor ? 20 : 12);
      const outerR = radius - 4;
      const start = getCoords(angle, innerR);
      const end = getCoords(angle, outerR);
      
      const isActive = (i / count) * 100 <= score;

      tickElements.push(
        <line
          key={i}
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
          stroke={isActive ? activeColor : '#374151'}
          strokeWidth={isMajor ? 2 : 1}
          opacity={isActive ? 0.9 : 0.2}
          strokeLinecap="round"
          style={{ transition: 'stroke 0.3s ease, opacity 0.3s ease' }}
        />
      );
    }
    return tickElements;
  }, [center, radius, startAngle, angleRange, score, activeColor]);

  const clampedScore = Math.min(100, Math.max(0, score));
  const arcLength = (angleRange / 360) * 2 * Math.PI * radius;
  const dashOffset = arcLength - (clampedScore / 100) * arcLength;
  const rotationAngle = (clampedScore / 100) * angleRange;
  const knobStartCoords = getCoords(startAngle, radius);

  const isCritical = level === StressLevel.CRITICAL || level === StressLevel.UNSTABLE;

  return (
    <div className={`relative flex flex-col items-center justify-center p-4 select-none ${isCritical ? 'animate-[shake_0.4s_infinite]' : ''}`}>
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(1px); }
          75% { transform: translateX(-1px); }
        }
      `}</style>
      
      <div style={{ width: size, height: size }} className="relative">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <defs>
            <filter id="glow-stress" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            
            <radialGradient id="gaugeBg" cx="50%" cy="50%" r="60%">
                <stop offset="0%" stopColor={activeColor} stopOpacity="0.15" />
                <stop offset="70%" stopColor="transparent" stopOpacity="0" />
            </radialGradient>

            <linearGradient id="barGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor={activeColor} stopOpacity="0.8" />
                <stop offset="100%" stopColor={activeColor} stopOpacity="1" />
            </linearGradient>
          </defs>

          {/* Background Atmosphere */}
          <circle cx={center} cy={center} r={radius + 30} fill="url(#gaugeBg)" opacity="0.6" style={{ transition: 'fill 0.5s ease' }} />

          {/* Static Track */}
          <path
            d={arcPath}
            fill="none"
            stroke="#1f2937"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            opacity="0.3"
          />

          {/* Ticks */}
          <g>{ticks}</g>

          {/* Dynamic Stress Indicator Bar */}
          <path
            d={arcPath}
            fill="none"
            stroke="url(#barGradient)"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={arcLength}
            strokeDashoffset={dashOffset}
            filter="url(#glow-stress)"
            style={{
              transition: 'stroke-dashoffset 0.6s cubic-bezier(0.2, 0.8, 0.2, 1), stroke 0.5s ease',
            }}
          />

          {/* Knob/Pointer */}
          <g
            style={{
              transformOrigin: `${center}px ${center}px`,
              transform: `rotate(${rotationAngle}deg)`,
              transition: 'transform 0.6s cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          >
            <circle
              cx={knobStartCoords.x}
              cy={knobStartCoords.y}
              r={6}
              fill="#0a0e14"
              stroke={activeColor}
              strokeWidth="3"
              filter="url(#glow-stress)"
            />
          </g>
        </svg>

        {/* HUD Data Overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-4">
          <div className={`text-[9px] font-mono font-bold mb-2 flex items-center gap-1.5 transition-opacity duration-500 bg-[#0a0e14]/80 px-2 py-0.5 rounded-full border border-gray-800 ${delta === 0 ? 'opacity-0' : 'opacity-100'} ${delta > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
            {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}
          </div>

          <div className="flex flex-col items-center relative z-10">
            <span 
              className="text-8xl font-black font-mono tracking-tighter tabular-nums leading-none" 
              style={{ color: activeColor, textShadow: `0 0 40px ${activeColor}50` }}
            >
              {Math.round(clampedScore)}
            </span>
            <span className="text-xs text-gray-500 font-mono tracking-widest mt-1 opacity-60">INDEX SCORE</span>
          </div>
          
          <div className="mt-6 flex flex-col items-center gap-4 w-full px-12">
            <div 
              className="px-4 py-1.5 rounded text-center min-w-[120px] backdrop-blur-md transition-colors duration-500 border"
              style={{ 
                  backgroundColor: `${activeColor}15`, 
                  borderColor: `${activeColor}30`,
                  boxShadow: `0 0 15px ${activeColor}10`
              }}
            >
              <span className="text-[10px] font-black tracking-[0.25em] uppercase" style={{ color: activeColor }}>
                {level}
              </span>
            </div>

            {/* Micro-Vector Monitoring */}
            <div className="flex justify-between w-full gap-2 px-2 py-2 bg-[#0a0e14]/80 border border-gray-800 rounded-xl shadow-inner pointer-events-auto">
               {(['liquidity', 'flow', 'volatility', 'forcedSelling'] as const).map((key) => {
                 const val = breakdown[key] || 0;
                 const shortKey = key === 'forcedSelling' ? 'SELL' : key.substring(0, 4).toUpperCase();
                 const color = val > 75 ? '#ef4444' : val > 40 ? '#eab308' : '#10b981';
                 
                 return (
                   <div key={key} className="flex flex-col items-center flex-1 group cursor-help">
                      <div className="w-full h-12 bg-gray-900/50 rounded-sm overflow-hidden relative border border-gray-800/50 group-hover:border-gray-700 transition-colors">
                         <div 
                          className="absolute bottom-0 left-0 w-full transition-all duration-700 opacity-80 group-hover:opacity-100" 
                          style={{ height: `${val}%`, backgroundColor: color }} 
                         />
                         <div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.5)_50%)] bg-[length:100%_4px] pointer-events-none opacity-30" />
                      </div>
                      <span className="text-[7px] text-gray-500 font-mono font-bold mt-1.5 tracking-wider group-hover:text-gray-300 transition-colors">{shortKey}</span>
                      
                      <div className="absolute bottom-full mb-1 bg-gray-800 text-white text-[9px] px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity font-mono pointer-events-none whitespace-nowrap z-50 border border-gray-700">
                        {val.toFixed(1)}
                      </div>
                   </div>
                 );
               })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
