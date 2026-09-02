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

const AI_MODELS_ = ['gemini-3.5-flash', 'gemini-2.5-flash'];
const AI_MEMO_COL_ = 11;   // 「売買プラン」シートのメモ列（PLAN_HEADERS_ の11番目）

// メニューから呼ぶ入口。「売買プラン」シートを読み、Geminiでコメントを生成してメモ欄へ書く。
function generateAiSummary_() {
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
  const prompt = buildAiPrompt_(planRows, ctx);

  const text = callAiWithFallback_(apiKey, prompt);
  if (!text) {
    ss.toast('AIコメントの生成に失敗しました（実行ログを確認してください）', APP_NAME_, 8);
    return;
  }
  const comments = parseAiComments_(text);
  if (!comments) {
    ss.toast('AIの応答を解析できませんでした（実行ログを確認してください）', APP_NAME_, 8);
    return;
  }
  writeAiCommentsIntoPlan_(sh, planRows, comments);
  ss.toast('メモ欄をAIコメントに更新しました（参考・投資助言ではありません）', APP_NAME_, 6);
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
  lines.push('あなたは個人投資家向けの分析アシスタントです。以下は酒田五法の統計的シグナルに基づいて');
  lines.push('機械的に算出された売買プラン（買い候補・保有株）です。これは統計的シグナルの整理であり、');
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
      + ' シグナル:' + (r.signal || 'なし') + ' 既存メモ:' + (r.note || 'なし')
      + (earn ? ' 決算:' + earn : ''));
  });
  lines.push('');
  lines.push('【出力形式】');
  lines.push('コードをキー、書き換えたコメントを値とするJSONオブジェクトのみを返してください。');
  lines.push('説明・前置き・コードブロック記号（```等）は一切不要です。');
  lines.push('例: {"7203": "コメント本文", "6758": "コメント本文"}');
  return lines.join('\n');
}

// このURLには ?key=<GEMINI_API_KEY> がそのまま入っている。GASのUrlFetchApp.fetchは
// DNS解決失敗・接続断などの通信例外時に失敗したURLを例外メッセージへそのまま含める
// ことがあるため、e.messageをログへ渡す前に必ずこれでAPIキー部分を伏字化する
// （PdfAutoRename の redactApiKey_ と同じパターン）。
function redactApiKey_(text, apiKey) {
  const s = String(text == null ? '' : text);
  return apiKey ? s.split(apiKey).join('***') : s;
}

// Geminiを呼ぶ。混雑エラー（429/503等）は次のモデルへフォールバックする
// （Abitus-Automation の callProofreadGemini_ と同じ考え方）。
function callAiWithFallback_(apiKey, prompt) {
  for (let i = 0; i < AI_MODELS_.length; i++) {
    const model = AI_MODELS_[i];
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }),
        muteHttpExceptions: true,
      });
      const json = JSON.parse(res.getContentText());
      if (json.error) {
        const msg = String(json.error.message || '');
        const busy = json.error.code === 429 || json.error.code === 503 || /quota|overloaded|high demand/i.test(msg);
        Logger.log('AI要約: ' + model + ' エラー ' + msg);
        if (busy && i < AI_MODELS_.length - 1) continue;   // 混雑なら次のモデルへ切替え
        return null;
      }
      const candidate = json.candidates && json.candidates[0];
      // STOP以外は出力が途中で打ち切られている（MAX_TOKENS・SAFETY等）。尻切れの文章は採用しない。
      if (candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
        Logger.log('AI要約: 出力が不完全です (finishReason=' + candidate.finishReason + ')');
        return null;
      }
      const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]
        && candidate.content.parts[0].text;
      if (text) return text;
    } catch (e) {
      Logger.log('AI要約: ' + model + ' 呼び出しに失敗 ' + redactApiKey_(e.message, apiKey));
    }
  }
  return null;
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
