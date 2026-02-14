
import React from 'react';
import { StressLevel } from './types';

export const THEME = {
  bg: {
    primary: '#0a0e14',
    secondary: '#151a23',
    tertiary: '#1f2937',
  },
  stress: {
    [StressLevel.STABLE]: '#10b981',
    [StressLevel.ELEVATED]: '#eab308',
    [StressLevel.STRESSED]: '#f97316',
    [StressLevel.UNSTABLE]: '#ef4444',
    [StressLevel.CRITICAL]: '#dc2626',
  },
  text: {
    primary: '#f9fafb',
    secondary: '#d1d5db',
    muted: '#9ca3af',
    accent: '#60a5fa',
  },
  border: {
    default: '#374151',
    accent: '#4b5563',
  }
};

export const TYPOGRAPHY = {
  h1: 'font-mono text-2xl font-bold tracking-tight',
  h2: 'font-mono text-xl font-semibold',
  h3: 'font-mono text-lg font-medium',
  body: 'font-sans text-sm',
  caption: 'font-sans text-xs',
  metric: 'font-mono text-3xl font-bold tabular-nums',
  number: 'font-mono tabular-nums',
  timestamp: 'font-mono text-xs text-gray-400',
};

export const FORMATTERS = {
  currency: (val: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val),
  number: (val: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(val),
  bps: (val: number) => `${val.toFixed(2)} bps`,
  depth: (val: number) => `${val.toFixed(2)} BTC`,
};
