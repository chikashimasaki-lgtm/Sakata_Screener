// ============================================================================
//  酒田五法 シグナル・スクリーナー
//  ---------------------------------------------------------------------------
//  株価API（Yahoo Finance 日足）から多銘柄をスキャンし、酒田五法のシグナルが
//  点灯した銘柄を一覧化する。GitHub Pages 表示用の JSON も出力する。
//  ※ 投資助言ではなく、シグナル抽出の補助ツール。
//
//  実装パターン: 赤三兵 / 三羽烏(黒三兵) / 三空踏み上げ / 三空叩き込み /
//               上げ三法 / 下げ三法 / 三山(三尊天井) / 三川(逆三尊) /
//               明けの明星 / 宵の明星 / 捨て子線
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
    .addItem('自動実行を設定（走査:平日16時/保有確認:毎時）', 'installDailyScanTrigger')
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
  const u = ss.getSheetByName(SK.SHEETS.UNIVERSE);
  styleSheet_(u, 2, '#1a1e3a', '#eef3fc');   // 銘柄シートも配色
  if (u.getLastRow() > 1) u.getRange(2, 1, u.getLastRow() - 1, 1).setHorizontalAlignment('right');  // コード右寄せ
  autoFit_(u, 2);
  u.setTabColor('#5b6bd6');
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
  styleSheet_(uni, 2, '#1a1e3a', '#eef3fc');   // 銘柄シートも配色
  if (uni.getLastRow() > 1) uni.getRange(2, 1, uni.getLastRow() - 1, 1).setHorizontalAlignment('right');  // コード右寄せ
  autoFit_(uni, 2);
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
  // 自動再開トリガーと手動実行が重なった場合の二重追記を防ぐ（多重実行排他）
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('別の走査が進行中のためスキップ'); return; }

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
    sig.getRange(1, 1, 1, 7).setValues([['日付', 'コード', '銘柄名', '終値', '方向', 'シグナル', 'シグナル解説']]);
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
      const names = signals.map(s => s.name);
      buffer.push([
        Utilities.formatDate(new Date(last.t * 1000), 'JST', 'yyyy/MM/dd'),
        code, name, last.c, dir, names.join('、'), signalExplain_(names),
      ]);
    });
    Utilities.sleep(200);
  }

  if (buffer.length) sig.getRange(sig.getLastRow() + 1, 1, buffer.length, 7).setValues(buffer);

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

// ---- 定期実行（平日16時・土日祝／年末年始はスキップ） ----
function installDailyScanTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['scheduledScan', 'scheduledHeldCheck'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scheduledScan').timeBased().everyDays(1).atHour(16).create();  // 全銘柄 株価取得＋走査（1日1回）
  ScriptApp.newTrigger('scheduledHeldCheck').timeBased().everyHours(1).create();       // 購入ポートフォリオ確認（毎時）
  SpreadsheetApp.getActive().toast('自動実行を設定しました（全銘柄走査:平日16時 / 保有確認:毎時・立会時間内）', '酒田五法', 6);
  Logger.log('トリガー設定: scheduledScan(平日16時) / scheduledHeldCheck(毎時・立会時間内)');
}

// 平日16時に発火。全銘柄の株価取得＋シグナル走査（重い処理・1日1回）。
// 立会対象（営業日 9:00-17:00）のみ実行。isMarketOpen_() は共通モジュール MarketCalendar.js で定義。
function scheduledScan() {
  const now = new Date();
  if (!isMarketOpen_(now)) { Logger.log('立会時間外(土日祝・時間外)のため走査をスキップ: ' + now); return; }
  scanSignals();
}

// 毎時発火。購入ポートフォリオ(SBI保有銘柄)の確認 = 既存シグナルシートの保有ハイライトを最新の保有状況で更新する。
// 株価取得は行わない（全銘柄走査は scheduledScan 側の役割）。立会対象（営業日 9:00-17:00）のみ実行。
function scheduledHeldCheck() {
  const now = new Date();
  if (!isMarketOpen_(now)) { Logger.log('立会時間外のため保有確認をスキップ: ' + now); return; }
  const sig = SpreadsheetApp.getActive().getSheetByName(SK.SHEETS.SIGNALS);
  if (!sig || sig.getLastRow() < 2) { Logger.log('シグナル未生成のため保有確認をスキップ'); return; }
  finalizeSignals_(sig);
  Logger.log('購入ポートフォリオ確認: 保有ハイライトを更新');
}

