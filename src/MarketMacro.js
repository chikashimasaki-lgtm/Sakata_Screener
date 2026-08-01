// ============================================================================
//  相場マクロ監視（Sho「日本株急落の7条件」）＋ 銘柄別スクリーナーへの地合い供給
//  ---------------------------------------------------------------------------
//  ・自動取得(7条件すべて): NS倍率/VIX MACD(Yahoo ^N225/^GSPC/^VIX)・東証信用売残/倍率
//    (Driveのmtseisan*.xls)・日経EPS(stock-marketdata.com)・海外投資家 現物ネット
//    (J-Quants /markets/trades_spec)・好決算sell-on-news(J-Quants fins/statements×prices)。
//    各取得は失敗/サンプル不足/プラン遅延時に「相場マクロ」シートの手入力へフォールバック。
//  ・7条件の点灯を「急落サイン」シートに N/7 で出力。
//  ・条件1・2（売残・信用倍率）から地合い(SHORT_COVER/NEUTRAL/SUPPLY_RISK)を算出し、
//    Code.js の finalizeSignals_ がシグナルの強さ(★)スコアに反映する。
//  ・閾値/係数は Code.js の SK.MARGIN に一元化。macdSeries_(Code.js) を VIX 判定に流用。
// ============================================================================

const MACRO = {
  INPUT_SHEET: '相場マクロ',
  ALERT_SHEET: '急落サイン',
  REGIME_PROP: 'SK_MARGIN_REGIME',
  NS_WINDOW:   20,      // NS倍率トレンド判定窓（営業日）
  YAHOO_RANGE: '6mo',
  // 好決算sell-on-news(条件7): 直近WINDOW_DAYS営業日の黒字決算のうち翌日DROP_PCT超下落の
  // 割合がFREQ以上で点灯。MIN_SAMPLE未満は判定しない（手入力にフォールバック）。
  EARN: { WINDOW_DAYS: 14, DROP_PCT: 0.03, FREQ: 0.35, MIN_SAMPLE: 10 },
  // 手入力項目がこの日数を超えて更新されていなければ「古い」とみなして警告する。
  // 値だけ見ていると更新忘れに気づけず、数か月前の需給で地合いを判定してしまうため。
  STALE_DAYS: 10,
};

// ── 純ロジック（GAS非依存・ヘッドレステスト可能） ───────────────────────────

/**
 * 地合い：東証 売残(億円) と 信用倍率 から3区分。
 *
 * 【注意・既知の非整合】この2つは母集団が違う。売残は東証全体（金額ベース・億円）だが、
 * 信用倍率は日経レバ1570というETF単体の値（買残株÷売残株）を使っている。
 * 1570を使っているのは、東証全体の倍率（9倍前後）では RATIO_PIVOT=1.0 の条件が
 * 成立しないため。異なる母集団を1つの判定に混ぜている点は承知の上の割り切りで、
 * 「東証全体の需給」と読むと誤るので、シート上でも1570表記のまま出している。
 * SELL_THRESHOLD_OKU=8000 も名目円の固定値で、時価総額・売買代金による正規化はしていない。
 */
function marginRegime_(sellBalOku, ratio) {
  const T = SK.MARGIN.SELL_THRESHOLD_OKU, P = SK.MARGIN.RATIO_PIVOT;
  // 空セルは getValues() が '' を返し Number('') は 0 になる。そのまま判定すると
  // 「売残が未入力」＝「売残0億円＝枯渇」と読まれ、倍率が1.0以上なら SUPPLY_RISK が立って
  // 全ての売りシグナルが1.5倍に増幅される（倍率が未入力なら逆に SHORT_COVER）。
  // 手入力運用なので未入力は普通に起きる。未入力は判定材料にせず中立へ落とす。
  const toNum = v => (v === '' || v == null) ? NaN : Number(v);
  const s = toNum(sellBalOku), r = toNum(ratio);
  if (isFinite(s) && isFinite(r)) {
    if (s >= T && r <  P) return 'SHORT_COVER';   // 売残潤沢＋倍率低 ＝ ショートカバー好機（買い追い風）
    if (s <  T && r >= P) return 'SUPPLY_RISK';    // 売残枯渇＋倍率高 ＝ 需給悪化・投げ売り警戒（売り追い風）
  }
  return 'NEUTRAL';
}

// 地合い係数：地合いと方向でスコアを増減（買い/売りで逆方向に効かせる）。
function regimeFactor_(regime, dir) {
  const b = SK.MARGIN.BUY_BOOST, s = SK.MARGIN.SELL_BOOST;
  const buy = String(dir).indexOf('買い') >= 0, sell = String(dir).indexOf('売り') >= 0;
  if (regime === 'SHORT_COVER') return buy ? b : sell ? 1 / s : 1;
  if (regime === 'SUPPLY_RISK') return sell ? s : buy ? 1 / b : 1;
  return 1;
}

// NS倍率(日経/ S&P500)のトレンド。日米は休場日が異なり配列長も違うため（例:60本 vs 61本）、
// 比率を配列位置で対応付けると日付がズレて不正確になる。そこで各指数の「直近 window 営業日の
// 自己リターン」を比較する（NS倍率低下 ⟺ 日経の伸びがS&Pに劣る）。
// DOWN＝米国株優位/日本株劣位（急落サイン点灯）、UP＝日本株優位、FLAT＝拮抗。
function nsRatioTrend_(n225, spx, window) {
  if (!n225 || !spx || n225.length <= window || spx.length <= window) return 'FLAT';
  var nRet = n225[n225.length - 1] / n225[n225.length - 1 - window];
  var sRet = spx[spx.length - 1] / spx[spx.length - 1 - window];
  if (!isFinite(nRet) || !isFinite(sRet) || sRet === 0) return 'FLAT';
  if (nRet < sRet * 0.995) return 'DOWN';
  if (nRet > sRet * 1.005) return 'UP';
  return 'FLAT';
}

