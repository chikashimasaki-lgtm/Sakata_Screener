// ============================================================================
//  トムソン・ロイター ニュース速報メール（SBI証券経由、Gmail）の取り込み
//  ---------------------------------------------------------------------------
//  SBI証券の「ロイターニュース配信サービス」から、見出し1本ごとに1通届く
//  （送信元 sbi_news_alert@trkd-hs.com、件名は毎回「【SBI証券】 トムソン・ロイターニュース速報メール」、
//   本文1行目が「YYYY/MM/DD 見出し」、あとは定型の注意書き）。
//  直近1時間の見出しを、「投資デイリー分析」スプレッドシートの「ニュース_ロイター」シートへ書き出す。
//  （MarketBriefing の「ニュース」は Gemini の Web検索で、Bloomberg と同じく別シートとして並べる）
//
//  件名が同じなので Gmail は全部を1スレッドにまとめる（1スレッド最大100通）。MailCleanup が
//  「ニュース」「トムソン・ロイター」ラベルのメールをゴミ箱へ移すため in:anywhere で探す。
//  Gmail の権限はこのスクリプトが元から持っている。MarketBriefing 側に足すと全トリガーの再承認が要るので、こちらで行う
//  （[[GAS-スコープ追加で既存トリガーが止まる]]）。
// ============================================================================

const REUTERS_QUERY_ = 'from:sbi_news_alert@trkd-hs.com in:anywhere newer_than:2d';
const REUTERS_SHEET_ = 'ニュース_ロイター';
const REUTERS_HOURS_ = 1;       // 何時間ぶんの見出しを載せるか（メールの保持期間に合わせる。MailCleanup の「トムソン・ロイター」ラベルも1時間）
const REUTERS_MAX_ROWS_ = 100;  // シートに載せる見出しの上限
const REUTERS_TRIGGER_MINUTES_ = 10;   // 10分おきに取り込む（GASの everyMinutes は 1/5/10/15/30 のみ）

/**
 * メール本文（プレーンテキスト）から見出しを取り出す。純関数。
 * 本文1行目は「2026/10/08 BRIEF-…」。先頭の日付を落とし、全角スペースの連続は半角1つにする。
 * 見出しが読み取れなければ空文字。
 */
function reutersHeadline_(body) {
  const first = String(body || '').replace(/\r/g, '').split('\n').map(l => l.trim()).find(l => l);
  if (!first) return '';
  const head = first.replace(/^\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\s*/, '').replace(/[\s　]+/g, ' ').trim();
  // 定型文しか無いメール（見出しが空）は拾わない
  return /^ニュース本文は|^フィッシング/.test(head) ? '' : head;
}

/**
 * [{date: Date, when: '10/08 14:09', headline}] から、シートに書く行 [時刻, 見出し] を作る。純関数。
 * 同じ見出しは新しい方だけ残し、新しい順に並べ、上限で切る。
 * 見出しは外部入力なので、数式として評価されないよう無害化する
 * （"-" "+" "=" "@" 始まりでも安全。sanitizeForSheetCell_ は共通モジュール SheetUtils.js）。
 */
function reutersRows_(items) {
  const seen = {};
  return (items || [])
    .filter(x => x && x.headline)
    .sort((a, b) => b.date - a.date)
    .filter(x => (seen[x.headline] ? false : (seen[x.headline] = true)))
    .slice(0, REUTERS_MAX_ROWS_)
    .map(x => [x.when, sanitizeForSheetCell_(x.headline)]);
}

// 直近 REUTERS_HOURS_ 時間のロイター速報メールを見出しにして返す（新しい順）。
function reutersItems_(now) {
  const since = new Date((now || new Date()).getTime() - REUTERS_HOURS_ * 3600 * 1000);
  const out = [];
  GmailApp.search(REUTERS_QUERY_, 0, 5).forEach(th => {
    if (th.getLastMessageDate() < since) return;
    th.getMessages().forEach(m => {
      if (m.getDate() < since) return;
      if (!/trkd-hs\.com/i.test(m.getFrom())) return;
      const headline = reutersHeadline_(m.getPlainBody());
      if (headline) out.push({ date: m.getDate(), when: Utilities.formatDate(m.getDate(), 'JST', 'MM/dd HH:mm'), headline: headline });
    });
  });
  return out.sort((a, b) => b.date - a.date);
}

// 取り込みトリガー（10分おき）を、無ければ足す（既存のトリガーは触らない）。足したら true。
// 「自動実行を設定」（確認ダイアログあり）を押さなくても、すでに動いている朝のトリガー
// （updateBloombergNews）の頭から自動で足すための入口。
function ensureReutersTriggers_() {
  try {
    if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'updateReutersNews')) return false;
    ScriptApp.newTrigger('updateReutersNews').timeBased().everyMinutes(REUTERS_TRIGGER_MINUTES_).create();
    return true;
  } catch (e) { Logger.log('Reutersトリガーの確認に失敗: ' + e.message); return false; }
}

/** 直近1時間のロイター速報を「投資デイリー分析」の「ニュース_ロイター」シートへ書き出す。 */
function updateReutersNews() {
  // 10分おきに動くので、短い実行（新着なし）は実行記録に残さない（minSec）
  return runLogged_('ロイター取り込み', () => {
    const id = briefingSpreadsheetId_();
    if (!id) return;
    writeReutersSheet_(SpreadsheetApp.openById(id), reutersItems_(new Date()));
  }, { minSec: 5 });
}

function writeReutersSheet_(ss, items) {
  const sh = ss.getSheetByName(REUTERS_SHEET_) || ss.insertSheet(REUTERS_SHEET_);
  sh.clear();
  const rows = reutersRows_(items);
  const stamp = rows.length
    ? '更新: ' + Utilities.formatDate(new Date(), 'JST', 'yyyy/MM/dd HH:mm') + ' JST｜直近' + REUTERS_HOURS_ + '時間の速報 ' + rows.length + '件'
    : '直近' + REUTERS_HOURS_ + '時間にロイターの速報メールが見つかりませんでした';
  sh.getRange(1, 1).setValue(stamp).setFontWeight('bold');
  const header = ['受信（JST）', '見出し'];
  sh.getRange(2, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#1f2a44').setFontColor('#ffffff');
  if (rows.length) {
    sh.getRange(3, 1, rows.length, header.length).setValues(rows).setVerticalAlignment('top');
    sh.getRange(3, 2, rows.length, 1).setWrap(true);
  }
  sh.getRange(3 + Math.max(rows.length, 1) + 1, 1)
    .setValue('出典: トムソン・ロイター ニュース速報（SBI証券のメール配信・Gmail）。【免責】投資助言ではありません。')
    .setFontColor('#666666');
  sh.setColumnWidth(1, 90);
  sh.setColumnWidth(2, 700);
  sh.setFrozenRows(2);
  sh.setTabColor('#c2410c');
}
