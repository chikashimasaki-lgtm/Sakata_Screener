// ============================================================================
//  酒田五法 シグナル・スクリーナー
//  ---------------------------------------------------------------------------
//  株価API（Yahoo Finance 日足）から多銘柄をスキャンし、酒田五法のシグナルが
//  点灯した銘柄を一覧化する。GitHub Pages 表示用の JSON も出力する。
//  ※ 投資助言ではなく、シグナル抽出の補助ツール。
//
//  実装パターン: 赤三兵 / 三羽烏(黒三兵) / 三空踏み上げ / 三空叩き込み /
//               上げ三法 / 下げ三法
//  （三山・三川＝三尊/逆三尊は将来対応）
//
//  使い方:
//   1) メニュー「酒田五法」→ セットアップ
//   2) 「銘柄」シートにコード(4桁)を入れる（または「プライム銘柄を取得」でJ-Quantsから取得）
//   3) 「シグナル走査」を実行 → 「シグナル」シートに結果
// ============================================================================

const SK = {
  SHEETS: { UNIVERSE: '銘柄', SIGNALS: 'シグナル', USAGE: '使い方' },
  YAHOO_RANGE: '6mo',
  BATCH: 40,
  TIME_BUDGET_MS: 4.5 * 60 * 1000,
};

// ---- メニュー ----
function onOpen() {
  SpreadsheetApp.getUi().createMenu('酒田五法')
    .addItem('セットアップ', 'setup')
    .addSeparator()
    .addItem('プライム銘柄を取得（J-Quants）', 'fetchPrimeUniverse')
    .addItem('シグナル走査/続行',            'scanSignals')
    .addItem('JSON出力（Pages用）',          'exportJson')
    .addSeparator()
    .addItem('使い方シートを作成/更新',      'createUsageSheet')
    .addItem('走査の進捗リセット',           'resetScanQueue')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  let uni = ss.getSheetByName(SK.SHEETS.UNIVERSE);
  if (!uni) {
    uni = ss.insertSheet(SK.SHEETS.UNIVERSE);
    uni.getRange(1, 1, 1, 2).setValues([['コード', '銘柄名']]);
    uni.getRange(2, 1, 5, 2).setValues([
      ['7203', 'トヨタ自動車'], ['6758', 'ソニーグループ'], ['9984', 'ソフトバンクグループ'],
      ['8306', '三菱UFJ'], ['6501', '日立製作所'],
    ]);
  }
  if (!ss.getSheetByName(SK.SHEETS.SIGNALS)) ss.insertSheet(SK.SHEETS.SIGNALS);
  createUsageSheet();
  ss.getSheetByName(SK.SHEETS.UNIVERSE).setTabColor('#5b6bd6');
  ss.getSheetByName(SK.SHEETS.SIGNALS).setTabColor('#e0567a');
  ss.toast('シートを準備しました。「銘柄」にコードを入れて走査してください', '酒田五法', 6);
}

