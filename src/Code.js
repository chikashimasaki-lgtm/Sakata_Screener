// ============================================================================
//  短期売買支援（ダウ理論×フィボナッチの買い推奨）
//  ---------------------------------------------------------------------------
//  株価API（Yahoo Finance 日足）でプライム全銘柄を走査し、ダウ理論の上昇トレンドの押し目が
//  フィボナッチの押し幅で止まって反転した銘柄を、1日最大5件の買い推奨として出す。
//  判定の本体は DowFib.js（純ロジック）。根拠の検証は tools/backtest_dowfib.js（README 参照）。
//  UI はスプレッドシート「売買プラン」1枚（買い推奨＋保有株）。※投資助言ではなく抽出の補助。
//
//  旧・酒田五法のローソク足判定（detectSakata_ ほか）は、旧ロジックとの比較
//  （backtest_dowfib.js --old）と tools/calc_weights.js のために残しているが、走査には使っていない。
//
//  使い方:
//   1) メニュー「短期売買支援」→ 設定とメンテナンス → セットアップ
//   2) 「銘柄」シートにコード(4桁)を入れる（または「プライム銘柄を取得」でJ-Quantsから取得）
//   3) 「走査」を実行 → 「売買プラン」シートに結果
// ============================================================================

const SK = {
  SHEETS: { UNIVERSE: '銘柄', SIGNALS: 'シグナル', USAGE: '使い方', STATS: 'パターン成績', PLAN: '売買プラン' },
  YAHOO_RANGE: '6mo',   // 保有株の売買プラン・旧集計用
  SCAN_RANGE: '1y',     // 買い推奨の走査用。主要トレンドの山谷（左右10本）を2組そろえるのに半年では足りない
  BATCH: 40,
  TIME_BUDGET_MS: 4.5 * 60 * 1000,
  // 信用需給フィルター（動画の閾値）。地合いと係数の単一ソース。MarketMacro.js が参照。
  // RATIO_TREND_BAND: 信用倍率の「前回公表比」で上昇/低下を判定するときの不感帯（±2%）。
  //   以前は水準判定（倍率 >= 1.0 で買い方過多）だったが、基準にしている日経レバ1570の倍率は
  //   実測10.24倍（2026-09、買残2,144,098口/売残209,290口）で、1.0を割る前提が今の市場では成立せず
  //   条件が恒久点灯 → 地合いが SUPPLY_RISK に張り付いていた。母集団の絶対値に依存しないよう
  //   「前回公表からどちらへ動いたか」で見る。倍率上昇＝買い方過多が進行、低下＝売残が積む。
  MARGIN: { SELL_THRESHOLD_OKU: 8000, RATIO_TREND_BAND: 0.02, BUY_BOOST: 1.5, SELL_BOOST: 1.5 },
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
  // 売買プラン（ダウ理論ベースの買い・利確・損切り）。詳細は buildOrderPlan_ を参照。
  ORDER: {
    // スイング（高値・安値）の確定に要求する左右のバー数。三山/三川と同じ3本。
    // 右側にも3本要求するので、確定スイングは後から動かない（リペイントしない）。
    SWING_W: 3,
    // 利確幅＝損切り幅の何倍か。損切りはダウ理論（押し安値割れ＝上昇トレンド否定）で
    // 決まるので、利確側だけをこの比率で機械的に置く。
    RR: 2.0,
    // 1トレードで許容する損失額（円）。株数はこの額に収まるように逆算する。
    // スクリプトプロパティ SAKATA_RISK_BUDGET_YEN で上書き可。
    RISK_BUDGET_YEN: 30000,
    // 1銘柄あたりの建玉上限（円）。損切り幅が極端に狭いと株数が青天井になるため頭を押さえる。
    // スクリプトプロパティ SAKATA_MAX_POSITION_YEN で上書き可。
    MAX_POSITION_YEN: 1000000,
    // 売買単位。東証は2018年10月に全銘柄100株へ統一済み。
    LOT: 100,
    // 損切り幅の下限（ATR14の何倍か）。押し安値が現値のすぐ下にあるとき、
    // 理論どおりに置くと日中のノイズで確実に狩られるため、最低限の距離を確保する。
    MIN_STOP_ATR: 0.5,
    // 逆指値がヒットしたあとに出す指値を、トリガーの何ティック下に置くか。
    // 成行だと滑るが、トリガーと同値の指値では約定しないことがあるための余裕。
    STOP_SLIP_TICKS: 2,
    // 注文の有効期間。押し安値・戻り高値は数日単位で有効なので当日中では取りこぼす。
    TERM: '今週中',
  },
};

// プロジェクト名（メニュー名・トーストの見出し。共通モジュール ConfirmUi.js も参照）
const APP_NAME_ = '短期売買支援';

// 実績スコアリング設定（バックテスト学習・自動修正）
// バックテスト対象期間 = 過去6ヶ月（SK.YAHOO_RANGE '6mo'）
const BT_FORWARD     = 3;    // 先読み営業日数（発生から3営業日後の騰落率で的中/リターンを評価）
const BT_MIN_HISTORY = 30;   // シグナル検出に必要な最低バー数（三山/三川が25本必要）
const BT_MIN_SAMPLE  = 20;   // 実績を重みに採用する最低件数（未満は静的重みで代替）

// ---- メニュー ----
function onOpen() {
  // 使い方シートは一番右に置く（全プロジェクト共通方針、2026-09-19）。
  // 既存のスプレッドシートを開いたときに追従させるためのもの。既に末尾なら何もしない。
  try { UsageSheet.moveToLast(SpreadsheetApp.getActiveSpreadsheet()); } catch (e) {}

  const ui = SpreadsheetApp.getUi();

  // 日常的に押すのは上の2つだけ。残りは「たまに個別に更新したいもの」と
  // 「初回設定・後片付け」なので、サブメニューへ畳んで最初の画面を短く保つ。
  // 平日18時の走査トリガーが回っている限り、上の2つも押す必要はない。
  ui.createMenu(APP_NAME_)
    .addItem('走査/続行（買い推奨と売買プランを更新）', 'scanSignals')
    .addItem('売買プランだけ作り直す（買い推奨＋保有株）', 'buildPlans')
    .addSeparator()
    .addSubMenu(ui.createMenu('個別に更新')
      .addItem('相場マクロ/急落サインを更新',   'updateMarketMacro')
      .addItem('決算カレンダーを更新',          'updateEarningsCalendar')
      .addItem('Bloombergニュースを取り込む（投資デイリー分析へ）', 'updateBloombergNews')
      .addItem('AI推奨コメントを生成（参考・投資助言ではありません）', 'generateAiSummary'))
    .addSubMenu(ui.createMenu('設定とメンテナンス')
      .addItem('セットアップ',                  'setup')
      .addItem('プライム銘柄を取得（J-Quants）', 'fetchPrimeUniverse')
      .addItem('自動実行を設定（Bloomberg:7時半/相場マクロ:17時/走査:平日18時）', 'installDailyScanTrigger')
      .addSeparator()
      .addItem('使い方シートを作成/更新', 'createUsageSheet')
      .addItem('シート順序を整える',      'ensureSheetOrder')
      .addItem('走査の進捗リセット',      'resetScanQueue')
      .addItem('廃止シートを削除（一度だけ）', 'removeDeprecatedSheets'))
    .addToUi();
}

// 破壊的操作の確認 confirmDestructive_() の本体は共通モジュール ConfirmUi.js
// （gas-shared/modules/ConfirmUi.js の symlink）。トーストに出す名前は APP_NAME_ を見る。

function setup() {
  const ss = SpreadsheetApp.getActive();
  let uni = ss.getSheetByName(SK.SHEETS.UNIVERSE);
  if (!uni) {
    uni = ss.insertSheet(SK.SHEETS.UNIVERSE);
    uni.getRange(1, 1, 1, 2).setValues([['コード', '銘柄名']]);
    // コード列はテキスト型で持つ（数値に落ちると 7,203 表示・先頭0落ち・130A と型が不揃いになる）
    uni.getRange(2, 1, uni.getMaxRows() - 1, 1).setNumberFormat('@');
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
  hideWorkSheets_();   // 「シグナル」は走査の作業場所なので見せない
  ss.toast('シートを準備しました。「銘柄」にコードを入れて走査してください', APP_NAME_, 6);
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
    // 429/5xx は共通モジュール FetchRetry.js が指数バックオフで再試行する。
    // ここで即 throw すると、それまでに集めたページごと捨てて最初からやり直しになる。
    const res = fetchWithRetry_(url, { headers: { 'x-api-key': key }, muteHttpExceptions: true },
      { retry: SK.FETCH_RETRY, backoffMs: SK.FETCH_BACKOFF_MS, label: 'equities/master' });
    if (res.getResponseCode() !== 200) throw new Error('equities/master 失敗: ' + res.getContentText().slice(0, 200));
    const j = JSON.parse(res.getContentText());
    (j.data || []).forEach(x => { if (x.Mkt === '0111' || x.MktNm === 'プライム') collect.push([to4_(x.Code), x.CoName || '']); });
    pagination = j.pagination_key || null;
  } while (pagination);

  const uni = SpreadsheetApp.getActive().getSheetByName(SK.SHEETS.UNIVERSE);
  uni.clear();
  uni.getRange(1, 1, 1, 2).setValues([['コード', '銘柄名']]);
  // 値を入れる前にテキスト書式にする。後からだと "7203" は既に数値7203になっていて
  // 書式を変えても型は戻らない（表示が 7203 に見えても中身は数値のまま）。
  uni.getRange(2, 1, uni.getMaxRows() - 1, 1).setNumberFormat('@');
  if (collect.length) uni.getRange(2, 1, collect.length, 2).setValues(collect);
  styleSheet_(uni, 2, '#1a1e3a', '#eef3fc');   // 銘柄シートも配色
  if (uni.getLastRow() > 1) uni.getRange(2, 1, uni.getLastRow() - 1, 1).setHorizontalAlignment('right');  // コード右寄せ
  autoFit_(uni, 2);
  uni.setTabColor('#5b6bd6');
  Logger.log('プライム銘柄: ' + collect.length + '件');
  SpreadsheetApp.getActive().toast('プライム ' + collect.length + '件を取得', APP_NAME_, 5);
}

// to4_() の本体は共通モジュール StockCode.js（gas-shared/modules/StockCode.js の symlink）

// ============================================================================
//  走査（時間分割・自動再開）
//  全銘柄の日足を取り、dfSetup_（DowFib.js）が成立した銘柄を「シグナル」シートに候補として貯める。
//  「シグナル」シートは時間分割をまたいで候補を持ち越すための作業場所で、走査完了後は非表示にする。
//  人が見るのは「売買プラン」シート（買い推奨 最大5件＋保有株）だけ。
// ============================================================================
// 候補シートの列（作業用。人が見る前提ではないので数値のまま持つ）
const CAND_HEADERS_ = ['コード', '銘柄名', '終値', '確度', 'スコア', '損切り', '利確', '押し率', '出来高倍率', '根拠', '日付'];

