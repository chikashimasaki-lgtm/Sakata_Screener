/**
 * Sakata_Screener 純ロジック検証（GAS不要 / 依存なし）
 *
 *   node tests/verify.js
 *
 * src/Code.js と src/MarketMacro.js を GAS API のモック上へそのまま読み込み、
 * 指標計算・パターン検出・マクロ判定を実際に動かす。トップレベルが宣言だけなので成立する。
 * 「間違った結果が正しそうな見た目で出る」種類の不具合を止めるのが目的。
 */
const fs   = require('fs');
const path = require('path');

/* ── GAS モック ───────────────────────────────────────────────────────────── */

const logs = [];
const sandbox = {
  Logger: { log: m => logs.push(String(m)) },
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} }),
  },
  SpreadsheetApp: { getActive: () => { throw new Error('シートは使わない'); } },
  UrlFetchApp: { fetch: () => { throw new Error('通信は使わない'); } },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep: () => {} },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => {}, deleteTrigger: () => {} },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.com' }) },
  DriveApp: {}, MailApp: { sendEmail: () => {} },
};

const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const EXPORTS = [
  'SK', 'MACRO', 'BT_MIN_SAMPLE',
  'rsiSeries_', 'rsiFrom_', 'macdSeries_',
  'detectSakata_', 'detectReversalPairs_', 'detectStars_', 'findExtrema_', 'detectHeadShoulders_',
  'parseYahooBars_', 'avgBody_', 'atr_', 'medianTurnover_', 'isLiquidEnough_',
  'signalStrength_', 'parseSignalNames_', 'suggestWeight_', 'patternPoints_',
  'marginRegime_', 'regimeFactor_', 'nsRatioTrend_', 'vixMacdSignal_', 'checkMarketConditions_',
  'parseTseMarginGrid_', 'parseNikkeiEpsHtml_', 'selloffFrequency_', 'macroValueLabel_',
  'filterCalendarToUniverse_', 'calendarStatusLabel_', 'edinetExtractArray_', 'calendarMapFromEntries_',
  'pickForeignFlow_', 'extractProfit_',
];
// 共通モジュール（symlink）も読み込む。本体が fetchWithRetry_ / confirmDestructive_ / to4_ を呼ぶため。
const M = new Function(...Object.keys(sandbox), `
${read('FetchRetry.js')}
${read('ConfirmUi.js')}
${read('StockCode.js')}
${read('Code.js')}
${read('MarketMacro.js')}
return { ${EXPORTS.join(', ')} };
`)(...Object.values(sandbox));

/* ── アサーション ─────────────────────────────────────────────────────────── */

let pass = 0, fail = 0;
const eq = (a, b, label) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x === y) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + '\n     期待: ' + y + '\n     実際: ' + x); }
};
const near = (a, b, tol, label) => {
  if (Math.abs(a - b) <= tol) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log(`  ❌ ${label}\n     期待: ${b} ±${tol}\n     実際: ${a}`); }
};
const has  = (arr, name, label) => eq(arr.some(s => s.name === name), true,  label);
const lacks= (arr, name, label) => eq(arr.some(s => s.name === name), false, label);

/* ── テスト用データ ───────────────────────────────────────────────────────── */

// 決定的な擬似乱数（再現性のため固定シードのLCG）
function lcg(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }
function closesSeries(n, seed) {
  const r = lcg(seed); const out = [100];
  for (let i = 1; i < n; i++) out.push(Math.max(1, out[i - 1] * (1 + (r() - 0.48) * 0.03)));
  return out;
}
// 実体の小さい静穏なバー列（パターンの偶発点灯を避ける土台）
function calmBars(n, base) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = base + (i % 2 ? 0.2 : -0.2), c = o + (i % 2 ? -0.1 : 0.1);
    out.push({ o, h: Math.max(o, c) + 0.3, l: Math.min(o, c) - 0.3, c, v: 1e6, t: 1e9 + i * 86400, cont: true });
  }
  return out;
}
const bar = (o, h, l, c, extra) => Object.assign({ o, h, l, c, v: 1e6, t: 0, cont: true }, extra || {});

/* ── 教科書実装（比較対象・本体とは独立に書く） ───────────────────────────── */