// ============================================================================
//  プライム銘柄の取得（J-Quants V2・任意）
// ============================================================================
function fetchPrimeUniverse() {
  const key = PropertiesService.getScriptProperties().getProperty('JQUANTS_API_KEY');
  if (!key) throw new Error('JQUANTS_API_KEY をスクリプトプロパティに設定してください（プライム取得に必要）');

  const collect = [];
  let pagination = null;
  do {
    let url = 'https://api.jquants.com/v2/equities/master';
    if (pagination) url += '?pagination_key=' + encodeURIComponent(pagination);
    const res = UrlFetchApp.fetch(url, { headers: { 'x-api-key': key }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('equities/master 失敗: ' + res.getContentText().slice(0, 200));
    const j = JSON.parse(res.getContentText());
    (j.data || []).forEach(x => { if (x.Mkt === '0111' || x.MktNm === 'プライム') collect.push([to4_(x.Code), x.CoName || '']); });
    pagination = j.pagination_key || null;
  } while (pagination);

  const uni = SpreadsheetApp.getActive().getSheetByName(SK.SHEETS.UNIVERSE);
  uni.clear();
  uni.getRange(1, 1, 1, 2).setValues([['コード', '銘柄名']]);
  if (collect.length) uni.getRange(2, 1, collect.length, 2).setValues(collect);
  uni.setTabColor('#5b6bd6');
  Logger.log('プライム銘柄: ' + collect.length + '件');
  SpreadsheetApp.getActive().toast('プライム ' + collect.length + '件を取得', '酒田五法', 5);
}

function to4_(code) {
  const c = String(code == null ? '' : code);
  return (c.length === 5 && c.slice(-1) === '0') ? c.slice(0, 4) : c;
}

// ============================================================================
//  シグナル走査（時間分割・自動再開）
// ============================================================================
function scanSignals() {
  const ss  = SpreadsheetApp.getActive();
  const uni = ss.getSheetByName(SK.SHEETS.UNIVERSE);
  const sig = ss.getSheetByName(SK.SHEETS.SIGNALS);
  if (!uni || uni.getLastRow() < 2) throw new Error('「銘柄」シートにコードを入れてください');

  const props = PropertiesService.getScriptProperties();
  let queue = JSON.parse(props.getProperty('SK_QUEUE') || 'null');
  if (!queue) {
    // 新規走査: 銘柄リストからキューを作り、シグナルシートを初期化
    const rows = uni.getRange(2, 1, uni.getLastRow() - 1, 2).getValues().filter(r => r[0]);
    queue = rows.map(r => [String(r[0]).trim(), r[1] || '']);
    sig.clear();
    sig.getRange(1, 1, 1, 6).setValues([['日付', 'コード', '銘柄名', '方向', 'シグナル', '終値']]);
  }

  const start = Date.now();
  const buffer = [];
  while (queue.length > 0) {
    if (Date.now() - start > SK.TIME_BUDGET_MS) break;
    const slice = queue.splice(0, SK.BATCH);
    const reqs = slice.map(([code]) => ({
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(code) +
           '.T?range=' + SK.YAHOO_RANGE + '&interval=1d',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      muteHttpExceptions: true,
    }));
    let resps;
    try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { queue.unshift.apply(queue, slice); break; }
    resps.forEach((res, i) => {
      const [code, name] = slice[i];
      const bars = parseYahooBars_(res);
      if (bars.length < 5) return;
      const signals = detectSakata_(bars);
      if (signals.length === 0) return;
      const last = bars[bars.length - 1];
      const dirs = new Set(signals.map(s => s.dir));
      const dir  = dirs.size > 1 ? '混在' : [...dirs][0];
      buffer.push([
        Utilities.formatDate(new Date(last.t * 1000), 'JST', 'yyyy/MM/dd'),
        code, name, dir, signals.map(s => s.name).join('、'), last.c,
      ]);
    });
    Utilities.sleep(200);
  }

  if (buffer.length) sig.getRange(sig.getLastRow() + 1, 1, buffer.length, 6).setValues(buffer);

  clearResumeTriggers_();
  if (queue.length > 0) {
    props.setProperty('SK_QUEUE', JSON.stringify(queue));
    ScriptApp.newTrigger('scanSignals').timeBased().after(90 * 1000).create();
    Logger.log('一時停止: 残り ' + queue.length + '銘柄。90秒後に自動再開。');
    ss.toast('残り ' + queue.length + '銘柄。自動再開します', '酒田五法', 5);
  } else {
    props.deleteProperty('SK_QUEUE');
    finalizeSignals_(sig);
    Logger.log('走査完了: シグナル ' + Math.max(sig.getLastRow() - 1, 0) + '件');
    ss.toast('走査完了: ' + Math.max(sig.getLastRow() - 1, 0) + '件のシグナル', '酒田五法', 6);
  }
}

function resetScanQueue() {
  PropertiesService.getScriptProperties().deleteProperty('SK_QUEUE');
  clearResumeTriggers_();
  SpreadsheetApp.getActive().toast('走査の進捗をリセットしました', '酒田五法', 5);
}

function clearResumeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'scanSignals')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function finalizeSignals_(sig) {
  if (sig.getLastRow() < 2) return;
  // 方向で並べ替え（買い→売り→混在）はせず、コード順のまま。装飾のみ。
  sig.getRange(2, 6, sig.getLastRow() - 1, 1).setNumberFormat('#,##0');   // 終値カンマ
  sig.getRange(2, 2, sig.getLastRow() - 1, 1).setHorizontalAlignment('right'); // コード右寄せ
  styleSheet_(sig, 6, '#3a1530', '#f7ecf3');
  autoFit_(sig, 6);
  // 方向の色分け（買い=緑 / 売り=赤）
  const dirs = sig.getRange(2, 4, sig.getLastRow() - 1, 1).getValues();
  const bg = dirs.map(([d]) => [d === '買い' ? '#e7f6ec' : d === '売り' ? '#fdeaea' : '#fff5e6']);
  sig.getRange(2, 4, dirs.length, 1).setBackgrounds(bg);
  sig.setTabColor('#e0567a');
}

// ============================================================================
//  Yahoo 日足パース
// ============================================================================
function parseYahooBars_(res) {
  try {
    if (res.getResponseCode() !== 200) return [];
    const r = JSON.parse(res.getContentText()).chart.result[0];
    const ts = r.timestamp, q = r.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      bars.push({ o, h, l, c, t: ts[i] });
    }
    return bars;
  } catch (e) { return []; }
}

