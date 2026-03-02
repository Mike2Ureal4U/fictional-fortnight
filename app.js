/* Cyclical vs Defensive Ratio Dashboard
   - Frontend-only MVP for hosting + embedding in Notion.
   - Uses Alpha Vantage daily series (JSON). Free tier: daily request limit (commonly 25/day). See Alpha Vantage docs.
   - Stores API key + cached data in localStorage (client-only).
*/

const CYCLICAL = [
  { ticker: "XLI", name: "Industrials" },
  { ticker: "XLB", name: "Materials" },
  { ticker: "XLY", name: "Consumer Discretionary" },
  { ticker: "XLE", name: "Energy" },
  { ticker: "XLF", name: "Financials" }
];

const DEFENSIVE = [
  { ticker: "XLP", name: "Consumer Staples" },
  { ticker: "XLV", name: "Healthcare" },
  { ticker: "XLU", name: "Utilities" },
  { ticker: "GLD", name: "Gold" }
];

const CHECKS = [
  { id: "xlf_lag", label: "Financials lagging: XLF underperforms S&P 500 (manual)", weight: 1 },
  { id: "yc_warn", label: "Yield curve warning: 2y/10y inversion or flattening (manual)", weight: 1 },
  { id: "credit", label: "Credit spreads widening: High yield spread rising (manual)", weight: 1 },
  { id: "breadth", label: "Market breadth declining: % above 50DMA falling (manual)", weight: 1 },
  { id: "macro", label: "Macro weakness: PMI / confidence deteriorating (manual)", weight: 1 }
];

// -------------------- Utilities --------------------
const LS = {
  get(key, fallback=null){
    try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value){
    localStorage.setItem(key, JSON.stringify(value));
  },
  del(key){ localStorage.removeItem(key); }
};