function finalizeSignals_(sig) {
  if (sig.getLastRow() < 2) return;
  const n = sig.getLastRow() - 1;
  // 強く出ているもの（同時に点灯したパターン数が多い＝強いシグナル）を上に並べ替え
  const data = sig.getRange(2, 1, n, 7).getValues();
  const strength = row => String(row[5] || '').split('、').filter(Boolean).length;  // シグナル列
  data.sort((a, b) => strength(b) - strength(a));
  sig.getRange(2, 1, n, 7).setValues(data);

  // B列（コード）を TradingView 日足チャート（保存レイアウト）へのハイパーリンクにする。
  // 並べ替え後に設定するので、後続の再書き込みで消えない。index.html のリンクと同一挙動。
  const TV = 'vrWJ3cQi';
  sig.getRange(2, 2, n, 1).setFormulas(data.map(row => {
    const code = to4_(String(row[1] || '').trim()).toUpperCase();   // 5桁→4桁に正規化
    return [code ? `=HYPERLINK("https://jp.tradingview.com/chart/${TV}/?symbol=TSE:${code}&interval=D","${code}")` : ''];
  }));

  sig.getRange(2, 4, n, 1).setNumberFormat('#,##0');        // 終値カンマ（4列目）
  sig.getRange(2, 2, n, 1).setHorizontalAlignment('right'); // コード右寄せ
  styleSheet_(sig, 7, '#3a1530', '#f7ecf3');
  autoFit_(sig, 6);                                         // 6列目まで内容にフィット
  sig.setColumnWidth(7, 460);                               // シグナル解説は固定幅＋折返し
  sig.getRange(2, 7, n, 1).setWrap(true);
  // 方向（5列目）の色分け（買い=緑 / 売り=赤 / 混在=橙）
  const dirs = sig.getRange(2, 5, n, 1).getValues();
  const bg = dirs.map(([d]) => [d === '買い' ? '#e7f6ec' : d === '売り' ? '#fdeaea' : '#fff5e6']);
  sig.getRange(2, 5, n, 1).setBackgrounds(bg);

  // SBI証券（日本株／日本株信用）で保有中の銘柄は、行ごと半透明赤でハイライト
  try {
    const held = getSbiHeldCodes_();
    for (let i = 0; i < n; i++) {
      const code = to4_(String(data[i][1] || '').trim()).toUpperCase();   // 5桁→4桁に正規化
      if (held.has(code)) sig.getRange(2 + i, 1, 1, 7).setBackground('#f2a9a9');
    }
  } catch (e) { Logger.log('SBI保有ハイライト失敗: ' + e.message); }

  sig.setTabColor('#e0567a');
}

// SBI証券の保有銘柄コードを参照元スプレッドシート（Asset_Status）から収集する。
// 「SBI証券（日本株）」「SBI証券（日本株信用）」の「銘柄コード」列から4桁の証券コードを抽出。
function getSbiHeldCodes_() {
  const SBI_SS_ID = '1VSSDMV5u8wNmGe9bh4wQI7wOULodzMq309cgWKljobg'; // Asset_Status のスプレッドシート
  const SHEET_NAMES = ['SBI証券（日本株）', 'SBI証券（日本株信用）'];
  const CODE_RE = /^[0-9][0-9A-Z]{3}$/;                            // 4桁の証券コード（例 7203 / 130A）
  const set = new Set();
  let ss;
  try { ss = SpreadsheetApp.openById(SBI_SS_ID); }
  catch (e) { Logger.log('SBIスプレッドシートを開けません: ' + e.message); return set; }
  SHEET_NAMES.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 1) return;
    const data = sh.getDataRange().getValues();
    // 「銘柄コード」ヘッダの列を特定（Asset_Status のCSV取込と同じ構造）
    let hi = -1, ci = -1;
    for (let r = 0; r < data.length && ci < 0; r++) {
      const c = data[r].findIndex(v => String(v || '').trim() === '銘柄コード');
      if (c >= 0) { hi = r; ci = c; }
    }
    if (ci < 0) {   // ヘッダが見つからなければ全セルから4桁コードを拾う保険
      data.forEach(row => row.forEach(v => {
        const s = to4_(String(v || '').trim()).toUpperCase();   // 5桁→4桁に正規化
        if (CODE_RE.test(s)) set.add(s);
      }));
      return;
    }
    for (let r = hi + 1; r < data.length; r++) {
      const s = to4_(String(data[r][ci] || '').trim()).toUpperCase();   // 5桁→4桁に正規化
      if (CODE_RE.test(s)) set.add(s);
    }
  });
  Logger.log('SBI保有銘柄コード: ' + set.size + '件');
  return set;
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

