// ============================================================================
//  スマホ用Webメニュー（Webアプリ、access=MYSELF＝本人だけが開ける）
//  ---------------------------------------------------------------------------
//  スプレッドシートの独自メニュー（onOpen）はスマホのアプリに出ないため、
//  よく使う操作と売買プランの確認だけをWebページにする（PdfAutoRename の doGet と同じ作り）。
//
//  走査は6分を超える（4.5分ごとに区切ってトリガーで自動再開する）ので、ボタンからは
//  直接呼ばず「1秒後に1回だけ動くトリガー」を作ってすぐ戻る。中身はPCのメニューと同じ関数。
//  進捗はシートに出している表示（売買プランL1）を読んで見せる。
// ============================================================================

const WEB_SS_PROP_ = 'SAKATA_SS_ID';   // Webアプリから開けなかったときの予備（走査時に保存）

// 自分のスプレッドシート。コンテナバインドなので通常は getActive() で取れる。
function webSs_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActive(); } catch (e) { /* Webアプリの文脈で取れない場合は下へ */ }
  if (ss) return ss;
  const id = PropertiesService.getScriptProperties().getProperty(WEB_SS_PROP_);
  if (!id) throw new Error('スプレッドシートを特定できません（一度PCのメニューから走査してください）');
  return SpreadsheetApp.openById(id);
}

// 走査・プラン作成の文脈（トリガー）で呼び、Webアプリ用の予備IDを残す。
function rememberSpreadsheetId_() {
  try {
    const ss = SpreadsheetApp.getActive();
    if (ss) PropertiesService.getScriptProperties().setProperty(WEB_SS_PROP_, ss.getId());
  } catch (e) { /* 予備なので失敗しても続行 */ }
}

/**
 * 売買プランシートの値（見出し行を含む2次元配列）を、スマホ表示用の行に変える。純関数。
 * 列の並びは PLAN_HEADERS_（区分, コード, 銘柄名, 現在値, 株数, 買い, 利確, 損切り, 損切り額, 根拠, メモ）。
 */
function webPlanRows_(values) {
  return (values || []).slice(1).filter(r => r[0] && r[1]).map(r => {
    const memo = String(r[10] || '');
    return {
      kind: String(r[0]), code: String(r[1]), name: String(r[2] || ''),
      shares: r[4] === '' ? null : Number(r[4]),
      buy: r[5] === '' ? null : Number(r[5]),
      target: r[6] === '' ? null : Number(r[6]),
      stop: r[7] === '' ? null : Number(r[7]),
      loss: r[8] === '' ? null : Number(r[8]),
      ng: /^(見送り|算出不可)/.test(memo),
      alert: /^トレンド崩れ/.test(memo),
      memo: memo.split('／')[0],
    };
  });
}

// 走査が進行中か（カーソルが残っている、または再開待ちトリガーがある）
function webScanRunning_() {
  if (PropertiesService.getScriptProperties().getProperty('SK_CURSOR')) return true;
  return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'scanSignals');
}

// 画面の状態（ページ表示時と「更新」ボタン・走査中の自動更新で呼ぶ）
function webStatus() {
  const ss = webSs_();
  const plan = ss.getSheetByName(SK.SHEETS.PLAN);
  const ifd = ss.getSheetByName(SK.SHEETS.IFDOCO);
  const values = plan && plan.getLastRow() > 0 ? plan.getRange(1, 1, plan.getLastRow(), 13).getValues() : [];
  const rebuilding = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'webBuildPlansJob');
  return {
    status: values.length ? String(values[0][11] || '') : '',
    note: values.length ? String(values[0][12] || '') : '',
    rows: webPlanRows_(values),
    running: webScanRunning_(),
    rebuilding: rebuilding,
    url: ss.getUrl(),
    planGid: plan ? plan.getSheetId() : null,
    ifdocoGid: ifd ? ifd.getSheetId() : null,
  };
}

// 「走査/続行」。進行中なら何もしない（二重に走らせない）。
function webStartScan() {
  if (webScanRunning_()) return { ok: true, message: '走査はすでに進行中です。この画面で進み具合を確認できます' };
  ScriptApp.newTrigger('scanSignals').timeBased().after(1000).create();
  return { ok: true, message: '走査を予約しました。1分ほどで始まり、全体で20〜30分かかります' };
}

// 「売買プランだけ作り直す」。数十秒〜1分かかるのでトリガーで動かす。
function webBuildPlans() {
  if (webScanRunning_()) return { ok: false, message: '走査中です。走査が終わると売買プランも自動で作り直されます' };
  clearTriggersFor_('webBuildPlansJob');
  ScriptApp.newTrigger('webBuildPlansJob').timeBased().after(1000).create();
  return { ok: true, message: '作り直しを予約しました。1〜2分後に「更新」を押してください' };
}

// 上のトリガーの本体。一度きりなので最初に自分のトリガーを消す。
function webBuildPlansJob() {
  clearTriggersFor_('webBuildPlansJob');
  return runLogged_('売買プラン作り直し（スマホ）', () => buildPlans());
}

function doGet() {
  return HtmlService.createHtmlOutput(WEB_MENU_HTML_)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle('短期売買支援');
}

