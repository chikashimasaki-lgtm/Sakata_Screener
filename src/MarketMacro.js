// ============================================================================
//  相場マクロ監視（Sho「日本株急落の7条件」）＋ 銘柄別スクリーナーへの地合い供給
//  ---------------------------------------------------------------------------
//  ・NS倍率(日経/ S&P500) と VIX MACD は Yahoo から自動取得。
//    信用売残/倍率・日経EPS・海外投資家・好決算sell-on-news は「相場マクロ」シートの
//    手入力（JPX/日経公表値。スクレイピングは後付け。取得不可時は手入力へフォールバック）。
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
};

// ── 純ロジック（GAS非依存・ヘッドレステスト可能） ───────────────────────────

// 地合い：東証 売残(億円) と 東証 信用倍率(買残÷売残) から3区分。
function marginRegime_(sellBalOku, ratio) {
  const T = SK.MARGIN.SELL_THRESHOLD_OKU, P = SK.MARGIN.RATIO_PIVOT;
  const s = Number(sellBalOku), r = Number(ratio);
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

// NS倍率(日経/ S&P500)のトレンド：直近 window 本の平均比率が、その前 window 本の平均比率を
// 下回れば DOWN（日本株劣位＝米国株優位）、上回れば UP、ほぼ横ばいなら FLAT。
function nsRatioTrend_(n225, spx, window) {
  const m = Math.min(n225.length, spx.length);
  if (m < window * 2) return 'FLAT';
  const ratio = [];
  for (let i = m - window * 2; i < m; i++) ratio.push(n225[i] / spx[i]);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const prev = avg(ratio.slice(0, window)), now = avg(ratio.slice(window));
  if (now < prev * 0.995) return 'DOWN';
  if (now > prev * 1.005) return 'UP';
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

// Yahoo チャートAPIから指数の終値配列を取得（^N225 / ^GSPC / ^VIX 等）。parseYahooBars_(Code.js) 流用。
function fetchIndexCloses_(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?range=' + MACRO.YAHOO_RANGE + '&interval=1d';
  const res = UrlFetchApp.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
  return parseYahooBars_(res).map(b => b.c);
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
  files.sort(function (a, b) { return a.name < b.name ? 1 : a.name > b.name ? -1 : 0; });  // mtseisanYYYYMMDD 降順
  return files[0];
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
  for (var i = 0; i + 1 < grid.length; i++) {
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
function writeMacroInputValues_(sellOku, ratio) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(MACRO.INPUT_SHEET); if (!sh) sh = setupMacroSheets_().input;
  var vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  for (var i = 0; i < vals.length; i++) {
    var k = String(vals[i][0] || '');
    if (/売残.*億|売残高/.test(k) && sellOku != null) sh.getRange(i + 1, 2).setValue(sellOku);
    else if (/信用倍率/.test(k) && ratio != null) sh.getRange(i + 1, 2).setValue(ratio);
  }
}

// 「相場マクロ」シート（A列=項目 / B列=値）から手入力値を読む。無ければ作成。
function readMacroInputSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(MACRO.INPUT_SHEET);
  if (!sh) sh = setupMacroSheets_().input;
  const rows = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  // ラベルはキーワードで照合（旧「二市場売残」等が残っていても拾えるよう寛容に）
  const find = (re) => { for (var i = 0; i < rows.length; i++) { if (re.test(String(rows[i][0] || ''))) return rows[i][1]; } return undefined; };
  return {
    sell_margin_oku:  find(/売残.*億|売残高/),
    margin_ratio:     find(/信用倍率/),
    nikkei_eps_trend: String(find(/EPS/) || 'FLAT').toUpperCase(),
    foreign_net_oku:  find(/海外/),
    earnings_selloff: String(find(/決算|sell/i) || 'NO').toUpperCase(),
  };
}

// メニュー本体：手入力＋自動(NS/VIX)から7条件を判定し「急落サイン」へ出力、地合いをキャッシュ。
function updateMarketMacro() {
  const tse = importTseMarginFile_();                          // 東証 mtseisan*.xls を自動取込
  if (tse) writeMacroInputValues_(tse.sellOku, tse.ratio);
  const manual = readMacroInputSheet_();                       // 取込値を書き戻した後に読む
  if (tse) { manual.sell_margin_oku = tse.sellOku; manual.margin_ratio = tse.ratio; }

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
    ' ・東証売残=' + (tse ? tse.sellOku + '億/倍率' + tse.ratio : '未取込'));
  try {
    SpreadsheetApp.getActive().toast(
      (tse ? '東証売残' + tse.sellOku + '億・倍率' + tse.ratio : '⚠ mtseisan未取込（ファイル/認可を確認）') +
      ' ・急落' + lit + '/7 ・地合い' + regime, '相場マクロ', 8);
  } catch (e) {}
}

// finalizeSignals_(Code.js) が参照する現在の地合い。未更新時は NEUTRAL。
function getMarketRegime_() {
  return PropertiesService.getScriptProperties().getProperty(MACRO.REGIME_PROP) || 'NEUTRAL';
}

function writeAlertSheet_(conds, lit, data) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(MACRO.ALERT_SHEET) || ss.insertSheet(MACRO.ALERT_SHEET);
  sh.clear();
  const regime = marginRegime_(data.sell_margin_oku, data.margin_ratio);
  const rows = [
    ['急落サイン 点灯数', lit + ' / 7'],
    ['市場地合い', regime + (regime === 'SHORT_COVER' ? '（ショートカバー好機・買い追い風）'
      : regime === 'SUPPLY_RISK' ? '（需給悪化・売り警戒）' : '（中立）')],
    ['更新', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm')],
    ['', ''],
    ['条件', '状態', '値'],
  ];
  conds.forEach(c => rows.push([c.condition, c.alert ? '⚠ 点灯' : '正常', c.value == null ? '' : String(c.value)]));
  // 列数を3に揃える
  const width = 3;
  const grid = rows.map(r => { const a = r.slice(0, width); while (a.length < width) a.push(''); return a; });
  sh.getRange(1, 1, grid.length, width).setValues(grid);
  try { styleSheet_(sh, width, '#7a1f2b', '#fbeef0'); autoFit_(sh, width); } catch (e) {}
  sh.setTabColor('#c0392b');
}

// 「相場マクロ」入力シートを作成（初回のみ・既定値入り）。
function setupMacroSheets_() {
  const ss = SpreadsheetApp.getActive();
  let input = ss.getSheetByName(MACRO.INPUT_SHEET);
  if (!input) {
    input = ss.insertSheet(MACRO.INPUT_SHEET);
    const seed = [
      ['項目', '値（東証売残・信用倍率はDLした mtseisan*.xls から自動。NS倍率/VIXも自動。他は手入力）'],
      ['東証 売残（億円）', 8000],
      ['東証 信用倍率（買残÷売残・株数）', 1.0],
      ['日経平均EPSトレンド（UP/FLAT/DOWN）', 'FLAT'],
      ['海外投資家 現物ネット（億円・売越は負）', 0],
      ['好決算sell-on-news 頻発（YES/NO）', 'NO'],
    ];
    input.getRange(1, 1, seed.length, 2).setValues(seed);
    try { styleSheet_(input, 2, '#141a33', '#eef1fb'); autoFit_(input, 2); } catch (e) {}
    input.setColumnWidth(1, 300);
    input.setTabColor('#8e44ad');
  }
  return { input };
}