function fmt(n, digits=2){
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function pct(n, digits=2){
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return (n*100).toFixed(digits);
}

function parseAlphaVantageDaily(json){
  // Supports TIME_SERIES_DAILY and TIME_SERIES_DAILY_ADJUSTED output.
  const key = json["Time Series (Daily)"] ? "Time Series (Daily)" :
              json["Weekly Time Series"] ? "Weekly Time Series" : null;
  if (!key) throw new Error("Unexpected Alpha Vantage response (no time series field).");
  const rows = json[key];
  const dates = Object.keys(rows).sort(); // ascending
  const series = dates.map(d => {
    const r = rows[d];
    const close = r["4. close"] ?? r["5. adjusted close"] ?? r["4. Close"] ?? r["close"];
    return { date: d, close: close ? Number(close) : NaN };
  }).filter(x => Number.isFinite(x.close));
  return series;
}

function normalizeTo100(series, startDate=null){
  // series: [{date, close}] ascending
  const filtered = startDate ? series.filter(x => x.date >= startDate) : series.slice();
  if (filtered.length < 2) return [];
  const base = filtered[0].close;
  return filtered.map(x => ({ date: x.date, v: (x.close / base) * 100 }));
}

function intersectDates(seriesList){
  // returns array of dates common to all
  const sets = seriesList.map(s => new Set(s.map(x => x.date)));
  const base = [...sets[0]];
  return base.filter(d => sets.every(s => s.has(d))).sort();
}

function averageBasket(normSeriesList, commonDates){
  // normSeriesList: array of [{date, v}] lists; returns [{date, v}]
  const mapList = normSeriesList.map(s => new Map(s.map(x => [x.date, x.v])));
  return commonDates.map(d => {
    const vals = mapList.map(m => m.get(d)).filter(v => Number.isFinite(v));
    const avg = vals.reduce((a,b)=>a+b,0) / vals.length;
    return { date: d, v: avg };
  });
}

function movingAverage(values, window){
  const out = [];
  for (let i=0; i<values.length; i++){
    const start = Math.max(0, i-window+1);
    const slice = values.slice(start, i+1);
    const avg = slice.reduce((a,b)=>a+b,0)/slice.length;
    out.push(avg);
  }
  return out;
}

function slope(values, k=20){
  // simple slope of last k points using linear regression on index 0..k-1
  if (values.length < 5) return 0;
  const n = Math.min(k, values.length);
  const y = values.slice(values.length - n);
  const x = [...Array(n).keys()];
  const xMean = (n-1)/2;
  const yMean = y.reduce((a,b)=>a+b,0)/n;
  let num=0, den=0;
  for(let i=0;i<n;i++){
    num += (x[i]-xMean)*(y[i]-yMean);
    den += (x[i]-xMean)*(x[i]-xMean);
  }
  return den === 0 ? 0 : num/den; // units: v per day
}

function parseDateISO(d){ return new Date(d+"T00:00:00"); }

// return lookup index for date N trading days ago (approx by array index)
function returnOver(series, days){
  if (!series || series.length < days+1) return null;
  const last = series[series.length-1].close;
  const prior = series[Math.max(0, series.length-1-days)].close;
  return prior ? (last/prior - 1) : null;
}

// -------------------- Alpha Vantage fetch + caching --------------------
async function fetchAlphaVantageSeries(ticker, avKey, outputSize="compact"){
  const fn = "TIME_SERIES_DAILY_ADJUSTED";
  const url = `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(ticker)}&outputsize=${outputSize}&apikey=${encodeURIComponent(avKey)}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json["Error Message"]) throw new Error(`${ticker}: ${json["Error Message"]}`);
  if (json["Note"]) throw new Error(`${ticker}: ${json["Note"]}`); // rate limits commonly returned here
  const series = parseAlphaVantageDaily(json);

  return series;
}

function cacheKey(ticker, outputSize){ return `av_cache_${ticker}_${outputSize}`; }

async function getSeries(ticker, avKey, outputSize){
  const key = cacheKey(ticker, outputSize);
  const cached = LS.get(key, null);
  const today = new Date().toISOString().slice(0,10);
  // cache is per day per ticker
  if (cached && cached.asof === today && Array.isArray(cached.series) && cached.series.length > 10){
    return { series: cached.series, source: "cache", asof: cached.asof };
  }
  const series = await fetchAlphaVantageSeries(ticker, avKey, outputSize);
  LS.set(key, { asof: today, series });
  return { series, source: "live", asof: today };
}

function clearAllCaches(){
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith("av_cache_")) localStorage.removeItem(k);
    if (k.startsWith("check_")) localStorage.removeItem(k);
  });
}

// -------------------- UI + charts --------------------
let chart = null;

function setBuildInfo(){
  const el = document.getElementById("buildDate");
  el.textContent = new Date().toISOString().replace("T"," ").slice(0,19) + "Z";
}

function renderChecklist(){
  const root = document.getElementById("checklist");
  root.innerHTML = "";
  CHECKS.forEach(c => {
    const saved = !!LS.get("check_"+c.id, false);
    const div = document.createElement("div");
    div.className = "check";
    div.innerHTML = `
      <input type="checkbox" id="chk_${c.id}" ${saved ? "checked":""}/>
      <div>
        <div>${c.label}</div>
        <div class="small">Stored locally in your browser.</div>
      </div>
    `;
    root.appendChild(div);
    div.querySelector("input").addEventListener("change", (e) => {
      LS.set("check_"+c.id, !!e.target.checked);
      updateSignalsUI();
    });
  });
  updateSignalsUI();
}

function updateSignalsUI(){
  let n = 0;
  CHECKS.forEach(c => { if (LS.get("check_"+c.id, false)) n += c.weight; });
  document.getElementById("signalsCount").textContent = String(n);
  // stance heuristic: >=3 signals => defensive tilt suggested (but ratio trend still matters)
  document.getElementById("stance").textContent = n >= 3 ? "Defensive bias" : (n === 2 ? "Neutral / watch" : "Risk-on ok");
}

function setStatus(kind, text, cacheInfo=""){
  const dot = document.getElementById("statusDot");
  dot.className = "dot " + (kind || "ok");
  document.getElementById("statusText").textContent = text;
  document.getElementById("cacheInfo").textContent = "Cache: " + (cacheInfo || "—");
}

function setBadge(kind, text){
  const b = document.getElementById("ratioBadge");
  const color = kind === "bad" ? "#7f1d1d" : (kind === "warn" ? "#78350f" : "#064e3b");
  b.style.borderColor = "#334155";
  b.style.background = color;
  b.style.color = "#e5e7eb";
  b.textContent = "Status: " + text;
}

function renderTable(rows){
  const tb = document.getElementById("tblBody");
  tb.innerHTML = "";
  rows.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono" title="${r.name}">${r.ticker}</td>
      <td>${fmt(r.last, 2)}</td>
      <td>${r.r1w===null?"—":pct(r.r1w,2)}</td>
      <td>${r.r1m===null?"—":pct(r.r1m,2)}</td>
      <td>${r.r3m===null?"—":pct(r.r3m,2)}</td>
    `;
    tb.appendChild(tr);
  });
}

