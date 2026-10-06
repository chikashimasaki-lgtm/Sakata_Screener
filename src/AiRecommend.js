/**
 * AI推奨コメント（Gemini）
 * ---------------------------------------------------------------------------
 * 「売買プラン」シートのメモ欄（K列）を、Geminiが生成した参考コメントで置き換える。
 * 別シートは作らない。既存メモ（トレンド崩れ警告・注文種別の根拠等、機械的に算出された
 * 事実）はプロンプトに渡し、AIコメントにその要点を残しつつ、地合い・決算近接などの
 * 文脈を添えた1〜2文へ書き換えさせる（事実を消さず、解釈を足す）。
 *
 * 位置づけ:
 *   統計的な重み決定（Wilson信頼区間・ベンチマーク控除・有意性検定、MLWeights.js）とは別物。
 *   ここでのAIは「新しく学習させる」のではなく、既に大規模に訓練済みのGemini（自己回帰の
 *   大規模言語モデルであるLLM）に、計算済みの統計結果を渡して自然文で解釈・要約させる使い方。
 *   投資助言ではなく、注目点・リスク要因を客観的に整理する参考情報として扱う（プロンプトにも
 *   明記し、シート側にも一言添える）。
 *
 * 認証・呼び出し方は ~/projects/Abitus-Automation の callGeminiText_ と同じパターン
 * （UrlFetchApp + Generative Language API、GEMINI_API_KEY をスクリプトプロパティから読む）。
 * JSON抽出も同プロジェクトの extractRuleProposal_ と同じ「本文からJSON部分だけ正規表現で
 * 取り出してparseする」方式（応答に前置き・コードブロック記号が混じっても崩れないように）。
 *
 * 自動トリガーには繋げず、メニューから手動実行のみとする（外部APIのレイテンシ・コストを
 * 毎回のシグナル走査に乗せないため。「パターン成績を集計」と同じ扱い）。
 */

const AI_MEMO_COL_ = 11;   // 「売買プラン」シートのメモ列（PLAN_HEADERS_ の11番目）
// AIに渡す銘柄数の上限（買い推奨を優先し、シートの並び順で上位N件）。
// 残りの銘柄は数値から確定できる注意書きをコードでテンプレート文にする（トークン節約）。
// 増やしたいときはこの値だけ変えればよい。
const AI_TOP_N_ = 3;

// メニューから呼ぶ入口。「売買プラン」シートを読み、Geminiでコメントを生成してメモ欄へ書く。
// メニューの入口なので末尾「_」を付けない（「_」は内部ヘルパの目印として使い分ける）。
// エディタの実行ドロップダウンにも出るので、手で動かして切り分けたいときに楽。
function generateAiSummary() {
  const ss = SpreadsheetApp.getActive();
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY がスクリプトプロパティに未設定です');

  const sh = ss.getSheetByName(SK.SHEETS.PLAN);
  const planRows = readPlanRowsForAi_(ss);
  if (!planRows.length) {
    ss.toast('「' + SK.SHEETS.PLAN + '」に対象行がありません。先に「売買プランを作成/更新」を実行してください', APP_NAME_, 8);
    return;
  }
  const ctx = readMacroContextForAi_(ss);

  // 定型の注意書きは全行ぶんコードで先に作る。AIは上位N件だけ。AIが失敗してもテンプレ分は書く。
  const templates = buildTemplateComments_(planRows, ctx);
  const aiRows = pickAiRows_(planRows, AI_TOP_N_);
  let comments = Object.assign({}, templates);
  let aiMsg = '';
  if (aiRows.length) {
    const text = callAiWithFallback_(apiKey, buildAiPrompt_(aiRows, ctx));
    const parsed = text ? parseAiComments_(text) : null;
    if (parsed) {
      aiRows.forEach(r => { if (parsed[r.code] != null && parsed[r.code] !== '') comments[r.code] = parsed[r.code]; });
    } else {
      aiMsg = text ? '（AIの応答を解析できずテンプレート文のみ）' : '（AI生成に失敗しテンプレート文のみ）';
    }
  }
  writeAiCommentsIntoPlan_(sh, planRows, comments);
  ss.toast('メモ欄を更新しました（AI ' + aiRows.length + '件＋テンプレート。参考・投資助言ではありません）' + aiMsg, APP_NAME_, 8);
}

// 見送り・算出不可の行はメモを書き換えない（理由がそのまま重要な事実のため）。
function isSkippedPlanRow_(r) {
  return /^(見送り|算出不可)/.test(String(r.note || ''));
}

