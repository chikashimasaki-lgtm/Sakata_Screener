/**
 * ML参考重み（実験的）
 * ---------------------------------------------------------------------------
 * 酒田五法シグナルの「効きやすさ」を、L2正則化ロジスティック回帰で学習して**参考表示**する。
 *
 * なぜ作るか:
 *   本番の★スコアは signalStrength_()（静的重みの単純合計）× regimeFactor_() の掛け算1回で、
 *   重みは人手で決めた 1〜3 の固定値。過去に suggestWeight_() でバックテスト勝率から重みを
 *   推定する試みがあったが、次の統計的欠陥を理由に**意図的に廃止**された（Code.js の同関数コメント）。
 *     1. ベンチマーク未控除の生騰落率で勝率を測っていた（上昇相場では買いが軒並み高勝率に見えるだけ）
 *     2. n=20 では勝率60%と50%を区別できない（標準誤差 約11pt）、有意性検定なし
 *     3. 同一シグナルの連日重複計上で実効サンプル数が水増し
 *     4. 約定を当日終値と仮定（実際は翌日寄付）
 *   ここではこの4点を構造的に潰したデータセット（ML学習データシート、Code.js の
 *   backtestWeights() が生成）を入力にする。それでもサンプル数は数十〜数百のオーダーなので、
 *   **本番の順位付けには一切反映しない**。「パターン成績」と同じ参考値の扱いに留める。
 *
 * 設計上の約束:
 *   - このファイルのトップレベルは自己完結な定数 ML のみ。SK 等の他ファイルのシンボルは
 *     必ず関数の内部から参照する（.clasp.json の filePushOrder が空でpush順が保証されないため。
 *     MarketMacro.js と同じ作法）。
 *   - 学習・評価まわりは GAS API に触らない純粋関数として書く（tests/verify.js から直接叩けるように）。
 */

// 自己完結な設定。他ファイルのシンボルを参照しないこと（上記の理由）。
const ML = {
  SHEET_DATA: 'ML学習データ',
  SHEET_OUT:  'ML重み(参考)',

  // 個別 one-hot 列を与えるのに必要な最低発生件数。これ未満のパターンは
  // 静的重み（1〜3）の数値1列に丸め込む。パターン名は約28種あり、素直に one-hot すると
  // サンプル数に対して次元が過大（過学習・多重共線性）になるため。
  MIN_PATTERN_ONEHOT: 15,

  // 方向（買い/売り）あたりの最低サンプル数。これ未満なら学習自体を行わない。
  // suggestWeight_ の BT_MIN_SAMPLE=20 が「n=20では有意差を語れない」と反省された経緯を踏まえ、
  // 5分割交差検証で各フォールド12件以上を確保できる水準に置く。
  MIN_SAMPLE_PER_DIR: 60,

  // SIGNAL_WEIGHT_ を動かすのに必要な、パターン1つあたりの最低件数。
  // これ未満は判定せず現行の静的重みを維持する（decideWeight_）。
  MIN_PATTERN_SAMPLE: 30,

  // 重みを動かすのに必要な、基準線からの最小の差（＝効果量）。
  // 統計的有意性だけを条件にすると、件数が大きいパターンで些細な差が通ってしまう。
  // 実データでは毛抜き天井が n=6650・基準+1.6pt で「有意」となり、重み1→3に跳ね上がった。
  // n が大きいほど小さな差でも有意になるのは当然で、有意であることと意味のある差であることは別。
  // 重みは1〜3の3段階しかなく1段の重みが★の判定を大きく動かすため、
  // 「検出できる差」ではなく「目に見える差」を要求する。
  MIN_EDGE: 0.05,   // 5ポイント

  FOLDS: 5,                                // ブロック分割時系列交差検証の分割数
  LAMBDAS: [0.01, 0.1, 1, 3, 10],          // L2強度のグリッド
  LEARNING_RATE: 0.1,
  EPOCHS: 500,
};

// ============================================================================
//  数値ユーティリティ（純粋関数）
// ============================================================================

/**
 * シグモイド関数。
 * exp のオーバーフローを避けるため z の符号で式を切り替える（z が大きな負値のとき
 * Math.exp(-z) が Infinity になり 1/(1+Infinity)=0 と、値としては合うが NaN 経路を作りやすい）。
 */