function wilderRsiRef(closes, p) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const ch = closes[i] - closes[i - 1];
    g += Math.max(ch, 0); l += Math.max(-ch, 0);
  }
  g /= p; l /= p;
  out[p] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    g = (g * (p - 1) + Math.max(ch, 0)) / p;
    l = (l * (p - 1) + Math.max(-ch, 0)) / p;
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}
function emaRef(arr, p) {   // pandas ewm(adjust=False) 相当
  const k = 2 / (p + 1); const out = []; let prev = null;
  for (const v of arr) { prev = prev == null ? v : v * k + prev * (1 - k); out.push(prev); }
  return out;
}

/* ── 1. RSI ──────────────────────────────────────────────────────────────── */

console.log('\n【1】RSI(Wilder) — 旧実装はシードに合計を入れており標準と乖離していた');
{
  const closes = closesSeries(300, 7);
  const mine = M.rsiSeries_(closes, 14), ref = wilderRsiRef(closes, 14);
  let maxDiff = 0, checked = 0;
  for (let i = 0; i < closes.length; i++) {
    if (mine[i] == null && ref[i] == null) continue;
    maxDiff = Math.max(maxDiff, Math.abs(mine[i] - ref[i])); checked++;
  }
  eq(checked, 286, '14本目から末尾まで値が入る（286点）');
  near(maxDiff, 0, 1e-9, '教科書実装との最大乖離が 0（286点すべて一致）');
  near(M.rsiSeries_(closes, 14)[30], wilderRsiRef(closes, 14)[30], 1e-9,
    'バックテスト開始位置(30本目)でも一致（旧実装はここで最大34pt乖離）');
  eq(mine.slice(0, 14).every(v => v === null), true, '13本目までは null（計算不能な区間を数値で埋めない）');
}
{
  eq(M.rsiFrom_(0, 0), 50, '値動きゼロは中立50（旧実装は一律100でRSI過熱が誤点灯）');
  eq(M.rsiFrom_(1, 0), 100, '下落ゼロ・上昇ありは100');
  eq(M.rsiFrom_(0, 1), 0, '上昇ゼロ・下落ありは0');
  const flat = new Array(40).fill(500);
  eq(M.rsiSeries_(flat, 14)[39], 50, '完全にフラットな系列は50（80超の過熱判定に入らない）');
}

/* ── 2. MACD ─────────────────────────────────────────────────────────────── */

console.log('\n【2】MACD(12,26,9)');
{
  const closes = closesSeries(200, 11);
  const m = M.macdSeries_(closes, 12, 26, 9);
  const ef = emaRef(closes, 12), es = emaRef(closes, 26);
  const macdRef = closes.map((_, i) => ef[i] - es[i]);
  const sigRef  = emaRef(macdRef, 9);
  let d1 = 0, d2 = 0;
  for (let i = 0; i < closes.length; i++) {
    d1 = Math.max(d1, Math.abs(m.macd[i] - macdRef[i]));
    d2 = Math.max(d2, Math.abs(m.signal[i] - sigRef[i]));
  }
  near(d1, 0, 1e-9, 'MACD線が ewm(adjust=False) 相当の参照実装と一致');
  near(d2, 0, 1e-9, 'シグナル線も一致');
  eq(m.macd.length === closes.length && m.signal.length === closes.length, true, '長さが入力と同じ');
  near(m.macd[0], 0, 1e-12, '先頭は必ず0（＝null判定では弾けない。だから最低バー数が要る）');
  eq(M.SK.MACD_MIN_BARS, 60, 'MACD判定の最低バー数は60本');
}

/* ── 3. 酒田五法の検出 ───────────────────────────────────────────────────── */