// AIに渡す行: 見送り行を除き、買い推奨を先に・保有を後に、各々シート順で上位n件。
function pickAiRows_(planRows, n) {
  const live = planRows.filter(r => !isSkippedPlanRow_(r));
  const buys = live.filter(r => String(r.kind).indexOf('買い推奨') === 0);
  const rest = live.filter(r => String(r.kind).indexOf('買い推奨') !== 0);
  return buys.concat(rest).slice(0, n);
}

// 数値・既存メモから確定できる注意書きだけでテンプレート文を作る（コード→文）。
// 口調はAIコメント（1〜2文・です/ます調でなく簡潔な体言止め混じり）に合わせ、解釈は足さない。
function buildTemplateComments_(planRows, ctx) {
  const out = {};
  planRows.forEach(r => {
    if (isSkippedPlanRow_(r)) return;
    const items = String(r.note || '').split('／').map(x => x.trim()).filter(Boolean);
    const head = items[0] || '';
    const warns = [];
    if (items.some(x => x.indexOf('トレンド崩れ') === 0)) warns.push('トレンドが崩れており、押し安値割れを待たず早期手仕舞いも検討');
    const earn = (ctx && ctx.earningsByCode && ctx.earningsByCode[String(r.code)])
      || (items.find(x => x.indexOf('決算 ') === 0) || '').replace(/^決算 /, '');
    if (earn) warns.push('決算発表が近く（' + earn + '）、発表前後の値動きに注意');
    const s1 = head && items[0].indexOf('トレンド崩れ') !== 0 ? head + '。' : '';
    const s2 = warns.length ? warns.join('。') + '。' : '';
    const text = s1 + s2;
    if (text) out[r.code] = text;
  });
  return out;
}

// 「売買プラン」シートから、AI要約の材料になる行を読む（PLAN_HEADERS_ の並びに合わせる）。
// row はシート上の行番号（書き戻し先の特定に使う）。
function readPlanRowsForAi_(ss) {
  const sh = ss.getSheetByName(SK.SHEETS.PLAN);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, PLAN_HEADERS_.length).getValues();
  const out = [];
  values.forEach((r, i) => {
    if (!r[1]) return;   // コード列が空の行（「対象がありません」等の案内行）は除く
    out.push({ row: i + 2, kind: r[0], code: r[1], name: r[2], signal: r[9], note: r[10] });
  });
  return out;
}

// 急落サイン（地合い）・決算カレンダー（銘柄別の決算近接）を読む。
// 取得できなくてもAI要約自体は続ける（材料が薄くなるだけで、機能全体を止める理由にはならない）。
function readMacroContextForAi_(ss) {
  const ctx = { alertLine: '', regimeLine: '', earningsByCode: {} };
  try {
    // 急落サインの判定結果は「相場マクロ」シート下段（ALERT_START_ROW行目〜）にある
    // （2026-08-21、旧「急落サイン」シートを統合）。点灯数・地合いは常にこの2行に出る。
    const sh = ss.getSheetByName(MACRO.INPUT_SHEET);
    if (sh && sh.getLastRow() >= MACRO.ALERT_START_ROW + 1) {
      const vals = sh.getRange(MACRO.ALERT_START_ROW, 1, 2, 2).getValues();
      ctx.alertLine = String(vals[0][1] || '');
      ctx.regimeLine = String(vals[1][1] || '');
    }
  } catch (e) { Logger.log('AI要約: 急落サインの読み取りに失敗 ' + e.message); }
  try {
    const sh = ss.getSheetByName(MACRO.CALENDAR_SHEET);
    if (sh && sh.getLastRow() >= 2) {
      const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
      vals.forEach(r => { if (r[0]) ctx.earningsByCode[String(r[0])] = r[2] + '（' + r[3] + '）'; });
    }
  } catch (e) { Logger.log('AI要約: 決算カレンダーの読み取りに失敗 ' + e.message); }
  return ctx;
}