// 実行記録（効率化KPI、共通モジュール RunLog.js）で包んだ入口。本体は scanSignalsRun_
function scanSignals() { return runLogged_('買い推奨走査', () => scanSignalsRun_()); }
function scanSignalsRun_() {
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
  let sig = ss.getSheetByName(SK.SHEETS.SIGNALS);
  if (!sig) sig = ss.insertSheet(SK.SHEETS.SIGNALS);
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
    // 新規走査は候補シートを作り直す（前回の候補は売買プランに反映済みなので確認は不要）
    const oldFilter = sig.getFilter(); if (oldFilter) oldFilter.remove();
    sig.clear();
    sig.setConditionalFormatRules([]);
    sig.getRange(1, 1, 1, CAND_HEADERS_.length).setValues([CAND_HEADERS_]);
    // コード列はテキスト書式（"5602" が 5,602 と表示されたり、先頭0が落ちたりしないように）
    sig.getRange(2, 1, sig.getMaxRows() - 1, 1).setNumberFormat('@');
    failed = 0;
  }

  const start = Date.now();
  while (cursor < total) {
    if (Date.now() - start > SK.TIME_BUDGET_MS) break;
    const slice = universe.slice(cursor, cursor + SK.BATCH);
    const resps = fetchAllWithRetry_(slice.map(([code]) => yahooChartRequest_(code, SK.SCAN_RANGE)));
    if (!resps) break;   // ネットワークごと落ちている。カーソルは進めず次回に持ち越す。

    const buffer = [];
    resps.forEach((res, i) => {
      const [code, name] = slice[i];
      if (!res || res.getResponseCode() !== 200) { failed++; return; }  // 取得失敗を数える
      const bars = parseYahooBars_(res);
      if (bars.length < DF.MIN_BARS) return;
      if (!isLiquidEnough_(bars)) return;   // 薄商い銘柄は実際にその値段で売買できない
      const s = dfSetup_(bars);
      if (!s) return;
      buffer.push([code, name, s.close, s.grade, s.score, s.stop, s.target, s.retr, s.volRatio,
        dfReason_(s), Utilities.formatDate(new Date(bars[bars.length - 1].t * 1000), 'JST', 'yyyy/MM/dd')]);
    });

    // バッチごとに「書き込み → カーソル確定」の順で確定させる。
    // 以前は全バッチ終了後にまとめて書いていたため、最後のバッチ中に6分制限で強制終了すると
    // 未書込のbufferと処理済みの分がまとめて失われ、再実行で重複追記が起きていた。
    if (buffer.length) sig.getRange(sig.getLastRow() + 1, 1, buffer.length, CAND_HEADERS_.length).setValues(buffer);
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
    ss.toast(cursor + '/' + total + '銘柄まで完了。90秒後に自動再開します', APP_NAME_, 8);
    return;
  }

  props.deleteProperty('SK_CURSOR');
  props.deleteProperty('SK_FAILED');
  const nCand = Math.max(sig.getLastRow() - 1, 0);
  Logger.log('走査完了: 候補 ' + nCand + '件 / 取得失敗 ' + failed + '件');

  // 売買プラン（買い推奨＋保有株）→ 通知メール → 投資デイリー分析への連動、の順。
  // メールは発注に使うので先に出し、連動と後片付けは失敗しても走査結果を壊さない。
  let result = { plans: {}, targets: [] };
  try {
    result = buildPlansFromSignals_(sig);
  } catch (e) {
    Logger.log('売買プランの作成に失敗: ' + e.message);
    ss.toast('売買プランを作成できませんでした: ' + e.message, APP_NAME_, 8);
  }
  writeScanStatus_(sig, total, total, failed);   // 売買プランを書いた後（clear で消えないように）
  sendBuyPicksEmail_(result.targets, result.plans);
  sendHeldWarningEmail_(result.targets, result.plans);
  try {
    writeBriefingPicks_(result.targets, result.plans);
    const id = briefingSpreadsheetId_();
    if (id) writeBloombergSheet_(SpreadsheetApp.openById(id), (bloombergTexts_() || [])[0] || null);
  } catch (e) { Logger.log('投資デイリー分析への書き込みに失敗（売買プランは正常）: ' + e.message); }
  hideWorkSheets_();

  const picks = result.targets.filter(t => t.pick);
  // 取得失敗は「推奨0件」と紛らわしいので必ず件数を出す。
  ss.toast('走査完了: 買い推奨 ' + picks.length + '件（確度A ' + picks.filter(t => t.grade === 'A').length + '件）'
    + (failed ? '／' + failed + '銘柄は取得できず未判定' : ''), APP_NAME_, 8);
}

// Yahoo Finance 日足（調整後終値つき）の取得リクエスト
function yahooChartRequest_(code, range) {
  return {
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(code) +
         '.T?range=' + range + '&interval=1d',
    headers: { 'User-Agent': 'Mozilla/5.0' },
    muteHttpExceptions: true,
  };
}

// 候補シートの行を読み、スコア順に並べる（純関数部分は topPicks_）
function readCandidates_(sig) {
  if (!sig || sig.getLastRow() < 2) return [];
  return sig.getRange(2, 1, sig.getLastRow() - 1, CAND_HEADERS_.length).getValues()
    .filter(r => r[0])
    .map(r => ({
      code: to4_(String(r[0]).trim()).toUpperCase(), name: r[1] || '',
      setup: { close: Number(r[2]), grade: String(r[3]), score: Number(r[4]), stop: Number(r[5]),
               target: Number(r[6]), retr: Number(r[7]), volRatio: Number(r[8]) },
      reason: String(r[9] || ''),
    }));
}

/**
 * 候補から1日の推奨（最大 DF.TOP_N 件）を選ぶ。確度Aが先、同じ確度なら出来高倍率の大きい順
 * （dfSetup_ の score がその順になるように作ってある）。保有中の銘柄は新規の推奨から外す
 * （保有行のメモに「買い推奨にも該当」と書く）。
 */
function topPicks_(cands, heldCodes) {
  const held = heldCodes || new Set();
  return cands.filter(c => !held.has(c.code))
    .sort((a, b) => b.setup.score - a.setup.score)
    .slice(0, DF.TOP_N);
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
    // 作業用の候補シートは非表示なので、人が見る「売買プラン」の右上（L1）にも出す。
    // 走査が終われば writePlanSheet_ が要約で上書きする。取得失敗の件数はM1に残す。
    sig.getRange(1, 12).setValue(msg);
    const plan = SpreadsheetApp.getActive().getSheetByName(SK.SHEETS.PLAN);
    if (plan) {
      if (!finished) plan.getRange(1, 12).setValue(msg).setFontColor('#b26a00').setFontWeight('bold');
      plan.getRange(1, 13).setValue(finished && failed ? '（' + failed + '銘柄は株価を取得できず未判定）' : '')
        .setFontColor('#8a3a3a');
    }
  } catch (e) { /* 進捗表示は失敗しても走査自体は続ける */ }
}

function resetScanQueue() {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('SK_CURSOR');
  props.deleteProperty('SK_FAILED');
  props.deleteProperty('SK_QUEUE');   // 旧方式の残骸があれば併せて掃除
  clearResumeTriggers_();
  SpreadsheetApp.getActive().toast('走査の進捗をリセットしました', APP_NAME_, 5);
}

function clearResumeTriggers_() {
  clearTriggersFor_('scanSignals');   // 共通モジュール TriggerUtils.js
}

// 廃止した「ML学習データ」「ML重み(参考)」「AI推奨（参考）」シートの後片付け（一度だけ実行すればよい）。
// 削除・設計変更した機能（trainMlWeights・別シート方式のAI推奨コメント等）がもう存在しないため、
// 稼働中のスプレッドシートにタブとしてだけ残ってしまったものを消す。存在しなければ何もしない安全設計。
// メニューの入口なので末尾「_」を付けない（「_」は内部ヘルパの目印として使い分ける）。
function removeDeprecatedSheets() {
  const ss = SpreadsheetApp.getActive();
  const names = ['ML学習データ', 'ML重み(参考)', 'AI推奨（参考）'];
  const removed = [];
  names.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh) { ss.deleteSheet(sh); removed.push(name); }
  });
  const msg = removed.length ? removed.join('・') + ' を削除しました' : '対象のシートはありませんでした';
  Logger.log('廃止シート削除: ' + msg);
  ss.toast(msg, APP_NAME_, 6);
}

// タブの並びを人が実際に見る優先順に揃える。存在しないシートは無視するので、
// 何度実行しても安全（実行するまでは何も変わらない）。
// メニューの入口なので末尾「_」を付けない（「_」は内部ヘルパの目印として使い分ける）。
// 「使い方」は一番右（全プロジェクト共通方針、2026-09-19）。onOpen の
// UsageSheet.moveToLast() と並びが食い違うと、開くたびに位置が入れ替わって見える。
function ensureSheetOrder() {
  const ss = SpreadsheetApp.getActive();
  const order = [
    SK.SHEETS.PLAN, MACRO.INPUT_SHEET, MACRO.CALENDAR_SHEET, SK.SHEETS.UNIVERSE,
    SK.SHEETS.USAGE,
  ];
  let moved = 0;
  order.forEach((name, i) => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    sh.activate();
    ss.moveActiveSheet(i + 1);
    moved++;
  });
  ss.toast('シート順序を整えました（' + moved + '件）', APP_NAME_, 5);
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
  clearTriggersFor_(['scheduledScan', 'scheduledHeldCheck', 'scheduledBacktest', 'updateMarketMacro', 'updateBloombergNews',
                     'updateEarningsCalendar', 'scanSignals', 'backtestWeights']);   // 共通モジュール TriggerUtils.js
  ScriptApp.newTrigger('updateMarketMacro').timeBased().everyDays(1).atHour(17).create();    // 相場マクロ/急落サイン・地合い更新（走査の前）
  ScriptApp.newTrigger('updateEarningsCalendar').timeBased().everyDays(1).atHour(17).create(); // 決算カレンダー更新（EDINETDB_API_KEY未設定なら早期return）
  ScriptApp.newTrigger('scheduledScan').timeBased().everyDays(1).atHour(18).create();       // 全銘柄 株価取得＋走査（1日1回）
  ScriptApp.newTrigger('updateBloombergNews').timeBased().everyDays(1).atHour(7).nearMinute(30).create(); // Bloomberg朝刊（6時着）を投資デイリー分析へ
  // 旧「保有チェック（毎時）」は廃止。保有株は走査時に売買プランへ載る（上の clearTriggersFor_ で消える）。
  // 月次の自動学習トリガーは設定しない。集計結果を順位付けに使わなくなったため、
  // 全銘柄分のYahoo取得を毎月自動で走らせる必要がない（必要ならメニューから手動実行する）。
  SpreadsheetApp.getActive().toast('自動実行を設定しました（Bloomberg:7時半 / 相場マクロ:17時 / 走査:平日18時）', APP_NAME_, 6);
  Logger.log('トリガー設定: scheduledScan(平日18時) / updateMarketMacro(17時) / updateEarningsCalendar(17時)');
}