console.log('\n【3】パターン検出');
{
  // 赤三兵：陽線3本・終値と始値を切り上げ
  const bars = calmBars(30, 100).concat([
    bar(100.0, 101.2, 99.8, 101.0), bar(100.5, 102.2, 100.3, 102.0), bar(101.0, 103.2, 100.8, 103.0),
  ]);
  const sig = M.detectSakata_(bars);
  has(sig, '赤三兵', '赤三兵が点灯する');
  lacks(sig, '先詰まり赤三兵(警戒)', '通常形では先詰まりは点灯しない');
}
{
  // 先詰まり赤三兵：3本目の実体が縮み上ヒゲが長い＝失速形
  const bars = calmBars(30, 100).concat([
    bar(100.0, 101.2, 99.8, 101.0), bar(100.5, 102.2, 100.3, 102.0), bar(101.0, 105.0, 100.8, 102.2),
  ]);
  const sig = M.detectSakata_(bars);
  has(sig, '先詰まり赤三兵(警戒)', '失速形は先詰まり（売り）として点灯');
  lacks(sig, '赤三兵', '同時に赤三兵（買い）を積まない（混在で地合い係数が無効化される不具合の再発防止）');
  eq(sig.filter(s => /赤三兵/.test(s.name)).map(s => s.dir), ['売り'], '方向が売りだけになる');
}
{
  // 三空踏み上げ：上向きの窓が3つ
  const base = calmBars(30, 100);
  const bars = base.concat([
    bar(101, 102, 100.5, 101.8), bar(103, 104, 102.5, 103.8),
    bar(105, 106, 104.5, 105.8), bar(107, 108, 106.5, 107.8),
  ]);
  has(M.detectSakata_(bars), '三空踏み上げ', '三空踏み上げが点灯する');

  // データ欠損をまたぐ足では窓と見なさない（cont=false）
  const gapped = bars.map((b, i) => i === bars.length - 1 ? Object.assign({}, b, { cont: false }) : b);
  lacks(M.detectSakata_(gapped), '三空踏み上げ', '欠損またぎ(cont=false)では窓判定をしない');
}
{
  // 上げ三法：起点Eが「長い」陽線であることを要求する
  // 直近10本（静穏部）の平均実体は0.1。eBig は 0.1×1.3=0.13 以上の実体を要求する。
  const mk = eBody => {
    const eHigh = 100 + eBody + 0.5;
    return calmBars(30, 100).concat([
      bar(100, eHigh, 99.5, 100 + eBody),                     // E（起点）
      bar(100.1, 100.3, 99.8, 100.0),                          // D  ┐
      bar(100.0, 100.3, 99.8, 100.2),                          // C  ├ Eの値幅内で調整
      bar(100.2, 100.3, 99.9, 100.1),                          // B  ┘
      bar(100.1, eHigh + 0.7, 100.0, eHigh + 0.5),             // A（E高値を上抜けの陽線）
    ]);
  };
  has(M.detectSakata_(mk(5)), '上げ三法', '起点が長大陽線なら上げ三法が点灯');
  lacks(M.detectSakata_(mk(0.1)), '上げ三法', '起点が平均並みの陽線なら点灯しない（単なるインサイド調整を拾わない）');
}
{
  // MACDクロスの配線確認：クロスが末尾に来る系列を作って検証する
  const closes = closesSeries(400, 23);
  const full = M.macdSeries_(closes, 12, 26, 9);
  let cut = -1;
  for (let i = 80; i < closes.length; i++) {
    if (full.macd[i - 1] <= full.signal[i - 1] && full.macd[i] > full.signal[i]) { cut = i; break; }
  }
  eq(cut > 0, true, 'テスト用にゴールデンクロスが起きる位置を特定できる');
  const toBars = arr => arr.map((c, i) => bar(c, c + 0.5, c - 0.5, c, { t: 1e9 + i * 86400 }));
  has(M.detectSakata_(toBars(closes.slice(0, cut + 1))), 'MACDゴールデンクロス', 'クロス直後のバーで点灯する');

  const short = toBars(closes.slice(0, 59));
  eq(M.detectSakata_(short).filter(s => /MACD/.test(s.name)).length, 0,
    '59本ではMACDを判定しない（EMA26が収束せず符号を誤るため）');
}

/* ── 4. 基準値の算定（自己参照の解消） ───────────────────────────────────── */