// シグナルの意味（解説列に表示）
const SIGNAL_DESC_ = {
  '赤三兵':         '陽線3本が連続し上昇の勢い。買い転換・継続のサイン。',
  '三羽烏(黒三兵)': '陰線3本が連続し下落の勢い。売り転換・継続のサイン。',
  '三空踏み上げ':   '上放れの窓が3回続き買われ過ぎ。反落に注意（売り）。',
  '三空叩き込み':   '下放れの窓が3回続き売られ過ぎ。反発期待（買い）。',
  '上げ三法':       '上昇中の小休止のあと高値を更新。上昇継続（買い）。',
  '下げ三法':       '下降中の小戻しのあと安値を更新。下落継続（売り）。',
  '三山(三尊天井)': '3つの山（中央が最高）でネックライン割れ。天井の売りサイン。',
  '三川(逆三尊)':   '3つの谷（中央が最安）でネックライン上抜け。大底の買いサイン。',
  '明けの明星':     '長大陰線→窓を開けた小さな星→陽線でC実体中心を回復。底の買い転換。',
  '宵の明星':       '長大陽線→窓を開けた小さな星→陰線でC実体中心を割る。天井の売り転換。',
  '捨て子線(明け)': '中央が同事線で前後に窓が開く強い底打ち反転（明けの明星の特殊形・買い）。',
  '捨て子線(宵)':   '中央が同事線で前後に窓が開く強い天井反転（宵の明星の特殊形・売り）。',
  'かぶせ線':       '大陽線の翌日、上に放れて始まるも前日実体の中心より下で引ける陰線。天井の売り転換。',
  '切り込み線':     '大陰線の翌日、下に放れて始まるも前日実体の中心より上で引ける陽線。底の買い転換。',
  '包み線(強気)':   '前日の陰線を当日の陽線が実体ごと包み込む。下落からの買い転換。',
  '包み線(弱気)':   '前日の陽線を当日の陰線が実体ごと包み込む。上昇からの売り転換。',
  'はらみ線(強気)': '前日の大陰線の実体内に当日の小陽線が収まる。下落の勢い減衰・買い転換。',
  'はらみ線(弱気)': '前日の大陽線の実体内に当日の小陰線が収まる。上昇の勢い減衰・売り転換。',
  '毛抜き天井':     '高値がほぼ同値で2本並び上値が重い。天井の売りサイン。',
  '毛抜き底':       '安値がほぼ同値で2本並び下値が固い。大底の買いサイン。',
  '先詰まり赤三兵(警戒)': '赤三兵だが3本目の実体が縮み上ヒゲが伸びる。買われ過ぎで失速・反落警戒（売り）。',
  '上放れ二羽烏':   '上昇中に窓を開けて陰線2本、2本目が1本目を包む。窓は埋めず天井の売りサイン。',
  '三山(三点天井)': '3つの山がほぼ同値で並びネックライン割れ。天井の売りサイン（三尊でない三点天井）。',
  'RSI過熱(80超)':            'RSIが80超で買われ過ぎ。三空踏み上げの反落を補強（売り）。',
  'RSI底値(20割れ)':          'RSIが20割れで売られ過ぎ。三空叩き込みの反発を補強（買い）。',
  'RSIダイバージェンス(弱気)': '高値圏でRSIが切り下がり上昇の勢いが減衰。天井を補強（売り）。',
  'RSIダイバージェンス(強気)': '安値圏でRSIが切り上がり下落の勢いが減衰。大底を補強（買い）。',
};
function signalExplain_(names) {
  return names.map(n => '・' + n + '：' + (SIGNAL_DESC_[n] || '')).join('\n');
}