// VIXのMACD状態。ゴールデンクロス＝恐怖指数の上昇サイン（株安）。macdSeries_(Code.js) 流用。
function vixMacdSignal_(vixCloses) {
  if (!vixCloses || vixCloses.length < 35) return 'NONE';
  const m = macdSeries_(vixCloses, 12, 26, 9);
  const n = vixCloses.length;
  const a = m.macd[n - 1] - m.signal[n - 1], b = m.macd[n - 2] - m.signal[n - 2];
  if (b <= 0 && a > 0) return 'GOLDEN_CROSS';
  if (b >= 0 && a < 0) return 'DEAD_CROSS';
  return a > 0 ? 'ABOVE' : 'BELOW';
}

// Sho「日本株急落の7条件」判定（提供Pythonと同型）。data は数値/状態のマップ。
// 各要素 { key, condition, value, alert }（alert=true が急落サイン点灯）。
function checkMarketConditions_(data) {
  const g = (k, d) => (data[k] != null && data[k] !== '' ? data[k] : d);
  return [
    { key: '1_short_margin', condition: '東証 売残 8,000億円未満', value: g('sell_margin_oku', null),
      alert: Number(g('sell_margin_oku', 9e9)) < SK.MARGIN.SELL_THRESHOLD_OKU },
    { key: '2_margin_ratio', condition: '信用倍率 1.0倍以上（買い方過多）', value: g('margin_ratio', null),
      alert: Number(g('margin_ratio', 0)) >= SK.MARGIN.RATIO_PIVOT },
    { key: '3_ns_ratio', condition: 'NS倍率（日経/ S&P500）低下・米国株優位', value: g('ns_ratio_trend', null),
      alert: g('ns_ratio_trend') === 'DOWN' },
    { key: '4_nikkei_eps', condition: '日経平均EPS 下落（理論株価の低下）', value: g('nikkei_eps_trend', null),
      alert: g('nikkei_eps_trend') === 'DOWN' },
    { key: '5_foreign_sell', condition: '海外投資家の現物売り越し', value: g('foreign_net_oku', null),
      alert: Number(g('foreign_net_oku', 0)) < 0 },
    { key: '6_vix_macd', condition: 'VIX指数 MACD ゴールデンクロス', value: g('vix_macd_signal', null),
      alert: g('vix_macd_signal') === 'GOLDEN_CROSS' },
    { key: '7_earnings', condition: '好決算銘柄の決算後急落が頻発', value: g('earnings_selloff', null),
      alert: g('earnings_selloff') === 'YES' || g('earnings_selloff') === true },
  ];
}

// ── I/O（GAS） ──────────────────────────────────────────────────────────────

// 日経平均の予想EPS(加重平均)トレンドを stock-marketdata.com から取得。
// 日経公式/証券系はボット遮断が多いが当サイトはHTML表で公開。数値・日付はASCIIなので
// エンコーディングに依らず抽出可能。取得/解析に失敗したら null（→手入力にフォールバック）。
function fetchNikkeiEps_() {
  try {
    var res = UrlFetchApp.fetch('https://stock-marketdata.com/kabukashihyo.html',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) { Logger.log('日経EPS取得失敗 HTTP ' + res.getResponseCode()); return null; }
    return parseNikkeiEpsHtml_(res.getContentText());
  } catch (e) { Logger.log('日経EPS取得エラー: ' + e.message); return null; }
}

// HTMLから日付ごとのEPS(加重平均)を拾い、直近トレンド(UP/FLAT/DOWN)を判定。
// 各日付トークン(yyyy-mm-dd)直後のセルから、最初に現れる 2000〜5500 の数値をEPSとみなす
// （PER≈18/PBR≈1/配当≈2 は範囲外、日経終値>6000も範囲外で除外）。
function parseNikkeiEpsHtml_(html) {
  var re = /(\d{4}-\d{2}-\d{2})([\s\S]{0,400}?)(?=\d{4}-\d{2}-\d{2}|$)/g, m, seen = {}, out = [];
  while ((m = re.exec(html)) !== null) {
    if (seen[m[1]]) continue;
    var seg = m[2].replace(/<[^>]+>/g, ' ');
    var nums = seg.match(/\d[\d,]*\.\d+/g) || [];
    for (var i = 0; i < nums.length; i++) {
      var v = parseFloat(nums[i].replace(/,/g, ''));
      if (v >= 2000 && v <= 5500) { out.push({ date: m[1], eps: v }); seen[m[1]] = 1; break; }
    }
  }
  if (out.length < 6) return null;
  out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });  // 新しい順
  var latest = out[0].eps, prior = out[5].eps;   // 約1週間前(5営業日前)と比較

  // この抽出は「日付の後に現れる2000〜5500の最初の小数」というヒューリスティックなので、
  // サイト改修で無関係な数値を拾っても気づけない。EPSが1週間で大きく動くことは通常ないため、
  // 想定外の変化率なら「取得できなかった」扱いにして手入力へ委ねる（誤った自動値で上書きしない）。
  if (!(latest > 0) || !(prior > 0)) return null;
  var change = Math.abs(latest - prior) / prior;
  if (change > 0.15) {
    Logger.log('⚠ 日経EPSの変化が想定外に大きいため採用しません: ' + prior + ' → ' + latest +
      '（' + Math.round(change * 100) + '%）。抽出パターンがサイト改修でずれた可能性');
    return null;
  }

  var trend = latest < prior * 0.997 ? 'DOWN' : latest > prior * 1.003 ? 'UP' : 'FLAT';
  return { eps: latest, date: out[0].date, trend: trend };
}

