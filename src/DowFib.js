// ============================================================================
//  ダウ理論 × フィボナッチ 買い推奨（純ロジック・GAS非依存）
//  ---------------------------------------------------------------------------
//  ダウ理論の「主要トレンド」と「二次的調整（押し）」をそのまま判定に使う。
//
//   1) 主要トレンド … 左右10本で確定する大きな山谷で「安値切り上げ」かつ「高値更新」。
//   2) 二次的調整 … 直近の上昇波（押し安値L→高値H）に対する押しの深さが
//      フィボナッチ 23.6%〜78.6%。ダウは「調整は上昇幅の1/3〜2/3」としており、
//      フィボ 38.2〜61.8% とほぼ同じ帯。78.6% を超える押しはトレンド否定に近い。
//   3) 調整の終わり … 押しの途中にできた小さな戻り高値（左右2本の山）を、当日の終値で
//      初めて上抜けた（＝小トレンドが上向きに転じた）。
//   4) 確度A … 押し 38.2% 以上、かつ当日の出来高が直近20日平均の 1.5 倍以上
//      （ダウ理論「出来高はトレンドを確認する」）。それ以外の成立銘柄は確度B。
//
//  損切り = 押し目の安値の少し下（割れたら安値切り上げが崩れる＝ダウ理論の否定）
//  利確   = L + 上昇幅 × 1.618（フィボナッチ・エクステンション）、最長 40 営業日
//
//  閾値は tools/backtest_dowfib.js で過去10年・約1,200銘柄を検証して決めた（README 参照）。
//  変えたら必ずバックテストを回し直すこと。
// ============================================================================

const DF = {
  PRIMARY_W: 10,         // 主要トレンドの山谷（左右10本。右10本が揃うまで確定しない＝後から動かない）
  MINOR_W: 2,            // 調整中の小さな戻り高値（左右2本）
  RETR_MIN: 0.236,       // 押しの深さの下限（浅すぎる押しは押し目と呼ばない）
  RETR_MAX: 0.786,       // 押しの深さの上限（これ以上はトレンド否定に近い）
  MIN_REACTION_BARS: 3,  // 高値からの調整の最短本数
  MAX_REACTION_BARS: 40, // 高値から日が経ちすぎた調整は別の局面
  A_RETR_MIN: 0.382,     // 確度A: 押しの深さの下限
  A_VOL_RATIO: 1.5,      // 確度A: 当日出来高 / 直近20日平均
  TARGET_EXT: 1.618,     // 利確 = L + 上昇幅 × これ
  STOP_ATR_BUF: 0.1,     // 損切りを押し目安値からさらに ATR14×これ だけ下に置く
  HOLD_DAYS: 40,         // 最長保有（営業日）。利確にも損切りにも届かなければ手仕舞い
  MIN_BARS: 120,         // これより短い履歴では主要トレンドを判定しない
  TOP_N: 5,              // 1日に出す推奨数の上限
  BREAK_WINDOW: 1,       // 戻り高値を上抜けたのが直近何日以内なら成立とするか（1=当日のみ）
  // ── だまし上抜けの除外（2026-10-11 楽天銀行 5838 の外れを受けて追加。0 なら無効）──
  // 5838 は 10/06 に確度Bで成立（出来高0.89倍・上抜け幅46円=0.23ATR）→翌日から反落し3日で−6%。
  // 10年・1,219銘柄のバックテスト（上位5・損切/利確）: 2016-21 平均 −0.03%→+0.48%（PF 0.99→1.11）、
  // 2022- 平均 1.49%→1.65%（PF 1.39→1.41、20日保有のベンチ差 +0.77%→+1.15%）。件数は 1日 約2.3件→約1件。
  MIN_VOL_RATIO: 1.0,    // 当日出来高 / 直近20日平均 がこれ未満なら不成立（出来高の裏付けなしの上抜け）
  BREAK_MIN_ATR: 0.25,   // 終値が戻り高値を ATR14×これ 以上上抜けていなければ不成立（ぎりぎりの上抜け）
  DESC_HIGHS: 0,         // 戻り高値の連続切り下げで除外（1・2とも両期間で成績が悪化したため無効のまま）
};

/**
 * 生の極値（左右 w 本より高い高値／低い安値）。i 本目の極値は i+w 本目の引けで確定し、
 * それより先の足の影響を受けない。バックテストではこれを1回だけ作って使い回す。
 */