// 平日18時に発火。全銘柄の株価取得＋シグナル走査（重い処理・1日1回）。
// 引け後にYahoo日足の当日終値が確定するのを待つため18時。立会時間外なので営業日判定(isBusinessDay_)のみ。
// isBusinessDay_() は共通モジュール MarketCalendar.js で定義。
// 実行記録（効率化KPI、共通モジュール RunLog.js）で包んだ入口。本体は scheduledScanRun_
function scheduledScan() { return runLogged_('定時スキャン', () => scheduledScanRun_()); }
function scheduledScanRun_() {
  const now = new Date();
  ensureBloombergTrigger_();
  if (!isBusinessDay_(now)) { Logger.log('休場日のため走査をスキップ: ' + now); return; }
  scanSignals();
}

// 旧: 毎時、シグナルシートの保有ハイライトを更新していた。保有株は売買プランに走査時点で載るようになり
// 不要になった。既存のトリガーが残っていても害がないよう、入口だけ残して何もしない。
// 「自動実行を設定」をやり直すとトリガー自体も消える。
function scheduledHeldCheck() {
  Logger.log('保有チェックは廃止しました（保有株は走査時に売買プランへ載ります）');
  // 旧トリガーが毎時ここへ来る。朝7時半のBloomberg取り込みトリガーが無ければ足し、今回ぶんをすぐ取り込む
  if (ensureBloombergTrigger_()) { try { updateBloombergNews(); } catch (e) { Logger.log('Bloomberg取り込み失敗: ' + e.message); } }
}

/**
 * 走査が終わったら作業用・旧形式のシートを非表示にする（削除はしない＝いつでも再表示できる）。
 *  - シグナル … 走査の途中経過（候補）を貯める作業場所
 *  - パターン成績 … 旧・酒田五法の集計（判定には使っていない）
 *  - 急落サイン … 「相場マクロ」へ統合済みの古いシート
 */
function hideWorkSheets_() {
  const ss = SpreadsheetApp.getActive();
  [SK.SHEETS.SIGNALS, SK.SHEETS.STATS, '急落サイン'].forEach(name => {
    const sh = ss.getSheetByName(name);
    try { if (sh && !sh.isSheetHidden()) sh.hideSheet(); } catch (e) { /* 表示中のシートが1枚だけ等。実害なし */ }
  });
}

// 通知メール（買い推奨・保有株の警告）に付けるラベル。
// 受信トレイに残さず、後で累計損益を振り返るときにこのラベルで一覧できるようにする。
const SAKATA_PROFIT_LABEL_ = '利益累計';

/**
 * 直前に送った通知メールへ SAKATA_PROFIT_LABEL_ を付けて受信トレイからアーカイブする。
 * 送信直後（sendMail_ の直後）に呼ぶ想定。件名でスレッドを特定するため、
 * 送信からラベル付けまでの間にGmail側の検索インデックスが追いつくよう少し待つ。
 * ここで失敗してもメール送信自体は既に成功しているので、ログに残すだけで通知は止めない。
 */
function labelAndArchiveSentMail_(subject) {
  try {
    Utilities.sleep(2000);
    const label = GmailApp.getUserLabelByName(SAKATA_PROFIT_LABEL_) || GmailApp.createLabel(SAKATA_PROFIT_LABEL_);
    const threads = GmailApp.search('subject:"' + subject + '" newer_than:1d');
    threads.forEach(t => { t.addLabel(label); t.moveToArchive(); });
    if (threads.length) Logger.log(`「${SAKATA_PROFIT_LABEL_}」ラベルを付けてアーカイブしました（${threads.length}スレッド）`);
  } catch (e) {
    Logger.log('通知メールのラベル付け/アーカイブに失敗（メール送信自体は成功しています）: ' + e.message);
  }
}

// 件名・本文を作って送る。該当が無い日は送らない（Asset_Status_Notify と同じ方針）。
function sendPlanMail_(subject, lines) {
  if (!lines.length) return;
  try {
    sendMail_(subject, lines.join('\n'), Session.getActiveUser().getEmail());
    Logger.log('メール送信: ' + subject);
    labelAndArchiveSentMail_(subject);
  } catch (e) {
    Logger.log('メール送信に失敗（' + subject + '）: ' + e.message);
  }
}

// 買い推奨（最大5件）。メールだけ見て発注できるよう「売買プラン」シートと同じ数字を載せる。
function sendBuyPicksEmail_(targets, plans) {
  const picks = (targets || []).filter(t => t.pick);
  const a = picks.filter(t => t.grade === 'A').length;
  if (!picks.length) return;
  sendPlanMail_(`${APP_NAME_}_買い推奨_${picks.length}件（確度A ${a}件）`, [
    '翌営業日の寄付で買い、利確・損切りをOCOで置く前提の数字です。',
    '寄付が損切り以下／利確以上で始まったら見送ってください。',
    '',
  ].concat(...picks.map(t => [
    `【確度${t.grade}】${t.code} ${t.name}`,
    `  根拠: ${t.reason}` + planMailLine_(plans, t.code),
    ...(t.extra || []).map(x => '  ' + x),
    '',
  ])).concat(['確度A=押し38.2%以上かつ出来高1.5倍以上（過去10年で基準を上回った型）／確度B=条件の一部のみ',
              '※投資助言ではありません。詳細は「売買プラン」シート']));
}

// 保有株のうち、ダウ理論の上昇トレンドが崩れたもの（押し安値割れを待たず手仕舞いを検討）。
function sendHeldWarningEmail_(targets, plans) {
  const warn = (targets || []).filter(t => t.kind === '保有').filter(t => {
    const p = plans[t.code];
    return p && p.ok && p.trend !== '上昇';
  });
  if (!warn.length) return;
  sendPlanMail_(`${APP_NAME_}_保有株トレンド崩れ_${warn.length}件`,
    ['高値・安値の切り上げが崩れた保有株です。押し安値割れを待たず手仕舞いも検討してください。', '']
      .concat(warn.map(t => `${t.code} ${t.name}` + planMailLine_(plans, t.code))));
}

/**
 * 「売買プラン」シートと同じ数字をメール本文に1行で添える。
 * 該当プランが無ければ空文字（行そのものは出す）。
 */
function planMailLine_(plans, code) {
  const p = plans && plans[to4_(String(code || '').trim()).toUpperCase()];
  if (!p) return '';
  // 保有株に「見送り」は無い（持っている以上、見送るという選択肢が無い）。
  if (!p.ok) return '\n  └ ' + (p.held ? '算出不可' : '見送り') + '（' + p.reason + '）';
  // 保有中の銘柄には新規の買値が無い（返済売の2値だけを出す）。
  const entry = p.held ? '保有中' : ('翌朝寄付で買い（目安 ' + fmtNum_(p.entry) + '）');
  const trendWarn = (p.held && p.trend !== '上昇') ? ' ／トレンド崩れ・早期手仕舞い検討' : '';
  return '\n  └ ' + entry
    + ' / 利確 ' + fmtNum_(p.target) + ' / 損切 ' + fmtNum_(p.stop)
    + (p.shares ? ' / ' + fmtNum_(p.shares) + '株 / 損切り額 ' + fmtNum_(p.lossYen) + '円' : '')
    + trendWarn;
}

// SBI証券の保有銘柄コードを参照元スプレッドシート（Asset_Status）から収集する。
// 「SBI証券（日本株）」「SBI証券（日本株信用）」の「銘柄コード」列から4桁の証券コードを抽出。
// 戻り値は { codes: Set, reason: string|null }。reason は「未設定」「アクセス不可」等、
// 保有ハイライトが機能していない理由（0件そのものは異常ではないので reason は null のまま）。
// 以前は例外時しか呼び出し元に伝わらず、未設定で常に0件になっているだけの状態が
// ユーザーからは「なぜか保有マークが出ない」としか見えなかった。
// 保有数量・取得単価のヘッダ候補（現物と信用で列名が違う）。見つからなければ数量なしで扱う。
const HELD_QTY_HEADERS_  = ['保有株数', '株数', '数量', '建株数'];
const HELD_COST_HEADERS_ = ['取得単価', '平均取得単価', '建単価'];

// 「1,234」「1,234 円」のような表示文字列を数値へ。読めなければ null（0にすると
// 「株数0」と「株数不明」が区別できなくなり、損切り額を0円と表示してしまう）。
function toNum_(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[,\s円株]/g, ''));
  return isFinite(n) ? n : null;
}