function sigmoid_(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

// 内積。長さが違う場合は短い方に合わせず例外にする（特徴量の作り間違いを黙って通さない）。
function dot_(a, b) {
  if (a.length !== b.length) throw new Error('内積の次元不一致: ' + a.length + ' vs ' + b.length);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * 標準化のパラメータ（列ごとの平均・標準偏差）を求める。
 * **学習フォールドのみ**から求めること。テスト側を含めて標準化すると、テストの分布情報が
 * 学習に混ざる（データリーク）。標準偏差0の列（全行同じ値）は 1 に置き換えて 0除算を避ける。
 */
function standardizeFit_(X) {
  const n = X.length;
  if (!n) return { mean: [], sd: [] };
  const d = X[0].length;
  const mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i][j];
    mean[j] = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) { const dv = X[i][j] - mean[j]; v += dv * dv; }
    const sdv = Math.sqrt(v / n);
    sd[j] = (sdv > 1e-12) ? sdv : 1;   // 定数列は割らない（係数は0付近に落ちる）
  }
  return { mean, sd };
}

// standardizeFit_ で得たパラメータを別の行列へ適用する。
function standardizeApply_(X, params) {
  return X.map(row => row.map((v, j) => (v - params.mean[j]) / params.sd[j]));
}

// ============================================================================
//  ロジスティック回帰（L2正則化・フルバッチ勾配降下）
// ============================================================================

/**
 * 正則化付き対数損失と勾配を返す。
 * 損失 = -(1/n)Σ[y log p + (1-y) log(1-p)] + (lambda/(2n))|w|^2
 * バイアス b は正則化しない（切片まで0へ引っ張ると、クラス比率の偏りを表現できなくなる）。
 */
function logisticGrad_(X, y, w, b, lambda) {
  const n = X.length;
  if (!n) return { loss: 0, gw: w.map(() => 0), gb: 0 };
  const d = w.length;
  const gw = new Array(d).fill(0);
  let gb = 0, loss = 0;
  for (let i = 0; i < n; i++) {
    const p = sigmoid_(dot_(X[i], w) + b);
    // log(0) を避けるクリップ。p は sigmoid_ の出力なので [0,1]。
    const pc = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
    loss += -(y[i] * Math.log(pc) + (1 - y[i]) * Math.log(1 - pc));
    const err = p - y[i];
    for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
    gb += err;
  }
  loss /= n;
  gb /= n;
  let reg = 0;
  for (let j = 0; j < d; j++) {
    gw[j] = gw[j] / n + (lambda / n) * w[j];
    reg += w[j] * w[j];
  }
  loss += (lambda / (2 * n)) * reg;
  return { loss, gw, gb };
}

/**
 * L2正則化ロジスティック回帰をフルバッチ勾配降下法で学習する。
 *
 * Adam やミニバッチSGDは使わない。サンプルが数十〜数百と小さく、確率的な要素を入れると
 * 実行のたびに係数が変わって「参考値」としての再現性が損なわれるため。固定学習率で十分収束する。
 * 収束の確認用に各エポックの損失を lossHistory に積む。
 */
function trainLogisticRegression_(X, y, opts) {
  opts = opts || {};
  const lambda = (opts.lambda != null) ? opts.lambda : 1;
  const lr     = (opts.lr     != null) ? opts.lr     : ML.LEARNING_RATE;
  const epochs = (opts.epochs != null) ? opts.epochs : ML.EPOCHS;
  const d = X.length ? X[0].length : 0;
  let w = new Array(d).fill(0), b = 0;
  const lossHistory = [];
  let diverged = false;
  for (let e = 0; e < epochs; e++) {
    const g = logisticGrad_(X, y, w, b, lambda);
    // 発散の検知。正則化の実効ステップ lr*lambda/n が2を超えると更新が振動して膨張し、
    // やがて Infinity → NaN になる（n=20, lr=0.1, λ=500 で再現）。
    // 実運用のグリッド（λ≦10）とサンプル数（≧MIN_SAMPLE_PER_DIR）では起きないが、
    // 黙って NaN や 1e87 の係数をシートへ出すと「効きの強い特徴量」に見えてしまう。
    // 直前の有限な係数を返し、発散した事実を呼び出し側へ伝える。
    if (!isFinite(g.loss)) { diverged = true; break; }
    const prevW = w.slice(), prevB = b;
    for (let j = 0; j < d; j++) w[j] -= lr * g.gw[j];
    b -= lr * g.gb;
    if (!w.every(isFinite) || !isFinite(b)) { w = prevW; b = prevB; diverged = true; break; }
    lossHistory.push(g.loss);
  }
  return { w, b, lossHistory, diverged };
}