function makeChart(labels, ratio, ratioMA){
  const ctx = document.getElementById("ratioChart").getContext("2d");
  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Growth Ratio", data: ratio, borderWidth: 2, tension: 0.25, pointRadius: 0 },
        { label: "MA", data: ratioMA, borderWidth: 1, tension: 0.25, pointRadius: 0 }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: "#cbd5e1" } },
        tooltip: { mode: "index", intersect: false }
      },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 8 }, grid: { color: "rgba(148,163,184,0.12)" } },
        y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.12)" } }
      }
    }
  });
}

// -------------------- Core calc --------------------
async function runLive(){
  const avKey = document.getElementById("avKey").value.trim();
  if (!avKey) throw new Error("Paste an Alpha Vantage API key first (or use Demo Mode).");
  const outputSize = document.getElementById("lookback").value;
  const smoothing = Number(document.getElementById("smooth").value);
  const startOverride = document.getElementById("startDate").value || null;

  LS.set("av_key", avKey);

  const all = [...CYCLICAL, ...DEFENSIVE];
  const results = [];
  const sources = [];

  // Fetch sequentially to be polite; free tier is commonly limited.
  for (let i=0; i<all.length; i++){
    const t = all[i].ticker;
    setStatus("ok", `Fetching ${t} (${i+1}/${all.length})…`, "");
    const { series, source, asof } = await getSeries(t, avKey, outputSize);
    results.push({ ticker: t, name: all[i].name, series });
    sources.push({ ticker: t, source, asof });
    // small delay to reduce per-minute spikes
    await new Promise(r => setTimeout(r, 350));
  }

  const cacheSummary = summarizeCache(sources);
  setStatus("ok", "Computing baskets…", cacheSummary);

  const cyc = results.filter(r => CYCLICAL.some(c => c.ticker === r.ticker));
  const def = results.filter(r => DEFENSIVE.some(d => d.ticker === r.ticker));

  const cycNorm = cyc.map(r => ({ ticker: r.ticker, name: r.name, norm: normalizeTo100(r.series, startOverride) }));
  const defNorm = def.map(r => ({ ticker: r.ticker, name: r.name, norm: normalizeTo100(r.series, startOverride) }));

  const cycDates = intersectDates(cycNorm.map(x => x.norm));
  const defDates = intersectDates(defNorm.map(x => x.norm));
  const common = cycDates.filter(d => defDates.includes(d));

  if (common.length < 30) throw new Error("Not enough overlapping history to compute the ratio. Try a shorter start date or 'full' history.");

  const cycIndex = averageBasket(cycNorm.map(x => x.norm), common);
  const defIndex = averageBasket(defNorm.map(x => x.norm), common);

  const ratio = common.map((d, i) => (cycIndex[i].v / defIndex[i].v));
  const ratioSmooth = smoothing > 1 ? movingAverage(ratio, smoothing) : ratio.slice();
  const ratioMA = movingAverage(ratioSmooth, 20);

  // status heuristic
  const last = ratioSmooth[ratioSmooth.length-1];
  const lastMA = ratioMA[ratioMA.length-1];
  const sl = slope(ratioSmooth, 25);
  const down = last < lastMA && sl < 0;
  const severe = down && (last < ratioMA[Math.max(0, ratioMA.length-40)]); // ~2 months below earlier MA level

  if (severe) setBadge("bad", "Persistent defensive rotation");
  else if (down) setBadge("warn", "Ratio weakening");
  else setBadge("ok", "Cyclicals leading / stable");

  makeChart(common, ratioSmooth, ratioMA);

  // table snapshot (returns are based on raw closes)
  const rows = results.map(r => ({
    ticker: r.ticker,
    name: r.name,
    last: r.series[r.series.length-1]?.close ?? null,
    r1w: returnOver(r.series, 5),
    r1m: returnOver(r.series, 21),
    r3m: returnOver(r.series, 63)
  })).sort((a,b)=>a.ticker.localeCompare(b.ticker));

  renderTable(rows);

  setStatus(severe ? "bad" : (down ? "warn" : "ok"),
            severe ? "Ratio has been weakening with negative slope — treat as a real scare candidate (confirm signals)." :
            (down ? "Ratio weakening — watch for persistence + signal cluster." : "Ratio stable/strengthening."),
            cacheSummary);
}

