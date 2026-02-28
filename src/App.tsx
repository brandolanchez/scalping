import { useState, useEffect, useMemo, useRef } from 'react';
import { CheckCircle2, Circle, AlertTriangle, Clock, Activity, Target, ShieldAlert, Zap, TrendingUp, TrendingDown, Wifi, WifiOff, BarChart3, History } from 'lucide-react';
import { motion } from 'motion/react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, AreaChart, Area, ComposedChart } from 'recharts';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const ASSETS = {
  SOLUSDT: { label: 'SOL/USDT', tickOffset: 0.02, decimals: 2 },
  BTCUSDT: { label: 'BTC/USDT', tickOffset: 10.00, decimals: 1 },
  ETHUSDT: { label: 'ETH/USDT', tickOffset: 0.50, decimals: 2 },
};
type SymbolKey = keyof typeof ASSETS;

// --- Types ---
interface Kline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number;
  isFinal: boolean;
}

interface IndicatorData extends Kline {
  timeStr: string;
  ema50: number | null;
  ema100: number | null;
  ema150: number | null;
  rsi: number;
  stochK: number;
  stochD: number;
  cvd: number;
}

interface SignalRecord {
  id: string;
  timestamp: number;
  type: 'LONG' | 'SHORT';
  entry: number;
  sl: number;
  tp: number;
}

// --- Math Functions ---
function computeIndicators(klines: Kline[]): IndicatorData[] {
  if (!klines || klines.length === 0) return [];

  const result: IndicatorData[] = [];
  let ema50: number | null = null;
  let ema100: number | null = null;
  let ema150: number | null = null;
  let cvd = 0;

  const rsiPeriod = 4;
  let gains = 0, losses = 0;

  const stochPeriod = 14;
  const smoothK = 3;
  const smoothD = 3;

  for (let i = 0; i < klines.length; i++) {
    const d = klines[i];
    const close = d.close;

    // EMAs
    const k50 = 2 / (50 + 1);
    ema50 = ema50 === null ? close : (close - ema50) * k50 + ema50;

    const k100 = 2 / (100 + 1);
    ema100 = ema100 === null ? close : (close - ema100) * k100 + ema100;

    const k150 = 2 / (150 + 1);
    ema150 = ema150 === null ? close : (close - ema150) * k150 + ema150;

    // CVD (Proxy using Taker Buy Volume vs Sell Volume)
    const sellVol = d.volume - d.takerBuyVolume;
    const delta = d.takerBuyVolume - sellVol;
    cvd += delta;

    // RSI
    let rsi = 50;
    if (i > 0) {
      const change = close - klines[i - 1].close;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;

      if (i < rsiPeriod) {
        gains += gain;
        losses += loss;
      } else if (i === rsiPeriod) {
        gains /= rsiPeriod;
        losses /= rsiPeriod;
      } else {
        gains = (gains * (rsiPeriod - 1) + gain) / rsiPeriod;
        losses = (losses * (rsiPeriod - 1) + loss) / rsiPeriod;
      }

      if (i >= rsiPeriod) {
        const rs = losses === 0 ? 100 : gains / losses;
        rsi = losses === 0 ? 100 : 100 - (100 / (1 + rs));
      }
    }

    // Stochastic
    let stochK_raw = 50;
    if (i >= stochPeriod - 1) {
      const window = klines.slice(i - stochPeriod + 1, i + 1);
      const highest = Math.max(...window.map(w => w.high));
      const lowest = Math.min(...window.map(w => w.low));
      stochK_raw = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
    }

    result.push({
      ...d,
      ema50, ema100, ema150, cvd, rsi, stochK_raw: stochK_raw, stochK: 50, stochD: 50,
      timeStr: new Date(d.time).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
    } as any);
  }

  // Smooth Stochastic
  for (let i = 0; i < result.length; i++) {
    if (i >= smoothK - 1) {
      const window = result.slice(i - smoothK + 1, i + 1);
      result[i].stochK = window.reduce((sum, w: any) => sum + w.stochK_raw, 0) / smoothK;
    }
  }
  for (let i = 0; i < result.length; i++) {
    if (i >= smoothD - 1) {
      const window = result.slice(i - smoothD + 1, i + 1);
      result[i].stochD = window.reduce((sum, w) => sum + w.stochK, 0) / smoothD;
    }
  }

  return result;
}