// 予測確率。
function predictProba_(X, w, b) {
  return X.map(row => sigmoid_(dot_(row, w) + b));
}

// ============================================================================
//  評価指標
// ============================================================================

/**
 * ROC-AUC。閾値に依存しないので、クラス比率が偏ったデータでも正解率より実態を反映する。
 * Mann-Whitney の U統計量で求める（順位和ベース）。同値スコアには平均順位を与える。
 * 片方のクラスが0件のときは定義できないので null を返す。
 */
function rocAuc_(yTrue, yScore) {
  const n = yTrue.length;
  const pos = yTrue.reduce((s, v) => s + (v === 1 ? 1 : 0), 0);
  const neg = n - pos;
  if (!pos || !neg) return null;
  const idx = yScore.map((s, i) => ({ s, y: yTrue[i] })).sort((a, b) => a.s - b.s);
  // 同値グループへ平均順位を割り当てる（1始まり）
  const rank = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1].s === idx[i].s) j++;
    const avg = (i + j + 2) / 2;   // (i+1 .. j+1) の平均
    for (let k = i; k <= j; k++) rank[k] = avg;
    i = j + 1;
  }
  let sumRankPos = 0;
  for (let k = 0; k < n; k++) if (idx[k].y === 1) sumRankPos += rank[k];
  return (sumRankPos - pos * (pos + 1) / 2) / (pos * neg);
}

/**
 * 2値分類の基本指標。分母0のケース（陽性と予測したものが1件もない等）は
 * 0ではなく null を返す。0と表示すると「性能が悪い」と読めてしまうが、実際は「定義できない」ため。
 */
function evaluateBinary_(yTrue, yScore, threshold) {
  const th = (threshold != null) ? threshold : 0.5;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const pred = yScore[i] >= th ? 1 : 0;
    if (pred === 1 && yTrue[i] === 1) tp++;
    else if (pred === 1 && yTrue[i] === 0) fp++;
    else if (pred === 0 && yTrue[i] === 0) tn++;
    else fn++;
  }
  const total = tp + fp + tn + fn;
  const accuracy  = total ? (tp + tn) / total : null;
  const precision = (tp + fp) ? tp / (tp + fp) : null;
  const recall    = (tp + fn) ? tp / (tp + fn) : null;
  const f1 = (precision != null && recall != null && (precision + recall) > 0)
    ? 2 * precision * recall / (precision + recall) : null;
  return { tp, fp, tn, fn, accuracy, precision, recall, f1 };
}

// ============================================================================
//  交差検証
// ============================================================================

/**
 * 時系列を連続ブロックへ分割したフォールドを返す（[{trainIdx, testIdx}, ...]）。
 *
 * ランダムK-foldは使わない。同一銘柄の近接日イベントや、同じ日に点灯した別銘柄は
 * 市場全体の変動を共有していて強く相関する。ランダムに混ぜると「実質同じ値動きを
 * 学習側と評価側の両方で見る」ことになり、評価が甘く出る（時系列データ特有のリーク）。
 * 呼び出し側は**日付昇順に並べた行**を渡すこと。
 */
function blockedTimeSeriesFolds_(n, k) {
  const folds = [];
  if (!(n > 0) || !(k > 1)) return folds;
  const size = Math.floor(n / k);
  if (!size) return folds;
  for (let f = 0; f < k; f++) {
    const start = f * size;
    const end = (f === k - 1) ? n : start + size;   // 端数は最終フォールドへ寄せる
    const testIdx = [], trainIdx = [];
    for (let i = 0; i < n; i++) (i >= start && i < end ? testIdx : trainIdx).push(i);
    folds.push({ trainIdx, testIdx });
  }
  return folds;
}

/**
 * 指定 lambda でブロック分割交差検証を回し、フォールドごとのAUC・正解率等を返す。
 * 標準化は毎フォールドの**学習側だけ**で fit し、テスト側へ apply する（リーク対策）。
 */
