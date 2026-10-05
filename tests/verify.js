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
const sandboxTriggers = [];   // ScriptApp スタブが持つ登録済みトリガー
const sandbox = {
  Logger: { log: m => logs.push(String(m)) },
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} }),
  },
  SpreadsheetApp: {
    getActive: () => { throw new Error('シートは使わない'); },
    // RichTextValue のビルダーだけは実物の形を真似る（コード列のリンク生成を検証するため）
    newRichTextValue: () => {
      const v = { text: '', link: null };
      const b = {
        setText(s) { v.text = String(s); return b; },
        setLinkUrl(u) { v.link = u; return b; },
        build() { return v; },
      };
      return b;
    },
  },
  UrlFetchApp: { fetch: () => { throw new Error('通信は使わない'); } },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10), sleep: () => {} },
  ScriptApp: {
    getProjectTriggers: () => sandboxTriggers.slice(),
    newTrigger: (fn) => { const t = { getHandlerFunction: () => fn, fn, cfg: {} };
      const b = { timeBased: () => b, everyDays: (n) => { t.cfg.everyDays = n; return b; }, atHour: (h) => { t.cfg.atHour = h; return b; },
        nearMinute: (m) => { t.cfg.nearMinute = m; return b; }, after: () => b, everyHours: () => b, create: () => { sandboxTriggers.push(t); return t; } };
      return b; },
    deleteTrigger: () => {},
  },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.com' }) },
  DriveApp: {}, MailApp: { sendEmail: () => {} },
  GmailApp: {
    getUserLabelByName: () => null,
    createLabel: () => ({ addLabel: () => {} }),
    search: () => [],
  },
};

