/**
 * SIGNAL_WEIGHT_ の算出（実データ・GAS不要）
 *
 *   node tools/calc_weights.js            … 算出してレポートを出す
 *   node tools/calc_weights.js --limit 50 … 銘柄数を絞って試す
 *
 * 何をするか:
 *   Yahoo から全銘柄の日足を取り、src/Code.js のパターン検出をそのまま回して
 *   「ML学習データ」相当のデータセットを作り、パターンごとの重み(1〜3)を決める。
 *
 * なぜGASでなくここで回すか:
 *   GAS側の backtestWeights() は6分制限のため自動再開を何度も挟む必要があり、
 *   1500銘柄を完走させるのに時間がかかる。ここでは同じ処理が1分程度で終わる。
 *   ロジックは src/ のファイルを**そのまま読み込んで**使うので、書き写しによる乖離は起きない
 *   （tests/verify.js と同じサンドボックス方式）。
 *
 * 重みの決め方:
 *   ベンチマーク（日経平均）控除後の勝率について Wilson 95%信頼区間を求め、
 *   「同じ方向・同じホライズンで、シグナル無しに入った場合の勝率（基準線）」と比べる。
 *   区間が基準線をまたぐ間は動かさない（点推定の大小では動かさない）。
 *
 *   基準線を実測して使うのが要点。日経平均控除後でも勝率は0.5を中心にせず、
 *   実測では 3日後で買い41%・売り59%、20日後で買い40%・売り61% になる
 *   （日経平均は値がさ株偏重で、個別株の中央値はこれに劣後するため）。
 *   0.5と比べると売りが軒並み「勝ち」買いが軒並み「負け」と出るが、それは
 *   指数の作りの話であってパターンの優位性ではない。
 *
 * 再実行の目安:
 *   月次〜四半期に1回（基準線・勝率が相場付きでドリフトするため）。自動実行はしない
 *   （意図的に手動コマンドのまま。実行後は git diff で src/Code.js の変更内容を確認してからコミットする）。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const LIMIT = Number(argVal('--limit', '0')) || 0;
// 基準線からの最小の差（ポイント）。--edge 5 のように指定して感度を見る。
// 0 を渡せる必要があるので `|| undefined` では書けない（0は falsy）。
const edgeArg = argVal('--edge', null);
const MIN_EDGE = (edgeArg != null && isFinite(Number(edgeArg))) ? Number(edgeArg) / 100 : undefined;
// 多重比較の補正（既定でオン）。29パターンを95%水準で検定すると、
// 全て無効だとしても偶然「有意」になるものが1〜2件は出る。有意水準を 0.05/検定数 に絞る
// （z=1.96 → 3.134）。実データでは補正の有無で結論が変わらないことを確認済みだが、
// 「29回引いて当たった1回」を採用しない仕組みは残しておく。--no-bonferroni で外せる。
const BONFERRONI = !args.includes('--no-bonferroni');
const CONCURRENCY = 10;

/* ── GAS モック（tests/verify.js と同じ方式） ─────────────────────────────── */

const sandbox = {
  Logger: { log: () => {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} }) },
  SpreadsheetApp: { getActive: () => { throw new Error('シートは使わない'); } },
  UrlFetchApp: { fetch: () => { throw new Error('通信はNode側で行う'); } },
  Utilities: {
    // barDateKey_ が 'Asia/Tokyo' で日付キーを作る。JSTは UTC+9 固定なので加算で足りる。
    formatDate: (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10),
    sleep: () => {},
  },
  ScriptApp: { getProjectTriggers: () => [], newTrigger: () => {}, deleteTrigger: () => {} },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'local@example.com' }) },
  DriveApp: {}, MailApp: { sendEmail: () => {} },
  GmailApp: { getUserLabelByName: () => null, createLabel: () => ({ addLabel: () => {} }), search: () => [] },
};
const read = f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
const EXPORTS = [
  'SK', 'SIGNAL_WEIGHT_', 'SIGNAL_DIR_', 'BT_MIN_HISTORY', 'BT_FORWARD',
  'parseYahooBars_', 'detectSakata_', 'rsiSeries_', 'macdSeries_',
  'extractMlRow_', 'buildDateCloseMap_', 'barDateKey_', 'signalHorizon_',
  'signalStrength_', 'patternPoints_', 'medianTurnover_', 'isLiquidEnough_',
  'ML', 'wilsonInterval_', 'decideWeight_',
];
const M = new Function(...Object.keys(sandbox), `
${read('FetchRetry.js')}
${read('ConfirmUi.js')}
${read('StockCode.js')}
${read('Code.js')}
${read('MarketMacro.js')}
${read('MLWeights.js')}
return { ${EXPORTS.join(', ')} };
`)(...Object.values(sandbox));