function crossValidate_(X, y, lambda, opts) {
  opts = opts || {};
  const k = opts.folds || ML.FOLDS;
  const folds = blockedTimeSeriesFolds_(X.length, k);
  const aucs = [], accs = [];
  folds.forEach(f => {
    const Xtr = f.trainIdx.map(i => X[i]), ytr = f.trainIdx.map(i => y[i]);
    const Xte = f.testIdx.map(i => X[i]),  yte = f.testIdx.map(i => y[i]);
    if (!Xtr.length || !Xte.length) return;
    // 学習側に片方のクラスしか無いフォールドは学習が成立しないので飛ばす
    const uniq = ytr.reduce((s, v) => s + v, 0);
    if (uniq === 0 || uniq === ytr.length) return;
    const sp = standardizeFit_(Xtr);
    const m = trainLogisticRegression_(standardizeApply_(Xtr, sp), ytr,
      { lambda, lr: opts.lr, epochs: opts.epochs });
    if (m.diverged) return;   // 発散したフォールドの予測は意味を持たないので評価に混ぜない
    const p = predictProba_(standardizeApply_(Xte, sp), m.w, m.b);
    const auc = rocAuc_(yte, p);
    if (auc != null) aucs.push(auc);
    const ev = evaluateBinary_(yte, p);
    if (ev.accuracy != null) accs.push(ev.accuracy);
  });
  return {
    lambda,
    nFolds: aucs.length,
    aucMean: aucs.length ? aucs.reduce((s, v) => s + v, 0) / aucs.length : null,
    aucSd:   aucs.length ? Math.sqrt(aucs.reduce((s, v) => s + v * v, 0) / aucs.length -
             Math.pow(aucs.reduce((s, v) => s + v, 0) / aucs.length, 2)) : null,
    accMean: accs.length ? accs.reduce((s, v) => s + v, 0) / accs.length : null,
  };
}

/**
 * lambda のグリッド探索。交差検証の平均AUCが最良のものを選ぶ。
 * AUCが1つも算出できなかった（＝どのフォールドも片クラスだった等）場合は null を返す。
 */
function selectLambda_(X, y, lambdas, opts) {
  const grid = (lambdas && lambdas.length) ? lambdas : ML.LAMBDAS;
  const results = grid.map(l => crossValidate_(X, y, l, opts));
  const valid = results.filter(r => r.aucMean != null);
  if (!valid.length) return { best: null, results };
  const best = valid.reduce((a, b) => (b.aucMean > a.aucMean ? b : a));
  return { best, results };
}

// ============================================================================
//  特徴量の組み立て
// ============================================================================

/**
 * 学習データ行（ML学習データシートのオブジェクト配列）から特徴量行列を作る。
 *
 * パターン名は「発生件数が MIN_PATTERN_ONEHOT 以上のものだけ」個別の one-hot 列を与え、
 * それ未満は staticWeight（1〜3）の1列へ丸め込む。全パターンを one-hot にすると
 * 約28次元となり、サンプル数（数十〜数百）に対して次元が過大になるため。
 *
 * opts.excludeStaticWeight を立てると「静的重み」列を作らない。
 * SIGNAL_WEIGHT_ そのものを決めるために学習するときに使う。静的重みを入力に含んだまま
 * その出力で SIGNAL_WEIGHT_ を書き換えると、次の学習は自分が出した重みを読むことになり、
 * 値が自己参照で強化されていく（何度か回すと初期値とは無関係に発散・固着する）。
 *
 * rows の各要素: { date, code, pattern, dir, staticWeight, rsi, macdHist, macdDiff, label }
 * 戻り値: { X, y, names }（names は特徴量の並び順のラベル）
 */