// 海外投資家の現物ネット（投資部門別売買状況）を J-Quants /markets/trades_spec から取得。
// ForeignersBalanceValue（買-売, 単位=千円）を億円換算。売り越しなら負。取得不可は null。
function fetchForeignFlow_() {
  var key = PropertiesService.getScriptProperties().getProperty('JQUANTS_API_KEY');
  if (!key) { Logger.log('海外投資家: JQUANTS_API_KEY 未設定（手入力にフォールバック）'); return { error: 'JQUANTS_API_KEY未設定' }; }
  var from = Utilities.formatDate(new Date(Date.now() - 90 * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  var rows = jqGet_('markets/trades_spec', { from: from }, key);
  var r = pickForeignFlow_(rows);
  if (!r) return { error: 'J-Quants取得失敗またはデータなし' };
  return r;
}

// trades_spec 応答から、最新週の東証プライム（無ければ最新週の任意）海外投資家ネットを億円で返す。
function pickForeignFlow_(rows) {
  if (!rows || !rows.length) return null;
  var prime = rows.filter(function (x) { return /Prime/i.test(x.Section || ''); });
  var pool = (prime.length ? prime : rows).slice();
  pool.sort(function (a, b) { return (a.EndDate < b.EndDate) ? 1 : (a.EndDate > b.EndDate ? -1 : 0); });  // 最新週
  var r = pool[0];
  if (!r || r.ForeignersBalanceValue == null) return null;
  return { netOku: Math.round(Number(r.ForeignersBalanceValue) / 100000), week: r.EndDate, section: r.Section };  // 千円→億円
}

// 日経レバ(1570)の信用倍率を J-Quants /markets/weekly_margin_interest から取得。
// 買残÷売残(株数)。1570は空売りが積むと倍率<1.0になり得る＝ショートカバー燃料の指標。
// 市場全体の信用倍率は常に買残>>売残で約9倍固定のため、動画の「信用倍率<1.0」判定には1570を使う。
function fetch1570MarginRatio_() {
  var errors = {};
  var m = fetchYahooJpMarginRatios_(['1570'], errors);
  return (m['1570'] != null) ? { ratio: m['1570'], date: '' } : { error: errors['1570'] || '信用倍率(1570)の取得に失敗' };
}

// Yahoo Finance Japan の各銘柄ページから信用倍率(合計)を取得し code→倍率 マップを返す。
// J-Quantsの信用残がプラン外/空のときの代替。制度/一般の内訳は無く合計倍率のみ。
// 点灯銘柄など少数を渡す想定（fetchAllでバッチ）。取得不可の銘柄は欠落。
// errorsOut を渡すと、取得できなかった銘柄ごとに { code: 失敗理由 } を書き込む（呼び出し元が任意で使う）。
function fetchYahooJpMarginRatios_(codes, errorsOut) {
  var map = {};
  var uniq = Array.from(new Set((codes || []).map(function (c) { return to4_(String(c).trim()); }).filter(Boolean)));
  for (var i = 0; i < uniq.length; i += 25) {
    var slice = uniq.slice(i, i + 25);
    var reqs = slice.map(function (c) {
      return { url: 'https://finance.yahoo.co.jp/quote/' + c + '.T', headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true };
    });
    var resps;
    try { resps = UrlFetchApp.fetchAll(reqs); }
    catch (e) {
      Logger.log('信用倍率の取得に失敗（' + slice.length + '銘柄スキップ）: ' + e.message);
      if (errorsOut) slice.forEach(function (c) { errorsOut[c] = 'HTTP取得失敗: ' + e.message; });
      continue;
    }
    resps.forEach(function (res, j) {
      try {
        if (res.getResponseCode() === 200) {
          var r = parseYahooJpMarginRatio_(res.getContentText());
          if (r != null) map[slice[j]] = r;
          else if (errorsOut) errorsOut[slice[j]] = '解析失敗（ページ構造が変わった可能性）';
        } else if (errorsOut) {
          errorsOut[slice[j]] = 'HTTP ' + res.getResponseCode();
        }
      } catch (e) {
        Logger.log('信用倍率の解析に失敗 (' + slice[j] + '): ' + e.message);
        if (errorsOut) errorsOut[slice[j]] = e.message;
      }
    });
    Utilities.sleep(150);
  }
  return map;
}

// Yahoo JapanのHTMLから信用倍率を抽出。①「信用倍率」直後の小数、無ければ②信用買残÷信用売残。
function parseYahooJpMarginRatio_(html) {
  var m = html.match(/信用倍率[^0-9\-]{0,60}?([0-9]+\.[0-9]+)/);
  if (m) return parseFloat(m[1]);
  var b = html.match(/信用買残[^0-9]{0,60}?([0-9,]+)/), s = html.match(/信用売残[^0-9]{0,60}?([0-9,]+)/);
  if (b && s) { var bv = parseFloat(b[1].replace(/,/g, '')), sv = parseFloat(s[1].replace(/,/g, '')); if (sv > 0) return Math.round(bv / sv * 100) / 100; }
  return null;
}

// 全銘柄の「制度信用倍率」(制度買残÷制度売残) を J-Quants weekly_margin_interest から取得。
// 直近の週次データを1回で取り、code(4桁)→倍率 のマップを返す（銘柄別に個別APIは呼ばない）。
// finalizeSignals_(Code.js) がシグナル一覧の各行に結合する。取得不可/キー無は {} を返す。
function fetchStandardizedMarginMap_() {
  var key = PropertiesService.getScriptProperties().getProperty('JQUANTS_API_KEY');
  if (!key) { Logger.log('制度信用倍率: JQUANTS_API_KEY 未設定'); return {}; }
  var from = fmtDate_(new Date(Date.now() - 130 * 86400000));   // フリープランの約12週遅延をカバー
  var rows = jqGet_('markets/weekly_margin_interest', { from: from }, key);
  if (!rows || !rows.length) { Logger.log('制度信用倍率: データなし（プラン外/遅延の可能性）'); return {}; }
  var latest = {};   // code -> { date, ratio }（最新週のみ採用）
  rows.forEach(function (r) {
    var code = to4_(String(r.Code || ''));
    var lng = Number(r.LongStandardizedMarginOutstanding), sht = Number(r.ShortStandardizedMarginOutstanding);
    if (!code || !isFinite(lng) || !isFinite(sht) || sht <= 0) return;
    var d = String(r.Date || '');
    if (!latest[code] || d > latest[code].date) latest[code] = { date: d, ratio: Math.round(lng / sht * 100) / 100 };
  });
  var map = {};
  Object.keys(latest).forEach(function (c) { map[c] = latest[c].ratio; });
  Logger.log('制度信用倍率: ' + Object.keys(map).length + '銘柄分を取得');
  return map;
}

// 好決算sell-on-news の頻発を J-Quants で自動判定（条件7）。
// 直近 WINDOW 営業日に黒字の実績決算を発表した銘柄のうち、決算後（翌営業日）に DROP_PCT 超
// 下落した割合が FREQ 以上なら「頻発」= 点灯。単位・閾値は MACRO.EARN。
// 好決算プロキシ=黒字(Profit>0)、急落=翌営業日リターン<=-DROP_PCT。取得不可/サンプル不足は null。
function fetchEarningsSelloff_() {
  var key = PropertiesService.getScriptProperties().getProperty('JQUANTS_API_KEY');
  if (!key) { Logger.log('好決算sell-on-news: JQUANTS_API_KEY 未設定'); return { error: 'JQUANTS_API_KEY未設定' }; }
  var C = MACRO.EARN;
  var today = new Date();
  var stmts = jqGet_('fins/statements',
    { from: fmtDate_(new Date(today.getTime() - (C.WINDOW_DAYS + 10) * 86400000)), to: fmtDate_(today) }, key);
  if (!stmts || !stmts.length) { Logger.log('好決算: 対象決算なし（プラン遅延の可能性）'); return { error: '対象決算なし（プラン遅延の可能性）' }; }

  var events = [];   // { code, date }（黒字の実績決算）
  stmts.forEach(function (s) {
    if (!/FinancialStatements/i.test(String(s.TypeOfDocument || ''))) return;   // 実績決算のみ（予想修正等は除外）
    var profit = Number(s.Profit);
    if (!isFinite(profit) || profit <= 0) return;                              // 黒字（好決算プロキシ）
    var code = to4_(String(s.LocalCode || s.Code || ''));
    var d = String(s.DisclosedDate || '').slice(0, 10);
    if (code && /^\d{4}-\d{2}-\d{2}$/.test(d)) events.push({ code: code, date: d });
  });
  if (events.length < C.MIN_SAMPLE) { Logger.log('好決算: サンプル不足 ' + events.length + '件'); return { error: 'サンプル不足 ' + events.length + '件' }; }

  // 必要期間の日次終値を date→{code:adjClose} で取得
  var ds = events.map(function (e) { return e.date; }).sort();
  var priceMap = fetchPricesByDateRange_(
    fmtDate_(new Date(parseDate_(ds[0]).getTime() - 4 * 86400000)),
    fmtDate_(new Date(parseDate_(ds[ds.length - 1]).getTime() + 5 * 86400000)), key);
  var dates = Object.keys(priceMap).sort();
  if (!dates.length) { Logger.log('好決算: 価格取得不可'); return { error: '価格取得不可' }; }

  var reactions = [];
  events.forEach(function (ev) {
    var prev = null, next = null;
    for (var i = 0; i < dates.length; i++) {
      if (dates[i] <= ev.date) prev = dates[i];
      if (dates[i] > ev.date && next === null) next = dates[i];
    }
    if (!prev || !next) return;
    var p = priceMap[prev][ev.code], n = priceMap[next][ev.code];
    if (isFinite(p) && isFinite(n) && p > 0) reactions.push(n / p - 1);   // 決算後（翌営業日）リターン
  });

  var st = selloffFrequency_(reactions, C.DROP_PCT);
  if (st.total < C.MIN_SAMPLE) { Logger.log('好決算: 価格照合後サンプル不足 ' + st.total); return { error: '価格照合後サンプル不足 ' + st.total }; }
  var alert = st.frac >= C.FREQ;
  Logger.log('好決算sell-on-news: ' + st.drops + '/' + st.total + '銘柄が翌日' + (C.DROP_PCT * 100) + '%超下落 (率' +
    (st.frac * 100).toFixed(0) + '%, 閾値' + (C.FREQ * 100) + '%) → ' + (alert ? 'YES(頻発)' : 'NO'));
  return { alert: alert, frac: st.frac, drops: st.drops, total: st.total };
}

// 翌営業日に決算発表が予定されている銘柄コードの集合を J-Quants /fins/announcement から取得。
// このエンドポイントは「翌営業日分のみ」を返す仕様で、日付範囲を指定した先読みはできない
// （公式ドキュメント確認済み。フリープランでも利用可）。そのため「あと何日か」は出せず、
// 「明日発表予定かどうか」の1日限定フラグとしてのみ使う。取得不可はnull。
function fetchTomorrowAnnouncementCodes_() {
  var key = PropertiesService.getScriptProperties().getProperty('JQUANTS_API_KEY');
  if (!key) { Logger.log('決算発表予定: JQUANTS_API_KEY 未設定'); return null; }
  var rows;
  try { rows = jqGet_('fins/announcement', {}, key); }
  catch (e) { Logger.log('決算発表予定の取得に失敗: ' + e.message); return null; }
  if (!rows) return null;
  var set = {};
  rows.forEach(function (r) {
    var code = to4_(String(r.Code || r.LocalCode || '').trim());
    if (code) set[code] = true;
  });
  Logger.log('決算発表予定（翌営業日）: ' + Object.keys(set).length + '銘柄');
  return set;
}

// リターン配列から、-dropPct 以下の急落の件数・総数・割合を返す（純ロジック）。
function selloffFrequency_(reactions, dropPct) {
  var total = 0, drops = 0;
  (reactions || []).forEach(function (r) { if (isFinite(r)) { total++; if (r <= -dropPct) drops++; } });
  return { total: total, drops: drops, frac: total ? drops / total : 0 };
}

// 期間内の各営業日について /prices/daily_quotes を取得し date→{code:adjClose} を返す。
function fetchPricesByDateRange_(fromStr, toStr, key) {
  var map = {}, d = parseDate_(fromStr), end = parseDate_(toStr);
  while (d <= end) {
    var dow = d.getDay();
    if (dow !== 0 && dow !== 6) {   // 土日は取得しない（呼び出し削減）
      var ds = fmtDate_(d);
      var rows = jqGet_('prices/daily_quotes', { date: ds }, key);
      if (rows && rows.length) {
        var m = {};
        rows.forEach(function (r) {
          var c = to4_(String(r.Code || ''));
          var px = Number(r.AdjustmentClose != null ? r.AdjustmentClose : r.Close);
          if (c && isFinite(px)) m[c] = px;
        });
        if (Object.keys(m).length) map[ds] = m;
      }
    }
    d = new Date(d.getTime() + 86400000);
  }
  return map;
}

function fmtDate_(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'); }
function parseDate_(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }

// J-Quants V2 の GET（x-api-key・ページング・配列抽出）。失敗時 null。
function jqGet_(path, params, key) {
  var base = 'https://api.jquants.com/v2/' + path;
  var q = Object.keys(params || {}).filter(function (k) { return params[k] != null; })
    .map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  var url = q ? base + '?' + q : base, out = [], pg = null;
  do {
    var u = pg ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'pagination_key=' + encodeURIComponent(pg) : url;
    // 429/5xx は共通モジュール FetchRetry.js が指数バックオフで再試行する
    var res = fetchWithRetry_(u, { headers: { 'x-api-key': key }, muteHttpExceptions: true },
      { retry: SK.FETCH_RETRY, backoffMs: SK.FETCH_BACKOFF_MS, label: 'J-Quants ' + path });
    if (res.getResponseCode() !== 200) { Logger.log('J-Quants ' + path + ' 失敗(' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200)); return null; }
    var j = JSON.parse(res.getContentText());
    var arr = j.trades_spec || j.data;
    if (!arr) { for (var k in j) { if (Array.isArray(j[k])) { arr = j[k]; break; } } }   // 配列プロパティを拾う
    out = out.concat(arr || []);
    pg = j.pagination_key || null;
  } while (pg);
  return out;
}

// Yahoo チャートAPIから指数の終値配列を取得（^N225 / ^GSPC / ^VIX 等）。parseYahooBars_(Code.js) 流用。
function fetchIndexCloses_(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?range=' + MACRO.YAHOO_RANGE + '&interval=1d';
  // Yahooは429を返すことがある。ここで空配列になると NS倍率が FLAT・VIXが NONE となり、
  // 急落サインが「条件を満たさなかった」のか「取れなかった」のか区別できないまま消える。
  const res = fetchWithRetry_(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true },
    { retry: SK.FETCH_RETRY, backoffMs: SK.FETCH_BACKOFF_MS, label: 'Yahoo ' + symbol });
  const closes = parseYahooBars_(res).map(b => b.c);
  if (!closes.length) Logger.log('⚠ ' + symbol + ' の終値を取得できませんでした（HTTP ' + res.getResponseCode() + '）');
  return closes;
}

// JPX週次「信用取引現在高」(.xls) を取り込む。JPXはボット遮断(403)でGAS直取得不可のため、
// ユーザーがブラウザでDLした mtseisan*.xls を Drive に置く運用。ここでは最新の同ファイルを探し、
// Drive詳細サービス(v2)で Google スプレッドシートに変換して東証の売残/買残を読み取る。
// 返り値 { sellOku, ratio, sellShares, buyShares } / 見つからなければ null（→手入力にフォールバック）。
function importTseMarginFile_() {
  var latest = findLatestMtseisan_();   // Drive REST v3（マイドライブ＋共有ドライブ横断）
  if (!latest) { Logger.log('mtseisan*.xls が見つかりません（JPX信用残ファイルをDriveに置いてください）'); return null; }

  var newId = null;
  try {
    newId = convertXlsToSheet_(latest.id);   // .xls → Google スプレッドシート（Drive REST v3）
    var sh = SpreadsheetApp.openById(newId).getSheets()[0];
    var r = parseTseMarginGrid_(sh.getDataRange().getValues());
    if (r) Logger.log('東証信用残 取込: ' + latest.name +
      ' 売残=' + r.sellOku + '億 倍率=' + r.ratio + '（売残株' + r.sellShares + '/買残株' + r.buyShares + '）');
    else Logger.log('東証信用残 パース失敗（グリッドで東京行を検出できず）: ' + latest.name);
    return r;
  } catch (e) {
    Logger.log('東証信用残 取込エラー: ' + e.message);
    return null;
  } finally {
    if (newId) { try { Drive.Files.remove(newId); } catch (e2) {} }
  }
}

// mtseisan*.xls の最新を Drive REST v3 で探す（マイドライブ＋共有ドライブ横断）。{id,name} を返す。
function findLatestMtseisan_() {
  // Drive 詳細サービス(v3)。マイドライブ＋共有ドライブ横断で mtseisan*.xls を検索。
  var r = Drive.Files.list({
    q: "name contains 'mtseisan' and mimeType != 'application/vnd.google-apps.spreadsheet' and trashed = false",
    fields: 'files(id,name)', pageSize: 50, orderBy: 'name desc',
    includeItemsFromAllDrives: true, supportsAllDrives: true, corpora: 'allDrives'
  });
  var files = (r && r.files) || [];
  if (!files.length) return null;
  // ファイル名の日付(YYYYMMDD)を実際にパースして新しい順に並べる。
  // 以前は名前の文字列降順だけで「最新」を決めていたため、命名が揺れると古いファイルが
  // 選ばれ、数か月前の需給が黙って採用されることがあった。
  var withDate = files.map(function (f) {
    var m = String(f.name).match(/(20\d{2})(\d{2})(\d{2})/);
    var t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : -1;
    return { file: f, t: t };
  });
  withDate.sort(function (a, b) { return b.t - a.t; });
  var top = withDate[0];
  if (top.t < 0) {
    Logger.log('⚠ mtseisan ファイル名から日付を読み取れません: ' + top.file.name + '（名前順で代用）');
    return top.file;
  }
  var ageDays = Math.floor((Date.now() - top.t) / 86400000);
  if (ageDays > MACRO.STALE_DAYS) {
    Logger.log('⚠ 取り込んだ mtseisan が ' + ageDays + '日前のものです（' + top.file.name + '）。JPXから最新版をDLしてください');
  }
  top.file.ageDays = ageDays;
  return top.file;
}

// Drive上の .xls を Google スプレッドシートに変換したコピーを作り fileId を返す。
// Drive REST v3 の files.copy（mimeType 指定で変換）を UrlFetchApp で直接呼ぶ（詳細サービス不要）。
function convertXlsToSheet_(fileId) {
  // Drive 詳細サービス(v3)。mimeType 指定コピーで .xls → Google スプレッドシートに変換。
  var f = Drive.Files.copy(
    { name: '__tmp_tse_margin', mimeType: 'application/vnd.google-apps.spreadsheet' },
    fileId, { supportsAllDrives: true });
  return f.id;
}

// 変換済みグリッド(2次元配列)から東証の 売残(億円)・信用倍率(株数ベース) を読む。
// 「信用取引現在高」ブロックの『東京 Tokyo × 株数Shs.』行（最初の一致）をアンカーにし、
// 合計 売残高=L列(index11)/買残高=N列(index13)、直下の『金額Val.』行から合計売残金額(百万円)を取る。
function parseTseMarginGrid_(grid) {
  var num = function (v) {
    if (typeof v === 'number') return v;
    var s = String(v == null ? '' : v).replace(/[,\s　]/g, '').replace(/▲/, '-');
    var n = parseFloat(s); return isFinite(n) ? n : NaN;
  };
  var hit = function (v, re) { return re.test(String(v == null ? '' : v)); };
  // 最終行まで見る（i+1 で打ち切ると、株数行がグリッド末尾に来た場合に読めなくなる。
  // 直下の金額行は無いこともあるので valRow 側で存在を確認する）
  for (var i = 0; i < grid.length; i++) {
    var row = grid[i];
    if (hit(row[1], /東京|Tokyo/i) && hit(row[2], /株数|Shs/i)) {   // 現在高ブロックの東京・株数行（最初の一致）
      var sellShares = num(row[11]);   // 合計 売残高(株数)
      var buyShares  = num(row[13]);   // 合計 買残高(株数)
      var valRow     = grid[i + 1];    // 直下の金額行
      var sellMil    = (valRow && hit(valRow[2], /金額|Val/i)) ? num(valRow[11]) : NaN;  // 合計 売残高(百万円)
      if (isFinite(sellShares) && isFinite(buyShares) && sellShares > 0) {
        return {
          sellShares: sellShares, buyShares: buyShares,
          ratio:   Math.round(buyShares / sellShares * 100) / 100,      // 信用倍率(株数ベース)
          sellOku: isFinite(sellMil) ? Math.round(sellMil / 100) : null, // 百万円→億円
        };
      }
    }
  }
  return null;
}

// 「相場マクロ」入力シートの指定ラベル行(B列)に値を書き戻す（取込値の可視化・永続化）。
// pairs: [{ re, value }]（自動取得できた値。B列とC列(今日の日付)を上書き）
//     または [{ re, errorNote }]（自動取得に失敗。B列（手入力値）は残し、C列だけ失敗理由の文字列にする。
//     C列が Date でなくなるので readMacroInputSheet_ の age() は今まで通り「日付未記入」扱いになり、
//     急落サイン側の判定ロジックへの影響は無い＝Stackdriverを見なくても失敗理由がシート上で分かるようにするだけ）。
function writeMacroInputValues_(pairs) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(MACRO.INPUT_SHEET); if (!sh) sh = setupMacroSheets_().input;
  var rows = Math.max(sh.getLastRow(), 1);
  var vals = sh.getRange(1, 1, rows, 3).getValues();
  // 該当行ごとに setValue を呼ばず、B列・C列を組み立てて一度に書き戻す（API呼び出しを減らす）
  var out = vals.map(function (r) { return [r[1]]; });
  var stamps = vals.map(function (r) { return [r[2]]; });
  var today = new Date();
  var changed = false;
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0] || '');
    for (var j = 0; j < pairs.length; j++) {
      if (!pairs[j].re.test(k)) continue;
      if (pairs[j].value != null) {
        out[i] = [pairs[j].value];
        stamps[i] = [today];   // 自動取得できた項目は更新日も一緒に打つ
        changed = true; break;
      }
      if (pairs[j].errorNote) {
        stamps[i] = [pairs[j].errorNote];
        changed = true; break;
      }
    }
  }
  if (changed) {
    sh.getRange(1, 2, rows, 1).setValues(out);
    sh.getRange(1, 3, rows, 1).setValues(stamps);
    sh.getRange(2, 3, Math.max(rows - 1, 1), 1).setNumberFormat('yyyy/MM/dd');
  }
}

