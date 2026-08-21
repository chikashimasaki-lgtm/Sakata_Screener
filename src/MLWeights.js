/**
 * SIGNAL_WEIGHT_ 算出の統計コア
 * ---------------------------------------------------------------------------
 * `wilsonInterval_`/`decideWeight_` の2関数だけを持つ。tools/calc_weights.js から
 * 呼ばれ、パターンごとの重み（1〜3）を Wilson 信頼区間＋効果量ゲートで決める。
 *
 * かつてはここに L2正則化ロジスティック回帰（交差検証・特徴量構築・学習ループ等）も
 * 置いていたが、本番の順位付け（SIGNAL_WEIGHT_）には一度も接続されておらず、
 * 交差検証AUCも0.5前後（＝的中率ランダムと同等）で実用に耐えなかったため削除した
 * （2026-08-21、Sakata_Screenerプランより）。回帰が解こうとしていた「重みを実データから
 * 統計的に決める」という目的自体は、ここに残る wilsonInterval_/decideWeight_ が
 * より少ない仮定・より小さい過学習リスクで既に達成している。
 *
 * 設計上の約束:
 *   - このファイルのトップレベルは自己完結な定数 ML のみ。SK 等の他ファイルのシンボルは
 *     必ず関数の内部から参照する（.clasp.json の filePushOrder が空でpush順が保証されないため。
 *     MarketMacro.js と同じ作法）。
 *   - GAS API に触らない純粋関数として書く（tests/verify.js・tools/calc_weights.js の
 *     両方から同じサンドボックス方式で直接叩けるように）。
 */

// 自己完結な設定。他ファイルのシンボルを参照しないこと（上記の理由）。
const ML = {
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
};

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
