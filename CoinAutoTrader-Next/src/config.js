import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function number(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw Error(`Invalid ${name}`);
  return value;
}
if (process.env.TRADING_MODE && process.env.TRADING_MODE !== 'paper') throw Error('Live trading is disabled in this build');
export const config = Object.freeze({
  mode:'paper', host:process.env.HOST || '127.0.0.1', port:number('PORT',8787,1024,65535),
  separateAccounts:true,
  configurableLimits:true, fullUpbitRadar:true, fastEvaluation:true, marketIntegrity:true, morningSignals:true,
  decisionIntervalMs:100, uiRefreshMs:1000, entryMaxAgeMs:1500,
  catalogMs:300000,
  receiptDiagnostics:true,
  sessionStrategyV3:true, hourlyScanMs:500, morningEndMinutes:30,
  maxTickSpread:0.0075, strategySelectorV10:true, rebuiltStrategyV15:true, manualPaperSell:true,
  peakProfitRetention:number('PEAK_PROFIT_RETENTION',0.95,0.90,0.95),
  tradeRiskKrw:2000,
  relativeMinTurnover:200000000, probeMaxKrw:200000,
  dataDir:path.resolve(process.env.DATA_DIR || path.join(root,'data')),
  initialCash:10000000, marketLimit:300, candidateLimit:60, focusLimit:12,
  broadMs:10000, focusMs:2000, maxAgeMs:15000,
  orderKrw:1000000, minOrderKrw:100000, adaptiveSizing:true, maxPositions:5, maxExposure:0.20, dailyLossLimit:0.02,
  freshReentry:true, reentryRise:0.003, reentryWindowMs:30000,
  strategy:'morning-structure-v15', executionExchange:'upbit',
  highWaterLossLimit:0.08,
  maxSpread:0.001, maxImpact:0.001, bookMaxAgeMs:5000,
  fee:0.0005, slippage:0.001,
  warmupMs:30000, cooldownMs:86400000
});