console.log('\n【4】平均実体・ATR・流動性');
{
  const bars = calmBars(12, 100).concat([bar(100, 130, 99, 129)]);   // 末尾だけ極端に大きい実体
  const withLast = M.avgBody_(bars, 10, 0), without = M.avgBody_(bars, 10, 1);
  eq(withLast > without * 5, true, '判定対象を含めると平均が跳ね上がる（旧実装の自己参照）');
  near(without, 0.1, 1e-9, '末尾1本を除けば静穏な区間の平均実体（0.1）になる');
  eq(M.avgBody_([], 10, 1), 0, '空配列は0を返す（0除算しない）');
}
{
  const bars = calmBars(20, 100);
  eq(M.atr_(bars, 14, 2) > 0, true, 'ATRが正の値になる');
  eq(M.atr_(bars.slice(0, 1), 14, 2), 0, 'バーが足りなければ0');
}
{
  const v = n => ({ o: 100, h: 101, l: 99, c: 100, v: n, t: 0, cont: true });
  eq(M.medianTurnover_([v(1), v(3), v(2)].map(b => b), 20), 200, '売買代金の中央値（奇数個）');
  eq(M.medianTurnover_([v(1), v(2), v(3), v(4)], 20), 250, '中央値（偶数個は中央2つの平均）');
  eq(M.medianTurnover_([{ o: 1, h: 1, l: 1, c: 1, v: null, t: 0 }], 20), null, '出来高が無ければ null');
  eq(M.isLiquidEnough_([{ o: 1, h: 1, l: 1, c: 1, v: null, t: 0 }]), true, '出来高不明の銘柄は落とさない');
  eq(M.isLiquidEnough_([v(1000)]), false, '売買代金が基準未満なら対象外');
  eq(M.isLiquidEnough_([v(1e6)]), true, '基準以上なら対象');
  eq(M.SK.LIQ_MIN_TURNOVER, 50 * 1000 * 1000, '流動性基準は日次売買代金5,000万円');
}
{
  // 同値のピークが隣り合うと両方拾ってしまう問題
  eq(M.findExtrema_([1, 2, 3, 5, 5, 3, 2, 1], 2, true), [3], '同値が並ぶピークは1つに絞られる');
  eq(M.findExtrema_([5, 4, 3, 1, 3, 4, 5], 2, false), [3], 'トラフも検出できる');
  eq(M.findExtrema_([1, 2, 3], 2, true), [], '窓幅に満たない系列では何も返さない');
}

/* ── 5. Yahoo応答の解釈（分割調整・欠損・窓） ───────────────────────────── */

console.log('\n【5】parseYahooBars_ — 分割調整と欠損の扱い');
const yahooRes = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj) });
const chart = (ts, q, adjclose) => ({
  chart: { result: [{ timestamp: ts, indicators: { quote: [q], adjclose: adjclose ? [{ adjclose }] : undefined } }] },
});
{
  eq(M.parseYahooBars_(yahooRes(500, {})), [], 'HTTP 500 は空配列');
  eq(M.parseYahooBars_(yahooRes(200, { chart: { result: [] } })), [], '壊れた応答でも例外を投げず空配列');
}
{
  // 1:5分割。生の終値は 500 → 100 だが、調整後は連続する（-80%の偽の窓を作らない）
  const ts = [0, 86400, 172800];
  const q  = { open: [500, 505, 101], high: [510, 515, 103], low: [495, 500, 99], close: [505, 510, 102],
               volume: [1000, 1000, 5000] };
  const adj = [101, 102, 102];   // 分割前は 1/5 に調整される
  const bars = M.parseYahooBars_(yahooRes(200, chart(ts, q, adj)));
  eq(bars.length, 3, '3本とも取り込む');
  near(bars[0].c, 101, 1e-9, '分割前の終値が調整される（505 → 101）');
  near(bars[0].o / bars[0].c, 500 / 505, 1e-9, '四本値すべてに同じ係数がかかる（形は保たれる）');
  near(bars[2].c, 102, 1e-9, '分割後はそのまま');
  eq(Math.abs(bars[1].c - bars[2].c) < bars[1].c * 0.1, true, '分割日に-80%の偽の窓が生じない');
  eq(bars[0].v, 1000, '出来高を取り込む（「日足に出来高が無い」は事実誤認だった）');
}
{
  const ts = [0, 86400];
  const q  = { open: [100, null], high: [101, 102], low: [99, 100], close: [100, 101], volume: [1, 2] };
  eq(M.parseYahooBars_(yahooRes(200, chart(ts, q, null))).length, 1, '四本値に欠けがある足は捨てる');
}
{
  const day = 86400;
  const mk = gapDays => {
    const ts = [0, day, day + gapDays * day];
    const q = { open: [100, 100, 100], high: [101, 101, 101], low: [99, 99, 99], close: [100, 100, 100], volume: [1, 1, 1] };
    return M.parseYahooBars_(yahooRes(200, chart(ts, q, null)));
  };
  eq(mk(3)[2].cont, true, '3日空きは連続扱い（連休をまたぐ通常の足）');
  eq(mk(9)[2].cont, false, '9日空きは非連続（欠損またぎ＝窓判定を無効化する）');
  eq(mk(3)[0].cont, false, '先頭の足は前の足が無いので非連続');
}

/* ── 6. スコアリング ─────────────────────────────────────────────────────── */