// 「相場マクロ」シート（A列=項目 / B列=値）から手入力値を読む。無ければ作成。
function readMacroInputSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(MACRO.INPUT_SHEET);
  if (!sh) sh = setupMacroSheets_().input;
  const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 3).getValues();
  // ラベルはキーワードで照合（旧「二市場売残」等が残っていても拾えるよう寛容に）
  const find = (re) => { for (var i = 0; i < rows.length; i++) { if (re.test(String(rows[i][0] || ''))) return rows[i][1]; } return undefined; };
  // C列の最終更新日から鮮度を見る。値だけでは「更新済み」と「放置」を区別できない。
  const age = (re) => {
    for (var i = 0; i < rows.length; i++) {
      if (!re.test(String(rows[i][0] || ''))) continue;
      const d = rows[i][2];
      if (!(d instanceof Date) || isNaN(d.getTime())) return null;   // 未記入は不明
      return Math.floor((Date.now() - d.getTime()) / 86400000);
    }
    return null;
  };
  const items = {
    sell_margin_oku:  { re: /売残.*億|売残高/,   label: '東証 売残' },
    margin_ratio:     { re: /信用倍率/,          label: '信用倍率' },
    nikkei_eps_trend: { re: /EPS/,               label: '日経平均EPSトレンド' },
    foreign_net_oku:  { re: /海外/,              label: '海外投資家 現物ネット' },
    earnings_selloff: { re: /決算|sell/i,        label: '好決算sell-on-news' },
  };
  // 古い／日付未記入の項目名を集めて、判定結果と一緒に表示できるようにする
  const stale = [];
  Object.keys(items).forEach((k) => {
    const a = age(items[k].re);
    if (a == null) stale.push(items[k].label + '(日付未記入)');
    else if (a > MACRO.STALE_DAYS) stale.push(items[k].label + '(' + a + '日前)');
  });

  return {
    sell_margin_oku:  find(items.sell_margin_oku.re),
    margin_ratio:     find(items.margin_ratio.re),
    nikkei_eps_trend: String(find(items.nikkei_eps_trend.re) || 'FLAT').toUpperCase(),
    foreign_net_oku:  find(items.foreign_net_oku.re),
    earnings_selloff: String(find(items.earnings_selloff.re) || 'NO').toUpperCase(),
    stale: stale,
  };
}