// RSI(14) 系列（close値のみで計算）。HTML版スクリーナーの現代版フィルターを移植。
function rsiSeries_(closes, p) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = Math.max(ch, 0), dn = Math.max(-ch, 0);
    if (i <= p) {
      g += up; l += dn;
      if (i === p) out[i] = (l === 0) ? 100 : 100 - 100 / (1 + g / l);
    } else {
      g = (g * (p - 1) + up) / p;
      l = (l * (p - 1) + dn) / p;
      out[i] = (l === 0) ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
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
  const rsi  = rsiSeries_(bars.map(b => b.c), 14);  // 現代版フィルター（RSI補強）
  const rNow = rsi[n - 1];

  // 赤三兵: 直近3本が陽線・終値切り上げ・始値切り上げ（上昇転換/継続）
  if (bull(A) && bull(B) && bull(C) && A.c > B.c && B.c > C.c && A.o > B.o && B.o > C.o) {
    sig.push({ name: '赤三兵', dir: '買い' });
    // 先詰まり赤三兵: 3本目の実体が縮み上ヒゲが長い＝失速・買われ過ぎ警戒（売り）
    const bodyA = A.c - A.o, upWickA = A.h - A.c;
    if (bodyA < (B.c - B.o) && upWickA > bodyA)
      sig.push({ name: '先詰まり赤三兵(警戒)', dir: '売り' });
  }

  // 三羽烏(黒三兵): 直近3本が陰線・終値切り下げ・始値切り下げ（下落転換/継続）
  if (bear(A) && bear(B) && bear(C) && A.c < B.c && B.c < C.c && A.o < B.o && B.o < C.o)
    sig.push({ name: '三羽烏(黒三兵)', dir: '売り' });

  // 三空踏み上げ: 直近3つの窓が上向き（買われ過ぎ→反落）＋ RSI80超で過熱を補強
  if (A.l > B.h && B.l > C.h && C.l > D.h) {
    sig.push({ name: '三空踏み上げ', dir: '売り' });
    if (rNow != null && rNow >= 80) sig.push({ name: 'RSI過熱(80超)', dir: '売り' });
  }

  // 三空叩き込み: 直近3つの窓が下向き（売られ過ぎ→反発）＋ RSI20割れで底値を補強
  if (A.h < B.l && B.h < C.l && C.h < D.l) {
    sig.push({ name: '三空叩き込み', dir: '買い' });
    if (rNow != null && rNow <= 20) sig.push({ name: 'RSI底値(20割れ)', dir: '買い' });
  }

  // 上げ三法: E長陽 → D,C,B が E の値幅内で調整 → A が E 高値を上抜けの陽線（上昇継続）
  if (bull(E) && [D, C, B].every(x => x.h <= E.h && x.l >= E.l) && bull(A) && A.c > E.h)
    sig.push({ name: '上げ三法', dir: '買い' });

  // 下げ三法: E長陰 → D,C,B が E の値幅内 → A が E 安値を下抜けの陰線（下落継続）
  if (bear(E) && [D, C, B].every(x => x.h <= E.h && x.l >= E.l) && bear(A) && A.c < E.l)
    sig.push({ name: '下げ三法', dir: '売り' });

  // 上放れ二羽烏: C陽線 → 窓を開けて陰線B → 陰線Aが陰線Bを包むが窓は埋めない（天井・売り）
  if (bull(C) && bear(B) && bear(A) && Math.min(B.o, B.c) > C.c && A.o > B.o && A.c < B.c && A.c > C.c)
    sig.push({ name: '上放れ二羽烏', dir: '売り' });

  // 三山(三尊天井) / 三川(逆三尊) / 単純三山（RSIダイバージェンスで補強）
  detectHeadShoulders_(bars, rsi).forEach(s => sig.push(s));

  // 三川の代表形: 明けの明星 / 宵の明星（＋捨て子線）
  detectStars_(bars).forEach(s => sig.push(s));

  // 三川系の2本足 反転パターン: かぶせ線 / 切り込み線 / 包み線 / はらみ線 / 毛抜き天井・底
  detectReversalPairs_(bars).forEach(s => sig.push(s));

  return sig;
}

