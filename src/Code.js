// ============================================================================
//  酒田五法 シグナル・スクリーナー
//  ---------------------------------------------------------------------------
//  株価API（Yahoo Finance 日足）から多銘柄をスキャンし、酒田五法のシグナルが
//  点灯した銘柄を一覧化する。UI はスプレッドシートのみ（公開ページ・JSON出力は廃止）。
//  ※ 投資助言ではなく、シグナル抽出の補助ツール。
//  ※ シグナルの重みは静的（SIGNAL_WEIGHT_）。「パターン成績」の集計値は参考表示のみで
//    順位付けには使わない（統計的裏付けを欠くため。suggestWeight_ のコメント参照）。
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
  SHEETS: { UNIVERSE: '銘柄', SIGNALS: 'シグナル', USAGE: '使い方', STATS: 'パターン成績', HISTORY: 'シグナル履歴' },
  YAHOO_RANGE: '6mo',
  BATCH: 40,
  TIME_BUDGET_MS: 4.5 * 60 * 1000,
  // 信用需給フィルター（動画の閾値）。地合いと係数の単一ソース。MarketMacro.js が参照。
  MARGIN: { SELL_THRESHOLD_OKU: 8000, RATIO_PIVOT: 1.0, BUY_BOOST: 1.5, SELL_BOOST: 1.5 },
  // 流動性フィルター。売買代金が細い銘柄は、実際には取引が成立していない「気配だけの窓」で
  // 三空・捨て子線が点灯しやすく、しかも実際にはその値段で売買できない。
  // 直近 LIQ_DAYS 日の売買代金（終値×出来高）中央値が LIQ_MIN_TURNOVER 未満なら走査対象外。
  LIQ_DAYS: 20,
  LIQ_MIN_TURNOVER: 50 * 1000 * 1000,   // 5,000万円/日
  // 強さ★の絶対しきい値（重み合計×地合い係数のスコアに対して適用）。
  // 相対順位だと「全銘柄が弱い日でも上位1/3が必ず★★★になる」ため絶対値で切る。
  // 重みは1〜3（SIGNAL_WEIGHT_）なので、★★★=強いパターン1つ＋確認、★★=強いパターン1つ相当。
  STAR3: 5,
  STAR2: 3,
  // Yahoo が 429（レート制限）や 5xx を返したときの再試行回数と初回待ち時間（指数バックオフ）
  FETCH_RETRY: 2,
  FETCH_BACKOFF_MS: 1500,
  // 「大陽線/大陰線」とみなす実体の大きさ（直近平均実体の何倍か）。
  // 1.0（＝平均以上）だと半数が該当してしまうため、はっきり大きいものだけを拾う。
  BIG_BODY_MULT: 1.3,
  // 毛抜き天井/底で「ほぼ同値」とみなす許容幅（ATRの何倍か）
  TWEEZER_ATR: 0.15,
  // MACDのGC/DC判定に必要な最低バー数。EMA26は先頭値シードのため収束に時間がかかり、
  // 30本ではヒストグラムの符号が約12%の確率で誤る（60本で約1%、90本でほぼ0%）。
  MACD_MIN_BARS: 60,
  // 三山/三川の両肩の高さ許容差。5%は両肩の差として広く、形が崩れたものまで拾っていた。
  HS_TOL: 0.03,
  // 山と山の最低間隔（バー数）。隣接した極値の寄せ集めを「三山」と呼ばないため。
  HS_MIN_GAP: 4,
};

// 実績スコアリング設定（バックテスト学習・自動修正）
// バックテスト対象期間 = 過去6ヶ月（SK.YAHOO_RANGE '6mo'）
const BT_FORWARD     = 3;    // 先読み営業日数（発生から3営業日後の騰落率で的中/リターンを評価）
const BT_MIN_HISTORY = 30;   // シグナル検出に必要な最低バー数（三山/三川が25本必要）
const BT_MIN_SAMPLE  = 20;   // 実績を重みに採用する最低件数（未満は静的重みで代替）

// ---- メニュー ----
function onOpen() {
  SpreadsheetApp.getUi().createMenu('酒田五法')
    .addItem('セットアップ', 'setup')
    .addSeparator()
    .addItem('プライム銘柄を取得（J-Quants）', 'fetchPrimeUniverse')
    .addItem('シグナル走査/続行',            'scanSignals')
    .addItem('パターン成績を集計（参考値・順位には未使用）', 'backtestWeights')
    .addItem('相場マクロ/急落サインを更新', 'updateMarketMacro')
    .addItem('自動実行を設定（走査:平日18時/保有確認:毎時）', 'installDailyScanTrigger')
    .addSeparator()
    .addItem('使い方シートを作成/更新',      'createUsageSheet')
    .addItem('走査の進捗リセット',           'resetScanQueue')
    .addToUi();
}

/**
 * 取り返しのつかない操作の前に確認を取る。
 * トリガー起動では getUi() が使えないため、その場合は確認を求めず続行する
 * （定期実行の妨げにしない）。
 * @return {boolean} 続行してよければ true
 */