console.log('\n【6】スコアと★（絶対しきい値）');
{
  eq(M.parseSignalNames_('・赤三兵\n・MACDゴールデンクロス'), ['赤三兵', 'MACDゴールデンクロス'], 'シグナル名の分解');
  eq(M.parseSignalNames_(''), [], '空文字は空配列');
  eq(M.signalStrength_('・赤三兵\n・MACDゴールデンクロス'),
     M.patternPoints_('赤三兵') + M.patternPoints_('MACDゴールデンクロス'), '強さは静的重みの合計');
  eq(M.patternPoints_('存在しないパターン'), 1, '未知のパターンは1点');
  eq(M.SK.STAR3 >= M.SK.STAR2, true, '★★★のしきい値は★★以上');
}
{
  // 学習結果は「参考値」。順位には使わない（patternPoints_ は静的重みのまま）
  eq(M.suggestWeight_('赤三兵', 5, 5), M.patternPoints_('赤三兵'), 'サンプル不足なら静的重みを返す');
  eq(M.suggestWeight_('赤三兵', 100, 80), 3, '勝率80%なら参考重み3');
  eq(M.suggestWeight_('赤三兵', 100, 20), 1, '勝率20%なら参考重み1');
}

/* ── 7. 地合い（信用需給） ───────────────────────────────────────────────── */

console.log('\n【7】地合い判定と係数');
{
  const T = M.SK.MARGIN.SELL_THRESHOLD_OKU, P = M.SK.MARGIN.RATIO_PIVOT;
  eq(M.marginRegime_(T, P - 0.01), 'SHORT_COVER', '売残潤沢＋倍率低 → ショートカバー好機');
  eq(M.marginRegime_(T - 1, P), 'SUPPLY_RISK', '売残枯渇＋倍率高 → 需給悪化');
  eq(M.marginRegime_(T, P), 'NEUTRAL', '境界の組み合わせは中立');
  eq(M.marginRegime_('', 1.2), 'NEUTRAL', '売残が未入力なら中立（Number("")=0 を「売残枯渇」と読まない）');
  eq(M.marginRegime_(9000, ''), 'NEUTRAL', '倍率が未入力でも中立（逆向きの誤判定も防ぐ）');
  eq(M.marginRegime_(null, null), 'NEUTRAL', '未取得も中立');
  eq(M.marginRegime_('9000', '0.8'), 'SHORT_COVER', '数字の文字列は数値として扱う（シート入力はしばしば文字列）');
}
{
  const b = M.SK.MARGIN.BUY_BOOST, s = M.SK.MARGIN.SELL_BOOST;
  eq(M.regimeFactor_('SHORT_COVER', '買い'), b, 'ショートカバー局面は買いを増幅');
  near(M.regimeFactor_('SHORT_COVER', '売り'), 1 / s, 1e-12, '同局面の売りは減衰');
  eq(M.regimeFactor_('SUPPLY_RISK', '売り'), s, '需給悪化局面は売りを増幅');
  eq(M.regimeFactor_('NEUTRAL', '買い'), 1, '中立は等倍');
  eq(M.regimeFactor_('SHORT_COVER', '混在'), 1, '方向が混在なら等倍（順位を歪めない）');
}
{
  const up = n => Array.from({ length: n }, (_, i) => 100 * Math.pow(1.01, i));
  const flat = n => new Array(n).fill(100);
  eq(M.nsRatioTrend_(flat(30), up(31), 20), 'DOWN', '日経が横ばい・S&Pが上昇 → NS倍率低下（米国株優位）');
  eq(M.nsRatioTrend_(up(31), flat(30), 20), 'UP', '逆なら日本株優位');
  eq(M.nsRatioTrend_(flat(30), flat(30), 20), 'FLAT', '拮抗ならFLAT');
  eq(M.nsRatioTrend_(up(31), up(30), 20), 'FLAT', '配列長が違っても位置対応させず自己リターンで比較する');
  eq(M.nsRatioTrend_(up(5), up(5), 20), 'FLAT', 'データ不足はFLAT');
}
{
  const closes = closesSeries(200, 31);
  const m = M.macdSeries_(closes, 12, 26, 9);
  const n = closes.length;
  const expect = (m.macd[n - 2] - m.signal[n - 2]) <= 0 && (m.macd[n - 1] - m.signal[n - 1]) > 0 ? 'GOLDEN_CROSS'
               : (m.macd[n - 2] - m.signal[n - 2]) >= 0 && (m.macd[n - 1] - m.signal[n - 1]) < 0 ? 'DEAD_CROSS'
               : (m.macd[n - 1] - m.signal[n - 1]) > 0 ? 'ABOVE' : 'BELOW';
  eq(M.vixMacdSignal_(closes), expect, 'VIXのMACD状態がMACD系列と整合する');
  eq(M.vixMacdSignal_(closesSeries(34, 3)), 'NONE', '34本以下は判定しない');
  eq(M.vixMacdSignal_(null), 'NONE', '未取得はNONE');
}

