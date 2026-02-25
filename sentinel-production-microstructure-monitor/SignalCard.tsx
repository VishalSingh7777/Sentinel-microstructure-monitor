
import React from 'react';
import { SignalOutput, StressLevel } from '../types';
import { THEME, TYPOGRAPHY } from '../constants';

interface SignalCardProps {
  signal: SignalOutput;
}

export const SignalCard: React.FC<SignalCardProps> = ({ signal }) => {
  const isTriggered = signal.triggered;
  const severityColor = THEME.stress[signal.severity];

  return (
    <div className={`
      bg-[#151a23] 
      border-2 
      rounded-xl 
      p-4 
      transition-all duration-300
      ${isTriggered ? `border-[${severityColor}] shadow-[0_0_20px_${severityColor}20]` : 'border-gray-800'}
    `} style={{ borderColor: isTriggered ? severityColor : '#1f2937' }}>
      
      <div className="flex items-center justify-between mb-4">
        <h3 className={`${TYPOGRAPHY.h3} text-gray-200 text-sm`}>
          {signal.name.toUpperCase()}
        </h3>
        <div className={`w-2.5 h-2.5 rounded-full transition-all duration-300 ${isTriggered ? 'animate-pulse' : ''}`}
             style={{ backgroundColor: isTriggered ? severityColor : '#4b5563' }} />
      </div>

      <div className="mb-4">
        <div className="flex items-baseline gap-2 mb-2">
          <span className={`${TYPOGRAPHY.metric} text-2xl`} style={{ color: severityColor }}>
            {signal.value}
          </span>
          <span className="text-xs text-gray-500">/ 100</span>
        </div>
        
        <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div 
            className="h-full transition-all duration-700 ease-out"
            style={{ width: `${signal.value}%`, backgroundColor: severityColor }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-y-2 mb-4">
        {Object.entries(signal.raw_metrics).map(([key, value]) => (
          <div key={key} className="flex flex-col">
            <span className="text-[10px] text-gray-500 uppercase tracking-wider">{key}</span>
            <span className={`${TYPOGRAPHY.number} text-xs text-gray-300`}>{value}</span>
          </div>
        ))}
      </div>

      <div className="pt-3 border-t border-gray-800">
        <p className="text-[11px] text-gray-400 leading-relaxed min-h-[32px]">
          {signal.explanation}
        </p>
        <div className="flex items-center justify-between mt-3">
          <span className="text-[10px] text-gray-600 font-mono">CONFIDENCE</span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
            signal.confidence === 'HIGH' ? 'text-emerald-400 bg-emerald-400/10' :
            signal.confidence === 'MEDIUM' ? 'text-yellow-400 bg-yellow-400/10' : 'text-gray-500 bg-gray-500/10'
          }`}>
            {signal.confidence}
          </span>
        </div>
      </div>
    </div>
  );
};