function confirmDestructive_(title, message) {
  let ui;
  try { ui = SpreadsheetApp.getUi(); } catch (e) { return true; }   // トリガー実行時
  const res = ui.alert(title, message, ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) {
    try { SpreadsheetApp.getActive().toast('操作をキャンセルしました', '酒田五法', 4); } catch (_) {}
    return false;
  }
  return true;
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
  // 相場マクロ・急落サインもここで作る。以前はセットアップ対象外だったため、
  // 初回は「相場マクロ/急落サインを更新」を実行するまでシート自体が存在しなかった。
  try { setupMacroSheets_(); } catch (e) { Logger.log('相場マクロシートの作成に失敗: ' + e.message); }
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
  // この処理は「銘柄」シートを全消去して入れ替える。手入力した銘柄リストが
  // 無警告で消えていたため、実行前に確認する。
  const uniNow = SpreadsheetApp.getActive().getSheetByName(SK.SHEETS.UNIVERSE);
  const cur = uniNow ? Math.max(uniNow.getLastRow() - 1, 0) : 0;
  if (!confirmDestructive_('プライム銘柄を取得',
      '「銘柄」シートの内容（現在 ' + cur + '件）をすべて置き換えます。\n手入力した銘柄も消えます。続行しますか？')) return;

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

// to4_() の本体は共通モジュール StockCode.js（gas-shared/modules/StockCode.js の symlink）

// ============================================================================
//  シグナル走査（時間分割・自動再開）
// ============================================================================
function scanSignals() {
  // 自動再開トリガーと手動実行が重なった場合の二重追記を防ぐ（多重実行排他）
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    // 以前はログだけで黙って return しており、定期走査が再開処理とぶつかると
    // その日の走査が実行されないまま気づかれなかった。次回に持ち越す。
    Logger.log('別の走査が進行中のためスキップ（90秒後に再試行）');
    clearResumeTriggers_();
    ScriptApp.newTrigger('scanSignals').timeBased().after(90 * 1000).create();
    return;
  }

  const ss  = SpreadsheetApp.getActive();
  const uni = ss.getSheetByName(SK.SHEETS.UNIVERSE);
  const sig = ss.getSheetByName(SK.SHEETS.SIGNALS);
  if (!uni || uni.getLastRow() < 2) throw new Error('「銘柄」シートにコードを入れてください');

  // 進捗は「銘柄シートの何行目まで処理したか」だけを持つ。
  // 以前はキュー配列そのものをJSONでScriptPropertiesに保存していたが、
  // プライム約1600銘柄では30KBを超え、1値あたり9KBの上限で setProperty が例外になり、
  // 走査が中断したうえ自動再開もできなくなっていた。カーソルなら数バイトで済む。
  const props = PropertiesService.getScriptProperties();
  const universe = uni.getRange(2, 1, uni.getLastRow() - 1, 2).getValues()
    .filter(r => r[0]).map(r => [String(r[0]).trim(), r[1] || '']);
  const total = universe.length;
  let cursor = Number(props.getProperty('SK_CURSOR') || 0);
  let failed = Number(props.getProperty('SK_FAILED') || 0);

  if (!cursor) {
    // 新規走査はシグナルシートを消して作り直す。前回の結果を見ている最中に
    // 誤って実行すると消えてしまうため、既存結果があるときだけ確認する。
    if (sig.getLastRow() > 1 && !confirmDestructive_('シグナル走査',
        '現在の「シグナル」シートの結果（' + (sig.getLastRow() - 1) + '件）を消して、'
        + total + '銘柄を新たに走査します。続行しますか？\n'
        + '（中断した走査を再開したい場合は「いいえ」を選び、そのまま再実行してください）')) {
      lock.releaseLock();
      return;
    }
    const oldFilter = sig.getFilter(); if (oldFilter) oldFilter.remove();
    sig.clear();
    sig.getRange(1, 1, 1, 10).setValues([['保有', '強さ', '日付', 'コード', '銘柄名', '終値', '方向', 'シグナル', 'シグナル解説', '信用倍率']]);
    failed = 0;
  }

  const start = Date.now();
  while (cursor < total) {
    if (Date.now() - start > SK.TIME_BUDGET_MS) break;
    const slice = universe.slice(cursor, cursor + SK.BATCH);
    const reqs = slice.map(([code]) => ({
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(code) +
           '.T?range=' + SK.YAHOO_RANGE + '&interval=1d',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      muteHttpExceptions: true,
    }));
    const resps = fetchAllWithRetry_(reqs);
    if (!resps) break;   // ネットワークごと落ちている。カーソルは進めず次回に持ち越す。

    const buffer = [];
    resps.forEach((res, i) => {
      const [code, name] = slice[i];
      if (!res || res.getResponseCode() !== 200) { failed++; return; }  // 取得失敗を数える
      const bars = parseYahooBars_(res);
      if (bars.length < 5) return;
      if (!isLiquidEnough_(bars)) return;   // 薄商い銘柄は気配だけの窓を拾うため除外
      const signals = detectSakata_(bars);
      if (signals.length === 0) return;
      const last = bars[bars.length - 1];
      const dirs = new Set(signals.map(s => s.dir));
      const dir  = dirs.size > 1 ? '混在' : [...dirs][0];
      const names = signals.map(s => s.name);
      buffer.push([
        '', '',   // 保有・強さ は finalizeSignals_ で埋める
        Utilities.formatDate(new Date(last.t * 1000), 'JST', 'yyyy/MM/dd'),
        code, name, last.c, dir, names.map(s => '・' + s).join('\n'), signalExplain_(names),
      ]);
    });

    // バッチごとに「書き込み → カーソル確定」の順で確定させる。
    // 以前は全バッチ終了後にまとめて書いていたため、最後のバッチ中に6分制限で強制終了すると
    // 未書込のbufferと処理済みの分がまとめて失われ、再実行で重複追記が起きていた。
    if (buffer.length) sig.getRange(sig.getLastRow() + 1, 1, buffer.length, 9).setValues(buffer);
    cursor += slice.length;
    props.setProperty('SK_CURSOR', String(cursor));
    props.setProperty('SK_FAILED', String(failed));
    writeScanStatus_(sig, cursor, total, failed);
    Utilities.sleep(200);
  }

  clearResumeTriggers_();
  if (cursor < total) {
    ScriptApp.newTrigger('scanSignals').timeBased().after(90 * 1000).create();
    Logger.log('一時停止: ' + cursor + '/' + total + '銘柄。90秒後に自動再開。');
    ss.toast(cursor + '/' + total + '銘柄まで完了。90秒後に自動再開します', '酒田五法', 8);
  } else {
    props.deleteProperty('SK_CURSOR');
    props.deleteProperty('SK_FAILED');
    finalizeSignals_(sig);
    const hit = Math.max(sig.getLastRow() - 1, 0);
    writeScanStatus_(sig, total, total, failed);
    Logger.log('走査完了: シグナル ' + hit + '件 / 取得失敗 ' + failed + '件');
    // 取得失敗は「シグナル0件」と紛らわしいので必ず件数を出す。
    ss.toast('走査完了: ' + hit + '件のシグナル'
      + (failed ? '（' + failed + '銘柄は取得できず未判定）' : ''), '酒田五法', 8);
  }
}

/**
 * Yahoo へのバッチ取得。429/503 は一時的なことが多いので、失敗分だけ指数バックオフで再試行する。
 * 以前は非200を黙って捨てていたため「シグナル0件」と「取得失敗」が区別できなかった。
 * 戻り値は reqs と同じ並びのレスポンス配列。ネットワークごと落ちている場合のみ null。
 */
function fetchAllWithRetry_(reqs) {
  let resps;
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { Logger.log('fetchAll失敗: ' + e.message); return null; }

  for (let attempt = 1; attempt <= SK.FETCH_RETRY; attempt++) {
    // 再試行する価値のあるもの（429 レート制限 / 5xx 一時障害）だけ拾う
    const retryIdx = [];
    resps.forEach((r, i) => {
      const c = r ? r.getResponseCode() : 0;
      if (c === 429 || c >= 500) retryIdx.push(i);
    });
    if (!retryIdx.length) break;
    Utilities.sleep(SK.FETCH_BACKOFF_MS * Math.pow(2, attempt - 1));
    let again;
    try { again = UrlFetchApp.fetchAll(retryIdx.map(i => reqs[i])); }
    catch (e) { Logger.log('再試行失敗: ' + e.message); break; }
    retryIdx.forEach((origIdx, k) => { resps[origIdx] = again[k]; });
  }
  return resps;
}

/**
 * 走査の進捗をシグナルシート右上に常設表示する。
 * トーストは5〜8秒で消え、90秒の再開待ちの間は何も出ないため「今どうなっているのか」が
 * 分からなかった。シートに書けば、開き直しても状態が見える。
 */
function writeScanStatus_(sig, done, total, failed) {
  try {
    const finished = done >= total;
    const stamp = Utilities.formatDate(new Date(), 'JST', 'MM/dd HH:mm');
    const msg = finished
      ? '走査完了 ' + stamp + '時点（' + total + '銘柄' + (failed ? ' / 取得失敗' + failed + '件' : '') + '）'
      : '走査中 ' + done + '/' + total + '（' + Math.floor(done / total * 100) + '%）'
        + (failed ? ' / 取得失敗' + failed + '件' : '') + ' … 最終更新 ' + stamp;
    sig.getRange(1, 11).setValue(msg)
      .setFontColor(finished ? '#1a7f37' : '#b26a00').setFontWeight('bold');
  } catch (e) { /* 進捗表示は失敗しても走査自体は続ける */ }
}

function resetScanQueue() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('SK_CURSOR');
  props.deleteProperty('SK_FAILED');
  props.deleteProperty('SK_QUEUE');   // 旧方式の残骸があれば併せて掃除
  clearResumeTriggers_();
  SpreadsheetApp.getActive().toast('走査の進捗をリセットしました', '酒田五法', 5);
}

function clearResumeTriggers_() {
  clearTriggersFor_('scanSignals');   // 共通モジュール TriggerUtils.js
}

