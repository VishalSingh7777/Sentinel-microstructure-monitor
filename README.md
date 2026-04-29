# Sentinel-microstructure-monitor
Bitcoin order book monitor — tracks liquidity depth, order flow imbalance, volatility regime, and large trade activity in real time.

# Sentinel Microstructure Monitor

Sentinel is a browser-based market microstructure monitor for BTC/USDT. It connects to Binance live market streams and tracks structural stress in real time using liquidity depth, order-flow imbalance, volatility expansion, and large sell activity.

It is not a trading bot and it does not execute trades. It is a diagnostic and forensic monitoring interface designed to show when market structure begins to weaken.

## What it does

- Streams live BTC/USDT data from Binance WebSocket feeds
- Tracks order book depth, trades, ticker data, spread, latency, and data quality
- Computes four stress signals:
  - Liquidity Fragility
  - Order Flow Imbalance
  - Volatility Regime Shift
  - Forced Selling / Large Sell Activity
- Combines signals into a weighted stress score from 0–100
- Shows when multiple signals align into named structural failure patterns
- Provides a causal sequence view showing which signal triggered first and how other stress vectors joined
- Logs critical stress events above threshold
- Captures forensic snapshots so past breach events can be inspected later
- Includes a COVID Black Thursday replay mode using Binance historical 1-minute BTC/USDT data
- Includes an optional stress sonification engine that maps stress level into audio feedback

## What is real

- Live Binance WebSocket integration
- Real BTC/USDT ticker, trade, and top-20 order book streams
- Real-time mathematical stress calculations
- Weighted stress-score computation
- Signal confidence, score trace, and explainability layer
- Historical Binance kline fetching for March 2020 replay
- Event logging and snapshot inspection

## What is approximate

The historical COVID replay uses real Binance 1-minute OHLCV data, but historical order book depth is estimated because full historical order book snapshots are not included. The replay should be treated as a forensic simulation, not a perfect reconstruction of the 2020 order book.

## What it is not

Sentinel is not a price prediction system, not a guaranteed crash detector, not an execution system, and not a live trading strategy. It does not claim to predict exact crash timing or bottoms. It shows structural stress forming in market microstructure.

## Tech stack

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Recharts
- Binance WebSocket API

## Core architecture

```text
Binance live streams / historical replay
        ↓
Normalized market tick
        ↓
Analytics Engine
        ↓
Signal processors
        ↓
Weighted stress score
        ↓
Causal sequence + breach log + explainability UI 

## ⚖️ License
**All Rights Reserved** © 2026 Sentinel-microstructure-monitor

This software and associated documentation are **proprietary and confidential**. Unauthorized copying, distribution, modification, or use of this software is strictly prohibited. See [LICENSE](./LICENSE) for complete terms.