// --- Main Component ---
export default function App() {
  const [activeSymbol, setActiveSymbol] = useState<SymbolKey>('SOLUSDT');
  const [klines, setKlines] = useState<Kline[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [signalHistory, setSignalHistory] = useState<SignalRecord[]>([]);
  
  const wsRef = useRef<WebSocket | null>(null);
  const lastSignalTimeRef = useRef<number>(0);

  // Clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch initial data & setup WS
  useEffect(() => {
    let isMounted = true;
    const initData = async () => {
      try {
        setWsStatus('connecting');
        // Use Binance Futures REST API instead of Spot
        const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${activeSymbol}&interval=1m&limit=200`);
        const data = await res.json();
        
        const formattedKlines: Kline[] = data.map((d: any) => ({
          time: d[0],
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
          volume: parseFloat(d[5]),
          takerBuyVolume: parseFloat(d[9]),
          isFinal: true
        }));
        
        if (isMounted) {
          setKlines(formattedKlines);
          connectWs();
        }
      } catch (error) {
        console.error("Failed to fetch initial data", error);
        if (isMounted) setWsStatus('error');
      }
    };

    const connectWs = () => {
      if (wsRef.current) wsRef.current.close();
      
      // Use Binance Futures WebSocket instead of Spot
      const ws = new WebSocket(`wss://fstream.binance.com/ws/${activeSymbol.toLowerCase()}@kline_1m`);
      wsRef.current = ws;

      ws.onopen = () => setWsStatus('connected');
      ws.onclose = () => setWsStatus('error');
      ws.onerror = () => setWsStatus('error');

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.e === 'kline') {
          const k = message.k;
          const newKline: Kline = {
            time: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            takerBuyVolume: parseFloat(k.V),
            isFinal: k.x
          };

          setKlines(prev => {
            const last = prev[prev.length - 1];
            if (!last) return [newKline];
            
            // If it's the same candle, update it. Otherwise, append.
            if (last.time === newKline.time) {
              const updated = [...prev];
              updated[updated.length - 1] = newKline;
              return updated;
            } else {
              // Keep array size manageable
              const updated = [...prev, newKline];
              if (updated.length > 300) updated.shift();
              return updated;
            }
          });
        }
      };
    };

    initData();

    return () => {
      isMounted = false;
      if (wsRef.current) wsRef.current.close();
    };
  }, [activeSymbol]);

  // Prune old signals (older than 5 minutes)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setSignalHistory(prev => prev.filter(s => now - s.timestamp < 5 * 60 * 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Compute indicators
  const chartData = useMemo(() => computeIndicators(klines), [klines]);

  // Signal Logic
  const currentSecond = currentTime.getSeconds();
  const isEntryWindow = currentSecond === 58 || currentSecond === 59;

  const current = chartData[chartData.length - 1];
  const prev = chartData[chartData.length - 2];

  let checks = { ema: 'NONE', mom: 'NONE', cvd: 'NONE', time: isEntryWindow };
  let signal = 'WAIT';
  let type = 'NONE';

  if (current && prev) {
    const isBullishEMA = current.close > (current.ema50 || 0) && (current.ema50 || 0) > (current.ema100 || 0) && (current.ema100 || 0) > (current.ema150 || 0);
    const isBearishEMA = current.close < (current.ema50 || 0) && (current.ema50 || 0) < (current.ema100 || 0) && (current.ema100 || 0) < (current.ema150 || 0);

    const isBullishMom = (current.rsi > 50 || current.rsi < 20) && current.stochK > current.stochD && current.stochK > prev.stochK;
    const isBearishMom = (current.rsi < 50 || current.rsi > 80) && current.stochK < current.stochD && current.stochK < prev.stochK;

    const isBullishCVD = current && prev ? current.cvd > prev.cvd : false;
    const isBearishCVD = current && prev ? current.cvd < prev.cvd : false;

    checks.ema = isBullishEMA ? 'LONG' : isBearishEMA ? 'SHORT' : 'NONE';
    checks.mom = isBullishMom ? 'LONG' : isBearishMom ? 'SHORT' : 'NONE';
    checks.cvd = isBullishCVD ? 'LONG' : isBearishCVD ? 'SHORT' : 'NONE';

    if (checks.ema === 'LONG' && checks.mom === 'LONG' && checks.cvd === 'LONG') {
      signal = isEntryWindow ? 'EXECUTE LONG' : 'PREPARING LONG';
      type = 'LONG';
    } else if (checks.ema === 'SHORT' && checks.mom === 'SHORT' && checks.cvd === 'SHORT') {
      signal = isEntryWindow ? 'EXECUTE SHORT' : 'PREPARING SHORT';
      type = 'SHORT';
    }
  } else {
    // Fallback if current/prev are undefined for the UI
    var isBullishCVD = false;
  }

  // Record Signal to History
  useEffect(() => {
    if (!current || !prev || type === 'NONE' || !isEntryWindow) return;

    // Only record once per 1m candle
    if (current.time !== lastSignalTimeRef.current) {
      const entry = current.close;
      const offset = ASSETS[activeSymbol].tickOffset;
      const sl = type === 'LONG' ? current.low - offset : current.high + offset;
      const tp = type === 'LONG' ? entry + ((entry - sl) * 2) : entry - ((sl - entry) * 2);

      const newSignal: SignalRecord = {
        id: Date.now().toString(),
        timestamp: Date.now(),
        type: type as 'LONG' | 'SHORT',
        entry,
        sl,
        tp
      };

      setSignalHistory(h => [newSignal, ...h]);
      lastSignalTimeRef.current = current.time;
    }
  }, [current, prev, type, isEntryWindow]);

  // Display values
  const currentPrice = current?.close || 0;
  const priceChange = current && prev ? current.close - prev.close : 0;
  const isPriceUp = priceChange >= 0;

  // Chart domains
  const priceMin = Math.min(...chartData.slice(-60).map(d => d.low)) * 0.999;
  const priceMax = Math.max(...chartData.slice(-60).map(d => d.high)) * 1.001;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 font-sans selection:bg-emerald-500/30 flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-800/80 bg-zinc-900/80 sticky top-0 z-10 backdrop-blur-md">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="p-2 bg-emerald-500/10 rounded-lg border border-emerald-500/20">
              <Activity className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <div className="flex items-center gap-2 mb-1">
                {Object.entries(ASSETS).map(([sym, config]) => (
                  <button
                    key={sym}
                    onClick={() => setActiveSymbol(sym as SymbolKey)}
                    className={cn(
                      "px-2 py-1 rounded text-xs font-bold transition-colors",
                      activeSymbol === sym 
                        ? "bg-emerald-500 text-zinc-950" 
                        : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                    )}
                  >
                    {config.label}
                  </button>
                ))}
                <span className="text-xs font-mono px-2 py-1 bg-zinc-800 rounded text-zinc-400 ml-2">1m</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={cn("font-mono font-bold text-lg", isPriceUp ? "text-emerald-400" : "text-rose-400")}>
                  ${currentPrice.toFixed(ASSETS[activeSymbol].decimals)}
                </span>
                {wsStatus === 'connected' ? (
                  <span className="flex items-center gap-1 text-xs text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                    <Wifi className="w-3 h-3" /> Live
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-rose-500 bg-rose-500/10 px-1.5 py-0.5 rounded">
                    <WifiOff className="w-3 h-3" /> {wsStatus}
                  </span>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-4 bg-zinc-950 px-4 py-2 rounded-lg border border-zinc-800 shadow-inner">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-zinc-400" />
              <span className="font-mono text-sm tracking-wider">
                {currentTime.toLocaleTimeString('en-US', { hour12: false })}
              </span>
            </div>
            <div className={cn(
              "px-2 py-0.5 rounded text-xs font-mono font-bold transition-colors",
              isEntryWindow ? "bg-emerald-500 text-zinc-950 animate-pulse shadow-[0_0_15px_rgba(16,185,129,0.5)]" : "bg-zinc-800 text-zinc-500"
            )}>
              :{currentSecond.toString().padStart(2, '0')}
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1600px] w-full mx-auto p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column: Charts */}
        <div className="lg:col-span-9 flex flex-col gap-4">
          
          {/* Main Price & EMAs Chart */}
          <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-4 h-[400px] flex flex-col relative">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-sm font-semibold text-zinc-400 flex items-center gap-2">
                <TrendingUp className="w-4 h-4" /> Precio & EMAs (50, 100, 150)
              </h2>
              <div className="flex gap-3 text-xs font-mono">
                <span className="text-blue-400">EMA50: {current?.ema50?.toFixed(ASSETS[activeSymbol].decimals)}</span>
                <span className="text-amber-400">EMA100: {current?.ema100?.toFixed(ASSETS[activeSymbol].decimals)}</span>
                <span className="text-purple-400">EMA150: {current?.ema150?.toFixed(ASSETS[activeSymbol].decimals)}</span>
              </div>
            </div>
            <div className="flex-1 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData.slice(-60)} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="timeStr" stroke="#52525b" fontSize={10} tickMargin={10} minTickGap={30} />
                  <YAxis domain={[priceMin, priceMax]} stroke="#52525b" fontSize={10} tickFormatter={(val) => val.toFixed(ASSETS[activeSymbol].decimals)} orientation="right" />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', borderRadius: '8px', fontSize: '12px' }}
                    itemStyle={{ color: '#e4e4e7' }}
                    labelStyle={{ color: '#a1a1aa', marginBottom: '4px' }}
                  />
                  <Line type="monotone" dataKey="close" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} name="Precio" />
                  <Line type="monotone" dataKey="ema50" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} name="EMA 50" />
                  <Line type="monotone" dataKey="ema100" stroke="#fbbf24" strokeWidth={1.5} dot={false} isAnimationActive={false} name="EMA 100" />
                  <Line type="monotone" dataKey="ema150" stroke="#c084fc" strokeWidth={1.5} dot={false} isAnimationActive={false} name="EMA 150" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-[250px]">
            {/* RSI & Stochastic */}
            <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-4 flex flex-col">
              <div className="flex justify-between items-center mb-2">
                <h2 className="text-sm font-semibold text-zinc-400 flex items-center gap-2">
                  <Activity className="w-4 h-4" /> Momentum (RSI 4, Stoch 14,3,3)
                </h2>
                <div className="flex gap-3 text-xs font-mono">
                  <span className="text-emerald-400">RSI: {current?.rsi?.toFixed(1)}</span>
                  <span className="text-blue-400">K: {current?.stochK?.toFixed(1)}</span>
                  <span className="text-rose-400">D: {current?.stochD?.toFixed(1)}</span>
                </div>
              </div>
              <div className="flex-1 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData.slice(-60)} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="timeStr" hide />
                    <YAxis domain={[0, 100]} stroke="#52525b" fontSize={10} orientation="right" ticks={[20, 50, 80]} />
                    <ReferenceLine y={80} stroke="#ef4444" strokeDasharray="3 3" opacity={0.5} />
                    <ReferenceLine y={50} stroke="#a1a1aa" strokeDasharray="3 3" opacity={0.3} />
                    <ReferenceLine y={20} stroke="#10b981" strokeDasharray="3 3" opacity={0.5} />
                    <Tooltip contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', fontSize: '12px' }} />
                    <Line type="monotone" dataKey="rsi" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} name="RSI" />
                    <Line type="monotone" dataKey="stochK" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Stoch K" />
                    <Line type="monotone" dataKey="stochD" stroke="#fb7185" strokeWidth={1.5} dot={false} isAnimationActive={false} name="Stoch D" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* CVD (Cumulative Volume Delta) */}
            <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-4 flex flex-col">
              <div className="flex justify-between items-center mb-2">
                <h2 className="text-sm font-semibold text-zinc-400 flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" /> Flujo de Órdenes (CVD Proxy)
                </h2>
                <div className="flex gap-3 text-xs font-mono">
                  <span className={cn(isBullishCVD ? "text-emerald-400" : "text-rose-400")}>
                    Delta: {current && prev ? (current.cvd - prev.cvd).toFixed(2) : 0}
                  </span>
                </div>
              </div>
              <div className="flex-1 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData.slice(-60)} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="timeStr" hide />
                    <YAxis domain={['auto', 'auto']} stroke="#52525b" fontSize={10} orientation="right" tickFormatter={(val) => (val/1000).toFixed(1) + 'k'} />
                    <Tooltip contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a', fontSize: '12px' }} />
                    <Area type="step" dataKey="cvd" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.2} isAnimationActive={false} name="CVD" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

        </div>

        {/* Right Column: Signal Panel & Checklist */}
        <div className="lg:col-span-3">
          <div className="sticky top-24 space-y-4">
            
            {/* Signal Status Box */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl relative overflow-hidden">
              {/* Background Glow */}
              <div className={cn(
                "absolute inset-0 opacity-10 blur-2xl transition-colors duration-1000",
                type === 'LONG' ? "bg-emerald-500" : type === 'SHORT' ? "bg-rose-500" : "bg-zinc-500"
              )} />
              
              <div className="relative z-10 text-center">
                <div className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">
                  Señal del Algoritmo
                </div>
                
                <motion.div 
                  key={signal}
                  initial={{ scale: 0.9, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className={cn(
                    "p-4 rounded-xl flex flex-col items-center justify-center gap-2 border-2 transition-all duration-300",
                    signal.includes('EXECUTE') && type === 'LONG' ? "bg-emerald-500/20 border-emerald-500 text-emerald-400 shadow-[0_0_30px_rgba(16,185,129,0.3)]" :
                    signal.includes('EXECUTE') && type === 'SHORT' ? "bg-rose-500/20 border-rose-500 text-rose-400 shadow-[0_0_30px_rgba(244,63,94,0.3)]" :
                    signal.includes('PREPARING') && type === 'LONG' ? "bg-emerald-500/5 border-emerald-500/50 text-emerald-400/80" :
                    signal.includes('PREPARING') && type === 'SHORT' ? "bg-rose-500/5 border-rose-500/50 text-rose-400/80" :
                    "bg-zinc-950 border-zinc-800 text-zinc-500"
                  )}
                >
                  {type === 'LONG' ? <TrendingUp className="w-10 h-10 mb-1" /> : 
                   type === 'SHORT' ? <TrendingDown className="w-10 h-10 mb-1" /> : 
                   <Clock className="w-10 h-10 mb-1 opacity-50" />}
                  
                  <div className="font-black text-xl tracking-tight leading-none">
                    {signal}
                  </div>
                  
                  {signal.includes('PREPARING') && (
                    <div className="text-xs font-medium mt-1 opacity-80 animate-pulse">
                      Esperando segundo 58-59...
                    </div>
                  )}
                </motion.div>
              </div>
            </div>

            {/* Live Checklist */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 shadow-xl">
              <h3 className="text-sm font-semibold text-zinc-100 mb-4 flex items-center gap-2">
                <Target className="w-4 h-4 text-zinc-400" />
                Validación en Tiempo Real
              </h3>
              
              <div className="space-y-3">
                {/* EMA Check */}
                <div className={cn("p-3 rounded-lg border flex items-center gap-3 transition-colors", checks.ema !== 'NONE' ? (checks.ema === 'LONG' ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-rose-500/10 border-rose-500/30 text-rose-400") : "bg-zinc-950/50 border-zinc-800 text-zinc-500")}>
                  {checks.ema !== 'NONE' ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
                  <div>
                    <div className="text-sm font-medium">Alineación EMAs</div>
                    <div className="text-xs opacity-70 font-mono">{checks.ema !== 'NONE' ? `Confirmado (${checks.ema})` : 'Esperando tendencia'}</div>
                  </div>
                </div>

                {/* Momentum Check */}
                <div className={cn("p-3 rounded-lg border flex items-center gap-3 transition-colors", checks.mom !== 'NONE' ? (checks.mom === 'LONG' ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-rose-500/10 border-rose-500/30 text-rose-400") : "bg-zinc-950/50 border-zinc-800 text-zinc-500")}>
                  {checks.mom !== 'NONE' ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
                  <div>
                    <div className="text-sm font-medium">Impulso RSI/Stoch</div>
                    <div className="text-xs opacity-70 font-mono">{checks.mom !== 'NONE' ? `Confirmado (${checks.mom})` : 'Esperando momentum'}</div>
                  </div>
                </div>

                {/* CVD Check */}
                <div className={cn("p-3 rounded-lg border flex items-center gap-3 transition-colors", checks.cvd !== 'NONE' ? (checks.cvd === 'LONG' ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-rose-500/10 border-rose-500/30 text-rose-400") : "bg-zinc-950/50 border-zinc-800 text-zinc-500")}>
                  {checks.cvd !== 'NONE' ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
                  <div>
                    <div className="text-sm font-medium">Flujo de Órdenes (CVD)</div>
                    <div className="text-xs opacity-70 font-mono">{checks.cvd !== 'NONE' ? `Confirmado (${checks.cvd})` : 'Esperando absorción'}</div>
                  </div>
                </div>

                {/* Timing Check */}
                <div className={cn("p-3 rounded-lg border flex items-center gap-3 transition-colors", checks.time ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-zinc-950/50 border-zinc-800 text-zinc-500")}>
                  {checks.time ? <CheckCircle2 className="w-5 h-5" /> : <Circle className="w-5 h-5" />}
                  <div>
                    <div className="text-sm font-medium">Ventana de Entrada</div>
                    <div className="text-xs opacity-70 font-mono">{checks.time ? 'Segundos 58-59' : 'Esperando cierre de vela'}</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Risk Management Helper */}
            {type !== 'NONE' && current && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 shadow-xl">
                <h3 className="text-sm font-semibold text-zinc-100 mb-3 flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-zinc-400" />
                  Gestión de Riesgo (Ratio 1:2)
                </h3>
                
                <div className="space-y-4 font-mono text-sm">
                  {/* Entry */}
                  <div className="flex justify-between items-center bg-zinc-950/50 p-2 rounded border border-zinc-800">
                    <span className="text-zinc-500">Entrada Aprox:</span>
                    <span className="text-zinc-100 font-bold">${currentPrice.toFixed(ASSETS[activeSymbol].decimals)}</span>
                  </div>
                  
                  {/* Stop Loss */}
                  <div className="flex justify-between items-center bg-rose-500/10 p-2 rounded border border-rose-500/20">
                    <span className="text-rose-400 flex items-center gap-1">
                      <TrendingDown className="w-3 h-3" /> Stop Loss (SL):
                    </span>
                    <div className="text-right">
                      <div className="text-rose-400 font-bold">
                        ${type === 'LONG' ? (current.low - ASSETS[activeSymbol].tickOffset).toFixed(ASSETS[activeSymbol].decimals) : (current.high + ASSETS[activeSymbol].tickOffset).toFixed(ASSETS[activeSymbol].decimals)}
                      </div>
                      <div className="text-[10px] text-rose-500/70">
                        {type === 'LONG' ? 'Bajo el mínimo + offset' : 'Sobre el máximo + offset'}
                      </div>
                    </div>
                  </div>
                  
                  {/* Take Profit */}
                  <div className="flex justify-between items-center bg-emerald-500/10 p-2 rounded border border-emerald-500/20">
                    <span className="text-emerald-400 flex items-center gap-1">
                      <Target className="w-3 h-3" /> Take Profit (TP):
                    </span>
                    <div className="text-right">
                      <div className="text-emerald-400 font-bold">
                        ${type === 'LONG' ? 
                          (currentPrice + ((currentPrice - (current.low - ASSETS[activeSymbol].tickOffset)) * 2)).toFixed(ASSETS[activeSymbol].decimals) : 
                          (currentPrice - (((current.high + ASSETS[activeSymbol].tickOffset) - currentPrice) * 2)).toFixed(ASSETS[activeSymbol].decimals)}
                      </div>
                      <div className="text-[10px] text-emerald-500/70">
                        Ratio 1:2 (Doble del riesgo)
                      </div>
                    </div>
                  </div>

                  {/* Trade Stats */}
                  <div className="pt-3 border-t border-zinc-800 grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-zinc-950/50 p-2 rounded">
                      <div className="text-zinc-500 mb-1">Duración Est.</div>
                      <div className="text-zinc-300">5 - 15 min</div>
                    </div>
                    <div className="bg-zinc-950/50 p-2 rounded">
                      <div className="text-zinc-500 mb-1">Riesgo Máx.</div>
                      <div className="text-zinc-300">1% de la cuenta</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Signal History */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5 shadow-xl mt-4">
              <h3 className="text-sm font-semibold text-zinc-100 mb-3 flex items-center gap-2">
                <History className="w-4 h-4 text-zinc-400" />
                Historial (Últimos 5 min)
              </h3>
              <div className="space-y-2">
                {signalHistory.length === 0 ? (
                  <div className="text-xs text-zinc-500 text-center py-4 border border-zinc-800/50 rounded-lg border-dashed">
                    Esperando señales...
                  </div>
                ) : (
                  signalHistory.map(sig => (
                    <motion.div 
                      key={sig.id}
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={cn(
                        "p-3 rounded-lg border text-xs",
                        sig.type === 'LONG' ? "bg-emerald-500/10 border-emerald-500/20" : "bg-rose-500/10 border-rose-500/20"
                      )}
                    >
                      <div className="flex justify-between items-center mb-1">
                        <span className={cn("font-bold flex items-center gap-1", sig.type === 'LONG' ? "text-emerald-400" : "text-rose-400")}>
                          {sig.type === 'LONG' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {sig.type}
                        </span>
                        <span className="text-zinc-500 font-mono">
                          {new Date(sig.timestamp).toLocaleTimeString('en-US', { hour12: false })}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 font-mono mt-2 bg-zinc-950/50 p-2 rounded">
                        <div>
                          <div className="text-zinc-500 text-[10px]">Entrada</div>
                          <div className="text-zinc-200">${sig.entry.toFixed(ASSETS[activeSymbol].decimals)}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500 text-[10px]">SL</div>
                          <div className="text-rose-400">${sig.sl.toFixed(ASSETS[activeSymbol].decimals)}</div>
                        </div>
                        <div>
                          <div className="text-zinc-500 text-[10px]">TP</div>
                          <div className="text-emerald-400">${sig.tp.toFixed(ASSETS[activeSymbol].decimals)}</div>
                        </div>
                      </div>
                    </motion.div>
                  ))
                )}
              </div>
            </div>

          </div>
        </div>

      </main>
    </div>
  );
}