/* ── 8. 急落7条件 ───────────────────────────────────────────────────────── */

console.log('\n【8】急落の7条件 — 未取得の項目で点灯させない');
{
  const conds = M.checkMarketConditions_({});
  eq(conds.length, 7, '条件は7つ');
  eq(conds.filter(c => c.alert).length, 0, 'データが空なら1つも点灯しない（欠測を「危険」と読み替えない）');
  eq(conds.map(c => c.key), ['1_short_margin', '2_margin_ratio', '3_ns_ratio', '4_nikkei_eps',
    '5_foreign_sell', '6_vix_macd', '7_earnings'], '条件の並びと識別子');
}
{
  const all = M.checkMarketConditions_({
    sell_margin_oku: 5000, margin_ratio: 1.2, ns_ratio_trend: 'DOWN', nikkei_eps_trend: 'DOWN',
    foreign_net_oku: -1200, vix_macd_signal: 'GOLDEN_CROSS', earnings_selloff: 'YES',
  });
  eq(all.filter(c => c.alert).length, 7, '全条件が揃えば7/7点灯');
}
{
  const none = M.checkMarketConditions_({
    sell_margin_oku: 9000, margin_ratio: 0.8, ns_ratio_trend: 'UP', nikkei_eps_trend: 'UP',
    foreign_net_oku: 500, vix_macd_signal: 'DEAD_CROSS', earnings_selloff: 'NO',
  });
  eq(none.filter(c => c.alert).length, 0, '良好な地合いでは0/7');
  eq(M.checkMarketConditions_({ foreign_net_oku: 0 })[4].alert, false, '海外投資家フラットは売り越しではない');
}

/* ── 9. 東証信用残（mtseisan）の読み取り ─────────────────────────────────── */

console.log('\n【9】parseTseMarginGrid_ — JPX二市場信用取引現在高');
{
  // 実サンプル(2026/7/17)と同じ関係: 売残6,814億円・信用倍率9.21倍
  const sellShares = 739000000, buyShares = 6806190000, sellMil = 681400;
  const grid = [
    ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '東京 Tokyo', '株数 Shs.', '', '', '', '', '', '', '', '', sellShares, '', buyShares],
    ['', '', '金額 Val.', '', '', '', '', '', '', '', '', sellMil, '', 4000000],
  ];
  const r = M.parseTseMarginGrid_(grid);
  eq(r.sellOku, 6814, '売残（百万円→億円）が6,814億円');
  eq(r.ratio, 9.21, '信用倍率（買残株÷売残株）が9.21倍');
  eq(r.sellShares, sellShares, '売残株数をL列(index11)から読む');
  eq(r.buyShares, buyShares, '買残株数をN列(index13)から読む');
}
{
  const grid = [['', '東京', '株数', '', '', '', '', '', '', '', '', '1,000,000', '', '2,500,000']];
  const r = M.parseTseMarginGrid_(grid);
  eq(r.ratio, 2.5, 'カンマ区切りの文字列でも数値として読む');
  eq(r.sellOku, null, '金額行が続かなければ売残金額は null（倍率だけは使える）');
  eq(M.parseTseMarginGrid_(grid.concat([['', '', '合計', '', '', '', '', '', '', '', '', 1, '', 2]])).sellOku, null,
    '直下が金額行でなければ売残金額は採らない');
}
{
  const row = (mkt, kind, a, b) => ['', mkt, kind, '', '', '', '', '', '', '', '', a, '', b];
  eq(M.parseTseMarginGrid_([row('大阪', '株数', 1, 2), row('', '金額', 1, 2)]), null, '東京以外の行は拾わない');
  eq(M.parseTseMarginGrid_([row('東京', '金額', 1, 2)]), null, '金額行だけでは株数が取れないので採らない');
  eq(M.parseTseMarginGrid_([]), null, '空データは null');
  eq(M.parseTseMarginGrid_([row('東京', '株数', 0, 100)]), null, '売残0株は0除算になるので採用しない');
  eq(M.parseTseMarginGrid_([row('東京', '株数', '▲1,000', 100)]), null, '負の売残（▲表記）も採用しない');
}