function getSbiHeldCodes_() {
  // 参照先スプレッドシートIDはスクリプトプロパティ ASSET_STATUS_SS_ID に置く。
  // 個人の資産管理シートのIDを公開リポジトリのソースに直接書かないため。
  // 未設定なら保有ハイライトを行わない（機能を止めるだけで走査自体は続行する）。
  const SBI_SS_ID = PropertiesService.getScriptProperties().getProperty('ASSET_STATUS_SS_ID');
  const SHEET_NAMES = ['SBI証券（日本株）', 'SBI証券（日本株信用）'];
  const CODE_RE = /^[0-9][0-9A-Z]{3}$/;                            // 4桁の証券コード（例 7203 / 130A）
  const set = new Set();
  // コード→{shares, cost}。現物と信用の両方に同じ銘柄があれば株数を合算し、
  // 取得単価は株数で加重平均する（売買プランの損切り額を建玉全体で出すため）。
  const positions = {};
  const addPos = (code, shares, cost) => {
    if (!(shares > 0)) return;
    const p = positions[code] || (positions[code] = { shares: 0, costSum: 0, costQty: 0, cost: null });
    p.shares += shares;
    if (cost > 0) { p.costSum += cost * shares; p.costQty += shares; }
    p.cost = p.costQty ? p.costSum / p.costQty : null;
  };
  if (!SBI_SS_ID) {
    Logger.log('ASSET_STATUS_SS_ID が未設定のため保有ハイライトをスキップ');
    return { codes: set, positions: positions, reason: 'ASSET_STATUS_SS_ID未設定' };
  }
  let ss;
  try { ss = SpreadsheetApp.openById(SBI_SS_ID); }
  catch (e) {
    Logger.log('SBIスプレッドシートを開けません: ' + e.message);
    return { codes: set, positions: positions, reason: 'スプレッドシートを開けません: ' + e.message };
  }
  SHEET_NAMES.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) { Logger.log('保有取得: シート「' + name + '」が見つかりません'); return; }
    if (sh.getLastRow() < 1) { Logger.log('保有取得: シート「' + name + '」が空です'); return; }
    const data = sh.getDataRange().getValues();
    // 「銘柄コード」ヘッダの列を特定（Asset_Status のCSV取込と同じ構造）
    let hi = -1, ci = -1;
    for (let r = 0; r < data.length && ci < 0; r++) {
      const c = data[r].findIndex(v => String(v || '').trim() === '銘柄コード');
      if (c >= 0) { hi = r; ci = c; }
    }
    Logger.log('保有取得: シート「' + name + '」' + data.length + '行 / ヘッダ'
      + (ci >= 0 ? '発見(行' + hi + ' 列' + ci + ')' : '見つからず（保険で全セル走査）')
      + ' / 先頭行サンプル: ' + JSON.stringify((data[0] || []).slice(0, 6)));
    if (ci < 0) {   // ヘッダが見つからなければ全セルから4桁コードを拾う保険
      let hit = 0;
      data.forEach(row => row.forEach(v => {
        const s = to4_(String(v || '').trim()).toUpperCase();   // 5桁→4桁に正規化
        if (CODE_RE.test(s)) { set.add(s); hit++; }
      }));
      Logger.log('保有取得: シート「' + name + '」保険走査でのヒット数 ' + hit);
      return;
    }
    // 数量・取得単価の列も同じヘッダ行から探す。CSVの列名は現物/信用や年で変わるので、
    // 見つからなければ数量なし（＝損切り額は未計算）として続行する。
    const findCol = cands => data[hi].findIndex(v => cands.indexOf(String(v || '').trim()) >= 0);
    const qi = findCol(HELD_QTY_HEADERS_);
    const pi = findCol(HELD_COST_HEADERS_);
    let hit = 0;
    for (let r = hi + 1; r < data.length; r++) {
      const s = to4_(String(data[r][ci] || '').trim()).toUpperCase();   // 5桁→4桁に正規化
      if (!CODE_RE.test(s)) continue;
      set.add(s);
      hit++;
      if (qi >= 0) addPos(s, toNum_(data[r][qi]), pi >= 0 ? toNum_(data[r][pi]) : null);
    }
    Logger.log('保有取得: シート「' + name + '」データ行 ' + (data.length - hi - 1)
      + ' / コード一致 ' + hit + ' / 数量列' + (qi >= 0 ? '発見' : '無し'));
  });
  Logger.log('SBI保有銘柄コード: ' + set.size + '件（数量取得 ' + Object.keys(positions).length + '件）');
  return { codes: set, positions: positions, reason: null };
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
// npm run calc-weights が書き換えます。手動編集は次回実行で上書きされます。
// SIGNAL_WEIGHT_ AUTO-GENERATED START
const SIGNAL_WEIGHT_ = {
  // 2026-08-16 実データで算出（1225銘柄・6mo・日経平均控除後）。再現は npm run calc-weights
  // 比較対象は0.5ではなく「シグナル無しで入った場合の勝率」＝ 売り20日58.3% / 売り3日57.5% / 買い20日41.7% / 買い3日42.5%
  //   日経平均は値がさ株偏重で個別株の中央値が劣後するため、控除後でも0.5にならない。
  // 動かす条件は次の3つを全て満たすもの。それ以外は人手で決めた従来値のまま。
  //   ①30件以上  ②Wilson区間が基準線を外れる（Bonferroni補正 z=3.13）  ③基準線との差が5pt以上
  //   ③が要るのは、件数が数千あると1〜2ptの差でも②を通ってしまうため（有意≠意味のある差）。
  'MACDゴールデンクロス': 2,              // n=2867 38.6%(基準42.5% -3.9pt) CI[35.8%,41.5%] → 有意だが差が小さい（-3.9pt < +5.0pt）→ 現行値を維持
  'MACDデッドクロス': 1,                // n=2935 48.6%(基準57.5% -9.0pt) CI[45.7%,51.4%] → 基準57.5%を下回る（-9.0pt）（旧2）
  'RSIダイバージェンス(弱気)': 1,           // n=1904 57.0%(基準57.5% -0.5pt) CI[53.4%,60.5%] → 基準57.5%と区別できない → 現行値を維持
  'RSIダイバージェンス(強気)': 1,           // n=3061 37.7%(基準42.5% -4.8pt) CI[35.0%,40.5%] → 有意だが差が小さい（-4.8pt < +5.0pt）→ 現行値を維持
  'RSI底値(20割れ)': 1,               // 該当なし → 現行値を維持
  'RSI過熱(80超)': 1,                // n=11 63.6%(基準57.5% +6.1pt) CI[23.5%,90.9%] → データ不足（11件 / 必要30件）現行値を維持
  'かぶせ線': 2,                      // n=671 60.8%(基準57.5% +3.3pt) CI[54.8%,66.5%] → 基準57.5%と区別できない → 現行値を維持
  'はらみ線(弱気)': 1,                  // n=2489 59.4%(基準57.5% +1.9pt) CI[56.3%,62.5%] → 基準57.5%と区別できない → 現行値を維持
  'はらみ線(強気)': 1,                  // n=4173 42.8%(基準42.5% +0.3pt) CI[40.4%,45.2%] → 基準42.5%と区別できない → 現行値を維持
  '三山(三尊天井)': 3,                  // n=695 66.3%(基準58.3% +8.0pt) CI[60.5%,71.7%] → 基準58.3%を上回る（+8.0pt）
  '三山(三点天井)': 3,                  // n=380 70.5%(基準58.3% +12.2pt) CI[62.8%,77.3%] → 基準58.3%を上回る（+12.2pt）
  '三川(逆三尊)': 3,                   // n=960 37.7%(基準41.7% -4.0pt) CI[33.0%,42.7%] → 基準41.7%と区別できない → 現行値を維持
  '三空叩き込み': 3,                    // n=4 100.0%(基準42.5% +57.5pt) CI[28.9%,100.0%] → データ不足（4件 / 必要30件）現行値を維持
  '三空踏み上げ': 3,                    // n=39 61.5%(基準57.5% +4.0pt) CI[37.3%,81.2%] → 基準57.5%と区別できない → 現行値を維持
  '三羽烏(黒三兵)': 2,                  // n=4917 56.5%(基準57.5% -1.0pt) CI[54.3%,58.7%] → 基準57.5%と区別できない → 現行値を維持
  '上げ三法': 2,                      // n=32 34.4%(基準41.7% -7.3pt) CI[14.7%,61.4%] → 基準41.7%と区別できない → 現行値を維持
  '上放れ二羽烏': 3,                    // n=177 64.4%(基準57.5% +6.9pt) CI[52.6%,74.7%] → 基準57.5%と区別できない → 現行値を維持
  '下げ三法': 2,                      // n=50 70.0%(基準58.3% +11.7pt) CI[47.9%,85.6%] → 基準58.3%と区別できない → 現行値を維持
  '先詰まり赤三兵(警戒)': 1,               // n=1272 61.5%(基準57.5% +4.0pt) CI[57.1%,65.7%] → 基準57.5%と区別できない → 現行値を維持
  '切り込み線': 3,                     // n=389 52.2%(基準42.5% +9.7pt) CI[44.3%,60.0%] → 基準42.5%を上回る（+9.7pt）（旧2）
  '包み線(弱気)': 2,                   // n=5026 60.0%(基準57.5% +2.5pt) CI[57.8%,62.1%] → 有意だが差が小さい（+2.5pt < +5.0pt）→ 現行値を維持
  '包み線(強気)': 2,                   // n=3226 45.9%(基準42.5% +3.4pt) CI[43.1%,48.6%] → 有意だが差が小さい（+3.4pt < +5.0pt）→ 現行値を維持
  '宵の明星': 3,                      // n=261 51.7%(基準57.5% -5.8pt) CI[42.1%,61.2%] → 基準57.5%と区別できない → 現行値を維持
  '捨て子線(宵)': 3,                   // n=1 100.0%(基準57.5% +42.5pt) CI[9.2%,100.0%] → データ不足（1件 / 必要30件）現行値を維持
  '捨て子線(明け)': 3,                  // n=5 20.0%(基準42.5% -22.5pt) CI[1.7%,78.0%] → データ不足（5件 / 必要30件）現行値を維持
  '明けの明星': 3,                     // n=321 48.6%(基準42.5% +6.1pt) CI[40.0%,57.3%] → 基準42.5%と区別できない → 現行値を維持
  '毛抜き天井': 1,                     // n=6650 59.1%(基準57.5% +1.6pt) CI[57.2%,61.0%] → 基準57.5%と区別できない → 現行値を維持
  '毛抜き底': 1,                      // n=6819 44.4%(基準42.5% +2.0pt) CI[42.6%,46.3%] → 有意だが差が小さい（+2.0pt < +5.0pt）→ 現行値を維持
  '赤三兵': 1,                       // n=3455 37.3%(基準42.5% -5.2pt) CI[34.8%,39.9%] → 基準42.5%を下回る（-5.2pt）（旧2）
};
// SIGNAL_WEIGHT_ AUTO-GENERATED END

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
// SIGNAL_WEIGHT_ 自体は npm run calc-weights（tools/calc_weights.js, decideWeight_/wilsonInterval_）で
// 実データから統計的に検証して決めている。順位付けに使わないのは suggestWeight_ の生の勝率
// （上記コメント参照。ベンチマーク未控除・有意性検定なし）であり、SIGNAL_WEIGHT_ とは別物。
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
    ['短期売買支援　使い方', 'title'],
    ['', 'p'],
    ['■ これは何？', 'h'],
    ['プライム全銘柄の日足を毎営業日の引け後に調べ、ダウ理論の上昇トレンドの押し目が', 'p'],
    ['フィボナッチの押し幅で止まって反転した銘柄を、1日最大5件の「買い推奨」として出します。', 'p'],
    ['見るのは「売買プラン」シート1枚だけです（買い推奨＋保有株）。投資助言ではありません。', 'note'],
    ['', 'p'],
    ['■ 買い推奨の条件（すべて満たしたもの）', 'h'],
    ['① 主要トレンドが上昇 … 大きな山谷（左右10日で確定）で安値が切り上がり、直近の上昇で高値を更新', 'p'],
    ['② 押しの深さ … 直近の上昇幅に対する押しが 23.6%〜78.6%（フィボナッチ）。78.6%超はトレンド否定に近い', 'p'],
    ['③ 押しの終わり … 押しの途中にできた小さな戻り高値を、当日の終値で初めて上抜けた', 'p'],
    ['④ 売買代金 … 直近20日の中央値が5,000万円以上（薄商いは除外）', 'p'],
    ['確度A … さらに「押し38.2%以上」かつ「当日の出来高が20日平均の1.5倍以上」のもの', 'p'],
    ['   （ダウ理論「出来高はトレンドを確認する」）。確度Aを先に、残りを出来高の多い順に最大5件。', 'p'],
    ['', 'p'],
    ['■ どのくらい当たるのか（過去10年・約1,200銘柄で検証）', 'h'],
    ['比較の基準は「同じ日に全銘柄を買って20営業日持った平均」です（相場全体の上げ下げを差し引くため）。', 'p'],
    ['・確度A … 基準より +0.4%（2016〜2021年）／ +1.8%（2022年〜）。10年中7年で基準を上回った', 'p'],
    ['   損切り・利確つきの成績は 勝率44〜48%・1回平均 +0.8%〜+2.6%（損益比が大きく、勝率5割未満でも残る型）', 'p'],
    ['・確度B … 基準とほぼ同じ（2016〜2021年は下回った）。5件に満たない日の穴埋めと考えてください', 'p'],
    ['・旧・酒田五法の★3買い … 基準より −0.4%〜−0.5%（両期間とも下回っていたため作り直しました）', 'p'],
    ['確度Aは平均すると1日0.5件（週2〜3件）です。出ない日もあります。', 'note'],
    ['※過去の成績は将来を保証しません。現在の上場銘柄だけで検証しているため、やや甘めに出ます。', 'note'],
    ['', 'p'],
    ['■ 「売買プラン」シート', 'h'],
    ['・区分「買い推奨A／B」… これから建てる銘柄。翌営業日の寄付で買い、利確と損切りをOCOで置きます', 'p'],
    ['   寄付が損切り以下、または利確以上で始まったら見送ってください（検証もそうしています）', 'p'],
    ['・区分「保有」… いま持っている全銘柄。これから置くべき返済売の2値（利確・損切り）を出します', 'p'],
    ['・損切り（OCO2）… 押し目の安値の少し下。割れたら安値切り上げが崩れる＝ダウ理論の否定', 'p'],
    ['・利確（OCO1）… 押し安値＋上昇幅×1.618（フィボナッチ・エクステンション）', 'p'],
    ['   どちらにも届かなければ40営業日で手仕舞い（検証の前提）', 'p'],
    ['・株数 … 損切りに当たったときの損失が許容額（既定3万円）に収まる最大株数。建玉上限は既定100万円', 'p'],
    ['   ※スクリプトプロパティ SAKATA_RISK_BUDGET_YEN / SAKATA_MAX_POSITION_YEN で変更できます', 'p'],
    ['・根拠 … 押しの深さと出来高倍率。メモには決算予定とBloombergの関連記事（あれば）も添えます', 'p'],
    ['・メモが「見送り」「算出不可」の行（淡赤）は発注しないでください。理由も同じ列に出ます', 'p'],
    ['・保有行でメモが「トレンド崩れ」（橙）… 押し安値割れを待たずに早期の手仕舞いも検討してください', 'p'],
    ['・コードを押すとTradingViewの日足チャートが開きます', 'p'],
    ['', 'p'],
    ['■ SBI証券で発注するとき（IFDOCO）', 'h'],
    ['・買い推奨の行は、SBIの国内株 IFDOCO 注文1本で置けます。メモに入力の仕方を書いています', 'p'],
    ['   新規＝成行（翌朝寄付）・株数＝「株数」列、OCO1＝「利確」の指値、OCO2＝「損切り」の逆指値（以下）で発動後は成行', 'p'],
    ['   期間＝「期間指定」でメモの日付（SBIの上限＝発注日を含めて15営業日）', 'p'],
    ['・失効しても残っている株は保有株として売買プランに載るので、その値でOCOを置き直してください', 'p'],
    ['・IFDOCOでは「寄付が損切り以下／利確以上なら見送る」が自動ではできません。気配を見て取り消してください', 'p'],
    ['・SBIには個人向けの発注APIが無いため、発注は手入力です（画面の自動操作は規約違反のおそれ）', 'p'],
    ['', 'p'],
    ['■ 通知メール（該当がある日だけ）', 'h'],
    ['・短期売買支援_買い推奨_N件 … 売買プランと同じ数字（買い・利確・損切り・株数）を載せます', 'p'],
    ['・短期売買支援_保有株トレンド崩れ_N件 … 上昇トレンドが崩れた保有株', 'p'],
    ['送信後は「利益累計」ラベルを付けて受信トレイからアーカイブします。', 'p'],
    ['', 'p'],
    ['■ ほかのシート・連動', 'h'],
    ['・投資デイリー分析 … 同じ買い推奨を「日本株_買い推奨」シートに書き込みます', 'p'],
    ['   （書き込み先はドライブ上の「投資デイリー分析」を自動で探します。名前が重複するときは', 'p'],
    ['    スクリプトプロパティ MARKET_BRIEFING_SS_ID にスプレッドシートIDを入れてください）', 'p'],
    ['・Bloomberg … Gmailに届く朝のニュースレター（直近3日）に推奨・保有銘柄の社名があれば、メモに見出しを添えます', 'p'],
    ['   最新号の5本は投資デイリー分析の「ニュース_Bloomberg」シートにも書き出します（毎朝7時半・走査完了時）', 'p'],
    ['   推奨の判定そのものには使っていません（ニュースは過去に遡って検証できないため）', 'p'],
    ['・相場マクロ … 地合いの参考表示（手入力＋自動取得）。推奨の判定には使っていません', 'p'],
    ['   （日経平均のトレンドで絞っても成績が変わらなかったため）', 'p'],
    ['・決算カレンダー … 14日先までの決算発表予定（edinetdb.jp、EDINETDB_API_KEY が必要）', 'p'],
    ['・「シグナル」「パターン成績」… 走査の作業用と旧集計。走査後は自動で非表示になります', 'p'],
    ['', 'p'],
    ['■ 自動実行', 'h'],
    ['メニュー「設定とメンテナンス」→「自動実行を設定」で設定します（休場日はスキップ）。', 'p'],
    ['・Bloombergニュース … 毎日7時半（朝6時ごろ届くニュースレターを投資デイリー分析へ）', 'p'],
    ['・相場マクロ・決算カレンダー … 毎日17時', 'p'],
    ['・全銘柄の走査 … 平日18時（引け後の確定値で判定。6分制限のため自動で分割・再開します）', 'p'],
    ['', 'p'],
    ['■ 用語', 'h'],
    ['ダウ理論 … 高値と安値がそろって切り上がっていれば上昇トレンド、とみなす考え方。', 'p'],
    ['   トレンドは転換のはっきりした合図が出るまで続く、とします。', 'p'],
    ['フィボナッチ … 上昇幅に対する押しの深さを 23.6%・38.2%・61.8%・78.6% などの比率で測る方法。', 'p'],
    ['スクリプトプロパティ … Apps Scriptに設定値（APIキー等）を保存する場所。', 'p'],
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