// Geminiに渡す日本語プロンプトを組み立てる。JSON（コード→コメント）で返させる。
function buildAiPrompt_(planRows, ctx) {
  const lines = [];
  lines.push('あなたは個人投資家向けの分析アシスタントです。以下はダウ理論（上昇トレンドの押し目）と');
  lines.push('フィボナッチ（押しの深さ）で機械的に算出された売買プラン（買い推奨・保有株）です。これは機械的な判定の整理であり、');
  lines.push('投資助言ではありません。断定的な売買指示ではなく、注目点・リスク要因を客観的に整理してください。');
  lines.push('');
  lines.push('各銘柄には「既存メモ」として、注文種別やトレンド判定など機械的に算出された事実が');
  lines.push('付いています。これらの事実は削らず活かしつつ、地合い・急落サイン・決算近接などの');
  lines.push('文脈を添えて、1〜2文の簡潔な日本語コメントに書き換えてください。');
  lines.push('');
  lines.push('【市場全体の地合い】');
  lines.push(ctx.alertLine ? '急落サイン: ' + ctx.alertLine : '急落サイン: （データなし）');
  lines.push(ctx.regimeLine ? '市場地合い: ' + ctx.regimeLine : '市場地合い: （データなし）');
  lines.push('');
  lines.push('【対象銘柄】');
  planRows.forEach(r => {
    const earn = ctx.earningsByCode[String(r.code)];
    lines.push('- コード:' + r.code + ' 銘柄名:' + r.name + ' 区分:' + r.kind
      + ' 根拠:' + (r.signal || 'なし') + ' 既存メモ:' + (r.note || 'なし')
      + (earn ? ' 決算:' + earn : ''));
  });
  lines.push('');
  lines.push('【出力形式】');
  lines.push('コードをキー、書き換えたコメントを値とするJSONオブジェクトのみを返してください。');
  lines.push('説明・前置き・コードブロック記号（```等）は一切不要です。');
  lines.push('例: {"7203": "コメント本文", "6758": "コメント本文"}');
  return lines.join('\n');
}

// redactApiKey_ は共通モジュール RedactUtil.js（~/projects/RedactUtil.js のsymlink）に定義

// Geminiを呼ぶ。モデルフォールバック・429/503判別・リトライは共通モジュール GeminiCall.js
// （ADR-003）に統一済み。ここでの固有ロジックは「STOP以外（MAX_TOKENS・SAFETY等で
// 尻切れ）の応答は採用しない」判定だけ（自動トリガーには繋げず手動実行のみの機能のため、
// 失敗時はnullを返してUIにトースト表示する——例外は投げない）。
function callAiWithFallback_(apiKey, prompt) {
  let result;
  try {
    result = GeminiCall.call({
      apiKey, models: GeminiCall.STANDARD_MODELS,
      payload: {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: 'application/json' },
      },
    });
  } catch (e) {
    Logger.log('AI要約: 呼び出しに失敗 ' + redactApiKey_(e.message, apiKey));
    return null;
  }

  try { TokenLog.log(SpreadsheetApp.getActive(), 'AI推奨コメント', result); }
  catch (e) { Logger.log('トークンログ記録失敗: ' + e.message); }

  const finishReason = result.raw.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    Logger.log('AI要約: 出力が不完全です (finishReason=' + finishReason + ')');
    return null;
  }
  return result.text;
}

// Geminiの応答本文からJSON部分だけを取り出してパースする。前置き文やコードブロック記号が
// 混じっても崩れないよう、正規表現で { ... } の最初の塊を抜き出してから parse する
// （Abitus-Automation の extractRuleProposal_ と同じ方式）。
function parseAiComments_(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) { Logger.log('AI要約: 応答にJSONが見つかりません: ' + String(text).slice(0, 200)); return null; }
  try {
    const obj = JSON.parse(m[0]);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (e) {
    Logger.log('AI要約: JSON解析に失敗 ' + e.message);
    return null;
  }
}

// コード→コメントのマップを「売買プラン」シートのメモ列（K列）へ書き戻す。
// コメントが得られなかった行は既存メモを残す（書き換え失敗で情報が消えないように）。
function writeAiCommentsIntoPlan_(sh, planRows, comments) {
  let updated = 0;
  planRows.forEach(r => {
    if (isSkippedPlanRow_(r)) return;
    const c = comments[r.code];
    if (c == null || c === '') return;
    // Geminiの生成文はプロンプト経由で外部データ（決算カレンダー等）の影響を受けるため、
    // 先頭が =+-@ だとGoogle Sheetsが数式として解釈してしまう（数式インジェクション）。
    // sanitizeForSheetCell_ (SheetUtils.js) はAbitus-Automation/PdfAutoRename等で
    // 同種のAI生成テキスト・外部由来テキストの書き込み前に使っているのと同じ対策。
    sh.getRange(r.row, AI_MEMO_COL_).setValue(sanitizeForSheetCell_(String(c)));
    updated++;
  });
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  sh.getRange(1, 13)
    .setValue('メモ欄はAI参考コメント（' + stamp + ' 生成・' + updated + '件更新。投資助言ではありません）')
    .setFontColor('#8e6bd6').setFontWeight('bold');
}