// 三川系の2本足 反転パターンを直近2本で判定。
//   かぶせ線 … 大陽線の翌日、上放れ→前日実体中心より下で引ける陰線（売り）
//   切り込み線 … 大陰線の翌日、下放れ→前日実体中心より上で引ける陽線（買い）
//   包み線(抱き線) … 当日の実体が前日の実体を包む（強気=買い/弱気=売り）
//   はらみ線 … 当日の小実体が前日の大実体に収まる（強気=買い/弱気=売り）
//   毛抜き天井/底 … 高値/安値がほぼ同値で2本並ぶ（売り/買い）
function detectReversalPairs_(bars) {
  const n = bars.length;
  const out = [];
  if (n < 12) return out;
  const A = bars[n - 1], B = bars[n - 2];
  const bull = b => b.c > b.o, bear = b => b.c < b.o;
  const body = b => Math.abs(b.c - b.o);
  const mid  = b => (b.o + b.c) / 2;
  const uBody = b => Math.max(b.o, b.c), lBody = b => Math.min(b.o, b.c);

  // 平均実体（大陽線/大陰線の基準）
  let avg = 0; const m = Math.min(10, n - 1);
  for (let i = n - 1 - m; i < n - 1; i++) avg += body(bars[i]);
  avg /= (m || 1);
  const bBig = body(B) >= avg;   // 前日は大きめの実体

  // かぶせ線（売り）
  if (bBig && bull(B) && bear(A) && A.o > B.c && A.c < mid(B) && A.c > B.o)
    out.push({ name: 'かぶせ線', dir: '売り' });

  // 切り込み線（買い）
  if (bBig && bear(B) && bull(A) && A.o < B.c && A.c > mid(B) && A.c < B.o)
    out.push({ name: '切り込み線', dir: '買い' });

  // 包み線(抱き線): 当日の実体が前日の実体を完全に包む
  if (bear(B) && bull(A) && A.o <= B.c && A.c >= B.o && body(A) > body(B))
    out.push({ name: '包み線(強気)', dir: '買い' });
  if (bull(B) && bear(A) && A.o >= B.c && A.c <= B.o && body(A) > body(B))
    out.push({ name: '包み線(弱気)', dir: '売り' });

  // はらみ線: 当日の小実体が前日の大実体に収まる
  const inside = uBody(A) < uBody(B) && lBody(A) > lBody(B);
  if (bBig && inside && bear(B)) out.push({ name: 'はらみ線(強気)', dir: '買い' });
  if (bBig && inside && bull(B)) out.push({ name: 'はらみ線(弱気)', dir: '売り' });

  // 毛抜き天井/底: 高値/安値がほぼ同値
  const eq = (x, y) => Math.abs(x - y) <= (Math.abs(y) || 1) * 0.002;
  if (bull(B) && bear(A) && eq(A.h, B.h)) out.push({ name: '毛抜き天井', dir: '売り' });
  if (bear(B) && bull(A) && eq(A.l, B.l)) out.push({ name: '毛抜き底', dir: '買い' });

  return out;
}