// ============================================================================
//  重み算出の再利用可能な純粋関数（tools/calc_weights.js から呼ばれる）
//  ---------------------------------------------------------------------------
//  ここにある buildDateCloseMap_/barDateKey_/benchmarkReturn_/extractMlRow_ は、
//  SIGNAL_WEIGHT_ を実データから算出する tools/calc_weights.js が本体と同じロジックを
//  使うために存在する（書き写しによる乖離を防ぐ）。GAS側の backtestWeights() 自体は
//  これらを使わず、従来の「パターン成績」集計のみを行う（参考値・順位には未使用）。
//
//  suggestWeight_ が廃止された4つの理由を、tools/calc_weights.js 側で構造的に潰している:
//    (1) ベンチマーク未控除 → 日経平均の同期間リターンを引いた「超過リターン」でラベル付け
//    (2) 連日重複でサンプル水増し → 評価期間が重なる再点灯はクールダウンで採らない
//    (3) 約定タイミングが粗い    → 翌日始値エントリー・h営業日後終値エグジット
//    (4) サンプル不足            → decideWeight_ で最低件数ゲートをかける
// ============================================================================

// Yahooのバー配列から「YYYY-MM-DD → 終値」のマップを作る。
// 銘柄側のバーは休止日などで欠けることがあるので、指数との対応は配列位置ではなく日付で取る。
function buildDateCloseMap_(bars) {
  const map = {};
  (bars || []).forEach(b => { if (b && b.t != null) map[barDateKey_(b)] = b.c; });
  return map;
}

// バーのUNIX秒からJSTの日付キーを作る。指数と銘柄で同じ関数を通すことで対応がずれない。
function barDateKey_(bar) {
  return Utilities.formatDate(new Date(bar.t * 1000), 'Asia/Tokyo', 'yyyy-MM-dd');
}

/**
 * ベンチマーク（日経平均）の同区間リターン。
 * 該当日が指数側に無ければ null を返し、呼び出し側で行ごと捨てる。
 * 「取れなかった日を0%として扱う」と、控除しないのと同じ歪みが入るため。
 */
function benchmarkReturn_(idxByDate, entryKey, exitKey) {
  const e0 = idxByDate[entryKey], e1 = idxByDate[exitKey];
  if (e0 == null || e1 == null || !(e0 > 0)) return null;
  return (e1 - e0) / e0;
}

/**
 * 1つのシグナル発生イベントから学習データ1行を作る。採用しない場合は null。
 *
 * bars: 古い→新しい順の全期間バー。i: シグナル確定日のインデックス。
 * lastFire: 「コード|パターン名」→ 直近に採用したインデックス（クールダウン判定用の状態）。
 */
function extractMlRow_(params) {
  const bars = params.bars, i = params.i, sig = params.sig, code = params.code;
  const lastFire = params.lastFire, idxByDate = params.idxByDate;
  const rsi = params.rsi, macd = params.macd;

  const sign = sig.dir === '買い' ? 1 : sig.dir === '売り' ? -1 : 0;
  if (!sign) return null;

  // (2) クールダウン: 前回採用から評価ホライズン未満なら採らない。
  // 連日点灯するパターンをそのまま数えると、評価期間が重なる＝ほぼ同じ値動きを
  // 何度も学習することになり、実効サンプル数が水増しされる。
  const h = signalHorizon_(sig.name);
  const key = code + '|' + sig.name;
  if (lastFire[key] != null && (i - lastFire[key]) < h) return null;

  // (3) 約定タイミング: 走査は終値確定後なので、現実の約定は翌営業日の寄付。
  const entryIdx = i + 1, exitIdx = i + 1 + h;
  if (exitIdx > bars.length - 1) return null;
  const entryBar = bars[entryIdx], exitBar = bars[exitIdx];
  const entry = entryBar.o, exit = exitBar.c;
  if (!(entry > 0) || !(exit > 0)) return null;

  // (1) ベンチマーク控除: 銘柄の方向調整後リターンから、指数の同区間リターンを同じ向きで引く。
  const bench = benchmarkReturn_(idxByDate, barDateKey_(entryBar), barDateKey_(exitBar));
  if (bench == null) return null;
  const stockRet = (exit - entry) / entry * sign;
  const excess = stockRet - bench * sign;

  lastFire[key] = i;
  const mh = (macd && macd.macd[i] != null && macd.signal[i] != null) ? macd.macd[i] - macd.signal[i] : '';
  return [
    barDateKey_(bars[i]), code, sig.name, sig.dir, patternPoints_(sig.name),
    (rsi && rsi[i] != null) ? Math.round(rsi[i] * 100) / 100 : '',
    (macd && macd.macd[i] != null) ? Math.round(macd.macd[i] * 10000) / 10000 : '',
    (mh === '') ? '' : Math.round(mh * 10000) / 10000,
    Math.round(entry * 100) / 100, Math.round(exit * 100) / 100,
    Math.round(bench * 10000) / 10000, Math.round(stockRet * 10000) / 10000,
    Math.round(excess * 10000) / 10000,
    excess > 0 ? 1 : 0, h,
  ];
}