const read = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const EXPORTS = [
  'SK', 'MACRO', 'BT_MIN_SAMPLE',
  'rsiSeries_', 'rsiFrom_', 'macdSeries_',
  'detectSakata_', 'detectReversalPairs_', 'detectStars_', 'findExtrema_', 'detectHeadShoulders_',
  'parseYahooBars_', 'avgBody_', 'atr_', 'medianTurnover_', 'isLiquidEnough_',
  'signalStrength_', 'parseSignalNames_', 'suggestWeight_', 'patternPoints_',
  'marginRegime_', 'regimeFactor_', 'nsRatioTrend_', 'vixMacdSignal_', 'checkMarketConditions_',
  'marginRatioTrend_', 'shiftMarginRatioHistory_', 'marginRatioLabel_', 'parseYahooJpMarginDate_',
  'parseTseMarginGrid_', 'parseNikkeiEpsHtml_', 'selloffFrequency_', 'macroValueLabel_',
  'filterCalendarToUniverse_', 'calendarStatusLabel_', 'edinetExtractArray_', 'calendarMapFromEntries_',
  'pickForeignFlow_', 'extractProfit_',
  'tickSize_', 'roundToTick_', 'priceLimit_', 'dowSwings_', 'pullbackLow_', 'buildOrderPlan_',
  'planRow_', 'PLAN_HEADERS_', 'planTargets_', 'toNum_', 'topPicks_', 'briefingRows_', 'planSummary_',
  'planMailLine_', 'webPlanRows_', 'ifdocoExpiry_', 'IFDOCO_MAX_DAYS_', 'SAKATA_PROFIT_LABEL_', 'codeLinkRichText_', 'tvChartUrl_',
  'companyKey_', 'bloombergMention_', 'bloombergParse_', 'bloombergRows_', 'ensureBloombergTrigger_', 'applyCandidateFormats_', 'readCandidates_', 'planLooksBroken_', 'CAND_FORMATS_', 'CAND_HEADERS_',
  // ダウ理論×フィボナッチの買い推奨（DowFib.js）
  'DF', 'dfSetup_', 'dfSwings_', 'dfRawSwings_', 'dfOrderPlan_', 'dfReason_',
  // SIGNAL_WEIGHT_ 算出の統計コア（MLWeights.js）。tools/calc_weights.js から呼ばれる純粋関数。
  'ML',
  'benchmarkReturn_', 'extractMlRow_', 'buildDateCloseMap_', 'barDateKey_',
  'wilsonInterval_', 'decideWeight_', 'SIGNAL_WEIGHT_', 'SIGNAL_DIR_',
];
// 共通モジュール（symlink）も読み込む。本体が fetchWithRetry_ / confirmDestructive_ / to4_ を呼ぶため。
const M = new Function(...Object.keys(sandbox), `
${read('FetchRetry.js')}
${read('ConfirmUi.js')}
${read('StockCode.js')}
${read('Code.js')}
${read('DowFib.js')}
${read('Bloomberg.js')}
${read('MarketMacro.js')}
${read('MLWeights.js')}
${read('WebMenu.js')}
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
  const T = M.SK.MARGIN.SELL_THRESHOLD_OKU;
  eq(M.marginRegime_(T, 'DOWN'), 'SHORT_COVER', '売残潤沢＋倍率低下 → ショートカバー好機');
  eq(M.marginRegime_(T - 1, 'UP'), 'SUPPLY_RISK', '売残枯渇＋倍率上昇 → 需給悪化');
  eq(M.marginRegime_(T, 'UP'), 'NEUTRAL', '境界の組み合わせは中立');
  eq(M.marginRegime_('', 'UP'), 'NEUTRAL', '売残が未入力なら中立（Number("")=0 を「売残枯渇」と読まない）');
  eq(M.marginRegime_(9000, ''), 'NEUTRAL', '倍率トレンドが未判定でも中立（逆向きの誤判定も防ぐ）');
  eq(M.marginRegime_(null, null), 'NEUTRAL', '未取得も中立');
  eq(M.marginRegime_('9000', 'DOWN'), 'SHORT_COVER', '数字の文字列は数値として扱う（シート入力はしばしば文字列）');
  // 倍率が横ばいなら、売残の水準だけでは地合いを決めない。
  // 旧仕様（水準判定）は 1570 の倍率が 10 倍前後で 1.0 を恒久的に上回るため、
  // 売残が 8,000 億を割っている限り SUPPLY_RISK に張り付き、買いが永久に減点されていた。
  eq(M.marginRegime_(T - 1, 'FLAT'), 'NEUTRAL', '倍率が横ばいなら売残が枯渇していても中立');
  eq(M.marginRegime_(T + 1, 'FLAT'), 'NEUTRAL', '同上（買い側も同じ扱い）');
  eq(M.marginRegime_(6814, 'FLAT'), 'NEUTRAL',
    '実データ回帰: 売残6814億・倍率10.24倍でも、倍率が動かなければ SUPPLY_RISK に固定されない');
}
{
  const W = M.SK.MARGIN.RATIO_TREND_BAND;
  eq(M.marginRatioTrend_(10.24, 9.5), 'UP', '倍率が前回より上がれば UP（買い方過多が進行）');
  eq(M.marginRatioTrend_(9.5, 10.24), 'DOWN', '下がれば DOWN（売残が積む＝ショートカバー燃料）');
  eq(M.marginRatioTrend_(10.24, 10.24), 'FLAT', '同値は FLAT');
  eq(M.marginRatioTrend_(10 * (1 + W / 2), 10), 'FLAT', '不感帯の内側は FLAT（丸め由来の微小変動で反転させない）');
  eq(M.marginRatioTrend_(10 * (1 + W * 2), 10), 'UP', '不感帯を超えれば UP');
  eq(M.marginRatioTrend_(10.24, null), 'FLAT', '前回値が無い初回は判定しない');
  eq(M.marginRatioTrend_(10.24, 0), 'FLAT', '前回値が0なら割り算しない');
  eq(M.marginRatioTrend_('', 10), 'FLAT', '未入力は判定しない');
  // 水準に依存しないので、母集団を東証全体（9倍前後）に差し替えても同じ式で読める
  eq(M.marginRatioTrend_(9.4, 9.0), 'UP', '東証全体の倍率（9倍前後）でも同じ判定式が使える');
}
{
  // 週次公表なので、日次実行のたびにシフトすると「前週比」が「前日比」になり常に FLAT になる
  const h0 = M.shiftMarginRatioHistory_({}, 9.8, '09/04');
  eq(h0.cur.v, 9.8, '初回は cur に入る');
  eq(h0.prev, null, '初回は prev が無い');
  const h1 = M.shiftMarginRatioHistory_(h0, 9.8, '09/04');
  eq(h1.prev, null, '同じ公表日で再実行してもシフトしない（日次実行で履歴を潰さない）');
  const h2 = M.shiftMarginRatioHistory_(h1, 10.24, '09/11');
  eq(h2.prev.v, 9.8, '公表日が変われば前回値へ送る');
  eq(M.marginRatioTrend_(h2.cur.v, h2.prev.v), 'UP', '送った前回値で UP と判定できる');
  const h3 = M.shiftMarginRatioHistory_(h2, null, '09/18');
  eq(h3.cur.v, 10.24, '取得失敗(null)では履歴を汚さない');
  eq(h3.prev.v, 9.8, '同上（prev も保つ）');
  // 日付が取れないページ構造変更時のフォールバック
  const d0 = M.shiftMarginRatioHistory_({}, 9.8, '');
  const d1 = M.shiftMarginRatioHistory_(d0, 9.8, '');
  eq(d1.prev, null, '日付が無いときは同値ならシフトしない');
  const d2 = M.shiftMarginRatioHistory_(d1, 10.24, '');
  eq(d2.prev.v, 9.8, '日付が無くても値が変われば送る');
}
{
  eq(M.marginRatioLabel_(10.24, 9.8, 'UP'), '10.24（前回 9.8 → 上昇）', '値と前回値と方向を1セルに出す');
  eq(M.marginRatioLabel_(10.24, null, 'FLAT'), '10.24（前回なし・初回）',
    '初回は「横ばい」と書かない（比較した結果と区別できなくなるため）');
  eq(M.marginRatioLabel_(null, 9.8, 'UP'), null, '値が無ければ null');
}
{
  const b = M.SK.MARGIN.BUY_BOOST, s = M.SK.MARGIN.SELL_BOOST;
  eq(M.regimeFactor_('SHORT_COVER', '買い'), b, 'ショートカバー局面は買いを増幅');
  eq(M.regimeFactor_('SUPPLY_RISK', '売り'), s, '需給悪化局面は売りを増幅');
  eq(M.regimeFactor_('NEUTRAL', '買い'), 1, '中立は等倍');
  eq(M.regimeFactor_('SHORT_COVER', '混在'), 1, '方向が混在なら等倍（順位を歪めない）');
  // 逆風方向は等倍。除算すると★★★に必要な生スコアが倍になり、重み上限3では到達不能になる。
  eq(M.regimeFactor_('SUPPLY_RISK', '買い'), 1, '需給悪化局面でも買いは減点しない（等倍）');
  eq(M.regimeFactor_('SHORT_COVER', '売り'), 1, 'ショートカバー局面でも売りは減点しない（等倍）');
  // 実データ由来の回帰: 2026-09-18 の最強の買い（三川(逆三尊)3＋RSIダイバ(強気)1＋包み線(強気)2＋毛抜き底1＝7点）は
  // SUPPLY_RISK でも★★★（しきい値5）に届く。旧実装では 7/1.5=4.67 で★★に落ちていた。
  eq(7 * M.regimeFactor_('SUPPLY_RISK', '買い') >= M.SK.STAR3, true,
    '需給悪化局面でも生スコア7点の買いは★★★になる');
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
    sell_margin_oku: 5000, margin_ratio: 10.24, margin_ratio_prev: 9.5, margin_ratio_trend: 'UP',
    ns_ratio_trend: 'DOWN', nikkei_eps_trend: 'DOWN',
    foreign_net_oku: -1200, vix_macd_signal: 'GOLDEN_CROSS', earnings_selloff: 'YES',
  });
  eq(all.filter(c => c.alert).length, 7, '全条件が揃えば7/7点灯');
  eq(all[1].value, '10.24（前回 9.5 → 上昇）', '倍率は値・前回値・方向をまとめて出す');
}
{
  const none = M.checkMarketConditions_({
    sell_margin_oku: 9000, margin_ratio: 10.24, margin_ratio_prev: 11.0, margin_ratio_trend: 'DOWN',
    ns_ratio_trend: 'UP', nikkei_eps_trend: 'UP',
    foreign_net_oku: 500, vix_macd_signal: 'DEAD_CROSS', earnings_selloff: 'NO',
  });
  eq(none.filter(c => c.alert).length, 0, '良好な地合いでは0/7');
  eq(M.checkMarketConditions_({ foreign_net_oku: 0 })[4].alert, false, '海外投資家フラットは売り越しではない');
  // 水準では点灯しない＝旧仕様との決別。10.24倍でも、動いていなければ買い方過多の「進行」ではない
  eq(M.checkMarketConditions_({ margin_ratio: 10.24, margin_ratio_trend: 'FLAT' })[1].alert, false,
    '倍率が高水準でも横ばいなら点灯しない（水準判定をやめた）');
  eq(M.checkMarketConditions_({ margin_ratio: 0.8, margin_ratio_prev: 0.7, margin_ratio_trend: 'UP' })[1].alert, true,
    '倍率が1.0未満でも上昇していれば点灯する（同上）');
}
{
  // ページ構造変更で静かに壊れると「前回比」が出せなくなるため、実ページの形を固定する
  const html = '信用倍率\\",\\"primary\\":{\\"value\\":\\"10.24\\",\\"move\\":\\"even\\",\\"suffix\\":\\"倍\\"},\\"updateDate\\":\\"09/11\\"}';
  eq(M.parseYahooJpMarginDate_(html), '09/11', 'Yahooページから信用残の更新日(MM/DD)を取る');
  eq(M.parseYahooJpMarginDate_('信用倍率 10.24'), null, '日付が無ければ null（値の変化でシフト判断に落ちる）');
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
    { secCode: '9999', announcementDate: '2026-08-10', dateStatus: 'confirmed', marketCap: 500000000 },   // 対象外コード
    { secCode: '72030', announcementDate: '2026-08-05', dateStatus: 'confirmed', marketCap: 30000000000 }, // 5桁→to4_で7203化
    { secCode: '6758', announcementDate: null, estimatedAnnouncementDate: '2026-08-01', dateStatus: 'estimated', marketCap: 304411187880 },
  ];
  const out = M.filterCalendarToUniverse_(rows, ['7203', '6758']);
  eq(out.length, 2, '対象銘柄(7203/6758)の2件のみ残る');
  eq(out[0].code, '6758', '日付昇順で先頭は8/1の6758（estimatedAnnouncementDateから採る）');
  eq(out[1].code, '7203', '次が8/5の7203（5桁コードもto4_で正規化）');
  eq(out[0].dateStatus, 'estimated', 'dateStatusを保持する');
  eq(out[1].date, '2026-08-05', 'confirmed時はannouncementDateを採る');
  // marketCapはedinetdb.jpから生の円単位で返る（実測: 宝ホールディングス304,411,187,880円）。
  // シート見出しは「時価総額（億円）」なので1億で割る。円のまま書くと実際の1億倍という
  // 非現実的な数値になる不具合があった（2026-08-21発見）。
  eq(out[0].marketCap, 3044, '円→億円（304,411,187,880円 → 3,044億円）');
  eq(out[1].marketCap, 300, '円→億円（30,000,000,000円 → 300億円）');
  eq(M.filterCalendarToUniverse_([{ secCode: '7203', announcementDate: '2026-08-05', dateStatus: 'confirmed' }], ['7203'])[0].marketCap,
    null, 'marketCap未提供ならnull（0円と誤読しない）');

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

/* ── 16. 注文プラン（ダウ理論） ──────────────────────────────────────────── */

console.log('\n【16】呼値・値幅制限');
{
  eq(M.tickSize_(1595.5), 1, '3,000円以下は1円刻み');
  eq(M.tickSize_(3000), 1, '3,000円ちょうどは1円刻み（境界は「以下」）');
  eq(M.tickSize_(3001), 5, '3,000円超は5円刻み');
  eq(M.tickSize_(5001), 10, '5,000円超は10円刻み');
  eq(M.tickSize_(30001), 50, '30,000円超は50円刻み');
  eq(M.tickSize_(0), 1, '0や不正値でも0を返さない（0除算を作らない）');

  eq(M.roundToTick_(1595.7, 'down'), 1595, '切り捨て');
  eq(M.roundToTick_(1595.2, 'up'), 1596, '切り上げ');
  eq(M.roundToTick_(1596, 'down'), 1596, 'ちょうどの値は動かさない（浮動小数で1つ下にずれない）');
  eq(M.roundToTick_(3210.4, 'down'), 3210, '5円刻み帯の切り捨て');
  eq(M.roundToTick_(3210.4, 'up'), 3215, '5円刻み帯の切り上げ');

  // SBIの注文画面の実測値（基準値段1,595.5 → 1,195.5〜1,995.5）と一致すること
  const lim = M.priceLimit_(1595.5);
  eq([lim.low, lim.high, lim.width], [1195.5, 1995.5, 400], '制限値幅は基準値段±400（実画面と一致）');
  eq(M.priceLimit_(99).width, 30, '100円未満は±30');
  eq(M.priceLimit_(100).width, 50, '100円ちょうどは±50（境界は「未満」で切る）');
  eq(M.priceLimit_(120).low, 70, '下限は基準値段−制限値幅');
}

console.log('\n【17】ダウ理論のスイングとトレンド判定');
{
  // 折れ点を線形補間したバー列。h=c+spread, l=c−spread なので極値は終値の極値と一致する。
  const zig = (waypoints, spread) => {
    const s = spread == null ? 1 : spread;
    const last = waypoints[waypoints.length - 1];
    const c = new Array(last[0] + 1);
    for (let k = 0; k + 1 < waypoints.length; k++) {
      const [i0, p0] = waypoints[k], [i1, p1] = waypoints[k + 1];
      for (let i = i0; i < i1; i++) c[i] = p0 + (p1 - p0) * (i - i0) / (i1 - i0);
    }
    c[last[0]] = last[1];
    return c.map((v, i) => ({ o: i ? c[i - 1] : v, h: v + s, l: v - s, c: v, v: 1e6, t: 1e9 + i * 86400, cont: true }));
  };

  // 高値切り上げ(110→125)・安値切り上げ(90→100) = ダウ理論の上昇トレンド
  const up = zig([[0, 95], [5, 90], [12, 110], [20, 100], [28, 125], [34, 120]]);
  const swUp = M.dowSwings_(up, 3);
  eq([swUp.prevLow, swUp.low, swUp.prevHigh, swUp.high], [89, 99, 111, 126], '確定スイングの高値・安値を拾う');
  eq(swUp.trend, '上昇', '高値・安値とも切り上げ → 上昇トレンド');
  eq(M.pullbackLow_(up, swUp), 99, '押し安値＝直近スイング安値以降の最安値');

  // 高値が1つしか確定していない = トレンドとは呼ばない
  const rng = zig([[0, 140], [8, 130], [14, 138], [22, 100], [30, 108]]);
  const swRng = M.dowSwings_(rng, 3);
  eq(swRng.trend, 'レンジ', '比較対象の高値が無ければトレンド判定しない');

  // 一直線に上がるだけの列にはスイング安値が無い
  const mono = zig([[0, 100], [19, 140]]);
  eq(M.dowSwings_(mono, 3).lowIdx, null, '単調上昇には確定スイング安値が無い');
  eq(M.pullbackLow_(mono, M.dowSwings_(mono, 3)), null, 'スイング安値が無ければ押し安値もnull');

  /* ── 注文プラン本体 ── */
  console.log('\n【18】注文プラン — 買い/利確/損切り/株数');

  const cfg = k => Object.assign({}, M.SK.ORDER, k || {});

  // 上昇トレンド継続: 現値の指値で押し目を待ち、押し安値(99)の1ティック下で損切り
  const p1 = M.buildOrderPlan_(up, cfg());
  eq(p1.ok, true, '上昇トレンドではプランが成立する');
  eq(p1.entryType, '指値', '上昇トレンド継続中は現値の指値（追いかけない）');
  eq([p1.entry, p1.stop, p1.target], [120, 98, 164], '買い120 / 損切り98(押し安値99の1つ下) / 利確164(リスク22×2)');
  eq(p1.rr, 2, '呼値に丸めた後もRRは2.0');
  eq(p1.stopLimit, 96, 'OCO2の訂正指値はトリガーの2ティック下');
  eq(p1.shares, 1300, '許容損失30,000円 ÷ リスク22円 → 1,300株（100株単位で切り捨て）');
  eq(p1.lossYen, 28600, '損切り額は許容損失に収まる実額');
  eq(p1.profitYen, 57200, '想定利益は損切り額の2倍');
  eq(p1.notes, [], '警告なし');

  // トレンド未確定: 戻り高値(138)を上抜けたところの逆指値で「転換の確定」を待つ
  const p2 = M.buildOrderPlan_(rng, cfg());
  eq(p2.entryType, '逆指値', 'トレンド未確定なら戻り高値の上抜けを待つ');
  eq(p2.entry, 140, '買いは直近高値139の1ティック上');
  eq(p2.stop, 98, '損切りは押し安値99の1つ下（エントリー方式によらずダウ理論の水準）');
  eq(p2.shares, 700, 'リスクが広がるぶん株数は減る（許容損失は一定）');
  eq(p2.notes.indexOf('利確が制限値幅の上限外（当日は発注不可）') >= 0, true,
    '利確が値幅制限の外なら警告する（黙って発注不可の値段を出さない）');

  // 許容損失が小さすぎて1単元も建てられないときは、0株ではなく「見送り」を返す
  const p3 = M.buildOrderPlan_(up, cfg({ RISK_BUDGET_YEN: 1000 }));
  eq(p3.ok, false, '許容損失内で100株も建てられなければ成立させない');
  eq(p3.shares, 0, '見送り時は株数0');
  eq(p3.reason.indexOf('リスク過大') === 0, true, '理由を返す（黙って空欄にしない）');

  // 建てられない理由がリスク幅なのか建玉上限なのかを書き分ける
  // （まとめて「リスク過大」と出すと、値がさ株で上限に当たっただけのときに損切り幅を疑う）
  const p3b = M.buildOrderPlan_(up, cfg({ MAX_POSITION_YEN: 1000 }));
  eq(p3b.ok, false, '建玉上限が買値100株に届かなければ成立させない');
  eq(p3b.reason.indexOf('建玉上限') === 0, true, '建玉上限が理由のときはリスク過大と言わない');

  // 建玉上限はリスク基準より優先して株数を抑える
  const p4 = M.buildOrderPlan_(up, cfg({ MAX_POSITION_YEN: 100000 }));
  eq(p4.shares, 800, '建玉上限10万円 ÷ 買値120 → 800株');
  eq(p4.notes.indexOf('建玉上限で株数を抑制') >= 0, true, '株数を絞ったことを明示する');

  // 押し安値が現値のすぐ下だと、理論どおりの損切りはノイズで即狩られる
  const tight = zig([[0, 1000], [5, 995], [12, 1010], [20, 1002], [28, 1020], [36, 1001.9]], 0.2);
  const p5 = M.buildOrderPlan_(tight, cfg());
  eq(p5.notes.indexOf('損切り幅をATR14×0.5まで拡大') >= 0, true, '損切りが近すぎるときはATRまで広げる');
  eq(p5.entry - p5.stop >= 1, true, '拡大後は最低1ティック以上離れている');

  // 前提が揃わないケース
  eq(M.buildOrderPlan_(up.slice(0, 8), cfg()).reason, '足が不足（スイングを確定できない）', '足が短ければ計算しない');
  eq(M.buildOrderPlan_(mono, cfg()).reason, '押し安値を特定できない（確定スイング安値なし）', '押し安値が無ければ計算しない');
  eq(M.buildOrderPlan_([], cfg()).ok, false, '空配列でも例外にならない');

  console.log('\n【19】保有株モード — 返済売の2値だけを出す');

  // 保有株はすでに建っているので、買値と株数は逆算せず、実際の建玉をそのまま使う。
  // リスクの起点は買値ではなく現在値（これから失いうるのは現在値からの下落分）。
  const h1 = M.buildOrderPlan_(up, cfg(), { shares: 300, cost: 110 });
  eq(h1.ok, true, '保有株でもプランは成立する');
  eq(h1.held, true, '保有株モードのフラグが立つ');
  eq(h1.entry, null, '保有株に新規の買値は出さない');
  eq([h1.basis, h1.stop, h1.target], [120, 98, 164], '基準は現在値120、損切り・利確は★3買いと同じ水準');
  eq(h1.shares, 300, '株数は逆算せず実際の保有数を使う');
  eq(h1.lossYen, 6600, '損切り額は現在値から損切りまでの下落 × 保有株数');

  // 株数が取れないときに0株として損切り額0円を出すと、リスクが無いように見える
  const h2 = M.buildOrderPlan_(up, cfg(), { shares: 0, cost: null });
  eq(h2.ok, true, '株数不明でも価格は出す（損切りの置き直しには十分）');
  eq(h2.lossYen, 0, '株数不明なら損切り額は空扱い');
  eq(h2.notes.indexOf('保有株数を取得できず損切り額は未計算') >= 0, true, '株数が無いことを明示する');

  // 保有株は許容損失で弾かない（もう建っているので「見送り」は成立しない）
  eq(M.buildOrderPlan_(up, cfg({ RISK_BUDGET_YEN: 1000 }), { shares: 300, cost: 110 }).ok, true,
    '許容損失を超えていても保有株のプランは出す（撤退水準は必要）');

  // トレンドが崩れた（上昇でなくなった）保有株は、押し安値割れを待たず早期手仕舞いの
  // 材料として出す。損切り価格自体はダウ理論の撤退水準（押し安値）のまま動かさない。
  const over2 = zig([[0, 140], [8, 130], [14, 138], [22, 100], [30, 145]]);
  const h3 = M.buildOrderPlan_(over2, cfg(), { shares: 300, cost: 110 });
  eq(h3.trend, 'レンジ', 'トレンドが崩れているケースを用意');

  console.log('\n【20】ダウ理論×フィボナッチの買い推奨（DowFib.js）');
  {
    // 主要トレンドの山谷: 30本目の安値80 → 55本目の高値120 → 80本目の安値95（切り上げ）→ 110本目の高値140（更新）
    // そこから押し（小さな戻り高値132をはさんで118まで）→ 124本目に終値135で小さな戻り高値を上抜け
    const path = [[0, 110], [30, 80], [55, 120], [80, 95], [110, 140], [114, 126], [117, 132], [121, 118], [123, 125], [124, 135]];
    const mk = (pts, lastVol) => {
      const out = [];
      for (let k = 0; k < pts.length - 1; k++) {
        const [i0, p0] = pts[k], [i1, p1] = pts[k + 1];
        for (let i = i0; i < i1; i++) out.push(p0 + (p1 - p0) * (i - i0) / (i1 - i0));
      }
      out.push(pts[pts.length - 1][1]);
      return out.map((c, i) => ({ o: i ? out[i - 1] : c, h: c + 1, l: c - 1, c, v: 1000, t: 1700000000 + i * 86400, cont: true }))
        .map((b, i, a) => (i === a.length - 1 && lastVol ? Object.assign(b, { v: lastVol }) : b));
    };
    const bars = mk(path, 2000);
    const s = M.dfSetup_(bars);
    eq(s != null, true, '上昇トレンドの押し目から小さな戻り高値を上抜けた日に成立する');
    near(s.retr, (141 - 117) / (141 - 94), 1e-9, '押しの深さ = (高値 − 押し目安値) / (高値 − 押し安値)');
    eq(s.grade, 'A', '押し38.2%以上かつ出来高1.5倍以上なら確度A');
    near(s.target, 94 + 47 * 1.618, 1e-9, '利確 = 押し安値 + 上昇幅 × 1.618');
    eq(s.stop < 117 && s.stop > 116, true, '損切りは押し目の安値（117）の少し下');
    eq(M.dfSetup_(mk(path, 1200)).grade, 'B', '出来高が増えていなければ確度B');

    // 前日すでに戻り高値を超えていたら「初めて上抜けた日」ではない
    const p2 = path.slice(0, -2).concat([[123, 134], [124, 136]]);
    eq(M.dfSetup_(mk(p2, 2000)), null, '前日に上抜け済みなら成立しない（初日だけ）');
    // 押しが深すぎる（78.6%超）とトレンド否定に近い
    const p3 = path.slice(0, -3).concat([[121, 100], [123, 110], [124, 135]]);
    eq(M.dfSetup_(mk(p3, 2000)), null, '押しが78.6%を超えたら成立しない');
    // 高値更新が無い（前回の山120を超えない）ならダウ理論の上昇トレンドではない
    const p4 = [[0, 110], [30, 80], [55, 120], [80, 95], [110, 118], [114, 108], [117, 112], [121, 102], [123, 106], [124, 113]];
    eq(M.dfSetup_(mk(p4, 2000)), null, '高値を更新していなければ成立しない');

    // 先読みしない: e より後の足（さらに安い安値）を足しても、e 時点の判定は変わらない
    const future = mk(path.concat([[140, 60]]), 0);
    future[124].v = 2000;
    eq(JSON.stringify(M.dfSetup_(future, 124)), JSON.stringify(s), '未来の足を足しても過去の判定が変わらない（先読みなし）');
    eq(M.dfSetup_(bars.slice(0, 100)), null, '履歴が足りなければ判定しない');

    // 注文値: 呼値に丸め、許容損失から株数を逆算する
    const op = M.dfOrderPlan_(s, cfg());
    eq([op.ok, op.entry, op.stop, op.target], [true, 135, Math.floor(s.stop), Math.floor(s.target)], '買い・損切り・利確を呼値に丸める');
    eq(op.shares % 100, 0, '株数は100株単位');
    eq(op.lossYen <= cfg().RISK_BUDGET_YEN, true, '損切りに当たっても許容損失に収まる');
    eq(M.dfOrderPlan_(s, cfg({ RISK_BUDGET_YEN: 100 })).ok, false, '100株も建てられなければ見送り');

    // 推奨の選び方: 確度Aが先、保有中は外す、最大5件
    const c = (code, grade, vr) => ({ code, name: code, setup: { grade, score: (grade === 'A' ? 100 : 0) + vr }, reason: '' });
    const cands = [c('1111', 'B', 3), c('2222', 'A', 1.6), c('3333', 'B', 1), c('4444', 'A', 2.5), c('5555', 'B', 2),
                   c('6666', 'B', 0.5), c('7777', 'B', 4)];
    eq(M.topPicks_(cands).map(x => x.code), ['4444', '2222', '7777', '1111', '5555'], '確度A→出来高の多い順に最大5件');
    eq(M.topPicks_(cands, new Set(['4444'])).map(x => x.code)[0], '2222', '保有中の銘柄は新規の推奨から外す');
  }

  console.log('\n【21】売買プランの行整形・対象組み立て');
  {
    const setup = { close: 135, grade: 'A', score: 102, stop: 116.5, target: 170.0, retr: 0.51, volRatio: 2 };
    const cands = [
      { code: '7203', name: 'トヨタ', setup, reason: '押し51%' },
      { code: '8306', name: '三菱UFJ', setup: Object.assign({}, setup, { grade: 'B', score: 1 }), reason: '押し40%' },
    ];
    const held = { codes: new Set(['8306', '4502']), positions: { '8306': { shares: 200, cost: 1400 } } };
    const targets = M.planTargets_(cands, held);
    eq(targets.map(t => [t.kind, t.code]), [['買い推奨A', '7203'], ['保有', '4502'], ['保有', '8306']],
      '買い推奨が先、保有はコード順。保有中の銘柄は買い側に重複させない');
    eq(targets[2].note, '買い推奨の条件にも該当（買い増し候補・確度B）', '保有中に条件を満たしたら買い増し候補としてメモに残す');
    eq(targets[2].pos, { shares: 200, cost: 1400 }, '保有数量と建値を引き当てる');
    eq(targets[1].pos, { shares: 0, cost: null }, '数量が取れない保有銘柄も落とさない');
    eq(M.planTargets_([], { codes: new Set(), positions: {} }), [], '対象が無ければ空');

    const buyT = Object.assign(targets[0], { extra: ['決算 2026-10-28(予測)'] });
    const op = Object.assign({ held: false }, M.dfOrderPlan_(setup, cfg()));
    const row = M.planRow_(buyT, op);
    eq(row.length, M.PLAN_HEADERS_.length, '買い推奨行の列数がヘッダと一致する');
    eq([row[5], row[6], row[7]], [135, 170, 116], '買い・利確・損切り');
    eq(String(row[10]).split('／')[0], '翌朝の寄付で買い・最長40営業日', 'メモの先頭は注文の仕方');
    eq(String(row[10]).indexOf('決算 2026-10-28(予測)') > 0, true, '決算予定をメモに添える');
    const ng = M.planRow_(buyT, Object.assign({}, op, { ok: false, reason: 'リスク過大' }));
    eq(String(ng[10]).indexOf('見送り：リスク過大') === 0, true, '不成立は「見送り」と理由');
    eq(M.planRow_(buyT, null).length, M.PLAN_HEADERS_.length, '株価が取れなかった行も列数は一致する');

    const heldT = { kind: '保有', code: '7203', name: 'トヨタ', reason: '', note: '', pos: { shares: 300, cost: 110 } };
    eq(M.planRow_(heldT, h1)[5], 110, '保有行の「買い」は実際の建値');
    eq(String(M.planRow_(heldT, null)[10]).indexOf('算出不可') === 0, true,
      '保有株は「見送り」ではなく「算出不可」（持っている以上、見送るという選択肢が無い）');
    eq(String(M.planRow_(heldT, h3)[10]).indexOf('トレンド崩れ（レンジ）') === 0, true,
      '保有株はトレンドが崩れたら早期手仕舞いの警告をメモ先頭に出す');
    eq([M.planRow_(heldT, h3)[6], M.planRow_(heldT, h3)[7]], [h3.target, h3.stop],
      'トレンド崩れの警告があっても損切り・利確の価格は押し安値基準のまま動かさない');
    eq(String(M.planRow_(heldT, h1)[10]).indexOf('トレンド崩れ') === -1, true,
      '上昇トレンドが続いている保有株には警告を出さない');

    // 投資デイリー分析へは発注できる推奨だけを載せる
    const plans = { '7203': op, '8306': h1 };
    eq(M.briefingRows_(targets, plans), [['A', '7203', 'トヨタ', 135, '翌朝寄付', 170, 116, '押し51%']],
      '投資デイリー分析には買い推奨（成立分）だけを書く');
    // SBIのIFDOCOで置くための入力を、別シートではなく買い推奨行のメモに書く
    const ifd = String(M.planRow_(buyT, op, '2026/10/23')[10]).split('／');
    eq(ifd[1], 'SBIはIFDOCO：新規 成行・期間指定 2026/10/23・損切りは発動後 成行', 'メモ2項目目にIFDOCOの入力（区切り記号は／と混ぜない）');
    eq(String(M.planRow_(buyT, op, '2026/10/23')[10]).indexOf('期間指定 2026/10/23') > 0, true, '期間指定の日付をメモに書く');
    eq(String(M.planRow_(buyT, op, '2026/10/23')[10]).indexOf('寄付が損切り以下か利確以上なら取消') > 0, true, '見送り条件もメモに書く');
    eq(String(M.planRow_(heldT, h1, '2026/10/23')[10]).indexOf('IFDOCO') === -1, true, '保有株にはIFDOCOを書かない（OCOで置く）');
    eq(String(M.planRow_(buyT, op)[10]).indexOf('IFDOCO') === -1, true, '期限が渡されなければ書かない（従来どおり）');
  }

  console.log('\n【22】メール本文の売買プラン行');
  {
    const op = Object.assign({ held: false }, M.dfOrderPlan_({ close: 135, stop: 116.5, target: 170 }, cfg()));
    eq(M.planMailLine_({ '7203': op }, '7203'),
      '\n  └ 翌朝寄付で買い（目安 135） / 利確 170 / 損切 116 / ' + op.shares.toLocaleString('en-US') + '株 / 損切り額 '
        + op.lossYen.toLocaleString('en-US') + '円',
      '買い推奨は買い・利確・損切り・株数・損切り額を1行で添える');
    eq(M.planMailLine_({ '7203': h1 }, '7203'),
      '\n  └ 保有中 / 利確 164 / 損切 98 / 300株 / 損切り額 6,600円',
      '保有株に新規の買値は出さず「保有中」と書く（空の買値を出さない）');
    eq(M.planMailLine_({ '7203': h2 }, '7203'), '\n  └ 保有中 / 利確 164 / 損切 98',
      '株数不明なら株数と損切り額は省く（0株0円と書かない）');
    eq(M.planMailLine_({ '8303': Object.assign({}, op, { ok: false, reason: 'x' }) }, '8303'), '\n  └ 見送り（x）',
      '不成立の推奨は理由つきで「見送り」と書く');
    eq(M.planMailLine_({}, '8303'), '', 'プランが無い銘柄は行を足さない');
    eq(M.planMailLine_(null, '8303'), '', 'plans自体が無くても例外にならない');
    eq(M.planMailLine_({ '7203': h1 }, '72030'), '\n  └ 保有中 / 利確 164 / 損切 98 / 300株 / 損切り額 6,600円',
      '5桁コードでも4桁に正規化して引き当てる');
    eq(M.planMailLine_({ '7203': h3 }, '7203').indexOf('／トレンド崩れ・早期手仕舞い検討') > 0, true,
      'トレンドが崩れた保有株はメールにも早期手仕舞いの警告を添える');
  }

  console.log('\n【23】通知メールのラベル・Bloombergの社名照合');
  eq(M.SAKATA_PROFIT_LABEL_, '利益累計', '通知メールにはこのラベルを付けてアーカイブする');
  {
    const texts = [{ body: 'ニデック上場維持に課題 https://example.com/x\n世界的な金利上昇なぜ\nＡＤＥＫＡが増産' }];
    eq(M.companyKey_('ニデックホールディングス'), 'ニデック', '接尾辞「ホールディングス」を落として照合する');
    eq(M.bloombergMention_(texts, 'ニデック'), 'ニデック上場維持に課題', '社名を含む行を返す（URLは落とす）');
    eq(M.bloombergMention_(texts, 'ADEKA'), 'ADEKAが増産', '全角・半角の違いを吸収する');
    eq(M.bloombergMention_(texts, 'トヨタ自動車'), '', '出ていなければ空');
    eq(M.bloombergMention_(texts, 'JT'), '', '3文字未満の社名は誤検知が多いので照合しない');
    eq(M.bloombergMention_([], 'ニデック'), '', 'メールが無くても例外にならない');

    // 実物（2026-09-30受信）と同じ構造: スナップショット→「ウォッチリスト」の直後に見出し1、
    // 段落は空行区切り、段落内はリンクの前後で行が切れる。最後に「その他の注目ニュース」とお知らせ。
    const body = [
      'マーケットスナップショット', 'S&P500種', '<https://www.bloomberg.com/quote/SPX:IND?x=1>', '7,651.54-0.3%',
      '市場データ 05:54 AM JST. ウォッチリスト', '<https://www.bloomberg.com/markets/watchlist?x=1>', '1年ぶり大幅増', '',
      '8月の米個人消費支出（PCE', '<https://www.bloomberg.com/jp/news/articles/a?x=1>', '）は約1年ぶりの大幅な伸びとなった。', '',
      'AI需要堅調', '',
      '米マイクロン・テクノロジーの売上高見通し', '<https://www.bloomberg.com/jp/news/articles/b?x=1>', 'が市場予想を上回った。', '',
      'その他の注目ニュース', '',
      'トヨタ、「センチュリー」で世界の超高級車市場へ', '<https://www.bloomberg.com/jp/news/features/c?x=1>', '',
      'ニュースレターに関するお知らせ', '', '登録内容の変更',
    ].join('\n');
    const parsed = M.bloombergParse_(body);
    eq(parsed.items, [
      { head: '1年ぶり大幅増', body: '8月の米個人消費支出（PCE）は約1年ぶりの大幅な伸びとなった。' },
      { head: 'AI需要堅調', body: '米マイクロン・テクノロジーの売上高見通しが市場予想を上回った。' },
    ], '見出しと本文に分け、リンクで切れた文を元に戻す');
    eq(parsed.others, ['トヨタ、「センチュリー」で世界の超高級車市場へ'], '「その他の注目ニュース」のタイトルを拾い、お知らせ以降は捨てる');
    const t = [Object.assign({ body }, parsed)];
    eq(M.bloombergMention_(t, 'マイクロン・テクノロジー'), 'AI需要堅調：米マイクロン・テクノロジーの売上高見通しが市場予想を上回った。',
      '社名が出た記事は「見出し：本文」で返す');
    eq(M.bloombergMention_(t, 'トヨタ自動車'), '', '社名が完全一致しなければ拾わない（トヨタ自動車≠トヨタ）');
    eq(M.bloombergRows_(t[0]).length, 3, 'シートには5本（ここでは2本）＋その他を1行ずつ');
    eq(M.bloombergParse_('本文に構造がないメール'), { items: [], others: [] }, '構造が違うメールでも例外にならない');

    // 実物（2026-10-05 受信「今朝の5本」＝月曜朝の週末ニュース号）と同じ構造: マーケットスナップショット/「ウォッチリスト」が無い。
    // 見出し・URLのあとに導入文（「。」を含む段落）があり、その次から 見出し→本文。これを解析できず、シートが空になっていた。
    const U = (n) => '<https://www.bloomberg.com/jp/news/articles/' + n + '?cmpid=X&utm_term=261004>';
    const monday = [
      '【今朝の5本】仕事を始める前に読んでおきたい厳選ニュース', '1日を始める前に読んでおきたいニュース5本', '', 'Read in browser', U('r'), '',
      '<https://www.bloomberg.com/jp?cmpid=X>', '', '<https://sli.bloomberg.com/click?s=1>', '',
      '週末に話題になったニュースをお届けします。一日を始めるにあたって押さえておきたい5本はこちら。最新ニュースはブルームバーグ日本語サイト（https://www.bloomberg.com/jp）でもご覧いただけます。', '',
      '熱烈な推進者も懸念', '',
      'ソフトバンクグループの孫正義', U('a'), '会長兼社長は、AIの安全性のリスクを懸念していると認めた。前日には米', 'OpenAI', U('b'), 'の安全対策を担当していた人物が寄稿した。', '',
      '利回りもAIも', '',
      'ベッセント', U('c'), '米財務長官は米国債利回りの上昇について懸念する必要はないとの見解を示した。', '',
      '40兆円', '',
      '片山さつき', U('d'), '財務相は3日、新規国債発行額を可能な限り抑制する方針を示した。', '',
      'その他の注目ニュース', '',
      '高市首相「極めて遺憾」と米側に抗議－沖縄強盗殺人事件で米兵逮捕', U('e'), '',
      'FRB中枢2人の発言で動いた市場、「フォワードガイダンス」なお健在', U('f'), '',
      'ニュースレターに関するお知らせ', '', '「Japan’s Economy Decoded」日本経済の今を分析します。',
    ].join('\n');
    const pm = M.bloombergParse_(monday);
    eq(pm.items.map(x => x.head), ['熱烈な推進者も懸念', '利回りもAIも', '40兆円'], 'ウォッチリストが無い号でも、導入文の次から見出しを拾う');
    eq(pm.items[0].body, 'ソフトバンクグループの孫正義会長兼社長は、AIの安全性のリスクを懸念していると認めた。前日には米OpenAIの安全対策を担当していた人物が寄稿した。', 'リンクで切れた本文を元に戻す');
    eq(pm.others, ['高市首相「極めて遺憾」と米側に抗議－沖縄強盗殺人事件で米兵逮捕', 'FRB中枢2人の発言で動いた市場、「フォワードガイダンス」なお健在'], 'その他の注目ニュース');
    eq(M.bloombergRows_(Object.assign({ body: monday }, pm)).length, 5, 'シートに 3本＋その他2件 の行が出る');
    eq(M.bloombergParse_('見出しだけ\n\nURLだけ\n<https://x.test/a>').items, [], '導入文（「。」を含む段落）が無い本文は空（例外にしない）');

    // 7時半トリガーの自動追加（無ければ1本足し、あれば増やさない・他のトリガーは触らない）
    sandboxTriggers.length = 0; sandboxTriggers.push({ getHandlerFunction: () => 'scheduledScan' });
    eq(M.ensureBloombergTrigger_(), true, '無ければ足す');
    eq(M.ensureBloombergTrigger_(), false, 'あれば足さない（冪等）');
    const bt = sandboxTriggers.filter(x => x.getHandlerFunction() === 'updateBloombergNews');
    eq([bt.length, bt[0].cfg.atHour, bt[0].cfg.nearMinute, sandboxTriggers.length], [1, 7, 30, 2], '毎日7時台・30分・既存は残る');
    sandboxTriggers.length = 0;
  }

  console.log('\n【23c】候補シートの書式（終値が日付として読まれた不具合）');
  {
    // 2026-10-05: 「終値」列が日付書式のままで、終値 5,230 が Date(1914/04/26) として読まれ、現在値が -1,757,322,000,000 になった。
    const fmts = {};
    const sigStub = (rows) => ({
      getMaxRows: () => 1000, getLastRow: () => rows.length + 1,
      getRange: (r, c, nr, nc) => ({
        setNumberFormat(f) { fmts[c] = f; return this; },
        getValues: () => rows.map(x => x.slice()),
      }),
    });
    eq(M.CAND_FORMATS_.length, M.CAND_HEADERS_.length, '列の数と書式の数が一致する');
    const st = sigStub([]);
    M.applyCandidateFormats_(st);
    eq([fmts[1], fmts[3], fmts[6], fmts[7]], ['@', '#,##0.##', '#,##0.##', '#,##0.##'], 'コードはテキスト、終値・損切り・利確は数値書式（日付書式ではない）');
    eq(M.CAND_FORMATS_.every(f => !/y|d/i.test(f.replace('@', ''))), true, 'どの列も日付書式にしない');
    const good = ['5302', '日本カーボン', 5230, 'B', 1.35, 4900.36, 5968.39, 0.62, 1.35, '押し62%', '2026/10/05'];
    const bad = ['9999', '壊れた', new Date(-1757322000000), 'B', 1, 4900, 5968, 0.6, 1.3, '', '2026/10/05'];   // 日付として読まれた終値
    const got = M.readCandidates_(sigStub([good, bad]));
    eq(got.map(c => c.code), ['5302'], '終値が数値でない候補は読み捨てる（壊れた価格で売買プランを作らない）');
    eq(got[0].setup.close, 5230, '正常な候補はそのまま読める');
    eq(M.planLooksBroken_([['買い推奨B', '5302', '日本カーボン', -1757322000000], ['保有', '1329', '', 7283]]), true, '現在値が負の行があれば壊れている');
    eq(M.planLooksBroken_([['買い推奨B', '5302', '日本カーボン', 5230], ['保有', '1329', '', 7283], ['', '', '', '']]), false, '正常な売買プランは壊れていない（空行は見ない）');
    eq(M.planLooksBroken_([['保有', '1329', '', '']]), true, '現在値が空でも壊れている');
    eq(M.planLooksBroken_([]), false, '空は壊れていない');
  }

  console.log('\n【23b】メニュー・トリガー・スマホ用Webメニューが呼ぶ関数が全て定義されている');
  {
    // 2026-10-05: IFDOCO統合の変更で buildPlans だけ消え、メニューが「スクリプト関数が見つかりません」になった。同じ消し忘れを検出する。
    const fsx = require('fs'), pathx = require('path');
    const dir = pathx.join(__dirname, '..', 'src');
    const all = fsx.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => fsx.readFileSync(pathx.join(dir, f), 'utf8')).join('\n');
    const defined = new Set();
    (all.match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm) || []).forEach(m => defined.add(m.replace(/^\s*(?:async\s+)?function\s+/, '').replace(/\s*\($/, '')));
    (all.match(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/gm) || []).forEach(m => defined.add(m.replace(/^(?:const|let|var)\s+/, '').replace(/\s*=$/, '')));
    const called = new Set();
    for (const m of all.matchAll(/\.addItem\(\s*'[^']*'\s*,\s*'([A-Za-z0-9_$]+)'\s*\)/g)) called.add(m[1]);
    for (const m of all.matchAll(/newTrigger\(\s*'([A-Za-z0-9_$]+)'\s*\)/g)) called.add(m[1]);
    for (const m of all.matchAll(/clearTriggersFor_\(\s*\[?([^\])]*)\]?\s*\)/g)) (m[1].match(/'([A-Za-z0-9_$]+)'/g) || []).forEach(x => called.add(x.replace(/'/g, '')));
    const missing = [...called].filter(n => !defined.has(n));
    eq(missing, [], 'addItem / newTrigger / clearTriggersFor_ の関数名が全て定義されている');
    eq(called.size >= 10, true, 'menu/trigger の関数名を10個以上拾えている（検査が空振りしていない）: ' + called.size);
    eq(defined.has('buildPlans'), true, 'buildPlans が定義されている');
  }

  console.log('\n【24】保有数量の読み取り');
  eq(M.toNum_('1,234'), 1234, '桁区切りを外して数値化する');
  eq(M.toNum_('1,234 円'), 1234, '単位付きでも読む');
  eq(M.toNum_(300), 300, '数値はそのまま');
  eq(M.toNum_(''), null, '空欄はnull（0にすると「株数0」と区別できない）');
  eq(M.toNum_('—'), null, '読めない値はnull');

  console.log('\n【25】重みの算出: ベンチマーク控除とクールダウン（extractMlRow_）');
  {
    const idx = { '2026-01-05': 100, '2026-01-08': 110 };
    near(M.benchmarkReturn_(idx, '2026-01-05', '2026-01-08'), 0.1, 1e-12, '指数の同区間リターンを返す');
    eq(M.benchmarkReturn_(idx, '2026-01-05', '2026-01-09'), null,
      '指数側に該当日が無ければnull（0%扱いにするとベンチマークを引かないのと同じ歪みが出る）');
    eq(M.benchmarkReturn_({ '2026-01-05': 0, '2026-01-08': 110 }, '2026-01-05', '2026-01-08'), null,
      '始点が0なら割れないのでnull');

    // 日付キーは指数側と銘柄側で同じ関数を通す（配列位置ではなく日付で突き合わせるため）
    const bars = [];
    const t0 = Date.UTC(2026, 0, 5) / 1000;
    for (let i = 0; i < 40; i++) bars.push({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1e6, t: t0 + i * 86400, cont: true });
    const map = M.buildDateCloseMap_(bars);
    eq(map[M.barDateKey_(bars[0])], bars[0].c, '日付キーで終値を引ける');

    // 全営業日を指数側にも用意して、クールダウンだけを見る
    const idxAll = {};
    bars.forEach(b => { idxAll[M.barDateKey_(b)] = 1000; });   // 指数は横ばい＝超過リターン=銘柄リターン
    const sig = { name: '赤三兵', dir: '買い' };
    const lastFire = {};
    const a = M.extractMlRow_({ bars, i: 10, sig, code: '7203', lastFire, idxByDate: idxAll, rsi: null, macd: null });
    eq(a !== null, true, '初回の点灯は採用される');
    const b = M.extractMlRow_({ bars, i: 11, sig, code: '7203', lastFire, idxByDate: idxAll, rsi: null, macd: null });
    eq(b, null, '評価期間が重なる翌日の再点灯は採らない（サンプル水増しの防止）');
    const c = M.extractMlRow_({ bars, i: 20, sig, code: '7203', lastFire, idxByDate: idxAll, rsi: null, macd: null });
    eq(c !== null, true, 'ホライズンを空ければ再び採用される');
    // 別銘柄は独立にカウントする（クールダウンはコード×パターン単位）
    eq(M.extractMlRow_({ bars, i: 11, sig, code: '6758', lastFire, idxByDate: idxAll, rsi: null, macd: null }) !== null,
      true, 'クールダウンは銘柄ごとに独立');

    // 約定は翌日始値、決済はh営業日後の終値
    const h = 3;   // 赤三兵は短期＝BT_FORWARD
    eq(a[8], bars[11].o, 'エントリーは翌営業日の始値（走査は終値確定後なので当日終値では約定できない）');
    eq(a[9], bars[11 + h].c, 'エグジットはホライズン後の終値');
    eq(a[13], 1, '指数横ばいで株価が上がっていれば超過リターンが正＝ラベル1');

    // 先読み分の足が足りないイベントは捨てる（未来を覗かない）
    eq(M.extractMlRow_({ bars, i: bars.length - 2, sig, code: '9999', lastFire: {}, idxByDate: idxAll, rsi: null, macd: null }),
      null, '評価に必要な先の足が無ければ行を作らない');
    // 方向の無いシグナルは学習に使えない
    eq(M.extractMlRow_({ bars, i: 10, sig: { name: 'x', dir: '' }, code: '1', lastFire: {}, idxByDate: idxAll, rsi: null, macd: null }),
      null, '方向が無いシグナルは採らない');
  }

  console.log('\n【26】重みの算出: Wilson信頼区間');
  {
    // 教科書的な既知値。p=0.5, n=100, z=1.96 の Wilson 区間は概ね [0.404, 0.596]
    const a = M.wilsonInterval_(50, 100);
    near(a.lower, 0.4038, 0.001, 'n=100・勝率50%の下限');
    near(a.upper, 0.5962, 0.001, 'n=100・勝率50%の上限');
    eq(a.p, 0.5, '点推定はそのまま');
    // 正規近似と違い、端でも[0,1]をはみ出さない
    const b = M.wilsonInterval_(0, 10);
    eq(b.lower >= 0 && b.upper <= 1, true, '全敗でも区間が[0,1]に収まる');
    const c = M.wilsonInterval_(10, 10);
    eq(c.lower >= 0 && c.upper <= 1, true, '全勝でも区間が[0,1]に収まる');
    eq(c.upper, 1, '全勝の上限は1');
    // 件数が増えるほど区間は狭くなる
    const wide = M.wilsonInterval_(15, 30), narrow = M.wilsonInterval_(1500, 3000);
    eq((narrow.upper - narrow.lower) < (wide.upper - wide.lower), true, '件数が増えると区間が狭まる');
    eq(M.wilsonInterval_(0, 0), null, '試行0件では区間を作らない');
    // z を大きくすると区間は広がる（多重比較の補正で使う）
    eq(M.wilsonInterval_(50, 100, 3.13).lower < a.lower, true, 'zを大きくすると区間が広がる');
  }

  console.log('\n【27】重みの算出: 重みを動かす条件');
  {
    const B = 0.575;   // 売り3日の実測基準線
    // ① 件数が足りなければ動かさない
    eq(M.decideWeight_(20, 25, 2, { baseline: B }).weight, 2, '30件未満は現行値を維持');
    eq(M.decideWeight_(20, 25, 2, { baseline: B }).changed, false, '維持なので changed は false');
    // ② 基準線と区別できなければ動かさない（0.5ではなく基準線と比べる）
    const near575 = M.decideWeight_(Math.round(0.59 * 3000), 3000, 1, { baseline: B });
    eq(near575.weight, 1, '基準57.5%に対し59%程度なら動かさない');
    // 同じ勝率でも 0.5 と比べると「有意に勝ち越し」と誤判定されることの確認
    eq(M.decideWeight_(Math.round(0.59 * 3000), 3000, 1, { baseline: 0.5 }).weight, 3,
      '0.5基準だと同じ数字が3に上がってしまう（基準線を使う理由）');
    // ③ 有意でも差が小さければ動かさない（件数が大きいと僅差が有意になる）
    const tiny = M.decideWeight_(Math.round(0.591 * 6650), 6650, 1, { baseline: B, minEdge: 0.05 });
    eq(tiny.weight, 1, '+1.6ptの差は件数が多くても動かさない');
    eq(tiny.reason.indexOf('差が小さい') >= 0 || tiny.reason.indexOf('区別できない') >= 0, true,
      '動かさない理由を返す');
    // 差が十分で有意なら動く
    const up = M.decideWeight_(Math.round(0.70 * 400), 400, 2, { baseline: B, minEdge: 0.05 });
    eq(up.weight, 3, '基準を大きく上回れば3');
    eq(up.changed, true, '変更されたことが分かる');
    const down = M.decideWeight_(Math.round(0.42 * 3000), 3000, 2, { baseline: B, minEdge: 0.05 });
    eq(down.weight, 1, '基準を大きく下回れば1');
    // 効果量の下限を0にすると僅差でも通ってしまう（③の存在意義の確認）
    eq(M.decideWeight_(Math.round(0.591 * 6650), 6650, 1, { baseline: B, minEdge: 0 }).weight, 3,
      '下限を外すと+1.6ptでも3に上がる＝③が効いている');
  }

  console.log('\n【28】SIGNAL_WEIGHT_ の健全性');
  {
    const names = Object.keys(M.SIGNAL_WEIGHT_);
    eq(names.every(n => [1, 2, 3].includes(M.SIGNAL_WEIGHT_[n])), true, '重みは1〜3の整数のみ');
    // 方向テーブルと対応が取れていること（算出スクリプトが方向別の基準線を引けるため）
    const missing = names.filter(n => !M.SIGNAL_DIR_[n]);
    eq(missing, [], 'すべてのパターンに方向が定義されている');
    // 実データで算出した3件が入っていること（意図しない巻き戻しの検知）
    eq(M.SIGNAL_WEIGHT_['赤三兵'], 1, '赤三兵は基準を5.2pt下回るため1');
    eq(M.SIGNAL_WEIGHT_['MACDデッドクロス'], 1, 'MACDデッドクロスは基準を9.0pt下回るため1');
    eq(M.SIGNAL_WEIGHT_['切り込み線'], 3, '切り込み線は基準を9.7pt上回るため3');
  }
}

console.log('\n【29】コード列はテキスト型（リンク付き文字列）');
{
  // =HYPERLINK() だとセルの中身が数式になり "5602" が数値評価されて 5,602 と表示される。
  // RichTextValue なら値そのものが文字列のまま。
  const a = M.codeLinkRichText_('5602');
  eq(a.text, '5602', '値は文字列（数値に評価されない）');
  eq(typeof a.text, 'string', '型も文字列');
  eq(a.link, M.tvChartUrl_('5602'), 'TradingViewへのリンクが張られる');
  // 新形式の英数字コードも同じ扱い（数値化されないので表示が揃う）
  eq(M.codeLinkRichText_('130A').text, '130A', '英数字コードもそのまま');
  // 空コードでリンクを張ると、シート上で行き先の無いリンクが残る
  const e = M.codeLinkRichText_('');
  eq(e.text, '', '空コードは空文字');
  eq(e.link, null, '空コードにはリンクを張らない');
  eq(M.codeLinkRichText_(null).text, '', 'null も空文字（"null" と書かない）');
}

console.log('\n【30】IFDOCOの期間指定（発注日を含めて15営業日）');
{
  const biz = d => d.getDay() !== 0 && d.getDay() !== 6;
  const f = d => d.toISOString().slice(0, 10);
  // 2026-10-05(月)から: 1日目=10/05 … 15日目=10/23(金)
  eq(f(M.ifdocoExpiry_(new Date('2026-10-05T12:00:00Z'), M.IFDOCO_MAX_DAYS_, biz)), '2026-10-23', '今日が営業日なら今日を1日目に数える');
  // 土曜に作っても月曜から数える
  eq(f(M.ifdocoExpiry_(new Date('2026-10-03T12:00:00Z'), 15, biz)), '2026-10-23', '休日は数えない');
  const noHoliday = d => biz(d) && f(d) !== '2026-10-12';
  eq(f(M.ifdocoExpiry_(new Date('2026-10-05T12:00:00Z'), 15, noHoliday)), '2026-10-26', '祝日を挟むと1日延びる');
}

console.log('\n【31】スマホ用Webメニューの表示行');
{
  const v = [
    ['区分', 'コード', '銘柄名', '現在値', '株数', '買い(価格)', '利確(OCO1)', '損切り(OCO2)', '損切り額', '根拠', 'メモ', '10/05 18:40 更新'],
    ['買い推奨A', '7203', 'トヨタ', 135, 200, 135, 170, 116, 3800, '押し51%', '翌朝の寄付で買い・最長40営業日／決算 2026-10-28(予測)', ''],
    ['買い推奨B', '6814', '古野電気', 7900, '', 7900, 8900, 7400, '', '', '見送り：リスク過大', ''],
    ['保有', '1329', '', 7104, 305, 6960.16, 7840, 6730, 112850, '', 'トレンド崩れ（レンジ）: 早期手仕舞いも検討／押し安値6,740割れで手仕舞い', ''],
    ['本日の買い推奨はありません', '', '', '', '', '', '', '', '', '', '', ''],
  ];
  const r = M.webPlanRows_(v);
  eq(r.length, 3, '見出しと「該当なし」の行は出さない');
  eq([r[0].code, r[0].shares, r[0].buy, r[0].target, r[0].stop], ['7203', 200, 135, 170, 116], '価格と株数は数値で渡す');
  eq(r[0].memo, '翌朝の寄付で買い・最長40営業日', 'メモは先頭の1項目だけ（スマホで読める長さ）');
  eq([r[1].ng, r[1].shares], [true, null], '見送り行は ng、空の株数は null（0株と表示しない）');
  eq([r[2].alert, r[2].ng], [true, false], 'トレンド崩れの保有行は alert');
  eq(M.webPlanRows_([]), [], 'シートが空なら空');
}

console.log('\n' + '─'.repeat(62));
console.log(fail === 0 ? `全 ${pass} 項目 合格` : `${pass} 合格 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