// メニュー本体：手入力＋自動(NS/VIX)から7条件を判定し「急落サイン」へ出力、地合いをキャッシュ。
function updateMarketMacro() {
  // 休場日は各種データが更新されないため、古い値で地合いを計算し直して上書きしても意味がない。
  // scheduledScan には営業日ガードがあるのに、こちらには無く土日祝も走っていた。
  // 手動実行（メニュー）は確認のため回したいこともあるので、トリガー起動時のみ止める。
  try {
    if (!isBusinessDay_(new Date()) && !isUserTriggered_()) {
      Logger.log('休場日のため相場マクロの更新をスキップ');
      return;
    }
  } catch (e) { /* 営業日判定が使えない環境でも更新自体は続行する */ }

  const tse = importTseMarginFile_();                          // 東証 mtseisan*.xls（売残億円）を自動取込
  const r1570 = fetch1570MarginRatio_();                       // 信用倍率は日経レバ1570（<1.0になり得る）。取得不可時は { error }
  const marginRatio = (r1570 && r1570.ratio != null) ? r1570.ratio : null;   // 取得不可時は手入力値を使う（東証全体9.21は使わない）
  const eps = fetchNikkeiEps_();                               // 日経EPS(加重平均)トレンドを自動取得
  const flow = fetchForeignFlow_();                            // 海外投資家 現物ネット（J-Quants）。取得不可時は { error }
  const earn = fetchEarningsSelloff_();                        // 好決算sell-on-news 頻発（J-Quants）。取得不可時は { error }
  var writes = [];
  if (tse) writes.push({ re: /売残.*億|売残高/, value: tse.sellOku });
  // 自動取得できなければ、値（B列）は前回の手入力値のまま残し、C列にだけ失敗理由を書く
  // （Stackdriverを見なくてもシート上で原因が分かるようにする。判定ロジック側は変更していない）。
  if (marginRatio != null) writes.push({ re: /信用倍率/, value: marginRatio });
  else if (r1570 && r1570.error) writes.push({ re: /信用倍率/, errorNote: r1570.error });
  if (eps) writes.push({ re: /EPS/, value: eps.trend });
  if (flow && flow.netOku != null) writes.push({ re: /海外/, value: flow.netOku });
  else if (flow && flow.error) writes.push({ re: /海外/, errorNote: flow.error });
  if (earn && earn.alert != null) writes.push({ re: /決算|sell/i, value: earn.alert ? 'YES' : 'NO' });
  else if (earn && earn.error) writes.push({ re: /決算|sell/i, errorNote: earn.error });
  if (writes.length) writeMacroInputValues_(writes);
  const manual = readMacroInputSheet_();                       // 取込値を書き戻した後に読む
  if (tse) manual.sell_margin_oku = tse.sellOku;
  if (marginRatio != null) manual.margin_ratio = marginRatio;
  if (eps) manual.nikkei_eps_trend = eps.trend;
  if (flow && flow.netOku != null) manual.foreign_net_oku = flow.netOku;
  if (earn && earn.alert != null) manual.earnings_selloff = earn.alert ? 'YES' : 'NO';

  let ns = 'FLAT', vix = 'NONE';
  try {
    const n225 = fetchIndexCloses_('^N225'), spx = fetchIndexCloses_('^GSPC');
    ns = nsRatioTrend_(n225, spx, MACRO.NS_WINDOW);
  } catch (e) { Logger.log('NS倍率取得失敗: ' + e.message); }
  try { vix = vixMacdSignal_(fetchIndexCloses_('^VIX')); } catch (e) { Logger.log('VIX取得失敗: ' + e.message); }

  const data = Object.assign({}, manual, { ns_ratio_trend: ns, vix_macd_signal: vix });
  const conds = checkMarketConditions_(data);
  const lit = conds.filter(c => c.alert).length;

  writeAlertSheet_(conds, lit, data);

  const regime = marginRegime_(data.sell_margin_oku, data.margin_ratio);
  PropertiesService.getScriptProperties().setProperty(MACRO.REGIME_PROP, regime);
  Logger.log('相場マクロ更新: 点灯 ' + lit + '/7 ・地合い=' + regime + ' ・NS=' + ns + ' ・VIX=' + vix +
    ' ・東証売残=' + (tse ? tse.sellOku + '億' : '未取込') +
    ' ・信用倍率(1570)=' + (marginRatio != null ? marginRatio + '(' + r1570.date + ')' : (r1570 && r1570.error ? '取得失敗:' + r1570.error : '手入力')) +
    ' ・日経EPS=' + (eps ? eps.eps + '(' + eps.date + ')→' + eps.trend : '手入力') +
    ' ・海外投資家=' + ((flow && flow.netOku != null) ? flow.netOku + '億(' + flow.week + ')' : (flow && flow.error ? '取得失敗:' + flow.error : '手入力')) +
    ' ・好決算sell=' + ((earn && earn.alert != null) ? (earn.alert ? 'YES' : 'NO') + '(' + earn.drops + '/' + earn.total + ')' : (earn && earn.error ? '取得失敗:' + earn.error : '手入力')));
  // 入力の欠損・古さは、判定結果(N/7)だけ見ていると気づけない。必ず表に出す。
  const stale = (manual.stale || []).slice(0, 4);
  try {
    SpreadsheetApp.getActive().toast(
      (tse ? '東証売残' + tse.sellOku + '億' : '⚠ mtseisan未取込') +
      '・倍率' + (marginRatio != null ? marginRatio + '(1570)' : '手入力') +
      ' ・急落' + lit + '/7 ・地合い' + regime +
      (stale.length ? '\n⚠ 古い入力: ' + stale.join('、') : ''), '相場マクロ', stale.length ? 15 : 8);
  } catch (e) { Logger.log('トースト表示に失敗: ' + e.message); }
  if (stale.length) Logger.log('⚠ 更新が古い/日付未記入の項目: ' + stale.join('、'));
}