const WEB_MENU_HTML_ = `<!DOCTYPE html><html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:18px;background:#f4f5f7;color:#222;}
  h1{font-size:18px;margin:0 0 14px;}
  h2{font-size:14px;color:#555;margin:20px 0 10px;}
  .status{font-size:15px;padding:14px 16px;background:#fff;border-radius:12px;margin-bottom:14px;
          box-shadow:0 1px 3px rgba(0,0,0,.1);font-weight:600;color:#1a7f37;}
  .status.busy{color:#b26a00;} .status.err{color:#b00020;}
  .status small{display:block;font-weight:normal;color:#8a3a3a;margin-top:4px;}
  .btn{display:block;width:100%;box-sizing:border-box;text-align:center;background:#1a73e8;color:#fff;
       padding:15px;border:none;border-radius:12px;font-size:16px;font-weight:bold;margin-bottom:8px;text-decoration:none;}
  .btn.go{background:#1a7f37;} .btn.gray{background:#6b7280;}
  .btn.link{background:#fff;color:#1a73e8;border:1px solid #d3d7de;}
  .btn:disabled{opacity:.5;}
  .row{background:#fff;padding:12px 14px;border-radius:10px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:14px;}
  .row.ng{background:#f6e3e3;color:#8a3a3a;} .row.alert{background:#fde9d9;}
  .tag{font-size:11px;padding:2px 7px;border-radius:6px;background:#eef1f5;color:#555;margin-right:6px;font-weight:bold;}
  .tag.A{background:#c9ecd5;color:#0f5a2b;} .tag.held{background:#fff3da;color:#8a6100;}
  .px{margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;}
  .px b{font-size:15px;} .tp{color:#1a7f37;} .sl{color:#c0392b;}
  small{color:#666;}
</style></head><body>
<h1>📈 短期売買支援</h1>
<div class="status" id="status">読み込み中…</div>
<button class="btn go" id="b1" onclick="act('scan')">▶ 走査/続行</button>
<button class="btn gray" id="b2" onclick="act('plans')">↻ 売買プランだけ作り直す</button>
<button class="btn link" id="b3" onclick="load()">状態を更新</button>
<a class="btn link" id="lp" target="_blank">📊 売買プランを開く</a>
<a class="btn link" id="li" target="_blank">🧾 IFDOCO入力を開く</a>
<div id="rows"></div>
<script>
  var BTNS = ['b1','b2','b3'], timer = null;
  function esc(s){ return String(s == null ? '' : s).replace(/[<>&]/g, function(c){ return {'<':'&lt;','>':'&gt;','&':'&amp;'}[c]; }); }
  function num(v){ return v == null || isNaN(v) ? '—' : Number(v).toLocaleString('ja-JP'); }
  function busy(on){ BTNS.forEach(function(id){ document.getElementById(id).disabled = on; }); }
  function setStatus(msg, cls, note){
    var st = document.getElementById('status');
    st.className = 'status' + (cls ? ' ' + cls : '');
    st.innerHTML = esc(msg) + (note ? '<small>' + esc(note) + '</small>' : '');
  }
  function render(s){
    busy(false);
    var cls = (s.running || s.rebuilding) ? 'busy' : '';
    var msg = s.rebuilding ? '売買プランを作り直しています…' : (s.status || '（まだ走査していません）');
    setStatus(msg, cls, s.note);
    var lp = document.getElementById('lp'), li = document.getElementById('li');
    lp.href = s.url + (s.planGid != null ? '#gid=' + s.planGid : '');
    li.href = s.url + (s.ifdocoGid != null ? '#gid=' + s.ifdocoGid : '');
    li.style.display = s.ifdocoGid == null ? 'none' : 'block';
    var rows = s.rows || [];
    document.getElementById('rows').innerHTML = !rows.length ? '' : '<h2>売買プラン</h2>' + rows.map(function(r){
      var tagCls = r.kind === '保有' ? 'held' : (r.kind.slice(-1) === 'A' ? 'A' : '');
      var cls = 'row' + (r.ng ? ' ng' : (r.alert ? ' alert' : ''));
      return '<div class="' + cls + '"><span class="tag ' + tagCls + '">' + esc(r.kind) + '</span>'
        + '<b>' + esc(r.code) + '</b> ' + esc(r.name)
        + '<div class="px"><span>株数 <b>' + num(r.shares) + '</b></span>'
        + '<span>買い <b>' + num(r.buy) + '</b></span>'
        + '<span class="tp">利確 <b>' + num(r.target) + '</b></span>'
        + '<span class="sl">損切り <b>' + num(r.stop) + '</b></span></div>'
        + (r.memo ? '<small>' + esc(r.memo) + '</small>' : '') + '</div>';
    }).join('');
    clearTimeout(timer);
    if (s.running || s.rebuilding) timer = setTimeout(load, 20000);   // 進行中は20秒ごとに自動更新
  }
  function fail(e){ busy(false); setStatus('⚠️ エラー: ' + e.message, 'err'); }
  function load(){ busy(true); google.script.run.withSuccessHandler(render).withFailureHandler(fail).webStatus(); }
  function act(kind){
    if (kind === 'scan' && !confirm('全銘柄の走査を始めます（20〜30分）。よろしいですか？')) return;
    busy(true);
    var r = google.script.run.withFailureHandler(fail).withSuccessHandler(function(res){
      setStatus((res.ok ? '✅ ' : '⚠️ ') + res.message, res.ok ? 'busy' : 'err');
      setTimeout(load, 5000);
    });
    if (kind === 'scan') r.webStartScan(); else r.webBuildPlans();
  }
  load();
</script>
</body></html>`;