function summarizeCache(sources){
  // sources: [{ticker, source, asof}]
  const live = sources.filter(x => x.source === "live").length;
  const cached = sources.filter(x => x.source === "cache").length;
  const asof = sources[0]?.asof ?? "—";
  return `${live} live, ${cached} cached (asof ${asof})`;
}

function runDemo(){
  // Generates plausible synthetic data for layout/testing without any API key.
  const n = 110;
  const start = new Date();
  start.setDate(start.getDate() - n*1.5);
  const dates = [];
  for(let i=0;i<n;i++){
    const d = new Date(start.getTime());
    d.setDate(start.getDate() + i);
    // keep weekdays-ish (skip weekends by forcing monotonic unique dates)
    dates.push(d.toISOString().slice(0,10));
  }
  // make a ratio that dips then recovers
  const ratio = [];
  let v = 1.02;
  for(let i=0;i<n;i++){
    const drift = (i<55 ? -0.0012 : 0.0010);
    const noise = (Math.random()-0.5)*0.01;
    v = Math.max(0.7, v*(1+drift+noise*0.2));
    ratio.push(v);
  }
  const smoothing = Number(document.getElementById("smooth").value);
  const ratioSmooth = smoothing > 1 ? movingAverage(ratio, smoothing) : ratio.slice();
  const ratioMA = movingAverage(ratioSmooth, 20);

  makeChart(dates, ratioSmooth, ratioMA);
  renderTable([...CYCLICAL, ...DEFENSIVE].map(x => ({
    ticker: x.ticker,
    name: x.name,
    last: (100+Math.random()*50),
    r1w: (Math.random()-0.5)*0.04,
    r1m: (Math.random()-0.5)*0.08,
    r3m: (Math.random()-0.5)*0.18
  })).sort((a,b)=>a.ticker.localeCompare(b.ticker)));

  setBadge("warn", "Demo mode");
  setStatus("ok", "Demo data (no API calls).", "Cache: n/a");
}

// -------------------- Init --------------------
function init(){
  setBuildInfo();
  renderChecklist();

  document.getElementById("cycTickers").textContent = CYCLICAL.map(x=>x.ticker).join(", ");
  document.getElementById("defTickers").textContent = DEFENSIVE.map(x=>x.ticker).join(", ");

  const savedKey = LS.get("av_key", "");
  if (savedKey) document.getElementById("avKey").value = savedKey;

  document.getElementById("runBtn").addEventListener("click", async () => {
    try{
      disableButtons(true);
      await runLive();
    } catch(err){
      console.error(err);
      setBadge("bad", "Error");
      setStatus("bad", String(err.message || err), "—");
    } finally {
      disableButtons(false);
    }
  });

  document.getElementById("demoBtn").addEventListener("click", () => runDemo());

  document.getElementById("clearBtn").addEventListener("click", () => {
    clearAllCaches();
    setStatus("ok", "Cache cleared (localStorage).", "—");
  });

  // initial demo to show something
  runDemo();
}

function disableButtons(disabled){
  document.getElementById("runBtn").disabled = disabled;
  document.getElementById("demoBtn").disabled = disabled;
  document.getElementById("clearBtn").disabled = disabled;
}

window.addEventListener("load", init);