// finalizeSignals_(Code.js) が参照する現在の地合い。未更新時は NEUTRAL。
function getMarketRegime_() {
  return PropertiesService.getScriptProperties().getProperty(MACRO.REGIME_PROP) || 'NEUTRAL';
}

/**
 * メニューから手動で呼ばれたか（＝UIが使えるか）を判定する。
 * トリガー起動では getUi() が例外になるため、それを利用する。
 */
function isUserTriggered_() {
  try { SpreadsheetApp.getUi(); return true; } catch (e) { return false; }
}

// 内部の英語enum（DOWN / GOLDEN_CROSS 等）をそのまま表示すると意味が伝わらないため日本語にする
function macroValueLabel_(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  const dict = {
    UP: '上昇', DOWN: '下落', FLAT: '横ばい',
    GOLDEN_CROSS: 'ゴールデンクロス', DEAD_CROSS: 'デッドクロス', NONE: 'クロスなし',
    YES: 'あり', NO: 'なし',
  };
  return dict[s] || s;
}

function writeAlertSheet_(conds, lit, data) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(MACRO.ALERT_SHEET) || ss.insertSheet(MACRO.ALERT_SHEET);
  sh.clear();
  const regime = marginRegime_(data.sell_margin_oku, data.margin_ratio);
  // 点灯数だけでは強弱が読み取れないため、目安を併記する
  const scale = lit >= 5 ? '（5件以上＝警戒領域）' : lit >= 3 ? '（3〜4件＝注意）' : '（2件以下＝落ち着いている）';
  const rows = [
    ['急落サイン 点灯数', lit + ' / 7' + scale],
    ['市場地合い', regime + (regime === 'SHORT_COVER' ? '（ショートカバー好機・買い追い風）'
      : regime === 'SUPPLY_RISK' ? '（需給悪化・売り警戒）' : '（中立）')],
    ['この表を更新した時刻', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')
      + '（※データそのものの基準日は「相場マクロ」シートのC列を参照）'],
  ];
  // 入力が古いままだと、判定は動いていても中身は数か月前の需給ということが起きる
  const stale = data.stale || [];
  if (stale.length) rows.push(['⚠ 更新が古い/日付未記入の入力', stale.join('、')]);
  rows.push(['', '']);
  rows.push(['条件', '状態', '値']);
  conds.forEach(c => rows.push([c.condition, c.alert ? '⚠ 点灯' : '正常', macroValueLabel_(c.value)]));
  // 列数を3に揃える
  const width = 3;
  const grid = rows.map(r => { const a = r.slice(0, width); while (a.length < width) a.push(''); return a; });
  sh.getRange(1, 1, grid.length, width).setValues(grid);
  try { styleSheet_(sh, width, '#7a1f2b', '#fbeef0'); autoFit_(sh, width); } catch (e) {}
  sh.setTabColor('#c0392b');
}