// 明けの明星 / 宵の明星（酒田五法・三川の代表形）と、その特殊形の捨て子線を判定。
//   明けの明星 … 長大陰線 → 窓を開けた下放れの小さな星 → 実体中心を上回る陽線（底の買い転換）
//   宵の明星   … 長大陽線 → 窓を開けた上放れの小さな星 → 実体中心を下回る陰線（天井の売り転換）
//   捨て子線   … 中央が同事線で、両側に窓が開く特殊形（より強い反転）
function detectStars_(bars) {
  const n = bars.length;
  const out = [];
  if (n < 4) return out;
  const A = bars[n - 1], B = bars[n - 2], C = bars[n - 3];
  const body  = b => Math.abs(b.c - b.o);
  const upper = b => Math.max(b.o, b.c);   // 実体上端
  const lower = b => Math.min(b.o, b.c);   // 実体下端
  const mid   = b => (b.o + b.c) / 2;      // 実体中心
  const bull  = b => b.c > b.o, bear = b => b.c < b.o;

  // 直近10本の平均実体（中日前の「長大線」判定の基準）
  const m = Math.min(10, n);
  let avg = 0;
  for (let i = n - m; i < n; i++) avg += body(bars[i]);
  avg /= (m || 1);

  const cBig  = body(C) >= avg;                     // 中日前は長大線
  const bStar = body(B) <= body(C) * 0.5;           // 中央は小さな実体（星／コマ）
  const bDoji = body(B) <= (B.h - B.l) * 0.1;       // ほぼ同事線（寄引同値）

  // 明けの明星: 星がC終値の下に窓を開けて放れ、翌日の陽線がC実体の中心を上回る
  if (cBig && bear(C) && bStar && upper(B) < C.c && bull(A) && A.c > mid(C)) {
    out.push({ name: '明けの明星', dir: '買い' });
    // 捨て子線（明け）: 星が同事線で、前後ともヒゲを含め窓が開く（強い底打ち反転）
    if (bDoji && B.h < C.l && A.l > B.h) out.push({ name: '捨て子線(明け)', dir: '買い' });
  }

  // 宵の明星: 星がC終値の上に窓を開けて放れ、翌日の陰線がC実体の中心を下回る
  if (cBig && bull(C) && bStar && lower(B) > C.c && bear(A) && A.c < mid(C)) {
    out.push({ name: '宵の明星', dir: '売り' });
    // 捨て子線（宵）: 星が同事線で、前後ともヒゲを含め窓が開く（強い天井反転）
    if (bDoji && B.l > C.h && A.h < B.l) out.push({ name: '捨て子線(宵)', dir: '売り' });
  }

  return out;
}

// 極大（ピーク）/極小（トラフ）の位置を返す（前後 w 本より高い/低い）
function findExtrema_(vals, w, isPeak) {
  const idx = [];
  for (let i = w; i < vals.length - w; i++) {
    let ok = true;
    for (let k = i - w; k <= i + w; k++) {
      if (k === i) continue;
      if (isPeak ? vals[k] > vals[i] : vals[k] < vals[i]) { ok = false; break; }
    }
    if (ok) idx.push(i);
  }
  return idx;
}