function dfRawSwings_(bars, w) {
  const out = [];
  for (let i = w; i < bars.length - w; i++) {
    let isH = true, isL = true;
    for (let k = i - w; k <= i + w; k++) {
      if (k === i) continue;
      // 左は「以上」、右は「より大きい」で同値の山を1つにまとめる
      if (k < i ? bars[k].h >= bars[i].h : bars[k].h > bars[i].h) isH = false;
      if (k < i ? bars[k].l <= bars[i].l : bars[k].l < bars[i].l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) out.push({ i: i, p: bars[i].h, t: 'H' });
    if (isL) out.push({ i: i, p: bars[i].l, t: 'L' });
  }
  return out;
}

/**
 * e 本目の引け時点で確定しているスイングを、H/L 交互に並べて返す（古い順）。
 * 同じ種類が続いたら、より極端な方だけを残す。この圧縮は e より先の極値を混ぜると
 * 過去のスイングが差し替わる（＝先読み）ので、必ず e で切ってから行う。
 */
function dfSwings_(bars, w, end, raw) {
  const e = (end == null ? bars.length - 1 : end);
  const src = raw || dfRawSwings_(bars, w);
  const out = [];
  for (let k = 0; k < src.length; k++) {
    if (src[k].i > e - w) break;
    dfPushSwing_(out, src[k]);
  }
  return out;
}

function dfPushSwing_(out, s) {
  const prev = out[out.length - 1];
  if (prev && prev.t === s.t) {
    if ((s.t === 'H' && s.p > prev.p) || (s.t === 'L' && s.p < prev.p)) out[out.length - 1] = s;
    return;
  }
  out.push(s);
}

// ATR14（e 本目までの足で計算）
function dfAtr_(bars, e, p) {
  p = p || 14;
  const start = Math.max(1, e - p + 1);
  let sum = 0, n = 0;
  for (let i = start; i <= e; i++) {
    const b = bars[i], q = bars[i - 1];
    sum += Math.max(b.h - b.l, Math.abs(b.h - q.c), Math.abs(b.l - q.c));
    n++;
  }
  return n ? sum / n : 0;
}

// a〜b 本目の平均出来高（出来高が無い足は除く）。1本も無ければ null。
function dfAvgVol_(bars, a, b) {
  let s = 0, n = 0;
  for (let i = Math.max(0, a); i <= b; i++) if (bars[i].v > 0) { s += bars[i].v; n++; }
  return n ? s / n : null;
}

/**
 * e 本目の引け時点で買い推奨が成立しているか。成立しなければ null。
 * rawP / rawM（dfRawSwings_ の結果）を渡すと極値の再計算を省く（バックテスト用）。
 */
function dfSetup_(bars, e, rawP, rawM) {
  const c = DF;
  if (e == null) e = bars.length - 1;
  if (e < c.MIN_BARS - 1) return null;
  const T = bars[e], Y = bars[e - 1];
  if (!(T.c > Y.c)) return null;

  // 1) 主要トレンド：確定安値の切り上げ（L > L0）と、L 以降の高値が前回の山 H0 を更新
  const sw = dfSwings_(bars, c.PRIMARY_W, e, rawP);
  const ls = sw.filter(s => s.t === 'L'), hs = sw.filter(s => s.t === 'H');
  if (ls.length < 2 || !hs.length) return null;
  const L = ls[ls.length - 1], L0 = ls[ls.length - 2];
  if (!(L.p > L0.p)) return null;
  const prevHs = hs.filter(s => s.i < L.i);
  if (!prevHs.length) return null;
  const H0 = prevHs[prevHs.length - 1];
  let hi = -Infinity, hIdx = -1;
  for (let i = L.i + 1; i <= e; i++) if (bars[i].h > hi) { hi = bars[i].h; hIdx = i; }
  if (hIdx < 0 || !(hi > H0.p)) return null;

  // 2) 二次的調整の長さと深さ
  const reaction = e - hIdx;
  if (reaction < c.MIN_REACTION_BARS || reaction > c.MAX_REACTION_BARS) return null;
  let pl = Infinity;
  for (let i = hIdx + 1; i <= e; i++) pl = Math.min(pl, bars[i].l);
  const impulse = hi - L.p;
  const atr = dfAtr_(bars, e);
  if (!(impulse > 0) || !(atr > 0)) return null;
  const retr = (hi - pl) / impulse;
  if (retr < c.RETR_MIN || retr >= c.RETR_MAX) return null;

  // 3) 調整の終わり：調整中の最後の小さな戻り高値を、今日はじめて終値で上抜けた
  const minorHs = dfSwings_(bars, c.MINOR_W, e, rawM).filter(s => s.t === 'H' && s.i > hIdx && s.i < e);
  if (!minorHs.length) return null;
  const mh = minorHs[minorHs.length - 1];
  // 上抜けた日 = 終値が mh を初めて超えた日。それが直近 BREAK_WINDOW 日以内で、今日も上にあること。
  if (!(T.c > mh.p)) return null;
  // 戻り高値の連続切り下げ（例 6,635 → 6,564 → 6,505）は、上昇トレンドの押しではなく勢いが落ちた持ち合い
  if (c.DESC_HIGHS > 0 && minorHs.length >= c.DESC_HIGHS + 1) {
    const last = minorHs.slice(-(c.DESC_HIGHS + 1));
    if (last.every((s, k) => k === 0 || s.p < last[k - 1].p)) return null;
  }
  let brk = -1;
  for (let i = mh.i + 1; i <= e; i++) if (bars[i].c > mh.p && bars[i - 1].c <= mh.p) brk = i;
  if (brk < 0 || e - brk >= c.BREAK_WINDOW) return null;
  for (let i = brk; i <= e; i++) if (bars[i].c <= mh.p) return null;

  const stop = pl - atr * c.STOP_ATR_BUF;
  const target = L.p + impulse * c.TARGET_EXT;
  if (!(T.c > stop) || !(target > T.c)) return null;

  const avg20 = dfAvgVol_(bars, e - 20, e - 1);
  const volRatio = (avg20 && T.v > 0) ? T.v / avg20 : 0;
  if (c.MIN_VOL_RATIO > 0 && volRatio < c.MIN_VOL_RATIO) return null;
  if (c.BREAK_MIN_ATR > 0 && T.c - mh.p < atr * c.BREAK_MIN_ATR) return null;
  const grade = (retr >= c.A_RETR_MIN && volRatio >= c.A_VOL_RATIO) ? 'A' : 'B';
  return {
    grade: grade, close: T.c, stop: stop, target: target,
    retr: retr, volRatio: volRatio, reaction: reaction,
    swingLow: L.p, swingHigh: hi, pullbackLow: pl, breakLevel: mh.p, atr: atr,
    score: (grade === 'A' ? 100 : 0) + volRatio,
  };
}

// 根拠を1行で（シート・メールの「根拠」欄）。読む人が検算できる数字だけを書く。
function dfReason_(s) {
  return '上昇トレンドの押し' + Math.round(s.retr * 1000) / 10 + '%から反転'
    + '／出来高' + Math.round(s.volRatio * 10) / 10 + '倍';
}

/**
 * 推奨銘柄の注文値（翌営業日の寄付で買い、損切り・利確をOCOで置く）。
 * 株数は「損切りまでの下落×株数」が許容損失額に収まる最大値（LOT単位・建玉上限で頭打ち）。
 * 呼値・株数の計算は Code.js の tickSize_ / roundToTick_ / fmtNum_ を使う。
 */
function dfOrderPlan_(s, cfg) {
  const out = { ok: false, reason: '', close: s.close, entry: null, stop: null, target: null,
                shares: 0, lossYen: 0, notes: [] };
  out.entry = roundToTick_(s.close, 'down');
  out.stop = roundToTick_(s.stop, 'down');
  out.target = roundToTick_(s.target, 'down');
  const risk = out.entry - out.stop;
  if (!(risk > 0)) { out.reason = '損切りが買値以上'; return out; }
  const lot = cfg.LOT;
  const byRisk = Math.floor(cfg.RISK_BUDGET_YEN / risk / lot) * lot;
  const byCap  = Math.floor(cfg.MAX_POSITION_YEN / out.entry / lot) * lot;
  const shares = Math.min(byRisk, byCap);
  if (shares < lot) {
    out.reason = (byCap < lot)
      ? '建玉上限（' + fmtNum_(cfg.MAX_POSITION_YEN) + '円）では' + lot + '株を建てられない'
      : 'リスク過大（1株' + fmtNum_(Math.round(risk)) + '円の損切り幅では許容損失'
        + fmtNum_(cfg.RISK_BUDGET_YEN) + '円で' + lot + '株も建てられない）';
    return out;
  }
  if (byCap < byRisk) out.notes.push('建玉上限で株数を抑制');
  out.shares = shares;
  out.lossYen = Math.round(risk * shares);
  const lim = priceLimit_(s.close);
  if (out.target > lim.high) out.notes.push('利確は値幅制限の外（翌日は発注不可・後日置く）');
  out.ok = true;
  return out;
}

// clasp run 用（読み取り専用・書き込みなし）。銘柄の日足を取り、指定日（YYYY-MM-DD）の判定を返す。
// 例: claspDowFibCheck('5838', '2026-10-06') → 本番のロジック・閾値で推奨が出るかを確かめる。
function claspDowFibCheck(code, date) {
  const bars = fetchIndexBars_(code + '.T', SK.SCAN_RANGE);
  const day = t => Utilities.formatDate(new Date(t < 1e11 ? t * 1000 : t), 'Asia/Tokyo', 'yyyy-MM-dd');
  const e = bars.findIndex(b => day(b.t) === date);
  if (e < 0) return { error: '日付が見つかりません', keys: bars.length ? Object.keys(bars[0]) : [] };
  const s = dfSetup_(bars, e);
  return { date, close: bars[e].c, signal: s ? { grade: s.grade, retr: s.retr, volRatio: s.volRatio, breakLevel: s.breakLevel, atr: s.atr } : null,
    filters: { MIN_VOL_RATIO: DF.MIN_VOL_RATIO, BREAK_MIN_ATR: DF.BREAK_MIN_ATR } };
}