// ---- 定期実行（平日18時・土日祝／年末年始はスキップ） ----
function installDailyScanTrigger() {
  // 既存トリガーを消してから作り直すため、実行中の走査があると止まる
  const existing = ScriptApp.getProjectTriggers().length;
  if (existing && !confirmDestructive_('自動実行を設定',
      '既存のトリガー（' + existing + '件）をすべて削除して設定し直します。\n'
      + '中断中の走査があれば、その自動再開も取り消されます。続行しますか？')) return;

  // 定期トリガーに加え、走査/集計の「自動再開」トリガーも掃除する。
  // 以前は再開トリガーが対象外で、中断状態のまま残った再開トリガーが後から発火していた。
  clearTriggersFor_(['scheduledScan', 'scheduledHeldCheck', 'scheduledBacktest', 'updateMarketMacro',
                     'scanSignals', 'backtestWeights']);   // 共通モジュール TriggerUtils.js
  ScriptApp.newTrigger('updateMarketMacro').timeBased().everyDays(1).atHour(17).create();    // 相場マクロ/急落サイン・地合い更新（走査の前）
  ScriptApp.newTrigger('scheduledScan').timeBased().everyDays(1).atHour(18).create();       // 全銘柄 株価取得＋走査（1日1回）
  ScriptApp.newTrigger('scheduledHeldCheck').timeBased().everyHours(1).create();            // 購入ポートフォリオ確認（毎時）
  // 月次の自動学習トリガーは設定しない。集計結果を順位付けに使わなくなったため、
  // 全銘柄分のYahoo取得を毎月自動で走らせる必要がない（必要ならメニューから手動実行する）。
  SpreadsheetApp.getActive().toast('自動実行を設定しました（走査:平日18時 / 保有確認:毎時）', '酒田五法', 6);
  Logger.log('トリガー設定: scheduledScan(平日18時) / scheduledHeldCheck(毎時) / updateMarketMacro(17時)');
}