// ============================================================================
//  酒田五法 検出（直近の足で判定）
//  bars: 古い→新しい順の配列 [{o,h,l,c,t}, ...]
// ============================================================================
function detectSakata_(bars) {
  const n = bars.length;
  const sig = [];
  if (n < 5) return sig;
  const A = bars[n - 1], B = bars[n - 2], C = bars[n - 3], D = bars[n - 4], E = bars[n - 5];
  const bull = b => b.c > b.o;
  const bear = b => b.c < b.o;

  // 赤三兵: 直近3本が陽線・終値切り上げ・始値切り上げ（上昇転換/継続）
  if (bull(A) && bull(B) && bull(C) && A.c > B.c && B.c > C.c && A.o > B.o && B.o > C.o)
    sig.push({ name: '赤三兵', dir: '買い' });

  // 三羽烏(黒三兵): 直近3本が陰線・終値切り下げ・始値切り下げ（下落転換/継続）
  if (bear(A) && bear(B) && bear(C) && A.c < B.c && B.c < C.c && A.o < B.o && B.o < C.o)
    sig.push({ name: '三羽烏(黒三兵)', dir: '売り' });

  // 三空踏み上げ: 直近3つの窓が上向き（買われ過ぎ→反落）
  if (A.l > B.h && B.l > C.h && C.l > D.h) sig.push({ name: '三空踏み上げ', dir: '売り' });

  // 三空叩き込み: 直近3つの窓が下向き（売られ過ぎ→反発）
  if (A.h < B.l && B.h < C.l && C.h < D.l) sig.push({ name: '三空叩き込み', dir: '買い' });

  // 上げ三法: E長陽 → D,C,B が E の値幅内で調整 → A が E 高値を上抜けの陽線（上昇継続）
  if (bull(E) && [D, C, B].every(x => x.h <= E.h && x.l >= E.l) && bull(A) && A.c > E.h)
    sig.push({ name: '上げ三法', dir: '買い' });

  // 下げ三法: E長陰 → D,C,B が E の値幅内 → A が E 安値を下抜けの陰線（下落継続）
  if (bear(E) && [D, C, B].every(x => x.h <= E.h && x.l >= E.l) && bear(A) && A.c < E.l)
    sig.push({ name: '下げ三法', dir: '売り' });

  return sig;
}

// ============================================================================
//  JSON出力（GitHub Pages 用）
// ============================================================================
function exportJson() {
  const sig = SpreadsheetApp.getActive().getSheetByName(SK.SHEETS.SIGNALS);
  if (!sig || sig.getLastRow() < 2) throw new Error('先に「シグナル走査」を実行してください');
  const keys = ['date', 'code', 'name', 'dir', 'signals', 'close'];
  const data = sig.getRange(2, 1, sig.getLastRow() - 1, 6).getValues()
    .map(r => Object.fromEntries(keys.map((k, i) => [k, r[i]])));
  const json = JSON.stringify({ updated: new Date().toISOString(), items: data });
  const file = DriveApp.createFile('sakata_signals.json', json, 'application/json');
  Logger.log('JSON出力: ' + file.getUrl());
  SpreadsheetApp.getActive().toast('JSONをDriveに出力しました', '酒田五法', 5);
  return file.getUrl();
}