/* ── Yahoo 取得 ───────────────────────────────────────────────────────────── */

// parseYahooBars_ は HTTPResponse 風のオブジェクトを受け取るので、同じ形に包む。
const asRes = (status, text) => ({ getResponseCode: () => status, getContentText: () => text });

function fetchChart(symbol) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?range=' + M.SK.YAHOO_RANGE + '&interval=1d';
  return new Promise(resolve => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => resolve(asRes(r.statusCode, d)));
    });
    req.on('error', () => resolve(asRes(0, '')));
    req.setTimeout(20000, () => { req.destroy(); resolve(asRes(0, '')); });
  });
}

/* ── データセット構築（GAS の backtestWeights と同じ手順） ─────────────────── */

// 各パターンが使うホライズンの一覧（基準線をこの粒度で測るため）
function horizonsInUse() {
  const set = {};
  Object.keys(M.SIGNAL_WEIGHT_).forEach(n => { set[M.signalHorizon_(n)] = true; });
  return Object.keys(set).map(Number).sort((a, b) => a - b);
}

/**
 * シグナルと無関係な「素の基準線」を同じデータから測る。
 * 全営業日で翌日始値に入り h営業日後の終値で決済したとき、超過リターンが正になる割合。
 * パターン別の勝率はこれと比べる（0.5とは比べない。理由は decideWeight_ のコメント）。
 */
function accumulateBaseline(acc, bars, idxByDate, horizons) {
  const last = bars.length - 1;
  horizons.forEach(h => {
    const a = acc[h] || (acc[h] = { 買い: [0, 0], 売り: [0, 0] });
    for (let k = M.BT_MIN_HISTORY; k + 1 + h <= last; k++) {
      const entry = bars[k + 1].o, exit = bars[k + 1 + h].c;
      if (!(entry > 0) || !(exit > 0)) continue;
      const b0 = idxByDate[M.barDateKey_(bars[k + 1])], b1 = idxByDate[M.barDateKey_(bars[k + 1 + h])];
      if (b0 == null || b1 == null || !(b0 > 0)) continue;
      const bench = (b1 - b0) / b0, stock = (exit - entry) / entry;
      // extractMlRow_ と同じ式（買い: stock-bench / 売り: (-stock)-(-bench)=bench-stock）
      a.買い[1]++; if (stock - bench > 0) a.買い[0]++;
      a.売り[1]++; if (bench - stock > 0) a.売り[0]++;
    }
  });
}

async function buildDataset(codes, idxByDate) {
  const rows = [];
  const baseAcc = {};
  const horizons = horizonsInUse();
  let ok = 0, ng = 0;
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const slice = codes.slice(i, i + CONCURRENCY);
    const resps = await Promise.all(slice.map(c => fetchChart(c + '.T')));
    resps.forEach((res, si) => {
      if (res.getResponseCode() !== 200) { ng++; return; }
      const bars = M.parseYahooBars_(res);
      const last = bars.length - 1;
      if (bars.length < M.BT_MIN_HISTORY + M.BT_FORWARD + 1) { ng++; return; }
      ok++;
      const code = slice[si];
      const closes = bars.map(b => b.c);
      const rsi = M.rsiSeries_(closes, 14);
      const macd = M.macdSeries_(closes, 12, 26, 9);
      const lastFire = {};
      accumulateBaseline(baseAcc, bars, idxByDate, horizons);
      for (let k = M.BT_MIN_HISTORY; k <= last - M.BT_FORWARD; k++) {
        const signals = M.detectSakata_(bars.slice(0, k + 1));
        if (!signals.length) continue;
        signals.forEach(s => {
          const row = M.extractMlRow_({ bars, i: k, sig: s, code, lastFire, idxByDate, rsi, macd });
          if (row) rows.push(row);
        });
      }
    });
    process.stderr.write('\r  取得 ' + Math.min(i + CONCURRENCY, codes.length) + '/' + codes.length +
      '（成功' + ok + ' 失敗' + ng + '） イベント' + rows.length + '件   ');
    await new Promise(r => setTimeout(r, 120));
  }
  process.stderr.write('\n');
  return { rows, ok, ng, baseAcc };
}

