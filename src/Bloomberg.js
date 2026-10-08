// ============================================================================
//  Bloomberg ニュースレター（Gmail）の取り込み
//  ---------------------------------------------------------------------------
//  毎朝6時ごろ届く「1日を始める前に読んでおきたいニュース5本」と土曜の「週末版ニュース5選」を読み、
//   1) 推奨銘柄・保有株の社名が記事に出ていれば、売買プランのメモに見出しを添える
//  （「ニュース_Bloomberg」シートへの書き出しは、権限を分離して MarketBriefing へ移した＝2026-10-09）
//  推奨の判定そのものには使わない（ニュースは過去に遡って検証できないため）。
//
//  MailCleanup が「ニュース」ラベルのメールをすぐゴミ箱へ移すため in:anywhere で探す
//  （ゴミ箱でも30日は残る）。Gmail の権限はこのスクリプトが元から持っている
//  （通知メールのラベル付けで使用）。
// ============================================================================

const BLOOMBERG_QUERY_ = 'from:noreply@news.bloomberg.com in:anywhere newer_than:3d';

// 直近の Bloomberg ニュースレター（新しい順）。{date, subject, body, items, others}
function bloombergTexts_() {
  const out = [];
  GmailApp.search(BLOOMBERG_QUERY_, 0, 10).forEach(th => th.getMessages().forEach(m => {
    if (!/bloomberg/i.test(m.getFrom())) return;
    const body = m.getPlainBody();
    const parsed = bloombergParse_(body);
    out.push({ date: m.getDate(), subject: m.getSubject(), body: body, items: parsed.items, others: parsed.others });
  }));
  return out.sort((a, b) => b.date - a.date);
}

/**
 * ニュースレター本文（プレーンテキスト）を見出しと本文に分ける。純関数。
 *
 * 実物の構造（2026-09-30 受信分で確認）:
 *   …マーケットスナップショット…「ウォッチリスト」\n<URL>\n見出し1\n\n本文1（リンク箇所で行が切れる）\n\n
 *   見出し2\n\n本文2 … \n\nその他の注目ニュース\n\nタイトル\n<URL>\n\n … \n\nニュースレターに関するお知らせ
 * 段落は空行で区切られ、段落内はリンク（<https://…>）の前後で行が切れているので、
 * URL行を捨てて段落内の行を連結すると元の文に戻る。
 */
function bloombergParse_(body) {
  const blocks = String(body || '').replace(/\r/g, '').split(/\n\s*\n/).map(b =>
    b.split('\n').map(l => l.trim()).filter(l => l && !/^<?https?:\/\/\S+>?$/.test(l)).join('')
      .replace(/<https?:[^>]*>/g, '').trim());
  const items = [], others = [];
  let i = blocks.findIndex(b => b.indexOf('ウォッチリスト') >= 0);
  let pendingHead = '';
  if (i >= 0) {
    pendingHead = blocks[i].split('ウォッチリスト').pop().trim();
  } else {
    // マーケットスナップショットが無い号（月曜朝の「週末に話題になったニュース」・土曜の週末版。2026-10-05 受信分で確認）:
    // 先頭の見出し・リンクのあと、「。」を含む最初の段落＝導入文。その次から 見出し→本文 が続く。
    i = blocks.findIndex(b => b.indexOf('。') >= 0);
    if (i < 0) return { items, others };
  }
  let inOthers = false;
  for (i = i + 1; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b) continue;
    if (b.indexOf('ニュースレターに関するお知らせ') === 0) break;
    if (b.indexOf('その他の注目ニュース') === 0) { inOthers = true; pendingHead = ''; continue; }
    if (inOthers) { others.push(b); continue; }
    if (!pendingHead && b.length <= 30) { pendingHead = b; continue; }   // 見出しは短い1行
    items.push({ head: pendingHead || '', body: b });
    pendingHead = '';
  }
  return { items, others };
}

// 7時半の取り込みトリガーを、無ければ足す（既存のトリガーは触らない）。足したら true。
// 「自動実行を設定」（メニュー・確認ダイアログあり）を押さなくても、すでに動いている別のトリガー
// （旧・保有チェック／走査）の頭から自動で追加するための入口（2026-10-05。7時半のトリガーが無く、朝の取り込みが一度も動いていなかった）。
function ensureBloombergTrigger_() {
  try {
    if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'updateBloombergNews')) return false;
    ScriptApp.newTrigger('updateBloombergNews').timeBased().everyDays(1).atHour(7).nearMinute(30).create();
    return true;
  } catch (e) { Logger.log('Bloombergトリガーの確認に失敗: ' + e.message); return false; }
}

// 社名の照合用の正規化（全角英数→半角、空白除去、よくある接尾辞を落とす）。純関数。
function companyKey_(name) {
  let s = String(name || '').normalize('NFKC').replace(/\s+/g, '').replace(/^株式会社|株式会社$/g, '');
  const short = s.replace(/(ホールディングス|グループ|HD)$/i, '');
  if (short.length >= 2) s = short;
  return s;
}

/**
 * 社名が記事に出ていれば、その記事の見出し（無ければ該当箇所）を短く返す。純関数。
 * texts は bloombergTexts_() の結果（items/others が無ければ body を行単位で見る）。
 * 3文字未満の社名は誤検知が多いので照合しない。
 */
function bloombergMention_(texts, name) {
  const key = companyKey_(name);
  if (key.length < 3) return '';
  const has = s => String(s || '').normalize('NFKC').replace(/\s+/g, '').indexOf(key) >= 0;
  const cut = s => { s = String(s).trim(); return s.length > 60 ? s.slice(0, 60) + '…' : s; };
  for (const t of texts || []) {
    const it = (t.items || []).find(x => has(x.head) || has(x.body));
    if (it) return cut(it.head ? it.head + '：' + it.body : it.body);
    const o = (t.others || []).find(has);
    if (o) return cut(o);
    if (!t.items || !t.items.length) {
      const line = String(t.body || '').split(/\r?\n/).find(has);
      if (line) return cut(line.normalize('NFKC').replace(/<https?:[^>]+>|https?:\S+/g, ''));
    }
  }
  return '';
}

/**
 * 毎朝7時半の Sakata 用ジョブ。売買プランの価格が壊れていれば作り直す（毎朝の保険）。
 * 関数名とトリガーは従来のまま（名前を変えると張り直しが要るため）。
 * 「ニュース_Bloomberg」シートへの書き出しは MarketBriefing へ移した（2026-10-09、権限の分離）。
 */
function updateBloombergNews() {
  return runLogged_('プラン点検', () => {
    healBrokenPlan_();   // 売買プランの価格が壊れていれば作り直す。投資デイリー分析の有無に関係なく
  });
}

/**
 * 旧: ロイター速報の10分おき取り込み。2026-10-09 に MarketBriefing の pollNewsMail へ移した。
 * 移す前に張られた updateReutersNews のトリガーが残っていると、毎回「関数が見つからない」で失敗し続ける。
 * それを防ぐため、入口だけ残して自分のトリガーを消す（次の実行で自動的に片付く）。
 */
function updateReutersNews() {
  const removed = clearTriggersFor_(['updateReutersNews']);
  Logger.log('ロイター速報の取り込みは MarketBriefing へ移しました。旧トリガーを' + removed + '件削除しました。');
}