// 三山(三尊天井=売り) / 三川(逆三尊=買い) を直近のピーク/トラフ3つで判定
function detectHeadShoulders_(bars, rsi) {
  const n = bars.length;
  const out = [];
  if (n < 25) return out;
  const highs = bars.map(b => b.h), lows = bars.map(b => b.l);
  const close = bars[n - 1].c;
  const W = 3, TOL = 0.05;  // 両肩の高さ許容差 5%

  // 三山(三尊天井): 直近ピーク3つ 左肩<頭>右肩、両肩が近い、ネックライン割れ
  const pk = findExtrema_(highs, W, true);
  if (pk.length >= 3) {
    const [a, b, c] = pk.slice(-3);
    const ha = highs[a], hb = highs[b], hc = highs[c];
    if (hb > ha && hb > hc && Math.abs(ha - hc) / hb < TOL) {
      const neck = Math.max(Math.min.apply(null, lows.slice(a, b + 1)),
                            Math.min.apply(null, lows.slice(b, c + 1)));
      if (close < neck) {
        out.push({ name: '三山(三尊天井)', dir: '売り' });
        if (rsi && rsi[c] != null && rsi[b] != null && rsi[c] < rsi[b])
          out.push({ name: 'RSIダイバージェンス(弱気)', dir: '売り' });
      }
    } else {
      // 単純三山(三点天井): 頭が突出せず3山がほぼ同値でネックライン割れ
      const mx = Math.max(ha, hb, hc), mn = Math.min(ha, hb, hc);
      if ((mx - mn) / mx < TOL) {
        const neck = Math.min.apply(null, lows.slice(a, c + 1));
        if (close < neck) out.push({ name: '三山(三点天井)', dir: '売り' });
      }
    }
  }
  // 三川(逆三尊): 直近トラフ3つ 左肩>頭<右肩、両肩が近い、ネックライン上抜け
  const tr = findExtrema_(lows, W, false);
  if (tr.length >= 3) {
    const [a, b, c] = tr.slice(-3);
    const la = lows[a], lb = lows[b], lc = lows[c];
    if (lb < la && lb < lc && Math.abs(la - lc) / Math.abs(lb || 1) < TOL) {
      const neck = Math.min(Math.max.apply(null, highs.slice(a, b + 1)),
                            Math.max.apply(null, highs.slice(b, c + 1)));
      if (close > neck) {
        out.push({ name: '三川(逆三尊)', dir: '買い' });
        if (rsi && rsi[c] != null && rsi[b] != null && rsi[c] > rsi[b])
          out.push({ name: 'RSIダイバージェンス(強気)', dir: '買い' });
      }
    }
  }
  return out;
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
    ['4. 「シグナル」シートに結果。SBI証券(日本株/信用)で保有中の銘柄は行を半透明赤でハイライト', 'p'],
    ['', 'p'],
    ['■ 自動実行（トリガー）', 'h'],
    ['メニュー「自動実行を設定（走査:平日16時/保有確認:毎時）」で以下の2つを設定します。', 'p'],
    ['① 全銘柄走査 … 平日16時に1回、全銘柄の株価を取得して酒田五法シグナルを走査（重い処理）', 'p'],
    ['② 購入ポートフォリオ確認 … 毎時、SBI保有銘柄をシグナルシート上で最新のハイライトに更新（株価取得はしない）', 'p'],
    ['   ※いずれも東証の立会対象（営業日9:00-17:00、土日祝・年末年始は除外）のときだけ実行', 'p'],
    ['', 'p'],
    ['■ 検出する酒田五法', 'h'],
    ['赤三兵 … 陽線3本の切り上げ（買い）', 'p'],
    ['三羽烏(黒三兵) … 陰線3本の切り下げ（売り）', 'p'],
    ['三空踏み上げ … 上の窓が3連続＝買われ過ぎ（売り）', 'p'],
    ['三空叩き込み … 下の窓が3連続＝売られ過ぎ（買い）', 'p'],
    ['上げ三法 … 長陽→値幅内の調整→上抜け陽線（買い・上昇継続）', 'p'],
    ['下げ三法 … 長陰→値幅内の調整→下抜け陰線（売り・下落継続）', 'p'],
    ['三山(三尊天井) … 中央が最高の3山でネックライン割れ（売り）', 'p'],
    ['三山(三点天井) … 頭が突出せず3山ほぼ同値でネックライン割れ（売り）', 'p'],
    ['三川(逆三尊) … 中央が最安の3谷でネックライン上抜け（買い）', 'p'],
    ['明けの明星 … 長大陰線→窓開けの星→陽線で中心回復（買い・底の転換）', 'p'],
    ['宵の明星 … 長大陽線→窓開けの星→陰線で中心割れ（売り・天井の転換）', 'p'],
    ['捨て子線 … 中央が同事線で両側に窓＝より強い反転（明け=買い/宵=売り）', 'p'],
    ['先詰まり赤三兵 … 赤三兵だが3本目失速・上ヒゲ長＝買われ過ぎ警戒（売り）', 'p'],
    ['上放れ二羽烏 … 上昇中に窓開け陰線2本、2本目が1本目を包む（売り）', 'p'],
    ['', 'p'],
    ['■ 三川系の2本足 反転パターン', 'h'],
    ['かぶせ線 … 大陽線の翌日、上放れも前日実体中心より下で引ける陰線（売り）', 'p'],
    ['切り込み線 … 大陰線の翌日、下放れも前日実体中心より上で引ける陽線（買い）', 'p'],
    ['包み線(抱き線) … 当日の実体が前日の実体を包む（強気=買い/弱気=売り）', 'p'],
    ['はらみ線 … 当日の小実体が前日の大実体に収まる（強気=買い/弱気=売り）', 'p'],
    ['毛抜き天井/底 … 高値/安値がほぼ同値で2本並ぶ（天井=売り/底=買い）', 'p'],
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