// ============================================================================
//  共通: 装飾・列幅
// ============================================================================
function styleSheet_(sheet, numCols, headerColor, altColor) {
  if (!sheet || sheet.getLastRow() < 1 || numCols < 1) return;
  const lastRow = sheet.getLastRow();
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).getBandings().forEach(b => b.remove());
  const band = sheet.getRange(1, 1, lastRow, numCols)
    .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
  band.setHeaderRowColor(headerColor).setFirstRowColor('#ffffff').setSecondRowColor(altColor);
  sheet.getRange(1, 1, 1, numCols)
    .setFontColor('#ffffff').setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 30);
}

function autoFit_(sheet, numCols) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 1 || numCols < 1) return;
  const values = sheet.getRange(1, 1, lastRow, numCols).getDisplayValues();
  for (let c = 0; c < numCols; c++) {
    let maxUnits = 1;
    for (let r = 0; r < values.length; r++) {
      const s = String(values[r][c] == null ? '' : values[r][c]);
      let units = 0;
      for (const ch of s) units += (ch.charCodeAt(0) > 0xFF ? 2 : 1);
      if (units > maxUnits) maxUnits = units;
    }
    sheet.setColumnWidth(c + 1, Math.min(Math.max(maxUnits * 8 + 16, 60), 520));
  }
}

// ============================================================================
//  使い方シート
// ============================================================================
function createUsageSheet() {
  const ss = SpreadsheetApp.getActive();
  const old = ss.getSheetByName(SK.SHEETS.USAGE);
  if (old) ss.deleteSheet(old);
  const sh = ss.insertSheet(SK.SHEETS.USAGE, 0);
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 760);

  const rows = [
    ['酒田五法 シグナル・スクリーナー　使い方', 'title'],
    ['', 'p'],
    ['■ これは何？', 'h'],
    ['株価API（Yahoo日足）から多銘柄をスキャンし、酒田五法のシグナルが点灯した銘柄を一覧化します。投資助言ではありません。', 'p'],
    ['', 'p'],
    ['■ 使い方', 'h'],
    ['1. セットアップ（シート作成）', 'p'],
    ['2. 「銘柄」シートにコード(4桁)を入力。または「プライム銘柄を取得（J-Quants）」で自動取得', 'p'],
    ['   ※J-Quants取得を使う場合はスクリプトプロパティ JQUANTS_API_KEY が必要', 'p'],
    ['3. 「シグナル走査/続行」を実行（銘柄数が多いと時間分割で自動再開）', 'p'],
    ['4. 「シグナル」シートに結果。JSON出力で公開ページ用データを作成', 'p'],
    ['', 'p'],
    ['■ 検出する酒田五法', 'h'],
    ['赤三兵 … 陽線3本の切り上げ（買い）', 'p'],
    ['三羽烏(黒三兵) … 陰線3本の切り下げ（売り）', 'p'],
    ['三空踏み上げ … 上の窓が3連続＝買われ過ぎ（売り）', 'p'],
    ['三空叩き込み … 下の窓が3連続＝売られ過ぎ（買い）', 'p'],
    ['上げ三法 … 長陽→値幅内の調整→上抜け陽線（買い・上昇継続）', 'p'],
    ['下げ三法 … 長陰→値幅内の調整→下抜け陰線（売り・下落継続）', 'p'],
    ['※ 三山・三川（三尊/逆三尊）は将来対応', 'note'],
    ['', 'p'],
    ['■ 注意', 'h'],
    ['・シグナルは補助情報です。だましもあります。必ず自身で確認してください。', 'note'],
  ];
  sh.getRange(1, 1, rows.length, 1).setValues(rows.map(r => [r[0]]));
  rows.forEach((r, i) => {
    const cell = sh.getRange(i + 1, 1);
    if (r[1] === 'title') { cell.setFontSize(16).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1a1e3a'); sh.setRowHeight(i + 1, 40); }
    else if (r[1] === 'h') { cell.setFontSize(12).setFontWeight('bold').setFontColor('#1a3c6e').setBackground('#e7effb'); sh.setRowHeight(i + 1, 26); }
    else if (r[1] === 'note') { cell.setFontColor('#666666').setWrap(true); }
    else { cell.setWrap(true); }
  });
  sh.getRange(1, 1, rows.length, 1).setVerticalAlignment('middle');
  sh.setTabColor('#f4b400');
  ss.setActiveSheet(sh);
  return sh;
}