function buildFeatureMatrix_(rows, opts) {
  opts = opts || {};
  const minOnehot = (opts.minPatternOnehot != null) ? opts.minPatternOnehot : ML.MIN_PATTERN_ONEHOT;
  const useStatic = !opts.excludeStaticWeight;
  const counts = {};
  rows.forEach(r => { counts[r.pattern] = (counts[r.pattern] || 0) + 1; });
  const onehot = Object.keys(counts).filter(p => counts[p] >= minOnehot).sort();
  const names = onehot.map(p => 'P:' + p)
    .concat(useStatic ? ['静的重み'] : [])
    .concat(['RSI14', 'MACDヒスト', 'MACD-Signal差']);
  const X = rows.map(r => {
    const row = onehot.map(p => (r.pattern === p ? 1 : 0));
    if (useStatic) row.push(Number(r.staticWeight) || 0);
    row.push(Number(r.rsi) || 0);
    row.push(Number(r.macdHist) || 0);
    row.push(Number(r.macdDiff) || 0);
    return row;
  });
  const y = rows.map(r => (Number(r.label) === 1 ? 1 : 0));
  return { X, y, names, onehot };
}

// ============================================================================
//  重みの決定（Wilson信頼区間で有意なものだけ動かす）
// ============================================================================

/**
 * 二項比率の Wilson score 信頼区間。
 *
 * 単純な正規近似（p ± z√(p(1-p)/n)）は、pが0や1に近いときや件数が少ないときに
 * 区間が[0,1]をはみ出すうえ被覆確率も落ちる。Wilson区間はその両方を避けられる。
 *
 * ここでこれを使うのは、suggestWeight_ が「n=20に対し勝率60%と50%を3段階に切っていたが、
 * n=20の標準誤差は約11ptあり両者を統計的に区別できない」という理由で廃止されたため。
 * 点推定の大小で重みを動かすと同じ誤りを繰り返す。区間が0.5をまたぐ間は「分からない」と扱う。
 *
 * @param {number} wins 成功数
 * @param {number} n 試行数
 * @param {number} [z] 標準正規の分位点（既定1.96 ≒ 95%）
 * @return {{lower:number, upper:number, p:number}|null} n<=0 なら null
 */