// extractMlRow_ が返す配列（ML_DATA_HEADERS_ の並び）をオブジェクトへ。
const toObj = r => ({
  date: r[0], code: r[1], pattern: r[2], dir: r[3], staticWeight: r[4],
  rsi: r[5], macdHist: r[6], macdDiff: r[7], label: r[13], horizon: r[14],
});

/* ── 本体 ─────────────────────────────────────────────────────────────────── */

const pct = v => (v * 100).toFixed(1) + '%';

(async () => {
  const uniPath = path.join(__dirname, 'universe.json');
  if (!fs.existsSync(uniPath)) {
    console.error('銘柄リストがありません: ' + uniPath);
    console.error('「銘柄」シートのコードを ["1301","1332",...] の形式で置いてください。');
    process.exit(1);
  }
  let codes = JSON.parse(fs.readFileSync(uniPath, 'utf8'));
  if (LIMIT) codes = codes.slice(0, LIMIT);
  console.log('■ 対象: ' + codes.length + '銘柄 / 期間 ' + M.SK.YAHOO_RANGE);

  console.log('\n■ ベンチマーク（^N225）を取得');
  const idxRes = await fetchChart('^N225');
  const idxBars = M.parseYahooBars_(idxRes);
  if (!idxBars.length) { console.error('日経平均を取得できませんでした。中止します。'); process.exit(1); }
  const idxByDate = M.buildDateCloseMap_(idxBars);
  console.log('  ' + idxBars.length + '営業日 (' + M.barDateKey_(idxBars[0]) + ' 〜 ' + M.barDateKey_(idxBars[idxBars.length - 1]) + ')');

  // 判定ルール（しきい値）を試すたびに1200銘柄を取り直すのは無駄なので、
  // 生成したデータセットはキャッシュする。--refresh で作り直す。
  const cachePath = path.join(__dirname, 'dataset_cache.json');
  let raw, ok, ng, baseAcc;
  if (!args.includes('--refresh') && fs.existsSync(cachePath) && !LIMIT) {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    ({ raw, ok, ng, baseAcc } = c);
    console.log('\n■ キャッシュを使用（' + c.generatedAt + '）  ※作り直すには --refresh');
  } else {
    console.log('\n■ 全銘柄を走査してデータセットを作る');
    ({ rows: raw, ok, ng, baseAcc } = await buildDataset(codes, idxByDate));
    if (!LIMIT) {
      fs.writeFileSync(cachePath, JSON.stringify({ generatedAt: new Date().toISOString(), raw, ok, ng, baseAcc }));
    }
  }
  const rows = raw.map(toObj);
  console.log('  銘柄 成功' + ok + ' / 失敗' + ng + '  → イベント ' + rows.length + '件');
  if (!rows.length) { console.error('イベントが0件でした。中止します。'); process.exit(1); }

  // 素の基準線。これと比べないと「指数の作り」を「パターンの優位性」と読み違える。
  console.log('\n■ 素の基準線（シグナル無しで全営業日に入った場合の勝率）');
  const baseline = {};
  Object.keys(baseAcc).sort((a, b) => a - b).forEach(h => {
    ['買い', '売り'].forEach(d => {
      const [w, n] = baseAcc[h][d];
      const p = n ? w / n : 0.5;
      baseline[d + '|' + h] = p;
      console.log('  ' + String(h).padStart(2) + '日後 ' + d + ': ' + pct(p).padStart(6) + '  (n=' + n + ')');
    });
  });
  console.log('  ※日経平均は値がさ株偏重のため個別株の中央値が劣後する。0.5ではなくこの値と比べる。');

  // パターンごとに Wilson 区間で重みを決める
  const agg = {};
  rows.forEach(r => {
    const a = agg[r.pattern] || (agg[r.pattern] = { n: 0, wins: 0, dir: r.dir });
    a.n++; a.wins += (Number(r.label) === 1 ? 1 : 0);
  });

  const all = Object.keys(M.SIGNAL_WEIGHT_);
  // Bonferroni: 有意水準 0.05 を検定数で割る。両側なので分位点は 1-α/(2m)。
  // 正規分位点は Acklam の有理近似（外部ライブラリを足さないため）。
  const normInv = p => {
    const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
    const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
    const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1-p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
  };
  const Z = BONFERRONI ? normInv(1 - 0.05 / (2 * all.length)) : undefined;
  if (BONFERRONI) console.log('\n■ 多重比較の補正あり: ' + all.length + '検定 → z=' + Z.toFixed(3) + '（通常1.96）');
  const results = all.map(name => {
    const dir = M.SIGNAL_DIR_[name] || '';
    const h = M.signalHorizon_(name);
    const a = agg[name] || { n: 0, wins: 0, dir };
    const cur = M.SIGNAL_WEIGHT_[name];
    const base = baseline[dir + '|' + h];
    const d = M.decideWeight_(a.wins, a.n, cur, { baseline: base, minEdge: MIN_EDGE, z: Z });
    return { name, dir, horizon: h, n: a.n, wins: a.wins, baseline: base,
      edge: a.n ? (a.wins / a.n - (base == null ? 0.5 : base)) : null,
      cur, next: d.weight, reason: d.reason, ci: d.ci };
  }).sort((x, y) => y.n - x.n);

  console.log('\n■ パターン別の判定（' + M.ML.MIN_PATTERN_SAMPLE + '件未満は現行値を維持）');
  console.log('  基準線に対する上振れ幅(差)で見る。勝率そのものではなく差が効いているかを問う。');
  console.log('  ' + 'パターン'.padEnd(24) + '方向 日数  件数   勝率   基準   差      Wilson95%CI      重み     判定');
  console.log('  ' + '─'.repeat(116));
  results.forEach(r => {
    const ciTxt = r.ci ? '[' + pct(r.ci.lower).padStart(6) + ',' + pct(r.ci.upper).padStart(6) + ']' : '     —';
    const wr = r.n ? pct(r.wins / r.n) : '—';
    const bs = r.baseline != null ? pct(r.baseline) : '—';
    const ed = r.edge != null ? ((r.edge >= 0 ? '+' : '') + (r.edge * 100).toFixed(1) + 'pt') : '—';
    const mark = r.cur === r.next ? '   ' : ' ★ ';
    console.log('  ' + r.name.padEnd(22) + (r.dir || '').padEnd(4) + String(r.horizon).padStart(3) +
      String(r.n).padStart(7) + ' ' + wr.padStart(6) + ' ' + bs.padStart(6) + ' ' + ed.padStart(7) + '  ' +
      ciTxt.padEnd(17) + mark + (r.cur + '→' + r.next).padEnd(6) + r.reason);
  });

  const changed = results.filter(r => r.cur !== r.next);
  console.log('\n  変更: ' + changed.length + '件 / ' + results.length + 'パターン');

  // ★分布への影響（同じシグナル集合に旧重み・新重みを当てて比べる）
  console.log('\n■ ★分布への影響（地合い係数=1.0 と仮定、しきい値 ★3=' + M.SK.STAR3 + ' / ★2=' + M.SK.STAR2 + '）');
  const nextWeight = {};
  results.forEach(r => { nextWeight[r.name] = r.next; });
  // 同一銘柄・同一日に同時点灯したパターンの組を復元して、合計点の分布を見る
  const byKey = {};
  rows.forEach(r => {
    const k = r.code + '|' + r.date;
    (byKey[k] || (byKey[k] = [])).push(r.pattern);
  });
  const star = (sum) => sum >= M.SK.STAR3 ? '★★★' : sum >= M.SK.STAR2 ? '★★' : '★';
  const tally = { 旧: { '★★★': 0, '★★': 0, '★': 0 }, 新: { '★★★': 0, '★★': 0, '★': 0 } };
  Object.keys(byKey).forEach(k => {
    const names = byKey[k];
    const o = names.reduce((s, n) => s + (M.SIGNAL_WEIGHT_[n] || 1), 0);
    const w = names.reduce((s, n) => s + (nextWeight[n] || 1), 0);
    tally.旧[star(o)]++; tally.新[star(w)]++;
  });
  const total = Object.keys(byKey).length;
  console.log('  対象: ' + total + '件（銘柄×日）');
  ['★★★', '★★', '★'].forEach(s => {
    const o = tally.旧[s], w = tally.新[s];
    const diff = w - o;
    console.log('  ' + s.padEnd(6) + '旧 ' + String(o).padStart(6) + ' → 新 ' + String(w).padStart(6) +
      '  (' + (diff >= 0 ? '+' : '') + diff + ' / ' + (o ? ((diff / o) * 100).toFixed(0) : '—') + '%)');
  });

  // SIGNAL_WEIGHT_ ブロックを構築し、src/Code.js のマーカー間へ直接書き込む
  console.log('\n■ src/Code.js の SIGNAL_WEIGHT_ を更新');
  console.log('─'.repeat(104));
  const stamp = new Date().toISOString().slice(0, 10);
  const baseTxt = Object.keys(baseline).sort().map(k => k.replace('|', '') + '日' + pct(baseline[k])).join(' / ');
  const edgeUsed = (MIN_EDGE != null ? MIN_EDGE : M.ML.MIN_EDGE) * 100;
  const lines = [];
  lines.push('const SIGNAL_WEIGHT_ = {');
  lines.push('  // ' + stamp + ' 実データで算出（' + ok + '銘柄・' + M.SK.YAHOO_RANGE + '・日経平均控除後）。再現は npm run calc-weights');
  lines.push('  // 比較対象は0.5ではなく「シグナル無しで入った場合の勝率」＝ ' + baseTxt);
  lines.push('  //   日経平均は値がさ株偏重で個別株の中央値が劣後するため、控除後でも0.5にならない。');
  lines.push('  // 動かす条件は次の3つを全て満たすもの。それ以外は人手で決めた従来値のまま。');
  lines.push('  //   ①' + M.ML.MIN_PATTERN_SAMPLE + '件以上  ②Wilson区間が基準線を外れる' +
    (BONFERRONI ? '（Bonferroni補正 z=' + Z.toFixed(2) + '）' : '（z=1.96）') +
    '  ③基準線との差が' + edgeUsed.toFixed(0) + 'pt以上');
  lines.push('  //   ③が要るのは、件数が数千あると1〜2ptの差でも②を通ってしまうため（有意≠意味のある差）。');
  results.slice().sort((a, b) => (a.name < b.name ? -1 : 1)).forEach(r => {
    const ciTxt = r.ci ? 'CI[' + pct(r.ci.lower) + ',' + pct(r.ci.upper) + ']' : '';
    const ed = r.edge != null ? ((r.edge >= 0 ? '+' : '') + (r.edge * 100).toFixed(1) + 'pt') : '';
    const note = r.n
      ? ('n=' + r.n + ' ' + pct(r.wins / r.n) + '(基準' + pct(r.baseline) + ' ' + ed + ') ' + ciTxt + ' → ' + r.reason)
      : '該当なし → 現行値を維持';
    lines.push("  '" + r.name + "': " + r.next + ',' +
      ' '.repeat(Math.max(1, 26 - r.name.length)) + '// ' + note + (r.cur !== r.next ? '（旧' + r.cur + '）' : ''));
  });
  lines.push('};');
  const blockText = lines.join('\n');
  console.log(blockText);
  console.log('─'.repeat(104));

  const codePath = path.join(ROOT, 'src', 'Code.js');
  const startMarker = '// SIGNAL_WEIGHT_ AUTO-GENERATED START';
  const endMarker = '// SIGNAL_WEIGHT_ AUTO-GENERATED END';
  const codeSrc = fs.readFileSync(codePath, 'utf8');
  const ms = codeSrc.indexOf(startMarker), me = codeSrc.indexOf(endMarker);
  if (ms === -1 || me === -1) {
    console.error('\nSIGNAL_WEIGHT_ のマーカーが src/Code.js に見つかりません。書き込みをスキップしました。');
  } else {
    const nextSrc = codeSrc.slice(0, ms + startMarker.length) + '\n' + blockText + '\n' + codeSrc.slice(me);
    fs.writeFileSync(codePath, nextSrc);
    console.log('\nsrc/Code.js の SIGNAL_WEIGHT_ を更新しました。git diff で確認してください。');
  }

  fs.writeFileSync(path.join(__dirname, 'weights_result.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), universe: codes.length, fetched: ok, events: rows.length, results }, null, 2));
  console.log('詳細を tools/weights_result.json に保存しました。');
})();
