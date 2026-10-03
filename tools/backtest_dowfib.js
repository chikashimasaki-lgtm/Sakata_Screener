/**
 * ダウ理論×フィボナッチ買い推奨（src/DowFib.js）のバックテスト。旧★3買い（酒田五法）とも同条件で比べる。
 *
 *   BARS_DIR=<Yahoo chart JSON を置いたフォルダ> node tools/backtest_dowfib.js [--old] [--split 2025-10-01]
 *
 * BARS_DIR には <コード>.T.json（range=3y&interval=1d の生レスポンス）と _N225.json を置く。
 * 本番と同じファイル（src/DowFib.js・src/Code.js）を読み込むので、ロジックの二重管理はない。
 *
 * 約定の前提（楽観バイアスを避ける）:
 *  - シグナルは引け後に出るので、約定は翌営業日の寄付。寄付が損切り以下/利確以上なら見送り。
 *  - 同じ日に損切りと利確の両方に触れたら損切りを先に約定させる（保守側）。
 *  - 寄付で損切りを下に窓開けしたら寄付で約定（損切り値では約定できない）。
 *  - 往復コスト 0.2% を差し引く。
 *  - 1日 TOP_N 件まで（スコア上位）。同じ銘柄の保有中の再推奨は数えない。
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BARS_DIR = process.env.BARS_DIR || arg('--bars');
if (!BARS_DIR) { console.error('BARS_DIR を指定してください'); process.exit(1); }
const SPLIT = arg('--split', '2022-01-01');      // これ以前=検討期間 / 以後=検証期間（パラメータは触っていない区間）
const WITH_OLD = args.includes('--old');
const COST = 0.002;

const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const sandbox = {
  Logger: { log: () => {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  SpreadsheetApp: {}, UrlFetchApp: {}, Utilities: { formatDate: d => d.toISOString().slice(0, 10), sleep: () => {} },
  ScriptApp: {}, Session: {}, DriveApp: {}, MailApp: {}, GmailApp: {},
};
const M = new Function(...Object.keys(sandbox), `
${src('StockCode.js')}
${src('Code.js')}
${src('DowFib.js')}
return { DF, dfSetup_, dfRawSwings_, parseYahooBars_, detectSakata_, signalStrength_, isLiquidEnough_, SK };
`)(...Object.values(sandbox));

// 変種を試すための上書き（例: DF_FIB_MAX=0.7）
Object.keys(process.env).filter(k => k.startsWith('DF_')).forEach(k => {
  M.DF[k.slice(3)] = Number(process.env[k]);
});

const resOf = txt => ({ getResponseCode: () => 200, getContentText: () => txt });
const load = f => M.parseYahooBars_(resOf(fs.readFileSync(path.join(BARS_DIR, f), 'utf8')));
const day = b => new Date((b.t + 9 * 3600) * 1000).toISOString().slice(0, 10);


function simulate(bars, e, stop, target, hold) {
  const n = e + 1;
  if (n + hold >= bars.length) return null;
  const entry = bars[n].o;
  if (!(entry > stop) || (target != null && entry >= target)) return null;
  for (let j = n; j <= n + hold - 1; j++) {
    const b = bars[j];
    if (j > n && b.o <= stop) return { r: b.o / entry - 1 - COST, why: 'stop', d: j - n };
    if (b.l <= stop) return { r: stop / entry - 1 - COST, why: 'stop', d: j - n };
    if (target != null && b.h >= target) return { r: (j > n ? Math.max(target, b.o) : target) / entry - 1 - COST, why: 'target', d: j - n };
  }
  return { r: bars[n + hold - 1].c / entry - 1 - COST, why: 'time', d: hold };
}
// 損切り・利確なしで HOLD 日持ったときの騰落（旧ロジックとの単純比較用）
function fwd(bars, e, hold) {
  if (e + hold >= bars.length) return null;
  return bars[e + hold].c / bars[e + 1].o - 1 - COST;
}

const files = fs.readdirSync(BARS_DIR).filter(f => /^\w+\.T\.json$/.test(f) && f !== '1306.T.json');
const byDay = {};      // 日付 → 候補
const oldByDay = {};
const allFwd = {};     // 日付 → 全銘柄の HOLD 日騰落（ベンチマーク）
const H = M.DF.HOLD_DAYS;
const FWD = 20;   // ベンチ・旧ロジックとの比較に使う単純保有日数
let nStocks = 0;
for (const f of files) {
  const bars = load(f);
  if (bars.length < 200) continue;
  nStocks++;
  const code = f.replace('.T.json', '');
  const rawP = M.dfRawSwings_(bars, M.DF.PRIMARY_W), rawM = M.dfRawSwings_(bars, M.DF.MINOR_W);
  for (let e = 210; e < bars.length - 1; e++) {
    const d = day(bars[e]);
    const fr = fwd(bars, e, FWD);
    if (fr != null) (allFwd[d] = allFwd[d] || []).push(fr);
    // 流動性（本番と同じ：直近20日売買代金中央値 5,000万円）
    const win = bars.slice(e - 20, e + 1);
    if (!M.isLiquidEnough_(win)) continue;
    const s = M.dfSetup_(bars, e, rawP, rawM);
    if (s) {
      const t = simulate(bars, e, s.stop, s.target, H);
      (byDay[d] = byDay[d] || []).push({ code, s, t, fr });
    }
    if (WITH_OLD) {
      const slice = bars.slice(e - 123, e + 1);
      const sig = M.detectSakata_(slice);
      if (sig.length && sig.every(x => x.dir === '買い')) {
        const sc = M.signalStrength_(sig.map(x => '・' + x.name).join('\n'));
        if (sc >= M.SK.STAR3) (oldByDay[d] = oldByDay[d] || []).push({ code, sc, fr });
      }
    }
  }
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = x => (x * 100).toFixed(2) + '%';
function report(label, picks, key) {
  const rs = picks.map(p => key(p)).filter(r => r != null);
  const wins = rs.filter(r => r > 0);
  const gw = wins.reduce((a, b) => a + b, 0), gl = -rs.filter(r => r <= 0).reduce((a, b) => a + b, 0);
  return `${label.padEnd(26)} n=${String(rs.length).padStart(5)}  勝率=${(wins.length / rs.length * 100).toFixed(1)}%  平均=${pct(mean(rs))}  PF=${(gw / gl).toFixed(2)}`;
}

function pick(dayMap, scoreFn, filterDay) {
  const out = [];
  const days = Object.keys(dayMap).sort();
  for (const d of days) {
    if (!filterDay(d)) continue;
    const c = dayMap[d].slice().sort((a, b) => scoreFn(b) - scoreFn(a)).slice(0, M.DF.TOP_N);
    c.forEach(x => out.push(Object.assign({ d }, x)));
  }
  return out;
}

const periods = [['検討期間(〜' + SPLIT + ')', d => d < SPLIT], ['検証期間(' + SPLIT + '〜)', d => d >= SPLIT]];
console.log(`銘柄 ${nStocks} / 最長保有 ${H}日 / DF=${JSON.stringify(M.DF)}`);
console.log('ex=同じ日の全銘柄平均(' + FWD + '日保有)との差。損切/利確=翌日寄付で買い、損切り・利確・最長' + H + '日で手仕舞い');
const exOf = p => p.fr == null ? null : p.fr - benchMean[p.d];
const benchMean = {}; Object.keys(allFwd).forEach(d => { benchMean[d] = mean(allFwd[d]); });
for (const [pl, inP] of periods) {
  console.log('\n■ ' + pl);
  const days = Object.keys(allFwd).filter(inP);
  const bench = [].concat(...days.map(d => allFwd[d]));
  console.log(report('ベンチ(全銘柄' + FWD + '日保有)', bench.map(r => ({ r })), p => p.r));
  const top = pick(byDay, x => x.s.score, d => inP(d));
  const A = top.filter(p => p.s.grade === 'A'), B = top.filter(p => p.s.grade === 'B');
  for (const [lab, set] of [['新: 上位' + M.DF.TOP_N, top], ['新: 確度A', A], ['新: 確度B', B]]) {
    console.log(report(lab + ' 損切/利確', set, p => p.t && p.t.r));
    console.log(report(lab + ' ' + FWD + '日保有', set, p => p.fr) + `  ex=${pct(mean(set.map(exOf).filter(x => x != null)))}`);
  }
  console.log(`  1日平均 ${(top.length / days.length).toFixed(2)}件（うちA ${(A.length / days.length).toFixed(2)}件）`);
  if (WITH_OLD) {
    const old = [].concat(...Object.keys(oldByDay).filter(inP).map(d => oldByDay[d]));
    console.log(report('旧: ★3買い ' + FWD + '日保有', old, p => p.fr) + `  ex=${pct(mean(old.map(exOf).filter(x => x != null)))}`);
    console.log(`  旧★3買い 1日平均 ${(old.length / days.length).toFixed(1)}件`);
  }
}