// 平日18時に発火。全銘柄の株価取得＋シグナル走査（重い処理・1日1回）。
// 引け後にYahoo日足の当日終値が確定するのを待つため18時。立会時間外なので営業日判定(isBusinessDay_)のみ。
// isBusinessDay_() は共通モジュール MarketCalendar.js で定義。
function scheduledScan() {
  const now = new Date();
  if (!isBusinessDay_(now)) { Logger.log('休場日のため走査をスキップ: ' + now); return; }
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

// 列構成: 1保有 2強さ 3日付 4コード 5銘柄名 6終値 7方向 8シグナル 9解説
function finalizeSignals_(sig) {
  if (sig.getLastRow() < 2) return;
  const n = sig.getLastRow() - 1;

  // 「傾向が強い順」に並べ替え（8列目=シグナル箇条書き）。重みは静的（SIGNAL_WEIGHT_）。
  const regime = getMarketRegime_();   // 信用需給の地合い（MarketMacro.js）。買い/売りスコアに反映。
  const data = sig.getRange(2, 1, n, 9).getValues();
  // 強さ = 静的重み合計 × 地合い係数（row[6]=方向 買い/売り。地合いで順位が動く）
  const scoreOf = row => signalStrength_(row[7]) * regimeFactor_(regime, row[6]);
  data.sort((a, b) => scoreOf(b) - scoreOf(a));

  // 強さ★は絶対しきい値で付与する。以前は相対順位（上位1/3=★★★）だったため、
  // 全銘柄が弱いシグナルしか出ていない日でも必ず★★★が並び、強さを誤認させていた。
  const scores = data.map(scoreOf);
  data.forEach((row, i) => {
    const s = scores[i];
    row[1] = s >= SK.STAR3 ? '★★★' : s >= SK.STAR2 ? '★★' : '★';    // 方向(7列目)を矢印付きバッジに整形
    const d = String(row[6] || '');
    row[6] = d === '買い' ? '▲ 買い' : d === '売り' ? '▼ 売り' : d === '混在' ? '◆ 混在' : d;
  });
  sig.getRange(2, 1, n, 9).setValues(data);

  // 信用倍率(合計)を Yahoo Finance Japan から結合（10列目）。点灯銘柄のみ取得。取得不可は空欄。
  const marginMap = fetchYahooJpMarginRatios_(data.map(row => row[3]));
  sig.getRange(2, 10, n, 1).setValues(data.map(row => {
    const c = to4_(String(row[3] || '').trim());
    return [marginMap[c] != null ? marginMap[c] : ''];
  }));
  sig.setColumnWidth(10, 96);
  sig.getRange(2, 10, n, 1).setNumberFormat('0.00').setHorizontalAlignment('center').setVerticalAlignment('middle');

  // コード(4列目)を TradingView 日足チャートへのハイパーリンクに。
  // 個人のチャートレイアウトIDはスクリプトプロパティ TRADINGVIEW_LAYOUT_ID で差し替えられる。
  // 未設定ならレイアウト指定なしの汎用チャートを開く。
  const TV = PropertiesService.getScriptProperties().getProperty('TRADINGVIEW_LAYOUT_ID') || '';
  const tvUrl = code => TV
    ? `https://jp.tradingview.com/chart/${TV}/?symbol=TSE:${code}&interval=D`
    : `https://jp.tradingview.com/chart/?symbol=TSE:${code}&interval=D`;
  sig.getRange(2, 4, n, 1).setFormulas(data.map(row => {
    const code = to4_(String(row[3] || '').trim()).toUpperCase();
    return [code ? `=HYPERLINK("${tvUrl(code)}","${code}")` : ''];
  }));

  // 全体スタイル: 濃紺ヘッダ＋淡色の行帯＋ヘッダ固定
  styleSheet_(sig, 10, '#141a33', '#eef1fb');
  autoFit_(sig, 7);                                          // 保有〜方向まで内容にフィット
  sig.setColumnWidth(8, 210);                                // シグナル（箇条書き・折返し）
  sig.getRange(2, 8, n, 1).setWrap(true).setVerticalAlignment('top');
  sig.setColumnWidth(9, 460);                                // 解説（折返し）
  sig.getRange(2, 9, n, 1).setWrap(true).setVerticalAlignment('top');

  sig.getRange(2, 6, n, 1).setNumberFormat('#,##0');         // 終値カンマ
  sig.getRange(2, 4, n, 1).setHorizontalAlignment('right');  // コード右寄せ
  sig.getRange(2, 1, n, 2).setHorizontalAlignment('center').setVerticalAlignment('middle'); // 保有・強さ
  sig.getRange(2, 7, n, 1).setHorizontalAlignment('center').setVerticalAlignment('middle'); // 方向
  sig.getRange(2, 2, n, 1).setFontColor('#e8a200').setFontWeight('bold');                    // 強さ=金

  // 明示背景をいったんリセット（売却済み銘柄のハイライトを残さないため）
  sig.getRange(2, 1, n, 10).setBackground(null);

  // 保有銘柄: 保有列に○を立てる（行のハイライトは条件付き書式が○を見て行う）
  try {
    const held = getSbiHeldCodes_();
    const marks = [];
    for (let i = 0; i < n; i++) {
      const code = to4_(String(data[i][3] || '').trim()).toUpperCase();
      marks.push([held.has(code) ? '○' : '']);
    }
    sig.getRange(2, 1, n, 1).setValues(marks).setFontColor('#c0392b').setFontWeight('bold');
  } catch (e) {
    // 参照元スプレッドシートの権限切れ等で落ちることがある。以前はログのみで、
    // ハイライトが消えた理由が利用者に伝わらなかった。
    Logger.log('SBI保有ハイライト失敗: ' + e.message);
    SpreadsheetApp.getActive().toast('保有銘柄のハイライトを取得できませんでした: ' + e.message, '酒田五法', 8);
  }

  // 方向・保有の色分けは条件付き書式で持たせる。
  // 直接 setBackground で塗ると、利用者がフィルタで並べ替えたときに色だけ元の行位置に
  // residual として残り、方向と色がずれて見える。条件付き書式なら値に追従する。
  applySignalFormatRules_(sig, n);

  // フィルタを張り直し（保有=○ で絞り込み可能に）
  const old = sig.getFilter(); if (old) old.remove();
  sig.getRange(1, 1, n + 1, 10).createFilter();
  sig.setTabColor('#e0567a');
}

/**
 * シグナルシートの色分けを条件付き書式で設定する（値に追従するので並べ替えに強い）。
 * 方向列: 買い=緑 / 売り=赤 / 混在=橙、保有行: 淡赤。
 */
function applySignalFormatRules_(sig, n) {
  const dir = sig.getRange(2, 7, n, 1);
  const all = sig.getRange(2, 1, n, 10);
  const textRule = (range, text, bg, fc) =>
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains(text).setBackground(bg).setFontColor(fc).setBold(true)
      .setRanges([range]).build();
  // 保有行は A列が「○」かどうかで行全体を塗る（$A で列を固定した数式）
  const heldRule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$A2="○"').setBackground('#fbe3e3')
    .setRanges([all]).build();

  sig.setConditionalFormatRules([
    heldRule,   // 先に行全体、あとから方向セルが上書きする
    textRule(dir, '買い', '#e3f5ea', '#1b7a3d'),
    textRule(dir, '売り', '#fce4e4', '#c0392b'),
    textRule(dir, '混在', '#fff3da', '#b8860b'),
  ]);
}

// SBI証券の保有銘柄コードを参照元スプレッドシート（Asset_Status）から収集する。
// 「SBI証券（日本株）」「SBI証券（日本株信用）」の「銘柄コード」列から4桁の証券コードを抽出。
function getSbiHeldCodes_() {
  // 参照先スプレッドシートIDはスクリプトプロパティ ASSET_STATUS_SS_ID に置く。
  // 個人の資産管理シートのIDを公開リポジトリのソースに直接書かないため。
  // 未設定なら保有ハイライトを行わない（機能を止めるだけで走査自体は続行する）。
  const SBI_SS_ID = PropertiesService.getScriptProperties().getProperty('ASSET_STATUS_SS_ID');
  const SHEET_NAMES = ['SBI証券（日本株）', 'SBI証券（日本株信用）'];
  const CODE_RE = /^[0-9][0-9A-Z]{3}$/;                            // 4桁の証券コード（例 7203 / 130A）
  const set = new Set();
  if (!SBI_SS_ID) {
    Logger.log('ASSET_STATUS_SS_ID が未設定のため保有ハイライトをスキップ');
    return set;
  }
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
// 1日の秒数。欠損日をまたいだ足かどうかの判定に使う。
const ONE_DAY_SEC_ = 24 * 60 * 60;
// 前の足からこの日数を超えて空いていたら「連続していない足」とみなし、窓（三空等）の判定に使わない。
// 3連休＋臨時休場を吸収できる幅にしている。
const MAX_BAR_GAP_DAYS_ = 5;

/**
 * Yahoo 日足レスポンスを bars 配列へ。
 *
 * 分割・配当調整：Yahoo は生値(quote)と調整後終値(adjclose)の両方を返す。生値のままだと
 * 株式分割日に巨大な窓が開き、三空叩き込みや明けの明星が誤点灯する（日本株は分割が多い）。
 * adjclose/close の比率を OHLC 全体に掛けて調整済み系列にする。adjclose が無い場合のみ
 * 生値へフォールバックする。
 *
 * 出来高：quote[0].volume は元から応答に含まれている。以前は読んでいなかったため
 * 「日足barsに出来高が無い」とされていたが、実際は取得できる。流動性フィルタで使う。
 *
 * 連続性：null 足を単に読み飛ばすと、欠損日をまたいだ足が隣接して実在しないギャップが
 * できる。前の足との日数差を見て cont（連続しているか）を持たせ、窓判定側で参照する。
 */
function parseYahooBars_(res) {
  try {
    if (res.getResponseCode() !== 200) return [];
    const r = JSON.parse(res.getContentText()).chart.result[0];
    const ts = r.timestamp, q = r.indicators.quote[0];
    const adj = (r.indicators.adjclose && r.indicators.adjclose[0])
      ? r.indicators.adjclose[0].adjclose : null;
    const bars = [];
    let prevT = null;
    for (let i = 0; i < ts.length; i++) {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if (o == null || h == null || l == null || c == null || !(c > 0)) continue;
      // 調整係数（adjclose/close）。欠損・異常値のときは 1（＝生値のまま）。
      const a = (adj && adj[i] != null && adj[i] > 0) ? adj[i] / c : 1;
      const v = (q.volume && q.volume[i] != null) ? q.volume[i] : null;
      const t = ts[i];
      const cont = (prevT == null) ? false : ((t - prevT) <= MAX_BAR_GAP_DAYS_ * ONE_DAY_SEC_);
      bars.push({ o: o * a, h: h * a, l: l * a, c: c * a, v, t, cont });
      prevT = t;
    }
    return bars;
  } catch (e) { return []; }
}

/**
 * 直近の平均実体。判定対象のバー自身を基準に含めると「平均より大きい」が自己言及になり、
 * さらに基準が単純平均なので約半数が「大陽線」と判定されていた。
 * 末尾 exclude 本（＝いま判定しているバー）を除いた区間で測る。
 */
function avgBody_(bars, lookback, exclude) {
  const end = Math.max(0, bars.length - exclude);
  const start = Math.max(0, end - lookback);
  let sum = 0, cnt = 0;
  for (let i = start; i < end; i++) { sum += Math.abs(bars[i].c - bars[i].o); cnt++; }
  return cnt ? sum / cnt : 0;
}

/**
 * 平均トゥルーレンジ（ATR）。末尾 exclude 本を除いた区間で測る。
 * 「ほぼ同値」の判定を固定％にすると、値がさ株では常に成立し低位株では永久に成立しない。
 * 値動きの実寸を基準にするため ATR を使う。
 */
function atr_(bars, lookback, exclude) {
  const end = Math.max(0, bars.length - exclude);
  const start = Math.max(1, end - lookback);
  let sum = 0, cnt = 0;
  for (let i = start; i < end; i++) {
    const p = bars[i - 1], b = bars[i];
    sum += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

/**
 * 直近の売買代金（終値×出来高）の中央値。出来高が取れない銘柄は null。
 * 平均でなく中央値を使うのは、1日だけの大口約定で薄商いの銘柄が通過するのを避けるため。
 */
function medianTurnover_(bars, days) {
  const tail = bars.slice(-days).filter(b => b.v != null && b.v > 0);
  if (!tail.length) return null;
  const vals = tail.map(b => b.c * b.v).sort((x, y) => x - y);
  const m = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
}

// 走査対象とするだけの流動性があるか。出来高が取得できない場合は従来どおり通す（判定不能で落とさない）。
function isLiquidEnough_(bars) {
  const t = medianTurnover_(bars, SK.LIQ_DAYS);
  return (t == null) ? true : t >= SK.LIQ_MIN_TURNOVER;
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
  'MACDゴールデンクロス': 'MACDがシグナル線を下から上抜け。上昇転換のサイン（買い）。',
  'MACDデッドクロス':     'MACDがシグナル線を上から下抜け。下落転換のサイン（売り）。',
};
// シグナルの強さ重み（「傾向が強い順」の並べ替えに使用）。大きいほど強いフォーメーション。
const SIGNAL_WEIGHT_ = {
  '三山(三尊天井)': 3, '三川(逆三尊)': 3, '三山(三点天井)': 3,
  '三空踏み上げ': 3, '三空叩き込み': 3,
  '明けの明星': 3, '宵の明星': 3, '捨て子線(明け)': 3, '捨て子線(宵)': 3, '上放れ二羽烏': 3,
  '赤三兵': 2, '三羽烏(黒三兵)': 2, '上げ三法': 2, '下げ三法': 2,
  '包み線(強気)': 2, '包み線(弱気)': 2, 'かぶせ線': 2, '切り込み線': 2,
  'はらみ線(強気)': 1, 'はらみ線(弱気)': 1, '毛抜き天井': 1, '毛抜き底': 1, '先詰まり赤三兵(警戒)': 1,
  'RSI過熱(80超)': 1, 'RSI底値(20割れ)': 1, 'RSIダイバージェンス(弱気)': 1, 'RSIダイバージェンス(強気)': 1,
  'MACDゴールデンクロス': 2, 'MACDデッドクロス': 2,
};

// 各パターンの方向（実績集計・履歴記録に使用）
const SIGNAL_DIR_ = {
  '赤三兵': '買い', '三空叩き込み': '買い', '上げ三法': '買い', '三川(逆三尊)': '買い',
  '明けの明星': '買い', '捨て子線(明け)': '買い', '切り込み線': '買い', '包み線(強気)': '買い',
  'はらみ線(強気)': '買い', '毛抜き底': '買い', 'RSI底値(20割れ)': '買い', 'RSIダイバージェンス(強気)': '買い',
  '三羽烏(黒三兵)': '売り', '三空踏み上げ': '売り', '下げ三法': '売り', '三山(三尊天井)': '売り',
  '三山(三点天井)': '売り', '宵の明星': '売り', '捨て子線(宵)': '売り', 'かぶせ線': '売り',
  '包み線(弱気)': '売り', 'はらみ線(弱気)': '売り', '毛抜き天井': '売り', '先詰まり赤三兵(警戒)': '売り',
  '上放れ二羽烏': '売り', 'RSI過熱(80超)': '売り', 'RSIダイバージェンス(弱気)': '売り',
  'MACDゴールデンクロス': '買い', 'MACDデッドクロス': '売り',
};

// パターン別の評価ホライズン（先読み営業日数）。
// 形成に数週間かかる中期系（大底/天井・トレンド継続）は20日、それ以外の短期系は既定 BT_FORWARD(3日)。
const SIGNAL_HORIZON_ = {
  '三山(三尊天井)': 20, '三山(三点天井)': 20, '三川(逆三尊)': 20, '上げ三法': 20, '下げ三法': 20,
};
function signalHorizon_(name) { return SIGNAL_HORIZON_[name] || BT_FORWARD; }

// 箇条書きのシグナル列テキストからシグナル名配列を取り出す
function parseSignalNames_(cellText) {
  return String(cellText || '').split('\n').map(s => s.replace(/^・/, '').trim()).filter(Boolean);
}

/**
 * 成績シートに出す「参考重み」。**順位付けには使わない**（下の patternPoints_ を参照）。
 *
 * 以前はこの値をそのままスコアに使っていたが、次の理由で統計的な裏付けを欠くため取りやめた：
 *  - 評価が生の騰落率のみで、ベンチマーク（日経平均等）を控除していない。上昇相場では
 *    買いパターンが軒並み高勝率と出るだけで、パターン固有の優位性を測れていない。
 *  - BT_MIN_SAMPLE=20 に対し勝率60%/50%で3段階に切っているが、n=20 の勝率の標準誤差は
 *    約11ptあり、60%と50%は統計的に区別できない。有意性検定も行っていない。
 *  - 連日判定のため同一シグナルが複数日に重複計上され、実効サンプル数が水増しされている。
 *  - 約定を当日終値と仮定しているが、走査は18時（終値確定後）なので実際には翌日寄付。
 *    手数料・スプレッドも未考慮。
 * 集計値そのものは傾向を眺める材料として残すが、スコアには反映しない。
 */
function suggestWeight_(name, n, wins) {
  if (!n || n < BT_MIN_SAMPLE) return SIGNAL_WEIGHT_[name] || 1;
  const win = wins / n * 100;
  return win >= 60 ? 3 : win >= 50 ? 2 : 1;
}

// パターン1つの点数 = 静的重み（SIGNAL_WEIGHT_）。
// バックテストの学習結果は上記の理由により順位付けへ反映しない。
function patternPoints_(name) {
  return SIGNAL_WEIGHT_[name] || 1;
}

// 傾向の強さ = 各シグナルの静的重みの合計
function signalStrength_(cellText) {
  return parseSignalNames_(cellText).reduce((sum, name) => sum + patternPoints_(name), 0);
}

function signalExplain_(names) {
  return names.map(n => '・' + n + '：' + (SIGNAL_DESC_[n] || '')).join('\n');
}

// RSI(14) 系列（close値のみで計算）。HTML版スクリーナーの現代版フィルターを移植。
/**
 * RSI(Wilder) 系列。
 *
 * 旧実装は、シード時点の g/l に「合計」を入れたまま再帰 g=(g*(p-1)+up)/p に渡していた。
 * 再帰の第2項 up は等倍なので、古い項（p倍のまま）と新しい項（等倍）でスケールが混ざる。
 * g/l の比を取るため破綻はしないが収束が非常に遅く、標準RSIとの乖離は bar30 で最大約34pt、
 * bar90 で約3.5pt、bar124 でようやく0.3pt程度まで縮む。実運用スキャン（6mo≒124本）の
 * 末尾はほぼ正しかったが、バックテストは30本目から評価するため誤差の大きい区間を集計していた。
 * シードを合計から平均へ直し、正しいWilder平滑化（α=1/p）にする。
 */
function rsiSeries_(closes, p) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = Math.max(ch, 0), dn = Math.max(-ch, 0);
    if (i <= p) {
      g += up; l += dn;
      if (i === p) { g /= p; l /= p; out[i] = rsiFrom_(g, l); }   // 合計→平均にしてシード
    } else {
      g = (g * (p - 1) + up) / p;
      l = (l * (p - 1) + dn) / p;
      out[i] = rsiFrom_(g, l);
    }
  }
  return out;
}

// 平均上昇幅・平均下落幅から RSI を求める。
// 値動きが全く無い（上げも下げもゼロ）区間は方向感が無いので中立50を返す。
// 旧実装は l===0 で一律100を返していたため、完全フラットな系列に「RSI過熱(80超)」が誤点灯していた。
function rsiFrom_(g, l) {
  if (l === 0) return (g === 0) ? 50 : 100;
  return 100 - 100 / (1 + g / l);
}

// MACD(12,26,9) 系列。close値のみ。EMA は逐次計算（pandas ewm(adjust=False) 相当：
// 先頭値をシードにする）。戻り値 { macd:[], signal:[] }（長さ = closes.length）。
function macdSeries_(closes, fast, slow, signalP) {
  fast = fast || 12; slow = slow || 26; signalP = signalP || 9;
  const ema = (arr, p) => {
    const k = 2 / (p + 1);
    const out = new Array(arr.length);
    let prev = null;
    for (let i = 0; i < arr.length; i++) {
      prev = (prev == null) ? arr[i] : arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  };
  const ef = ema(closes, fast), es = ema(closes, slow);
  const macd   = closes.map((_, i) => ef[i] - es[i]);
  const signal = ema(macd, signalP);
  return { macd, signal };
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
  // 窓（空）は「隣り合う営業日の間に空いた値幅」でなければ意味がない。データ欠損で日付が
  // 飛んでいる箇所を窓と誤認しないよう、連続していない足を含む区間では窓判定を行わない。
  // cont は parseYahooBars_ が付ける（前の足との日数差が MAX_BAR_GAP_DAYS_ 以内なら true）。
  const contiguous = (...bs) => bs.every(b => b.cont !== false);
  const rsi  = rsiSeries_(bars.map(b => b.c), 14);  // 現代版フィルター（RSI補強）
  const rNow = rsi[n - 1];

  // 赤三兵: 直近3本が陽線・終値切り上げ・始値切り上げ（上昇転換/継続）
  if (bull(A) && bull(B) && bull(C) && A.c > B.c && B.c > C.c && A.o > B.o && B.o > C.o) {
    // 先詰まり赤三兵: 3本目の実体が縮み上ヒゲが長い＝失速・買われ過ぎ警戒（売り）。
    // これは赤三兵の一形態であって、同時に「買い」と「売り」が成立するわけではない。
    // 以前は両方を積んでいたため行が「混在」になり、地合い係数(regimeFactor_)も
    // 1倍のまま無効化されて順位に反映されなくなっていた。失速形なら売りだけを採る。
    const bodyA = A.c - A.o, upWickA = A.h - A.c;
    if (bodyA < (B.c - B.o) && upWickA > bodyA) sig.push({ name: '先詰まり赤三兵(警戒)', dir: '売り' });
    else sig.push({ name: '赤三兵', dir: '買い' });
  }

  // 三羽烏(黒三兵): 直近3本が陰線・終値切り下げ・始値切り下げ（下落転換/継続）
  if (bear(A) && bear(B) && bear(C) && A.c < B.c && B.c < C.c && A.o < B.o && B.o < C.o)
    sig.push({ name: '三羽烏(黒三兵)', dir: '売り' });

  // 三空踏み上げ: 直近3つの窓が上向き（買われ過ぎ→反落）＋ RSI80超で過熱を補強
  if (contiguous(A, B, C) && A.l > B.h && B.l > C.h && C.l > D.h) {
    sig.push({ name: '三空踏み上げ', dir: '売り' });
    if (rNow != null && rNow >= 80) sig.push({ name: 'RSI過熱(80超)', dir: '売り' });
  }

  // 三空叩き込み: 直近3つの窓が下向き（売られ過ぎ→反発）＋ RSI20割れで底値を補強
  if (contiguous(A, B, C) && A.h < B.l && B.h < C.l && C.h < D.l) {
    sig.push({ name: '三空叩き込み', dir: '買い' });
    if (rNow != null && rNow <= 20) sig.push({ name: 'RSI底値(20割れ)', dir: '買い' });
  }

  // 上げ三法: E長陽 → D,C,B が E の値幅内で調整 → A が E 高値を上抜けの陽線（上昇継続）
  // 下げ三法: E長陰 → D,C,B が E の値幅内 → A が E 安値を下抜けの陰線（下落継続）
  // 起点Eは「長い」陽線/陰線であることが定義だが、以前は bull(E)/bear(E) しか見ておらず、
  // 単に5本のインサイド調整であれば点灯していた（READMEの説明とも食い違っていた）。
  const avgBodyE = avgBody_(bars, 10, 5);
  const eBig = avgBodyE > 0 && Math.abs(E.c - E.o) >= avgBodyE * SK.BIG_BODY_MULT;
  if (eBig && bull(E) && [D, C, B].every(x => x.h <= E.h && x.l >= E.l) && bull(A) && A.c > E.h)
    sig.push({ name: '上げ三法', dir: '買い' });

  if (eBig && bear(E) && [D, C, B].every(x => x.h <= E.h && x.l >= E.l) && bear(A) && A.c < E.l)
    sig.push({ name: '下げ三法', dir: '売り' });

  // 上放れ二羽烏: C陽線 → 窓を開けて陰線B → 陰線Aが陰線Bを包むが窓は埋めない（天井・売り）
  if (contiguous(A, B) && bull(C) && bear(B) && bear(A) && Math.min(B.o, B.c) > C.c && A.o > B.o && A.c < B.c && A.c > C.c)
    sig.push({ name: '上放れ二羽烏', dir: '売り' });

  // 三山(三尊天井) / 三川(逆三尊) / 単純三山（RSIダイバージェンスで補強）
  detectHeadShoulders_(bars, rsi).forEach(s => sig.push(s));

  // 三川の代表形: 明けの明星 / 宵の明星（＋捨て子線）
  detectStars_(bars).forEach(s => sig.push(s));

  // 三川系の2本足 反転パターン: かぶせ線 / 切り込み線 / 包み線 / はらみ線 / 毛抜き天井・底
  detectReversalPairs_(bars).forEach(s => sig.push(s));

  // MACD(12,26,9) ゴールデン/デッドクロス（直近バーでのクロス）
  // EMAは先頭値をシードにするため、バー数が少ないとEMA26がほぼ初日終値のままになり、
  // 意味のないクロスが出る。macd[0]は常に0で null にならないので、
  // null チェックだけでは弾けない。必要バー数を明示的に要求する。
  if (n >= SK.MACD_MIN_BARS) {
    const mac = macdSeries_(bars.map(b => b.c), 12, 26, 9);
    const mN = mac.macd[n - 1], sN = mac.signal[n - 1], mP = mac.macd[n - 2], sP = mac.signal[n - 2];
    if (mN != null && sN != null && mP != null && sP != null) {
      if (mP <= sP && mN > sN) sig.push({ name: 'MACDゴールデンクロス', dir: '買い' });
      if (mP >= sP && mN < sN) sig.push({ name: 'MACDデッドクロス', dir: '売り' });
    }
  }

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

  // 大陽線/大陰線の基準。判定対象のA・Bを除いた直近10本の平均実体に倍率をかける。
  // 以前は基準の算定区間にB自身を含み、しかも倍率なしの単純平均だったため、
  // 約半数のバーが「大きめの実体」と判定され、かぶせ線・はらみ線が量産されていた。
  const avg = avgBody_(bars, 10, 2);
  const bBig = avg > 0 && body(B) >= avg * SK.BIG_BODY_MULT;

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
  // 以前は固定0.2%だったため、300円株では1ティック未満で永久に不点灯、
  // 10000円株では20ティック幅が「同値」となり常時点灯していた。ATR基準にする。
  const tol = atr_(bars, 14, 2) * SK.TWEEZER_ATR || (Math.abs(A.c) || 1) * 0.002;
  const eq = (x, y) => Math.abs(x - y) <= tol;
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

  // 「長大線」判定の基準。判定対象のA・B・Cを除いた直近10本の平均実体に倍率をかける。
  // 以前は算定区間にA・B・C自身を含み倍率も無かったため、基準が甘くなっていた。
  const avg = avgBody_(bars, 10, 3);
  const cBig  = avg > 0 && body(C) >= avg * SK.BIG_BODY_MULT;   // 中日前は長大線
  const bStar = body(B) <= body(C) * 0.5;           // 中央は小さな実体（星／コマ）
  const bDoji = body(B) <= (B.h - B.l) * 0.1;       // ほぼ同事線（寄引同値）
  // 明星は「窓を開けて放れる」形が本質なので、データ欠損で日付が飛んでいる区間では判定しない
  const cont  = (A.cont !== false) && (B.cont !== false);

  // 明けの明星: 星がC終値の下に窓を開けて放れ、翌日の陽線がC実体の中心を上回る
  if (cont && cBig && bear(C) && bStar && upper(B) < C.c && bull(A) && A.c > mid(C)) {
    out.push({ name: '明けの明星', dir: '買い' });
    // 捨て子線（明け）: 星が同事線で、前後ともヒゲを含め窓が開く（強い底打ち反転）
    if (bDoji && B.h < C.l && A.l > B.h) out.push({ name: '捨て子線(明け)', dir: '買い' });
  }

  // 宵の明星: 星がC終値の上に窓を開けて放れ、翌日の陰線がC実体の中心を下回る
  if (cont && cBig && bull(C) && bStar && lower(B) > C.c && bear(A) && A.c < mid(C)) {
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
      // 同値を「厳密により大きい／小さい」で比較しているため、同じ高値が並ぶと
      // 隣り合うバーが両方ピークとして拾われる。左側は同値も不可として1つに絞る。
      const tie = vals[k] === vals[i];
      if (isPeak ? (vals[k] > vals[i] || (tie && k < i)) : (vals[k] < vals[i] || (tie && k < i))) { ok = false; break; }
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
  // 両肩の高さ許容差。5%は両肩の差として広すぎ、形として成立していないものまで拾っていた。
  const W = 3, TOL = SK.HS_TOL;
  // 三山/三川は「山が3つ並んでいる」ことが形の要件で、隣接した極値の寄せ集めではない。
  // 山と山の間に最低限の間隔を要求する。
  const spaced = (a, b, c) => (b - a) >= SK.HS_MIN_GAP && (c - b) >= SK.HS_MIN_GAP;

  // 三山(三尊天井): 直近ピーク3つ 左肩<頭>右肩、両肩が近い、ネックライン割れ
  const pk = findExtrema_(highs, W, true);
  if (pk.length >= 3 && spaced.apply(null, pk.slice(-3))) {
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
  if (tr.length >= 3 && spaced.apply(null, tr.slice(-3))) {
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
// styleSheet_ は共通モジュール SheetStyle.js（~/projects/SheetStyle.js のsymlink）に定義

// autoFit_ は共通モジュール AutoFit.js（~/projects/AutoFit.js のsymlink）に定義

// ============================================================================
//  使い方シート
// ============================================================================
function createUsageSheet() {
  // [テキスト, 種別]  種別: title / h(見出し) / p(本文) / note
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
    ['4. 「シグナル」シートに結果（傾向が強い順に並ぶ）', 'p'],
    ['   ・保有列 … SBI保有銘柄は○＋淡赤ハイライト。ヘッダのフィルタで「○」を選ぶと保有だけ表示', 'p'],
    ['   ・強さ列 … 点灯パターンの重み合計×地合い係数を、絶対しきい値で★★★/★★/★に分類', 'p'],
    ['     （相対順位ではないので、弱いシグナルしか出ていない日は★★★が0件になります）', 'p'],
    ['   ・方向列 … ▲買い(緑)/▼売り(赤)/◆混在(橙)。コードはTradingViewチャートへのリンク', 'p'],
    ['   ・K1セル … 走査の進捗と最終更新時刻を表示（走査中／完了・取得失敗件数）', 'p'],
    ['', 'p'],
    ['■ 「相場マクロ」シート（地合いの入力）', 'h'],
    ['急落サインの判定材料を入れるシートです。B列が値、C列が最終更新日です。', 'p'],
    ['・東証 売残／信用倍率 … JPXの信用取引現在高ファイル(mtseisan*.xls)から自動取込', 'p'],
    ['   ※JPXのサイトからDLした mtseisan*.xls を、このスプレッドシートと同じGoogleドライブに置いてください', 'p'],
    ['   （JPXはボットからの直接ダウンロードを拒否するため、ファイルの入手だけは手作業になります）', 'p'],
    ['・日経EPS／海外投資家／好決算sell-on-news … 自動取得を試み、取れないときは手入力', 'p'],
    ['・C列の最終更新日が10日以上前、または空欄だと「更新が古い」と警告します', 'p'],
    ['   値だけ見ていると更新忘れに気づけず、古い需給のまま判定してしまうためです', 'p'],
    ['', 'p'],
    ['■ 「急落サイン」シート', 'h'],
    ['相場全体の急落リスクを7つの条件で判定し、点灯数をN/7で表示します。', 'p'],
    ['目安 … 2件以下=落ち着いている / 3〜4件=注意 / 5件以上=警戒領域', 'p'],
    ['判定結果は個別シグナルの強さ(★)にも反映されます（買い/売りで逆方向に作用）。', 'p'],
    ['', 'p'],
    ['■ 「パターン成績」シート（参考値）', 'h'],
    ['メニュー「パターン成績を集計」で、過去6ヶ月の全銘柄を対象に', 'p'],
    ['各パターンが「発生後にどれだけ騰落したか」を集計します。', 'p'],
    ['評価は時間軸別 … 短期系は3営業日後、中期系(三山/三川/三法)は20営業日後の騰落率で判定。', 'p'],
    ['※この集計はシグナルの順位付けには使っていません（あくまで傾向を眺めるための参考値）。', 'note'],
    ['   生の騰落率のみでベンチマークを控除しておらず、上昇相場では買いパターンが軒並み', 'p'],
    ['   高勝率と出ます。また件数20件では勝率60%と50%を統計的に区別できません。', 'p'],
    ['', 'p'],
    ['■ 自動実行（トリガー）', 'h'],
    ['メニュー「自動実行を設定」で以下の3つを設定します。', 'p'],
    ['① 相場マクロ更新 … 毎日17時、地合いと急落サインを更新（走査の前に走らせる）', 'p'],
    ['② 全銘柄走査 … 平日18時に1回、全銘柄の株価を取得して酒田五法シグナルを走査（重い処理）', 'p'],
    ['③ 購入ポートフォリオ確認 … 毎時、SBI保有銘柄をシグナルシート上で最新のハイライトに更新（株価取得はしない）', 'p'],
    ['   ※いずれも休場日（土日祝・年末年始）はスキップします', 'p'],
    ['   ※パターン成績の集計は自動実行しません（必要なときにメニューから実行）', 'p'],
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
    ['・★は「形の強さ」であって期待収益ではありません。', 'note'],
    ['・損切り・利確・ポジションサイズ・銘柄分散はこのツールの対象外です。', 'note'],
    ['・株価は分割・配当調整済み。売買代金が細い銘柄（直近20日の中央値5,000万円未満）は対象外です。', 'p'],
    ['', 'p'],
    ['■ 用語', 'h'],
    ['J-Quants … 日本取引所グループ系のマーケットデータ配信サービス。プライム銘柄一覧や', 'p'],
    ['   海外投資家の売買動向の取得に使います。利用にはAPIキーの登録が必要です。', 'p'],
    ['スクリプトプロパティ … Apps Scriptに秘密の設定値（APIキー等）を保存する場所。', 'p'],
    ['   Apps Scriptエディタ → 左の歯車（プロジェクトの設定） → スクリプト プロパティ から設定します。', 'p'],
  ];

  return UsageSheet.buildDoc(SpreadsheetApp.getActive(), SK.SHEETS.USAGE, rows);
}

// ============================================================================
//  実績スコアリング：過去6ヶ月バックテスト → パターン成績DB（重みを自動学習・自動修正）
// ============================================================================

// map をパターン成績シートへ書き出す（勝率・期待リターン・参考重みを再計算、期待リターン降順）
// ※ 集計結果はシグナルの順位付けには使わない（suggestWeight_ のコメント参照）。
function writeStatsSheet_(map) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SK.SHEETS.STATS);
  if (!sh) sh = ss.insertSheet(SK.SHEETS.STATS);
  const old = sh.getFilter(); if (old) old.remove();
  sh.clear();
  // 1行目は但し書き。この集計は順位付けに使っていないことを、シートを見た人が必ず目にする位置に置く。
  const CAVEAT = '⚠ 参考値です。シグナルの順位付けには使っていません。'
    + '（生の騰落率のみでベンチマーク未控除／件数' + BT_MIN_SAMPLE + '件では勝率60%と50%を統計的に区別できない'
    + '／同一シグナルが連日重複計上される／約定を当日終値と仮定＝実際は翌日寄付、手数料未考慮）';
  sh.getRange(1, 1).setValue(CAVEAT);
  const header = ['パターン', '方向', '件数', '勝ち', '騰落率合計', '勝率%', '平均騰落率%', '参考重み', '先読み日'];
  const rows = Object.keys(map).map(name => {
    const s = map[name], nn = s.n || 0;
    const win = nn ? s.wins / nn * 100 : 0;
    const exp = nn ? s.retSum / nn * 100 : 0;
    const suggest = suggestWeight_(name, nn, s.wins || 0);
    return [name, s.dir || SIGNAL_DIR_[name] || '', nn, s.wins || 0,
            Math.round((s.retSum || 0) * 10000) / 10000, Math.round(win * 10) / 10, Math.round(exp * 100) / 100, suggest, signalHorizon_(name)];
  });
  rows.sort((a, b) => b[6] - a[6]);
  sh.getRange(2, 1, 1, header.length).setValues([header]);
  if (rows.length) {
    sh.getRange(3, 1, rows.length, header.length).setValues(rows);
    sh.getRange(3, 6, rows.length, 1).setNumberFormat('0.0');
    sh.getRange(3, 7, rows.length, 1).setNumberFormat('0.00');
  }
  // styleSheet_（共有モジュール）は「1行目=ヘッダー」を前提にしているため、
  // 但し書きを1行目に置いた分は呼び出し後に上書きして整える。共有側は変更しない。
  styleSheet_(sh, header.length, '#141a33', '#eef1fb');
  sh.getRange(1, 1, 1, header.length).merge()
    .setBackground('#fff4f4').setFontColor('#b00020').setFontWeight('bold')
    .setHorizontalAlignment('left').setVerticalAlignment('middle').setWrap(true);
  sh.getRange(2, 1, 1, header.length)
    .setBackground('#141a33').setFontColor('#ffffff').setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setFrozenRows(2);
  sh.setRowHeight(1, 44);
  autoFit_(sh, header.length);
  sh.setTabColor('#4a90d9');
}

// 過去6ヶ月バックテスト（時間分割・自動再開）。各パターンの N日後リターン実績を集計し成績DBを自動更新。
function backtestWeights() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) { Logger.log('別の処理が進行中のためスキップ'); return; }

  const ss  = SpreadsheetApp.getActive();
  const uni = ss.getSheetByName(SK.SHEETS.UNIVERSE);
  if (!uni || uni.getLastRow() < 2) throw new Error('「銘柄」シートにコードを入れてください');

  // 進捗はカーソル（処理済み銘柄数）のみを保存する。集計途中の acc も件数分しか増えないため
  // 9KB上限には収まるが、キュー配列は銘柄数に比例して膨らむのでカーソル方式に統一する。
  const props = PropertiesService.getScriptProperties();
  const universe = uni.getRange(2, 1, uni.getLastRow() - 1, 1).getValues()
    .map(r => String(r[0]).trim()).filter(Boolean);
  const total = universe.length;
  let cursor = Number(props.getProperty('BT_CURSOR') || 0);
  let acc    = JSON.parse(props.getProperty('BT_ACC') || 'null');
  if (!cursor || !acc) {
    cursor = 0;
    acc = {};   // name -> [n, wins, retSum]
    ss.toast('パターン成績の集計を開始（自動再開で完走します）', '酒田五法', 5);
  }

  const start = Date.now();
  while (cursor < total) {
    if (Date.now() - start > SK.TIME_BUDGET_MS) break;
    const slice = universe.slice(cursor, cursor + SK.BATCH);
    const reqs = slice.map(code => ({
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(code) +
           '.T?range=' + SK.YAHOO_RANGE + '&interval=1d',
      headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true,
    }));
    const resps = fetchAllWithRetry_(reqs);
    if (!resps) break;   // ネットワークごと落ちている。カーソルは進めず次回に持ち越す。
    resps.forEach(res => {
      if (!res || res.getResponseCode() !== 200) return;
      const bars = parseYahooBars_(res);
      const last = bars.length - 1;
      if (bars.length < BT_MIN_HISTORY + BT_FORWARD + 1) return;
      for (let i = BT_MIN_HISTORY; i <= last - BT_FORWARD; i++) {
        const signals = detectSakata_(bars.slice(0, i + 1));
        if (!signals.length) continue;
        const base = bars[i].c;
        if (!base) continue;
        signals.forEach(s => {
          const sign = s.dir === '買い' ? 1 : s.dir === '売り' ? -1 : 0;
          if (!sign) return;
          const h = signalHorizon_(s.name);                   // パターン別ホライズン(短期3日/中期20日)
          if (i + h > last) return;                            // 先読み分の足が足りなければ集計しない
          const dr = (bars[i + h].c - base) / base * sign;     // 発生からh営業日後の騰落率(方向調整)
          const a = acc[s.name] || (acc[s.name] = [0, 0, 0]);
          a[0] += 1; a[1] += dr > 0 ? 1 : 0; a[2] += dr;
        });
      }
    });
    // バッチ単位でカーソルと集計値を確定させる（6分制限で強制終了しても取りこぼさない）
    cursor += slice.length;
    props.setProperty('BT_CURSOR', String(cursor));
    props.setProperty('BT_ACC', JSON.stringify(acc));
    Utilities.sleep(150);
  }

  clearBtResume_();
  if (cursor < total) {
    ScriptApp.newTrigger('backtestWeights').timeBased().after(90 * 1000).create();
    Logger.log('成績集計 一時停止: ' + cursor + '/' + total + '銘柄。90秒後に自動再開。');
    ss.toast('成績集計 ' + cursor + '/' + total + '銘柄。自動再開します', '酒田五法', 8);
  } else {
    const map = {};
    Object.keys(acc).forEach(name => {
      const a = acc[name];
      map[name] = { dir: SIGNAL_DIR_[name] || '', n: a[0], wins: a[1], retSum: a[2] };
    });
    writeStatsSheet_(map);
    props.deleteProperty('BT_CURSOR'); props.deleteProperty('BT_ACC');
    props.deleteProperty('BT_QUEUE');   // 旧方式の残骸があれば掃除
    Logger.log('成績集計 完了: ' + Object.keys(map).length + 'パターン（参考値。順位付けには未使用）');
    ss.toast('パターン成績を更新しました（参考値・順位には未使用）', '酒田五法', 6);
  }
}

function clearBtResume_() {
  clearTriggersFor_('backtestWeights');   // 共通モジュール TriggerUtils.js
}

// パターン成績の集計をトリガーから回す場合の入口（営業日のみ）。
// 既定では installDailyScanTrigger はこれを登録しない（集計値を順位付けに使わないため）。
// 既存プロジェクトに残っている旧トリガーが発火しても安全に動くよう関数自体は残す。
function scheduledBacktest() {
  if (!isBusinessDay_(new Date())) { Logger.log('休場日のため成績集計をスキップ'); return; }
  backtestWeights();
}