/* ── 10. 日経EPS の妥当範囲ガード ───────────────────────────────────────── */

console.log('\n【10】parseNikkeiEpsHtml_ — 誤った自動値で上書きしない');
{
  const html = eps => eps.map(([d, v]) => `<tr><td>${d}</td><td>${v}</td><td>18.5</td></tr>`).join('');
  const week = (base, step) => Array.from({ length: 8 },
    (_, i) => [`2026-07-${String(20 - i).padStart(2, '0')}`, (base - i * step).toFixed(2)]);

  const down = M.parseNikkeiEpsHtml_(html(week(2500, -3)));
  eq(down && down.trend, 'DOWN', '直近が1週間前より低ければ DOWN');
  const up = M.parseNikkeiEpsHtml_(html(week(2500, 3)));
  eq(up && up.trend, 'UP', '高ければ UP');
  eq(M.parseNikkeiEpsHtml_(html(week(2500, 0))).trend, 'FLAT', 'ほぼ同じなら FLAT');

  const jump = [['2026-07-20', '4500.00']].concat(week(2500, 1).slice(1));
  eq(M.parseNikkeiEpsHtml_(html(jump)), null, '1週間で15%超の変化は採用しない（抽出ずれの疑い）');
  eq(M.parseNikkeiEpsHtml_(html(week(2500, 1).slice(0, 5))), null, 'データが6件未満なら null');
  eq(M.parseNikkeiEpsHtml_('<html>なにもない</html>'), null, '解析できなければ null（手入力へ委ねる）');
}

/* ── 11. その他 ─────────────────────────────────────────────────────────── */

console.log('\n【11】決算後の急落頻度・表示ラベル');
{
  eq(M.selloffFrequency_([-0.05, -0.01, -0.04, 0.02], 0.03), { total: 4, drops: 2, frac: 0.5 },
    '3%超の下落が4件中2件 → 0.5');
  eq(M.selloffFrequency_([], 0.03), { total: 0, drops: 0, frac: 0 }, '空なら0（0除算しない）');
  eq(M.selloffFrequency_([NaN, -0.05], 0.03).total, 1, '数値でない要素は母数から除く');
}
{
  eq(M.macroValueLabel_('GOLDEN_CROSS'), 'ゴールデンクロス', '内部表現を日本語ラベルにする');
  eq(M.macroValueLabel_(''), '', '空は空のまま');
  eq(M.macroValueLabel_(1234), '1234', '辞書に無い値はそのまま文字列化');
}
{
  eq(M.calendarStatusLabel_('confirmed'), '確定', 'confirmed→確定');
  eq(M.calendarStatusLabel_('estimated'), '予測', 'estimated→予測');
  eq(M.calendarStatusLabel_(''), '', '空は空のまま');
  eq(M.calendarStatusLabel_('unknown'), 'unknown', '辞書に無い値はそのまま返す');
}

console.log('\n【12】決算カレンダー — 対象銘柄への絞り込み・日付ソート');
{
  // edinetdb.jp /v1/calendar の実測フィールド名（secCode／announcementDate／estimatedAnnouncementDate）
  const rows = [
    { secCode: '9999', announcementDate: '2026-08-10', dateStatus: 'confirmed', marketCap: 500 },   // 対象外コード
    { secCode: '72030', announcementDate: '2026-08-05', dateStatus: 'confirmed', marketCap: 30000 }, // 5桁→to4_で7203化
    { secCode: '6758', announcementDate: null, estimatedAnnouncementDate: '2026-08-01', dateStatus: 'estimated', marketCap: 15000 },
  ];
  const out = M.filterCalendarToUniverse_(rows, ['7203', '6758']);
  eq(out.length, 2, '対象銘柄(7203/6758)の2件のみ残る');
  eq(out[0].code, '6758', '日付昇順で先頭は8/1の6758（estimatedAnnouncementDateから採る）');
  eq(out[1].code, '7203', '次が8/5の7203（5桁コードもto4_で正規化）');
  eq(out[0].dateStatus, 'estimated', 'dateStatusを保持する');
  eq(out[1].date, '2026-08-05', 'confirmed時はannouncementDateを採る');

  eq(M.filterCalendarToUniverse_([], ['7203']), [], '行が空なら空配列');
  eq(M.filterCalendarToUniverse_(null, ['7203']), [], 'rowsがnullでも例外にならず空配列');
  eq(M.filterCalendarToUniverse_([{ secCode: '7203', dateStatus: 'confirmed' }], ['7203']),
    [], '発表日(announcementDate/estimatedAnnouncementDateとも無し)の行は除外する');
}