function wilsonInterval_(wins, n, z) {
  if (!(n > 0)) return null;
  const zz = (z == null) ? 1.96 : z;
  const p = wins / n;
  const z2 = zz * zz;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (zz * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

/**
 * パターン1つの重みを決める。
 *
 * ■ 比較対象は 0.5 ではなく「同じ方向・同じホライズンの素の基準線」
 *
 * 勝率は「日経平均の同期間リターンを引いた超過リターンが正だった割合」だが、
 * これは 0.5 を中心に分布しない。実測（1245銘柄・6ヶ月）では、シグナルと無関係に
 * 全営業日で入った場合でも次のようになる。
 *
 *      3日後  買い 41.2% / 売り 58.8%
 *     20日後  買い 39.5% / 売り 60.5%
 *
 * 日経平均は値がさ株偏重の株価平均型で、個別株の中央値はこれに劣後する。加えて
 * 個別株のリターン分布は右に裾を引く（中央値 < 平均）ため、半数以上の銘柄・日が
 * 指数に負ける。結果として「何のシグナルも無しに売れば約59%勝つ」相場になる。
 *
 * ここで 0.5 を基準にすると、売りパターンは軒並み「有意に勝ち越し」、買いパターンは
 * 軒並み「有意に負け越し」と出る。それはパターンの優位性ではなく指数の作りの話で、
 * ベンチマークを控除しなかった suggestWeight_ と同じ誤りを一段深いところで繰り返すことになる。
 * （実データで確認: 毛抜き天井 59.1% は基準58.8%に対し+0.3ptしかないのに、
 *   0.5基準では「有意に勝ち越し」となり重み1→3に上がってしまう）
 *
 * ■ 動かすのは統計的に有意なものだけ
 *
 * 区間が基準線をまたぐケースを一律2に倒してはいけない。意図的に1を与えてある
 * 弱い確認系（はらみ線・毛抜き・RSI系）が「証拠が無い」というだけで2へ繰り上がり、
 * 合計点が押し上がって★★★が急増する（実データで4倍になることを確認済み）。
 * 「区別できない」は「中程度である」ではなく「動かす根拠が無い」と読む。
 *
 * @param {number} wins 超過リターンが正だった件数
 * @param {number} n 件数
 * @param {number} currentWeight 現行の静的重み（有意でない・データ不足のときはこれを返す）
 * @param {Object} [opts] { minSample, z, baseline } baseline は同方向・同ホライズンの素の勝率（既定0.5）
 * @return {{weight:number, reason:string, ci:Object|null, n:number, baseline:number, changed:boolean}}
 */
function decideWeight_(wins, n, currentWeight, opts) {
  opts = opts || {};
  const minSample = (opts.minSample != null) ? opts.minSample : ML.MIN_PATTERN_SAMPLE;
  const minEdge = (opts.minEdge != null) ? opts.minEdge : ML.MIN_EDGE;
  const base = (opts.baseline != null) ? opts.baseline : 0.5;
  const ci = wilsonInterval_(wins, n, opts.z);
  const pctTxt = v => (v * 100).toFixed(1) + '%';
  const ptTxt = v => ((v >= 0 ? '+' : '') + (v * 100).toFixed(1) + 'pt');
  const edge = ci ? ci.p - base : null;
  const out = (weight, reason) => ({ weight, reason, ci, n, baseline: base, edge, changed: currentWeight !== weight });
  const keep = (reason) => ({ weight: currentWeight, reason, ci, n, baseline: base, edge, changed: false });

  if (!ci || n < minSample) return keep('データ不足（' + n + '件 / 必要' + minSample + '件）現行値を維持');
  // ① 統計的に基準線と区別できるか（偶然の範囲か）
  const better = ci.lower > base, worse = ci.upper < base;
  if (!better && !worse) return keep('基準' + pctTxt(base) + 'と区別できない → 現行値を維持');
  // ② 差が実務的に意味のある大きさか（件数が多いと僅差でも①を通るため）
  if (Math.abs(edge) < minEdge) {
    return keep('有意だが差が小さい（' + ptTxt(edge) + ' < ' + ptTxt(minEdge) + '）→ 現行値を維持');
  }
  return out(better ? 3 : 1,
    '基準' + pctTxt(base) + 'を' + (better ? '上回る' : '下回る') + '（' + ptTxt(edge) + '）');
}

/**
 * パターンごとに「そのパターンの平均的な状況での予測勝率」を求める。
 * 本番の静的重み（1〜3）と横に並べて見るための数字。
 *
 * 各パターンの実際の特徴量ベクトルの平均を1本作り、それをモデルに通す。
 * 「係数そのもの」ではなくこの形にするのは、one-hot列を持たない少数パターン
 * （静的重み列へ丸め込まれたもの）についても同じ土俵で数字を出せるようにするため。
 * 実勝率（陽性率）も並べて出し、モデルが実績から乖離していないか見えるようにする。
 */
function perPatternPrediction_(rows, fm, sp, model) {
  const byPattern = {};
  rows.forEach((r, i) => {
    const p = r.pattern;
    if (!byPattern[p]) byPattern[p] = { n: 0, wins: 0, sum: fm.X[i].map(() => 0), staticWeight: Number(r.staticWeight) || 0 };
    const b = byPattern[p];
    b.n++;
    b.wins += fm.y[i];
    for (let j = 0; j < fm.X[i].length; j++) b.sum[j] += fm.X[i][j];
  });
  return Object.keys(byPattern).map(p => {
    const b = byPattern[p];
    const mean = b.sum.map(v => v / b.n);
    const proba = predictProba_(standardizeApply_([mean], sp), model.w, model.b)[0];
    return {
      pattern: p, n: b.n, staticWeight: b.staticWeight,
      actualWinRate: b.wins / b.n,     // 超過リターンが正だった割合（＝ラベル1の率）
      predWinRate: proba,
    };
  }).sort((a, b) => b.predWinRate - a.predWinRate);
}

// ============================================================================
//  学習の本体（方向別に2モデル）
// ============================================================================

/**
 * 方向（買い/売り）ごとに学習し、係数と検証指標を返す。
 * RSI・MACDの「良い値」は買いと売りで意味が反転するため、1つのモデルに混ぜず分ける。
 * サンプル不足のときは学習せず理由を添えて返す（suggestWeight_ の BT_MIN_SAMPLE ゲートと同じ思想）。
 */
function trainDirectionModel_(rows, opts) {
  opts = opts || {};
  const minSample = (opts.minSample != null) ? opts.minSample : ML.MIN_SAMPLE_PER_DIR;
  if (rows.length < minSample) {
    return { skipped: true, reason: 'サンプル不足（' + rows.length + '件 / 必要' + minSample + '件）', n: rows.length };
  }
  // 交差検証はブロック分割なので、日付昇順に並べてから渡す
  const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const fm = buildFeatureMatrix_(sorted, opts);
  const posN = fm.y.reduce((s, v) => s + v, 0);
  if (posN === 0 || posN === fm.y.length) {
    return { skipped: true, reason: 'ラベルが片方に偏っており学習できません（陽性' + posN + '件/' + fm.y.length + '件）', n: rows.length };
  }
  const sel = selectLambda_(fm.X, fm.y, opts.lambdas, opts);
  if (!sel.best) {
    return { skipped: true, reason: '交差検証でAUCを算出できませんでした（フォールド内のクラス偏り）', n: rows.length };
  }
  // 報告する係数は、選定したλで**全データ再学習**したもの。フォールドは評価専用。
  const sp = standardizeFit_(fm.X);
  const model = trainLogisticRegression_(standardizeApply_(fm.X, sp), fm.y,
    { lambda: sel.best.lambda, lr: opts.lr, epochs: opts.epochs });
  if (model.diverged) {
    return { skipped: true, reason: '学習が発散しました（λ=' + sel.best.lambda + '。学習率かλの設定を見直してください）', n: rows.length };
  }
  const inSample = predictProba_(standardizeApply_(fm.X, sp), model.w, model.b);
  return {
    skipped: false,
    n: rows.length,
    posN,
    lambda: sel.best.lambda,
    cv: sel.best,
    grid: sel.results,
    names: fm.names,
    w: model.w,
    b: model.b,
    standardize: sp,
    perPattern: perPatternPrediction_(sorted, fm, sp, model),
    lossFirst: model.lossHistory[0],
    lossLast: model.lossHistory[model.lossHistory.length - 1],
    inSampleEval: evaluateBinary_(fm.y, inSample),
    inSampleAuc: rocAuc_(fm.y, inSample),
  };
}

// ============================================================================
//  シート入出力（ここから下は GAS API に触る）
// ============================================================================

// ML学習データシートのヘッダー。Code.js の集計側と共有する単一ソース。
const ML_DATA_HEADERS_ = ['日付', 'コード', 'パターン名', '方向', '静的重み',
  'RSI14', 'MACDヒスト', 'MACD-Signal差', 'エントリー(翌日始値)', 'エグジット(終値)',
  'ベンチ騰落率', '銘柄騰落率', '超過リターン', 'ラベル', 'ホライズン日数'];

// ML学習データシートを読み、学習に使うオブジェクト配列へ変換する。
function readMlDataSheet_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(ML.SHEET_DATA);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, ML_DATA_HEADERS_.length).getValues();
  const out = [];
  values.forEach(v => {
    const pattern = String(v[2] || '').trim();
    if (!pattern) return;
    out.push({
      date: String(v[0] || ''), code: String(v[1] || ''), pattern: pattern,
      dir: String(v[3] || ''), staticWeight: Number(v[4]),
      rsi: Number(v[5]), macdHist: Number(v[6]), macdDiff: Number(v[7]),
      label: Number(v[13]),
    });
  });
  return out;
}