// 過去6ヶ月バックテスト（時間分割・自動再開）。各パターンの N日後リターン実績を集計し成績DBを自動更新。
// 実行記録（効率化KPI、共通モジュール RunLog.js）で包んだ入口。本体は backtestWeightsRun_
function backtestWeights() { return runLogged_('重みバックテスト', () => backtestWeightsRun_()); }
function backtestWeightsRun_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    // 以前はログだけで黙って return しており、自動再開トリガーが scanSignals 等と衝突すると
    // 集計が再開されないまま気づかれなかった（scanSignals の同種不具合と同じ構造）。次回に持ち越す。
    Logger.log('別の処理が進行中のためスキップ（90秒後に再試行）');
    clearBtResume_();
    ScriptApp.newTrigger('backtestWeights').timeBased().after(90 * 1000).create();
    return;
  }

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
    ss.toast('パターン成績の集計を開始（自動再開で完走します）', APP_NAME_, 5);
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
    resps.forEach((res, si) => {
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
    ss.toast('成績集計 ' + cursor + '/' + total + '銘柄。自動再開します', APP_NAME_, 8);
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
    ss.toast('パターン成績を更新しました（参考値・順位には未使用）', APP_NAME_, 8);
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

// ============================================================================
//  売買プラン（ダウ理論ベースの 買い / 利確 / 損切り）
//  ---------------------------------------------------------------------------
//  買い推奨（DowFib.js、最大5件）と、いま保有している全銘柄を
//  「売買プラン」シート1枚に並べる。価格の見出しには対応するSBI注文画面の欄名
//  （OCO1/OCO2）を添えてあるので、画面を見ながらそのまま転記できる。
//
//  買い推奨 … これから建てる銘柄。値は dfOrderPlan_（DowFib.js）が出す。
//  保有     … すでに建っている銘柄。以下の buildOrderPlan_ で、
//             これから置くべき返済売の2値（利確・損切り）を計算する。
//
//  なぜダウ理論か:
//    ダウ理論では上昇トレンドを「高値切り上げ・安値切り上げ」で定義し、
//    トレンドは明確な転換シグナルが出るまで継続するとみなす。
//    裏を返すと「直近の押し安値を割った時点で上昇トレンドは否定された」ので、
//    そこが最も理屈の通った損切り位置になる。利確側にはダウ理論由来の水準が無いため、
//    損切り幅に対する固定比率（SK.ORDER.RR）で置く。
//
//  ※ 出てくる数字は「シグナルの前提が崩れる水準」であって、値上がりの保証ではない。
// ============================================================================

/**
 * 東証の呼値（通常銘柄）。
 * TOPIX100構成銘柄は刻みがさらに細かいが、通常銘柄の刻みは全価格帯で
 * TOPIX100の刻みの整数倍になっているため、粗い方（通常銘柄）で丸めておけば
 * どちらの銘柄でも板に乗る値段になる。構成銘柄リストを持たずに済ませるための選択。
 */
function tickSize_(price) {
  const p = Number(price);
  if (!(p > 0)) return 1;
  if (p <= 3000) return 1;
  if (p <= 5000) return 5;
  if (p <= 30000) return 10;
  if (p <= 50000) return 50;
  if (p <= 300000) return 100;
  if (p <= 500000) return 500;
  if (p <= 3000000) return 1000;
  if (p <= 5000000) return 5000;
  return 10000;
}

/**
 * 呼値に丸める。dir='down' なら切り捨て、'up' なら切り上げ。
 * 買いの指値・利確・損切りは切り捨て、逆指値の買いだけは切り上げる
 * （切り捨てると狙った水準より手前で発動してしまうため）。
 */
function roundToTick_(price, dir) {
  const t = tickSize_(price);
  const q = price / t;
  // 1595.5/0.5 のような割り切れる値が浮動小数で 3190.9999… になり、
  // 切り捨てで1ティック下にずれるのを防ぐ。
  const n = dir === 'up' ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9);
  return Math.round(n * t * 1e6) / 1e6;
}

// 値幅制限（JPX）。[基準値段の上限（未満）, 制限値幅]。
const PRICE_LIMIT_TABLE_ = [
  [100, 30], [200, 50], [500, 80], [700, 100], [1000, 150], [1500, 300],
  [2000, 400], [3000, 500], [5000, 700], [7000, 1000], [10000, 1500],
  [15000, 3000], [20000, 4000], [30000, 5000], [50000, 7000], [70000, 10000],
  [100000, 15000], [150000, 30000], [200000, 40000], [300000, 50000],
  [500000, 70000], [700000, 100000], [1000000, 150000], [1500000, 300000],
  [2000000, 400000], [3000000, 500000], [5000000, 700000], [7000000, 1000000],
  [10000000, 1500000], [15000000, 3000000], [20000000, 4000000],
  [30000000, 5000000], [50000000, 7000000],
];

/**
 * その日の制限値幅。基準値段は前営業日の終値＝走査に使った最終足の終値。
 * 大引け後に翌営業日の注文を出す前提なので、最終足の終値がそのまま基準値段になる。
 * 利確・損切りがこの外に出ていると、その値段では発注自体ができない。
 */
function priceLimit_(base) {
  const b = Number(base);
  let w = 10000000;
  for (let i = 0; i < PRICE_LIMIT_TABLE_.length; i++) {
    if (b < PRICE_LIMIT_TABLE_[i][0]) { w = PRICE_LIMIT_TABLE_[i][1]; break; }
  }
  return { low: Math.max(b - w, 1), high: b + w, width: w };
}

/**
 * ダウ理論のスイング（確定した高値・安値）と、そこから導かれるトレンド。
 * findExtrema_ は左右 w 本より高い（低い）足だけを極値とするので、
 * 右側 w 本が埋まるまで確定しない＝あとから位置が動かない。
 */
function dowSwings_(bars, w) {
  const out = { high: null, low: null, prevHigh: null, prevLow: null,
                highIdx: null, lowIdx: null, trend: 'レンジ' };
  if (!bars || bars.length < w * 2 + 3) return out;
  const highs = bars.map(b => b.h), lows = bars.map(b => b.l);
  const pk = findExtrema_(highs, w, true);
  const tr = findExtrema_(lows, w, false);
  if (pk.length)      { out.highIdx = pk[pk.length - 1]; out.high = highs[out.highIdx]; }
  if (pk.length >= 2) { out.prevHigh = highs[pk[pk.length - 2]]; }
  if (tr.length)      { out.lowIdx = tr[tr.length - 1];  out.low  = lows[out.lowIdx]; }
  if (tr.length >= 2) { out.prevLow  = lows[tr[tr.length - 2]]; }
  // 高値・安値がそろって切り上がっていれば上昇、そろって切り下がっていれば下降。
  // 片方だけの切り上げ（切り下げ）はダウ理論ではトレンドと呼ばない。
  if (out.high != null && out.prevHigh != null && out.low != null && out.prevLow != null) {
    if (out.high > out.prevHigh && out.low > out.prevLow) out.trend = '上昇';
    else if (out.high < out.prevHigh && out.low < out.prevLow) out.trend = '下降';
  }
  return out;
}

/**
 * 押し安値＝「割れたら上昇トレンドが否定される安値」。
 *
 * 確定スイング安値そのものではなく、そこから最終足までの最安値を使う。
 * 確定スイング安値だけを見ると、その後さらに切り下げた足（右側 w 本が
 * まだ無くスイングと認定できない足）を無視することになり、明けの明星のような
 * 大底の転換シグナルでは損切りが現値より上に来てしまう。
 */
function pullbackLow_(bars, sw) {
  if (!bars || !bars.length || sw.lowIdx == null) return null;
  let m = Infinity;
  for (let i = sw.lowIdx; i < bars.length; i++) m = Math.min(m, bars[i].l);
  return isFinite(m) ? m : null;
}

// SK.ORDER にスクリプトプロパティの上書きを反映した設定を返す。
// 許容損失額と建玉上限は人によって違うので、コードを触らず変えられるようにしている。
function orderConfig_() {
  const cfg = {};
  Object.keys(SK.ORDER).forEach(k => { cfg[k] = SK.ORDER[k]; });
  try {
    const p = PropertiesService.getScriptProperties();
    const num = (key, def) => {
      const v = Number(p.getProperty(key));
      return (isFinite(v) && v > 0) ? v : def;
    };
    cfg.RISK_BUDGET_YEN  = num('SAKATA_RISK_BUDGET_YEN',  cfg.RISK_BUDGET_YEN);
    cfg.MAX_POSITION_YEN = num('SAKATA_MAX_POSITION_YEN', cfg.MAX_POSITION_YEN);
  } catch (e) {
    Logger.log('売買プランの設定読み込みに失敗（既定値で継続）: ' + e.message);
  }
  return cfg;
}

/**
 * ダウ理論から 買い・利確・損切り・株数 を計算する。GAS非依存の純関数。
 *
 *   損切り  = 押し安値の1ティック下（＝上昇トレンド否定の水準）
 *             ただし ATR14×MIN_STOP_ATR より近い場合はそこまで広げる
 *   買い    = 上昇トレンド継続中なら現値の指値（押し目待ち）
 *             まだトレンド転換が確定していなければ、直近の戻り高値を上抜けた
 *             ところの逆指値（＝ダウ理論で転換が確定する水準）
 *   利確    = 基準価格 + 損切り幅 × RR
 *   株数    = 許容損失額に収まる最大株数（LOT単位・建玉上限で頭打ち）
 *
 * pos（{shares, cost}）を渡すと保有株モードになり、買値と株数の逆算は行わない。
 * すでに建っているのでリスクの起点（basis）は買値ではなく現在値になり、
 * 出すのは返済売の2値（利確・損切り）だけになる。
 *
 * 成立しない場合は ok:false と reason を返す（黙って0を出すと発注してしまうため）。
 */
function buildOrderPlan_(bars, cfg, pos) {
  const c = cfg || orderConfig_();
  const held = !!pos;   // 保有株モード（新規の買値は出さず、返済売の2値だけを出す）
  const out = {
    ok: false, reason: '', notes: [], held: held,
    close: null, trend: '', pullbackLow: null, swingHigh: null,
    entryType: '', entry: null, basis: null, target: null, stop: null, stopLimit: null,
    shares: 0, riskPerShare: 0, lossYen: 0, profitYen: 0, rr: 0,
    limitLow: null, limitHigh: null,
  };
  if (!bars || bars.length < c.SWING_W * 2 + 5) { out.reason = '足が不足（スイングを確定できない）'; return out; }

  const close = bars[bars.length - 1].c;
  out.close = close;
  const lim = priceLimit_(close);
  out.limitLow = lim.low; out.limitHigh = lim.high;

  const sw = dowSwings_(bars, c.SWING_W);
  out.trend = sw.trend;
  out.swingHigh = sw.high;

  const pl = pullbackLow_(bars, sw);
  if (pl == null) { out.reason = '押し安値を特定できない（確定スイング安値なし）'; return out; }
  out.pullbackLow = pl;

  // --- 買い（基準価格）-----------------------------------------------------
  // basis は「リスクを測る起点」。新規はこれから建てる買値、保有はいまの値段
  // （すでに建っているので、これから失いうるのは現在値から損切りまでの下落分）。
  if (held) {
    out.entryType = '';
    out.basis = roundToTick_(close, 'down');
  } else if (sw.trend === '上昇' || sw.high == null || sw.high <= close) {
    // 高値・安値とも切り上がっている＝トレンドは継続中。追いかけずに現値の指値で待つ。
    // 直近の戻り高値を既に上抜けている場合も、上抜けを待つ意味が無いのでこちら。
    out.entryType = '指値';
    out.entry = out.basis = roundToTick_(close, 'down');
  } else {
    // まだ高値切り上げが確認できていない。戻り高値を上抜けて初めてダウ理論上の
    // 転換が確定するので、そこに逆指値を置いて「確定してから乗る」。
    out.entryType = '逆指値';
    out.entry = out.basis = roundToTick_(sw.high + tickSize_(sw.high), 'up');
  }

  // 呼値に丸めた結果が0以下になるのは1円未満の異常値のときだけだが、
  // そのまま進むと株数の計算が0除算でInfinityになり、巨大な株数が出てしまう。
  if (!(out.basis > 0)) { out.reason = '買値を算定できない（呼値に丸めると0以下）'; return out; }

  // --- 損切り -------------------------------------------------------------
  let stop = pl - tickSize_(pl);
  const a = atr_(bars, 14, 0);
  const minDist = a * c.MIN_STOP_ATR;
  if (minDist > 0 && (out.basis - stop) < minDist) {
    stop = out.basis - minDist;
    out.notes.push('損切り幅をATR14×' + c.MIN_STOP_ATR + 'まで拡大');
  }
  stop = roundToTick_(stop, 'down');
  out.stop = stop;

  const risk = out.basis - stop;
  if (!(risk > 0)) { out.reason = '押し安値が基準価格以上（損切りをその下に置けない）'; return out; }
  out.riskPerShare = risk;

  // 逆指値がヒットした後に出す指値。成行だと滑るが、トリガーと同値だと約定しないことがある。
  out.stopLimit = roundToTick_(stop - tickSize_(stop) * c.STOP_SLIP_TICKS, 'down');

  // --- 利確 ---------------------------------------------------------------
  out.target = roundToTick_(out.basis + risk * c.RR, 'down');
  out.rr = Math.round(((out.target - out.basis) / risk) * 100) / 100;

  // --- 株数 ---------------------------------------------------------------
  if (held) {
    // 保有株はもう建っているので逆算しない。数量が取れなければ価格だけ出す
    // （0株として損切り額0円と表示すると、リスクが無いように見えてしまう）。
    out.shares = (pos.shares > 0) ? pos.shares : 0;
    if (!out.shares) out.notes.push('保有株数を取得できず損切り額は未計算');
  } else {
    const lot = c.LOT;
    const byRisk = Math.floor(c.RISK_BUDGET_YEN / risk / lot) * lot;
    const byCap  = Math.floor(c.MAX_POSITION_YEN / out.basis / lot) * lot;
    const shares = Math.min(byRisk, byCap);
    if (shares < lot) {
      // どちらの制約で建てられないのかを書き分ける。まとめて「リスク過大」と出すと、
      // 実際には値がさ株で建玉上限に当たっているだけのときに損切り幅を疑ってしまう。
      out.reason = (byCap < lot)
        ? '建玉上限（' + fmtNum_(c.MAX_POSITION_YEN) + '円）では買値' + fmtNum_(out.basis)
          + '円の' + lot + '株を建てられない'
        : 'リスク過大（1株あたり' + fmtNum_(Math.round(risk)) + '円の損切り幅では、'
          + '許容損失' + fmtNum_(c.RISK_BUDGET_YEN) + '円で' + lot + '株も建てられない）';
      return out;
    }
    if (byCap < byRisk) out.notes.push('建玉上限で株数を抑制');
    out.shares = shares;
  }
  out.lossYen   = out.shares ? Math.round(risk * out.shares) : 0;
  out.profitYen = out.shares ? Math.round((out.target - out.basis) * out.shares) : 0;

  // 制限値幅の外は、その値段では発注できない（クリップせず注意書きにとどめる。
  // 勝手に丸めるとダウ理論上の水準と違う数字を出すことになるため）。
  if (out.target > lim.high) out.notes.push('利確が制限値幅の上限外（当日は発注不可）');
  if (out.stop   < lim.low)  out.notes.push('損切りが制限値幅の下限外（当日は発注不可）');

  out.ok = true;
  return out;
}

// ---------------------------------------------------------------------------
//  シート出力（買い推奨＋保有株の1枚）
// ---------------------------------------------------------------------------

// 「売買プラン」シートの列。日々これ1枚を見れば発注できる粒度に絞る。
// 価格3つの見出しには対応するSBI注文画面の欄名を添える（転記先を迷わないため）。
// 11列目（メモ）は AiRecommend.js が書き換える列なので、列の並びは変えないこと。
const PLAN_HEADERS_ = [
  '区分', 'コード', '銘柄名', '現在値', '株数',
  '買い(価格)', '利確(OCO1)', '損切り(OCO2)', '損切り額', '根拠', 'メモ',
];

/**
 * コードを「TradingViewへのリンクが張られた文字列セル」にする RichTextValue を作る。
 *
 * セルの値は文字列型のまま（=HYPERLINK の数式にしない）。数式にすると "5602" が
 * 数値として評価され、桁区切りで 5,602 と表示されたり、先頭0が落ちたりする。
 * 空コードは空文字（リンクなし）を返す。
 */
function codeLinkRichText_(code) {
  const s = String(code || '');
  const b = SpreadsheetApp.newRichTextValue().setText(s);
  if (s) b.setLinkUrl(tvChartUrl_(s));
  return b.build();
}

// TradingView 日足チャートのURL。個人のレイアウトIDはスクリプトプロパティで差し替え可。
function tvChartUrl_(code) {
  const TV = PropertiesService.getScriptProperties().getProperty('TRADINGVIEW_LAYOUT_ID') || '';
  return TV
    ? `https://jp.tradingview.com/chart/${TV}/?symbol=TSE:${code}&interval=D`
    : `https://jp.tradingview.com/chart/?symbol=TSE:${code}&interval=D`;
}

function fmtNum_(v) {
  if (v == null || !isFinite(v)) return '';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * 売買プランの対象を組み立てる。買い推奨（最大5件）が先、保有株が後。
 *
 * 保有中の銘柄は買い推奨から外し「保有」1行にまとめる。すでに持っている銘柄で
 * まずやることは新規建てではなく返済売の置き直しなので、買いプランを併記すると
 * どちらを実行すべきか迷う。買い増し候補であることはメモに残す。
 */
function planTargets_(cands, held) {
  const codes = held && held.codes ? held.codes : new Set();
  const positions = (held && held.positions) || {};
  const byCode = {};
  cands.forEach(c => { byCode[c.code] = c; });

  const buys = topPicks_(cands, codes).map(c => ({
    kind: '買い推奨' + c.setup.grade, pick: true, grade: c.setup.grade,
    code: c.code, name: c.name, setup: c.setup, reason: c.reason, pos: null, extra: [],
  }));

  const holds = [];
  codes.forEach(code => {
    const c = byCode[code];
    holds.push({
      kind: '保有', pick: false, code: code, name: c ? c.name : '', reason: c ? c.reason : '',
      note: c ? '買い推奨の条件にも該当（買い増し候補・確度' + c.setup.grade + '）' : '',
      pos: positions[code] || { shares: 0, cost: null }, extra: [],
    });
  });
  holds.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return buys.concat(holds);
}

// 1銘柄ぶんのシート行。算出できなかった場合も、そこまでで計算できた価格はメモの理由とあわせて出す。
function planRow_(t, p, expiryLabel) {
  const held = t.kind === '保有';
  const pos = t.pos || {};
  const extra = t.extra || [];
  if (!p || !p.ok) {
    const why = (p && p.reason) ? p.reason : '株価を取得できず未計算';
    return [t.kind, t.code, t.name, p ? p.close : '', held ? (pos.shares || '') : '',
      held ? (pos.cost || '') : (p && p.entry != null ? p.entry : ''),
      (p && p.target != null) ? p.target : '',
      (p && p.stop != null) ? p.stop : '',
      '', t.reason || '',
      [(held ? '算出不可：' : '見送り：') + why].concat(extra).join('／')];
  }
  const notes = [];
  if (held) {
    // 保有株はトレンドが崩れた時点（高値・安値の切り上げが揃わなくなった時点）で、
    // 押し安値割れを待たずに手仕舞いを検討する材料として先頭に出す。
    if (p.trend !== '上昇') notes.push('トレンド崩れ（' + p.trend + '）: 押し安値を待たず早期手仕舞いも検討');
    if (t.note) notes.push(t.note);
    notes.push('押し安値' + fmtNum_(p.pullbackLow) + '割れで手仕舞い');
  } else {
    notes.push('翌朝の寄付で買い・最長' + DF.HOLD_DAYS + '営業日');
    // SBIの IFDOCO 1本で置くときの入力（価格・株数は同じ行の列）。別シートに分けない
    if (expiryLabel) {
      notes.push('SBIはIFDOCO：新規 成行・期間指定 ' + expiryLabel + '・損切りは発動後 成行');
      notes.push('寄付が損切り以下か利確以上なら取消');
      notes.push(IFDOCO_MAX_DAYS_ + '営業日で失効したら保有欄の値でOCOを置き直す');
    }
  }
  p.notes.forEach(n => notes.push(n));
  extra.forEach(n => notes.push(n));

  return [t.kind, t.code, t.name, p.close,
    p.shares || '',
    held ? (pos.cost || '') : p.entry,
    p.target, p.stop, p.lossYen || '', t.reason || '', notes.join('／')];
}

/**
 * 決算発表の予定と Bloomberg の記事を、該当銘柄のメモに添える材料として集める。
 * どちらも取れなければ何も足さない（推奨の判定そのものには使っていない）。
 */
function attachPlanExtras_(targets) {
  if (!targets.length) return;
  const codes = targets.map(t => t.code);
  try {
    const calRows = fetchEarningsCalendarRows_();
    const cal = calRows ? calendarMapFromEntries_(filterCalendarToUniverse_(calRows, codes)) : null;
    if (cal) targets.forEach(t => {
      if (cal[t.code]) t.extra.push('決算 ' + cal[t.code].date + '(' + calendarStatusLabel_(cal[t.code].dateStatus) + ')');
    });
  } catch (e) { Logger.log('決算予定の取得に失敗（メモに載せずに続行）: ' + e.message); }
  try {
    const texts = bloombergTexts_();
    targets.forEach(t => {
      const hit = bloombergMention_(texts, t.name);
      if (hit) t.extra.push('Bloomberg: ' + hit);
    });
  } catch (e) { Logger.log('Bloombergメールの読み込みに失敗（メモに載せずに続行）: ' + e.message); }
}

/**
 * 対象銘柄の売買プランを計算し、「売買プラン」シートへ書き出す。
 * 買い推奨は走査時の値（候補シート）から計算し、保有株は日足を取り直して buildOrderPlan_ で計算する。
 * 戻り値は コード→plan のマップ（メールが同じ数字を載せるために使う）。
 */
function writePlanSheet_(targets) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SK.SHEETS.PLAN);
  if (!sh) sh = ss.insertSheet(SK.SHEETS.PLAN);
  // 売買プランは1枚にまとめる（ユーザー指示）。一時期だけ作っていた別シートが残っていれば消す。
  // 中身は売買プランと同じ数字の写しなので、消しても失うものはない。
  const leftover = ss.getSheetByName('IFDOCO入力');
  if (leftover) ss.deleteSheet(leftover);
  const oldFilter = sh.getFilter(); if (oldFilter) oldFilter.remove();
  sh.clear();
  sh.getRange(1, 1, 1, PLAN_HEADERS_.length).setValues([PLAN_HEADERS_]);
  sh.setTabColor('#1b7a3d');
  // 12列目（L1）に要約。ヘッダーは11列目（メモ）までなので空いている列に置く。
  // 開いた瞬間に「今日は何件あって、そのうち確度Aは何件か」が分かるようにする。
  sh.getRange(1, 12).setValue(planSummary_(targets))
    .setFontColor('#1a7f37').setFontWeight('bold');
  // 売買プランを一番左のタブにする（毎日見るのはこの1枚だけ）
  try { ss.setActiveSheet(sh); ss.moveActiveSheet(1); } catch (e) { /* 並び替えに失敗しても内容は正しい */ }

  const plans = {};
  if (!targets.length) {
    sh.getRange(2, 1).setValue('本日の買い推奨はありません（保有銘柄もありません）');
    styleSheet_(sh, PLAN_HEADERS_.length, '#14331f', '#eaf6ee');
    return plans;
  }

  const cfg = orderConfig_();
  const expiry = Utilities.formatDate(ifdocoExpiry_(new Date(), IFDOCO_MAX_DAYS_, isBusinessDay_), 'JST', 'yyyy/MM/dd');
  const holds = targets.filter(t => !t.pick);
  const resps = holds.length
    ? (fetchAllWithRetry_(holds.map(t => yahooChartRequest_(t.code, SK.YAHOO_RANGE))) || []) : [];
  const holdPlan = {};
  holds.forEach((t, i) => {
    const res = resps[i];
    const bars = (res && res.getResponseCode() === 200) ? parseYahooBars_(res) : [];
    holdPlan[t.code] = bars.length ? buildOrderPlan_(bars, cfg, t.pos) : null;
  });

  const rows = targets.map(t => {
    const p = t.pick ? Object.assign({ held: false }, dfOrderPlan_(t.setup, cfg)) : holdPlan[t.code];
    if (p) plans[t.code] = p;
    return planRow_(t, p, expiry);
  });

  const n = rows.length;
  sh.getRange(2, 1, n, PLAN_HEADERS_.length).setValues(rows);
  // コード列はリンク付きテキスト（値は文字列型のまま）
  sh.getRange(2, 2, n, 1).setNumberFormat('@')
    .setRichTextValues(targets.map(t => [codeLinkRichText_(t.code)]));

  styleSheet_(sh, PLAN_HEADERS_.length, '#14331f', '#eaf6ee');
  autoFit_(sh, 5);
  [4, 6, 7, 8].forEach(col => sh.getRange(2, col, n, 1).setNumberFormat('#,##0.##'));
  [5, 9].forEach(col => sh.getRange(2, col, n, 1).setNumberFormat('#,##0'));
  sh.getRange(2, 1, n, 1).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(2, 2, n, 1).setHorizontalAlignment('right');
  sh.getRange(2, 9, n, 1).setFontColor('#c0392b');    // 損切り額は赤（失う側の金額だと分かるように）
  sh.setColumnWidth(10, 220); sh.getRange(2, 10, n, 1).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(11, 320); sh.getRange(2, 11, n, 1).setWrap(true).setVerticalAlignment('top');

  const all = sh.getRange(2, 1, n, PLAN_HEADERS_.length);
  const kind = sh.getRange(2, 1, n, 1);
  sh.setConditionalFormatRules([
    // 価格が出せなかった行は淡赤で潰す（発注してよい行と一目で区別するため）
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=OR(LEFT($K2,3)="見送り",LEFT($K2,4)="算出不可")')
      .setBackground('#f6e3e3').setFontColor('#8a3a3a').setRanges([all]).build(),
    // 保有株でトレンドが崩れた行を橙で目立たせる
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=LEFT($K2,6)="トレンド崩れ"')
      .setBackground('#fde9d9').setFontColor('#b35900').setBold(true).setRanges([all]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('買い推奨A').setBackground('#c9ecd5').setFontColor('#0f5a2b').setBold(true)
      .setRanges([kind]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('買い推奨B').setBackground('#eef7f1').setFontColor('#1b7a3d')
      .setRanges([kind]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('保有').setBackground('#fff3da').setFontColor('#8a6100').setBold(true)
      .setRanges([kind]).build(),
  ]);
  sh.getRange(1, 1, n + 1, PLAN_HEADERS_.length).createFilter();
  // 横に長いので、見出し行と「区分・コード・銘柄名」を固定してスクロールしても行が分かるようにする
  sh.setFrozenRows(1);
  sh.setFrozenColumns(3);
  sh.setRowHeightsForced(2, n, 42);
  return plans;
}

// 売買プランの要約（L1セル）。純関数。
function planSummary_(targets) {
  const picks = (targets || []).filter(t => t.pick);
  const a = picks.filter(t => t.grade === 'A').length;
  const holds = (targets || []).length - picks.length;
  return Utilities.formatDate(new Date(), 'JST', 'MM/dd HH:mm') + ' 更新｜買い推奨 ' + picks.length + '件'
    + (picks.length ? '（確度A ' + a + '件）' : '（本日は条件を満たす銘柄なし）')
    + '｜保有 ' + holds + '件';
}

// 候補シートと保有銘柄から売買プランを作り直す（走査完了時とメニューの両方から呼ぶ）。
// 戻り値 { targets, plans }（メールと投資デイリー分析への連動が同じ内容を使う）。
function buildPlansFromSignals_(sig) {
  const cands = readCandidates_(sig);
  let held = { codes: new Set(), positions: {}, reason: null };
  try {
    held = getSbiHeldCodes_();
    if (held.reason) Logger.log('保有株を売買プランに載せられません: ' + held.reason);
  } catch (e) {
    // 参照元の権限切れ等。買い推奨だけでもプランは出したいので止めない。
    Logger.log('保有銘柄の取得に失敗（買い推奨のみで継続）: ' + e.message);
  }
  rememberSpreadsheetId_();   // スマホ用Webメニュー（WebMenu.js）が開けなかったときの予備
  const targets = planTargets_(cands, held);
  attachPlanExtras_(targets);
  return { targets: targets, plans: writePlanSheet_(targets) };
}

// ---------------------------------------------------------------------------
//  SBI証券の IFDOCO 注文（売買プランのメモに入力の仕方を添える）
//  SBI証券には個人向けの発注APIが無いので、発注は人が注文画面で行う。
//  買い推奨1件を IFDOCO 1本（新規の成行買い＋利確の指値＋損切りの逆指値）で置けば、
//  あとは約定も手仕舞いも自動で進む。別シートには分けず、売買プランの行に書く。
// ---------------------------------------------------------------------------

// SBIの「期間指定」は発注日を含めて最長15営業日。
const IFDOCO_MAX_DAYS_ = 15;

/**
 * 期間指定に入れる最終日（発注日を含めて n 営業日目）。純関数（営業日判定は引数で受け取る）。
 * 引け後に作るので、今日が営業日なら今日を1日目に数える。夜間の注文を SBI が
 * 翌営業日扱いにしても、1日短くなるだけで画面ではじかれることはない（長く数えると拒否される）。
 */
function ifdocoExpiry_(from, n, isBiz) {
  const d = new Date(from.getTime());
  let count = 0;
  for (let guard = 0; guard < 60; guard++) {
    if (isBiz(d)) { count++; if (count >= n) return d; }
    d.setDate(d.getDate() + 1);
  }
  return d;
}

// ---------------------------------------------------------------------------
//  投資デイリー分析（MarketBriefing）への連動
// ---------------------------------------------------------------------------
const BRIEFING_SHEET_ = '日本株_買い推奨';

const BRIEFING_FILE_NAME_ = '投資デイリー分析';

/**
 * 投資デイリー分析のスプレッドシートID。スクリプトプロパティ MARKET_BRIEFING_SS_ID を優先し、
 * 無ければドライブをファイル名で探して見つかったIDを保存する（個人のシートIDをソースに書かないため）。
 */
function briefingSpreadsheetId_() {
  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('MARKET_BRIEFING_SS_ID');
  if (saved) return saved;
  const res = Drive.Files.list({
    q: "name = '" + BRIEFING_FILE_NAME_ + "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and 'me' in owners",
    fields: 'files(id,name)', pageSize: 2,
  });
  const files = (res && res.files) || [];
  if (files.length !== 1) {
    Logger.log('「' + BRIEFING_FILE_NAME_ + '」が' + files.length + '件見つかったため連動をスキップ（MARKET_BRIEFING_SS_ID で指定してください）');
    return null;
  }
  props.setProperty('MARKET_BRIEFING_SS_ID', files[0].id);
  return files[0].id;
}

/**
 * 買い推奨を「投資デイリー分析」スプレッドシートの専用シートへ書き出す。
 * このシートは本スクリプトだけが書く（MarketBriefing 側は触らない）。
 */
function writeBriefingPicks_(targets, plans) {
  const id = briefingSpreadsheetId_();
  if (!id) return;
  const ss = SpreadsheetApp.openById(id);
  const sh = ss.getSheetByName(BRIEFING_SHEET_) || ss.insertSheet(BRIEFING_SHEET_);
  sh.clear();
  sh.getRange(1, 1).setValue('更新: ' + Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm') + ' JST（' + APP_NAME_ + 'の走査結果）');
  const header = ['確度', 'コード', '銘柄名', '終値', '買い', '利確', '損切り', '根拠'];
  sh.getRange(2, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#14331f').setFontColor('#ffffff');
  const rows = briefingRows_(targets, plans);
  if (rows.length) sh.getRange(3, 1, rows.length, header.length).setValues(rows);
  else sh.getRange(3, 1).setValue('本日の買い推奨はありません');
  sh.getRange(3 + Math.max(rows.length, 1) + 1, 1).setValue('【免責】情報提供目的です。投資助言ではありません。');
  if (rows.length) [4, 6, 7].forEach(col => sh.getRange(3, col, rows.length, 1).setNumberFormat('#,##0.##'));
  sh.getRange(3, 2, Math.max(rows.length, 1), 1).setNumberFormat('@');
  sh.setTabColor('#1b7a3d');
}

// 投資デイリー分析に出す行（純関数）。発注できる推奨だけを載せる。
function briefingRows_(targets, plans) {
  return (targets || []).filter(t => t.pick && plans[t.code] && plans[t.code].ok).map(t => {
    const p = plans[t.code];
    return [t.grade, t.code, t.name, p.close, '翌朝寄付', p.target, p.stop, t.reason];
  });
}

// Bloomberg ニュースレターの読み込み・社名照合は Bloomberg.js

/**
 * トリガーの入口を共通モジュール RunLog.js で包む（「実行記録」シートに 秒・結果・エラー種別 を1回1行）。
 * Geminiマネージャーが読み、6分の上限に近い処理・失敗の多い処理・1日のトリガー合計時間を出す。
 * RunLog が無い環境（テストなど）では本体をそのまま呼ぶ。
 */
function runLogged_(label, fn, opts) {
  if (typeof RunLog === 'undefined') return fn();
  return RunLog.wrap(() => SpreadsheetApp.getActive(), label, fn, opts);
}