/**
 * 相場マクロ入力シートに入力規則（プルダウン）を張る。
 * EPSトレンドと sell-on-news は決まった語しか受け付けないが、自由入力だったため
 * 誤記が黙って既定値へフォールバックし、入力したつもりの値が効いていなかった。
 */
function applyMacroValidation_(sh, lastRow) {
  const rows = sh.getRange(1, 1, Math.max(lastRow, sh.getLastRow()), 1).getValues();
  const mk = (list) => SpreadsheetApp.newDataValidation()
    .requireValueInList(list, true).setAllowInvalid(false)
    .setHelpText('次のいずれかを選んでください: ' + list.join(' / ')).build();
  for (let i = 0; i < rows.length; i++) {
    const k = String(rows[i][0] || '');
    if (/EPS/.test(k))            sh.getRange(i + 1, 2).setDataValidation(mk(['UP', 'FLAT', 'DOWN']));
    else if (/決算|sell/i.test(k)) sh.getRange(i + 1, 2).setDataValidation(mk(['YES', 'NO']));
  }
}

// 「相場マクロ」入力シートを作成（初回のみ・既定値入り）。
function setupMacroSheets_() {
  const ss = SpreadsheetApp.getActive();
  let input = ss.getSheetByName(MACRO.INPUT_SHEET);
  if (!input) {
    input = ss.insertSheet(MACRO.INPUT_SHEET);
    // C列は「最終更新日」。値だけだと更新忘れに気づけないため、鮮度を必ず併記する。
    const seed = [
      ['項目', '値（東証売残・信用倍率はDLした mtseisan*.xls から自動。NS倍率/VIXも自動。他は手入力）', '最終更新日'],
      ['東証 売残（億円）', 8000, ''],
      ['信用倍率（日経レバ1570・買残÷売残。取得不可時は手入力）', 1.0, ''],
      ["日経平均EPSトレンド（自動取得:stock-marketdata・手入力も可）", "FLAT", ''],
      ['海外投資家 現物ネット（億円・売越は負）', 0, ''],
      ['好決算sell-on-news 頻発（YES/NO）', 'NO', ''],
    ];
    input.getRange(1, 1, seed.length, 3).setValues(seed);
    try { styleSheet_(input, 3, '#141a33', '#eef1fb'); autoFit_(input, 3); } catch (e) {}
    input.setColumnWidth(1, 300);
    input.getRange(2, 3, seed.length - 1, 1).setNumberFormat('yyyy/MM/dd');
    applyMacroValidation_(input, seed.length);
    input.setTabColor('#8e44ad');
  }
  return { input };
}