/**
 * メニューから呼ぶ入口。ML学習データシートを読んで学習し、ML重み(参考)シートへ書き出す。
 * ネットワーク通信はしないので6分制限には余裕がある。
 */
function trainMlWeights() {
  const ss = SpreadsheetApp.getActive();
  const rows = readMlDataSheet_();
  if (!rows.length) {
    ss.toast('「' + ML.SHEET_DATA + '」が空です。先に「パターン成績を集計」を実行してください', APP_NAME_, 8);
    return;
  }
  const buy  = rows.filter(r => r.dir.indexOf('買い') >= 0);
  const sell = rows.filter(r => r.dir.indexOf('売り') >= 0);
  const models = {
    '買い': trainDirectionModel_(buy),
    '売り': trainDirectionModel_(sell),
  };
  writeMlWeightsSheet_(models, rows.length);
  Logger.log('ML参考重み: 買い' + buy.length + '件 / 売り' + sell.length + '件で学習');
  ss.toast('ML参考重みを更新しました（参考値・順位には未使用）', APP_NAME_, 6);
}

// 小数の表示整形。null は空欄（0と誤読させない）。
// Code.js に桁区切り用の fmtNum_ があるため、GASの単一グローバルスコープで衝突しない名前にする。
function mlRound_(v, digits) {
  if (v == null || !isFinite(v)) return '';
  const p = Math.pow(10, digits == null ? 3 : digits);
  return Math.round(v * p) / p;
}

