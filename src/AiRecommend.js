/**
 * AI推奨コメント（Gemini）
 * ---------------------------------------------------------------------------
 * 「売買プラン」シートの内容と、急落サイン/決算カレンダーの情報をGeminiに渡し、
 * 日本語の参考コメントを「AI推奨（参考）」シートへ書き出す。
 *
 * 位置づけ:
 *   統計的な重み決定（Wilson信頼区間・ベンチマーク控除・有意性検定、MLWeights.js）とは別物。
 *   ここでのAIは「新しく学習させる」のではなく、既に大規模に訓練済みのGemini（自己回帰の
 *   大規模言語モデルであるLLM）に、計算済みの統計結果を渡して自然文で解釈・要約させる使い方。
 *   投資助言ではなく、注目点・リスク要因を客観的に整理する参考情報として扱う（プロンプトにも
 *   明記する）。
 *
 * 認証・呼び出し方は ~/projects/Abitus-Automation の callGeminiText_ と同じパターン
 * （UrlFetchApp + Generative Language API、GEMINI_API_KEY をスクリプトプロパティから読む）。
 *
 * 自動トリガーには繋げず、メニューから手動実行のみとする（外部APIのレイテンシ・コストを
 * 毎回のシグナル走査に乗せないため。「パターン成績を集計」と同じ扱い）。
 */

const AI_MODELS_ = ['gemini-3.5-flash', 'gemini-2.5-flash'];
const AI_SHEET_ = 'AI推奨（参考）';

// メニューから呼ぶ入口。「売買プラン」シートを読み、Geminiでコメントを生成して書き出す。
function generateAiSummary_() {
  const ss = SpreadsheetApp.getActive();
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY がスクリプトプロパティに未設定です');

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
  writeAiSummarySheet_(text);
  ss.toast('AI推奨コメントを更新しました（参考・投資助言ではありません）', APP_NAME_, 6);
}

// 「売買プラン」シートから、AI要約の材料になる行を読む（PLAN_HEADERS_ の並びに合わせる）。
function readPlanRowsForAi_(ss) {
  const sh = ss.getSheetByName(SK.SHEETS.PLAN);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, PLAN_HEADERS_.length).getValues();
  return values
    .filter(r => r[1])   // コード列が空の行（「対象がありません」等の案内行）は除く
    .map(r => ({ kind: r[0], code: r[1], name: r[2], signal: r[9], note: r[10] }));
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

// Geminiに渡す日本語プロンプトを組み立てる。
function buildAiPrompt_(planRows, ctx) {
  const lines = [];
  lines.push('あなたは個人投資家向けの分析アシスタントです。以下は酒田五法の統計的シグナルに基づいて');
  lines.push('機械的に算出された売買プラン（買い候補・保有株）です。これは統計的シグナルの整理であり、');
  lines.push('投資助言ではありません。断定的な売買指示ではなく、注目点・リスク要因を客観的に、');
  lines.push('簡潔な日本語で整理してください。');
  lines.push('');
  lines.push('【市場全体の地合い】');
  lines.push(ctx.alertLine ? '急落サイン: ' + ctx.alertLine : '急落サイン: （データなし）');
  lines.push(ctx.regimeLine ? '市場地合い: ' + ctx.regimeLine : '市場地合い: （データなし）');
  lines.push('');
  lines.push('【対象銘柄】');
  planRows.forEach(r => {
    const earn = ctx.earningsByCode[String(r.code)];
    lines.push('- ' + r.code + ' ' + r.name + '（区分:' + r.kind + '）シグナル:' + (r.signal || 'なし')
      + (earn ? ' 決算:' + earn : '') + (r.note ? ' メモ:' + r.note : ''));
  });
  lines.push('');
  lines.push('【出力形式】');
  lines.push('1行目: 全体サマリー（地合いと急落サインを踏まえて2〜3文）');
  lines.push('2行目以降: 銘柄ごとに1行、「コード 銘柄名: コメント（1〜2文）」の形式で改行区切り');
  lines.push('前置き・見出し記号（#等）・箇条書き記号は不要です。');
  return lines.join('\n');
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
          generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
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
      Logger.log('AI要約: ' + model + ' 呼び出しに失敗 ' + e.message);
    }
  }
  return null;
}

// 生成結果を「AI推奨（参考）」シートへ書く。1行目は必ず免責の但し書き。
function writeAiSummarySheet_(text) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(AI_SHEET_);
  if (!sh) sh = ss.insertSheet(AI_SHEET_);
  const oldFilter = sh.getFilter(); if (oldFilter) oldFilter.remove();
  sh.clear();

  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
  const CAVEAT = '⚠ AIによる参考コメントです（' + stamp + ' 生成）。投資判断の最終責任はご自身にあります。'
    + '売買プランの統計的根拠そのものではなく、Geminiによる解釈・要約です。';
  sh.getRange(1, 1).setValue(CAVEAT);

  const bodyLines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const rows = (bodyLines.length ? bodyLines : ['（本文が空でした）']).map(l => [l]);
  sh.getRange(2, 1, rows.length, 1).setValues(rows);

  sh.getRange(1, 1).setBackground('#fff4f4').setFontColor('#b00020').setFontWeight('bold')
    .setHorizontalAlignment('left').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 44);
  sh.getRange(2, 1, rows.length, 1).setWrap(true).setVerticalAlignment('top');
  sh.setColumnWidth(1, 720);
  sh.setFrozenRows(1);
  sh.setTabColor('#8e6bd6');
}