console.log('\n【13】edinetExtractArray_ — レスポンス配列本体の抽出');
{
  // 実測: /v1/calendar は {"data":{"calendar":[...]}}（"data"自体は配列でなくオブジェクト）で返る
  eq(M.edinetExtractArray_({ data: { calendar: [{ a: 1 }, { a: 2 }] } }), [{ a: 1 }, { a: 2 }],
    '{data:{calendar:[...]}} の1階層ネストから配列を取り出す');
  eq(M.edinetExtractArray_({ data: [{ a: 1 }] }), [{ a: 1 }], '{data:[...]} のように直下が配列でもそのまま取れる');
  eq(M.edinetExtractArray_([{ a: 1 }]), [{ a: 1 }], 'レスポンス自体が配列ならそのまま');
  eq(M.edinetExtractArray_({}), [], '配列が見つからなければ空配列');
  eq(M.edinetExtractArray_(null), [], 'nullでも例外にならず空配列');
}

console.log('\n【14】calendarMapFromEntries_ — シグナルK列用のコード→直近1件マップ');
{
  const entries = [
    { code: '6758', date: '2026-08-01', dateStatus: 'confirmed' },
    { code: '7203', date: '2026-08-05', dateStatus: 'estimated' },
    { code: '6758', date: '2026-11-10', dateStatus: 'estimated' },   // 同一コード2件目（Q2等）は無視
  ];
  const m = M.calendarMapFromEntries_(entries);
  eq(Object.keys(m).length, 2, 'コードは2件（重複は先頭=直近日のみ採用）');
  eq(m['6758'].date, '2026-08-01', '6758は先頭（直近）の8/1を採る。11/10は無視');
  eq(m['7203'].date, '2026-08-05', '7203は8/5');
  eq(M.calendarMapFromEntries_([]), {}, '空なら空オブジェクト');
  eq(M.calendarMapFromEntries_(null), {}, 'nullでも例外にならず空オブジェクト');
}

console.log('\n【15】J-Quants V2移行 — pickForeignFlow_ / extractProfit_');
{
  // /equities/investor-types（旧 /markets/trades_spec）実測フィールド: EnDate・FrgnBal・Section
  const rows = [
    { Section: 'TSE1st', EnDate: '2026-07-10', FrgnBal: 100000 },
    { Section: 'TSEPrime', EnDate: '2026-07-24', FrgnBal: -222260039 },   // 最新週・売り越し
    { Section: 'TSEPrime', EnDate: '2026-07-17', FrgnBal: 500000 },
  ];
  const r = M.pickForeignFlow_(rows);
  eq(r.week, '2026-07-24', 'Primeの中で最新週(EnDate)を選ぶ');
  eq(r.netOku, Math.round(-222260039 / 100000), '千円→億円換算（売り越しは負）');
  eq(M.pickForeignFlow_([]), null, '空配列はnull');
  eq(M.pickForeignFlow_([{ Section: 'TSEPrime', EnDate: '2026-07-24' }]), null, 'FrgnBal欠損はnull');
}
{
  // /fins/details（旧 /fins/statements）実測: FSオブジェクトの中に会計基準別のキーで純利益が入る
  eq(M.extractProfit_({ 'Profit (loss) (IFRS)': '48314000000.0', 'Profit (loss) attributable to owners of parent (IFRS)': '40000000000.0' }),
    48314000000, '親会社帰属分ではなく連結全体のProfit (loss)を優先する');
  eq(M.extractProfit_({ 'Profit (loss) attributable to owners of parent (IFRS)': '40000000000.0' }),
    40000000000, '連結全体キーが無ければattributable系でも可');
  eq(M.extractProfit_({}), NaN, '該当キーが無ければNaN');
  eq(M.extractProfit_(null), NaN, 'nullでも例外にならずNaN');
}

console.log('\n' + '─'.repeat(62));
console.log(fail === 0 ? `全 ${pass} 項目 合格` : `${pass} 合格 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