// 学習結果を ML重み(参考) シートへ書き出す。
function writeMlWeightsSheet_(models, totalRows) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(ML.SHEET_OUT);
  if (!sh) sh = ss.insertSheet(ML.SHEET_OUT);
  const old = sh.getFilter(); if (old) old.remove();
  sh.clear();

  // 「パターン成績」シートと同じく、但し書きを必ず目に入る1行目に置く。
  const CAVEAT = '⚠ 参考値です。本番の★スコア（静的重み×地合い係数）には反映していません。'
    + '地合い（信用需給）は過去の時系列を取得できないため特徴量に含んでいません。'
    + 'サンプル数が小さいため、係数の符号や大小は「傾向の目安」以上には読まないでください。'
    + '（学習データ ' + totalRows + '件 / L2正則化ロジスティック回帰 / ブロック分割時系列交差検証）';
  sh.getRange(1, 1).setValue(CAVEAT);

  const rows = [];
  ['買い', '売り'].forEach(dir => {
    const m = models[dir];
    rows.push(['【' + dir + 'モデル】', '', '', '']);
    if (!m || m.skipped) {
      rows.push(['学習スキップ', (m && m.reason) || '該当データなし', '', '']);
      rows.push(['', '', '', '']);
      return;
    }
    rows.push(['サンプル数', m.n + '件（うち陽性 ' + m.posN + '件）', '', '']);
    rows.push(['採用λ(L2強度)', m.lambda, '', '']);
    rows.push(['交差検証AUC', mlRound_(m.cv.aucMean, 3) + ' ± ' + mlRound_(m.cv.aucSd, 3) +
               '（' + m.cv.nFolds + 'フォールド平均）', '', '']);
    rows.push(['交差検証 正解率', mlRound_(m.cv.accMean, 3), '', '']);
    rows.push(['学習時損失', mlRound_(m.lossFirst, 4) + ' → ' + mlRound_(m.lossLast, 4), '', '']);
    rows.push(['（参考）学習内AUC', mlRound_(m.inSampleAuc, 3) +
               '  ※交差検証AUCより大幅に高い場合は過学習', '', '']);
    rows.push(['', '', '', '']);
    rows.push(['特徴量', '係数（標準化スケール）', '向き', '']);
    // |係数|の降順。標準化済みなので列間で大きさを比較できる。
    const coef = m.names.map((nm, i) => ({ nm, w: m.w[i] }))
      .sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    coef.forEach(c => rows.push(['  ' + c.nm, mlRound_(c.w, 4), c.w > 0 ? '＋（勝ちやすい）' : c.w < 0 ? '－（負けやすい）' : '', '']));
    rows.push(['  (切片)', mlRound_(m.b, 4), '', '']);
    rows.push(['', '', '', '']);

    // 本番で使っている静的重みと、学習結果を横に並べる（置き換えではなく並行表示）。
    rows.push(['パターン', '本番の静的重み', 'ML予測勝率', '実績勝率(件数)']);
    (m.perPattern || []).forEach(p => {
      rows.push(['  ' + p.pattern, p.staticWeight,
        Math.round(p.predWinRate * 1000) / 10 + '%',
        Math.round(p.actualWinRate * 1000) / 10 + '%（' + p.n + '件）']);
    });
    rows.push(['', '', '', '']);
  });

  const header = ['項目', '値', '備考', '補足'];
  sh.getRange(2, 1, 1, header.length).setValues([header]);
  if (rows.length) sh.getRange(3, 1, rows.length, header.length).setValues(rows);

  styleSheet_(sh, header.length, '#141a33', '#eef1fb');
  sh.getRange(1, 1, 1, header.length).merge()
    .setBackground('#fff4f4').setFontColor('#b00020').setFontWeight('bold')
    .setHorizontalAlignment('left').setVerticalAlignment('middle').setWrap(true);
  sh.getRange(2, 1, 1, header.length)
    .setBackground('#141a33').setFontColor('#ffffff').setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setFrozenRows(2);
  sh.setRowHeight(1, 56);
  autoFit_(sh, header.length);
  sh.setTabColor('#8e6bd6');
}
