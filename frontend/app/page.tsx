'use client';

import { upload } from '@vercel/blob/client';
import { useEffect, useMemo, useState } from 'react';

const FEATURE_OPTIONS = [
  ['身体を開くな', '肩の回旋量'],
  ['割れを作れ', '肩―骨盤捻転差'],
  ['ボールを引きつけろ', '手部―体幹距離'],
  ['軸をぶらすな', '体幹中心の横移動'],
  ['壁を作れ', '前脚膝角度'],
  ['頭を残せ', '頭部移動量'],
  ['体重移動をしろ', '骨盤中心の水平移動'],
  ['腰を使え', '骨盤回転速度'],
] as const;

type Roi = { center: number; width: number };
type PlayerHistory = {
  id: string;
  createdAt: string;
  overall: string;
  best: string;
  lowest: string;
};
type Player = {
  id: string;
  name: string;
  batterSide: '右打者' | '左打者';
  histories: PlayerHistory[];
};
type AnalysisResult = Record<string, any>;

const ROI_PRESETS: Record<string, Roi> = {
  '左寄り': { center: 0.28, width: 0.48 },
  '中央': { center: 0.50, width: 0.50 },
  '右寄り': { center: 0.72, width: 0.48 },
  '画面全体': { center: 0.50, width: 1.00 },
};

function uid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fileUrl(file: File | null) {
  return file ? URL.createObjectURL(file) : '';
}

function VideoRoiCard({
  title,
  file,
  roi,
  onChange,
}: {
  title: string;
  file: File | null;
  roi: Roi;
  onChange: (roi: Roi) => void;
}) {
  const url = useMemo(() => fileUrl(file), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  return (
    <section className="card">
      <div className="section-title-row"><h3>{title}</h3><span className="muted">赤枠内を解析</span></div>
      {file ? (
        <div className="video-wrap">
          <video src={url} controls playsInline preload="metadata" />
          <div
            className="roi-overlay"
            style={{ left: `${(roi.center - roi.width / 2) * 100}%`, width: `${roi.width * 100}%` }}
          />
        </div>
      ) : <div className="empty-video">動画を選択してください</div>}
      <div className="preset-grid">
        {Object.entries(ROI_PRESETS).map(([name, value]) => (
          <button
            className={Math.abs(value.center - roi.center) < 0.01 && Math.abs(value.width - roi.width) < 0.01 ? 'chip active' : 'chip'}
            key={name}
            type="button"
            onClick={() => onChange(value)}
          >{name}</button>
        ))}
      </div>
      <details>
        <summary>細かく調整する</summary>
        <label className="field compact">
          <span>横位置 {Math.round(roi.center * 100)}%</span>
          <input type="range" min="10" max="90" value={Math.round(roi.center * 100)} onChange={(e) => onChange({ ...roi, center: Number(e.target.value) / 100 })} />
        </label>
        <label className="field compact">
          <span>幅 {Math.round(roi.width * 100)}%</span>
          <input type="range" min="25" max="100" value={Math.round(roi.width * 100)} onChange={(e) => onChange({ ...roi, width: Number(e.target.value) / 100 })} />
        </label>
      </details>
    </section>
  );
}

function QualityBadge({ label }: { label?: string }) {
  const safe = label || '未評価';
  return <span className={safe === '高' ? 'quality good' : 'quality warn'}>骨格検出品質：{safe}</span>;
}

export default function Home() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [newPlayer, setNewPlayer] = useState('');
  const [batterSide, setBatterSide] = useState<'右打者' | '左打者'>('右打者');
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>(FEATURE_OPTIONS.slice(0, 5).map(v => v[0]));
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [targetFile, setTargetFile] = useState<File | null>(null);
  const [referenceRoi, setReferenceRoi] = useState<Roi>({ center: 0.68, width: 0.55 });
  const [targetRoi, setTargetRoi] = useState<Roi>({ center: 0.68, width: 0.55 });
  const [referenceBlobUrl, setReferenceBlobUrl] = useState('');
  const [targetBlobUrl, setTargetBlobUrl] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [refImpact, setRefImpact] = useState<number | null>(null);
  const [tarImpact, setTarImpact] = useState<number | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem('bfa-v11-players');
      if (raw) setPlayers(JSON.parse(raw));
    } catch {}
  }, []);
  useEffect(() => {
    localStorage.setItem('bfa-v11-players', JSON.stringify(players));
  }, [players]);

  const selectedPlayer = players.find(p => p.id === selectedPlayerId);

  function createPlayer() {
    const name = newPlayer.trim();
    if (!name) return;
    const p: Player = { id: uid(), name, batterSide, histories: [] };
    setPlayers(prev => [p, ...prev]);
    setSelectedPlayerId(p.id);
    setNewPlayer('');
  }

  function toggleFeature(key: string) {
    setSelectedFeatures(prev => {
      if (prev.includes(key)) return prev.filter(v => v !== key);
      if (prev.length >= 5) return prev;
      return [...prev, key];
    });
  }

  async function uploadVideo(file: File, role: string, progressStart: number, progressSpan: number) {
    const blob = await upload(`batting/${role}-${Date.now()}-${file.name}`, file, {
      access: 'public',
      handleUploadUrl: '/blob-upload',
      multipart: true,
      onUploadProgress: ({ percentage }) => setUploadProgress(progressStart + percentage * progressSpan / 100),
    });
    return blob.url;
  }

  async function ensureBlobUrls() {
    if (!referenceFile || !targetFile) throw new Error('比較選手と自分の動画を2本とも選択してください。');
    let refUrl = referenceBlobUrl;
    let tarUrl = targetBlobUrl;
    if (!refUrl) refUrl = await uploadVideo(referenceFile, 'reference', 0, 50);
    if (!tarUrl) tarUrl = await uploadVideo(targetFile, 'target', 50, 50);
    setReferenceBlobUrl(refUrl);
    setTargetBlobUrl(tarUrl);
    return { refUrl, tarUrl };
  }

  async function suggestRoi() {
    setError(''); setStatus('動画をアップロードしています…'); setUploadProgress(0);
    try {
      const { refUrl, tarUrl } = await ensureBlobUrls();
      setStatus('打者位置を自動推定しています…');
      const [r1, r2] = await Promise.all([
        fetch('/api/suggest-roi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ video_url: refUrl }) }),
        fetch('/api/suggest-roi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ video_url: tarUrl }) }),
      ]);
      if (!r1.ok || !r2.ok) throw new Error('自動推定に失敗しました。プリセットで調整してください。');
      const [a, b] = await Promise.all([r1.json(), r2.json()]);
      setReferenceRoi({ center: a.center, width: a.width });
      setTargetRoi({ center: b.center, width: b.width });
      setStatus('赤枠を確認してください。');
    } catch (e) { setError(e instanceof Error ? e.message : 'エラーが発生しました。'); setStatus(''); }
  }

  async function analyze(manual = false) {
    setError(''); setResult(manual ? result : null); setUploadProgress(0);
    if (selectedFeatures.length !== 5) { setError('比較項目を5つ選択してください。'); return; }
    try {
      setStatus('動画をアップロードしています…');
      const { refUrl, tarUrl } = await ensureBlobUrls();
      setStatus('高精度骨格解析を実行しています…');
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference_url: refUrl,
          target_url: tarUrl,
          batter_side: batterSide,
          selected_features: selectedFeatures,
          reference_roi: referenceRoi,
          target_roi: targetRoi,
          reference_impact_frame: manual ? refImpact : null,
          target_impact_frame: manual ? tarImpact : null,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || '解析に失敗しました。');
      setResult(data);
      setRefImpact(data.reference?.impact_frame ?? null);
      setTarImpact(data.target?.impact_frame ?? null);
      setStatus('解析が完了しました。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析に失敗しました。');
      setStatus('');
    }
  }

  async function cleanupVideos() {
    const urls = [referenceBlobUrl, targetBlobUrl].filter(Boolean);
    if (urls.length) {
      await fetch('/blob-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls }) }).catch(() => null);
    }
    setReferenceBlobUrl(''); setTargetBlobUrl('');
    setStatus('アップロード動画を削除しました。');
  }

  function saveHistory() {
    if (!selectedPlayer || !result) return;
    const history: PlayerHistory = {
      id: uid(), createdAt: new Date().toISOString(), overall: result.overall_comparison_label,
      best: result.best_item, lowest: result.lowest_item,
    };
    setPlayers(prev => prev.map(p => p.id === selectedPlayer.id ? { ...p, histories: [history, ...p.histories] } : p));
    setStatus(`${selectedPlayer.name} の履歴に保存しました。`);
  }

  function exportPlayer() {
    if (!selectedPlayer) return;
    const blob = new Blob([JSON.stringify({ format: 'BFA_PLAYER_BUNDLE', version: 11, player: selectedPlayer }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${selectedPlayer.name}_batting_history.bfa`; a.click();
    URL.revokeObjectURL(url);
  }

  async function importPlayer(file: File) {
    try {
      const payload = JSON.parse(await file.text());
      if (payload?.format !== 'BFA_PLAYER_BUNDLE' || !payload?.player?.name) throw new Error();
      const p: Player = { ...payload.player, id: uid() };
      setPlayers(prev => [p, ...prev]); setSelectedPlayerId(p.id);
    } catch { setError('選手ファイルを読み込めませんでした。'); }
  }

  return (
    <main>
      <header className="hero">
        <div className="version">BATTING FORM ANALYZER · ver.11.1</div>
        <h1>打撃フォーム分析</h1>
        <p>比較選手との「違い」を動画から見つけ、改善の優先順位を整理します。</p>
      </header>

      <div className="notice">フォームの良し悪しや怪我の発生確率を採点するアプリではありません。単眼動画から取得できる運動学的な特徴を比較します。</div>

      <section className="step">
        <span>STEP 1</span><h2>解析する選手</h2>
        <div className="card">
          <label className="field"><span>選手ファイル</span>
            <select value={selectedPlayerId} onChange={(e) => { setSelectedPlayerId(e.target.value); const p=players.find(x=>x.id===e.target.value); if(p) setBatterSide(p.batterSide); }}>
              <option value="">今回だけ解析（履歴保存なし）</option>
              {players.map(p => <option key={p.id} value={p.id}>{p.name}（履歴 {p.histories.length}回）</option>)}
            </select>
          </label>
          <div className="inline-create">
            <input value={newPlayer} onChange={(e) => setNewPlayer(e.target.value)} placeholder="新しい選手名・ニックネーム" />
            <button type="button" onClick={createPlayer}>選手を追加</button>
          </div>
          <div className="segmented">
            {(['右打者','左打者'] as const).map(side => <button key={side} type="button" className={batterSide===side?'active':''} onClick={()=>setBatterSide(side)}>{side}</button>)}
          </div>
          {selectedPlayer && <div className="history-actions"><button type="button" onClick={exportPlayer}>選手ファイルを書き出す</button><label className="import-label">選手ファイルを読み込む<input type="file" accept=".bfa,.json" onChange={(e)=>e.target.files?.[0] && importPlayer(e.target.files[0])}/></label></div>}
        </div>
      </section>

      <section className="step">
        <span>STEP 2</span><h2>動画を選択</h2>
        <div className="upload-grid">
          <label className="upload-card"><strong>比較選手の動画</strong><input type="file" accept="video/*" onChange={(e)=>{setReferenceFile(e.target.files?.[0]||null);setReferenceBlobUrl('');setResult(null)}}/><small>{referenceFile?.name || '2〜5秒程度がおすすめ'}</small></label>
          <label className="upload-card"><strong>自分の動画</strong><input type="file" accept="video/*" onChange={(e)=>{setTargetFile(e.target.files?.[0]||null);setTargetBlobUrl('');setResult(null)}}/><small>{targetFile?.name || '同じ向き・近い画角がおすすめ'}</small></label>
        </div>
        <div className="card feature-card"><h3>比較する5項目</h3><div className="feature-grid">{FEATURE_OPTIONS.map(([key,label])=><label key={key} className={selectedFeatures.includes(key)?'feature selected':'feature'}><input type="checkbox" checked={selectedFeatures.includes(key)} onChange={()=>toggleFeature(key)}/><span>{label}</span></label>)}</div><p className="muted">{selectedFeatures.length} / 5 選択中</p></div>
      </section>

      <section className="step">
        <span>STEP 3</span><h2>打者の範囲を確認</h2>
        <button className="secondary full" type="button" onClick={suggestRoi} disabled={!referenceFile || !targetFile}>2本とも自動で打者位置を探す</button>
        <VideoRoiCard title="比較選手" file={referenceFile} roi={referenceRoi} onChange={setReferenceRoi}/>
        <VideoRoiCard title="自分" file={targetFile} roi={targetRoi} onChange={setTargetRoi}/>
      </section>

      <section className="step">
        <span>STEP 4</span><h2>解析</h2>
        <button className="primary full" type="button" onClick={()=>analyze(false)} disabled={!referenceFile || !targetFile || selectedFeatures.length!==5}>高精度解析を開始</button>
        {(status || uploadProgress > 0) && <div className="status"><div>{status}</div>{uploadProgress>0 && uploadProgress<100 && <progress value={uploadProgress} max="100"/>}</div>}
        {error && <div className="error">{error}</div>}
      </section>

      {result && <section className="results">
        <div className="result-hero"><span>比較選手との動作傾向</span><strong>{result.overall_comparison_label}</strong></div>
        <div className="two-col">
          <div className="summary-card"><span>最も近い動き</span><strong>{result.best_item}</strong></div>
          <div className="summary-card"><span>最も違う動き</span><strong>{result.lowest_item}</strong></div>
        </div>
        <div className="quality-row"><QualityBadge label={result.reference?.quality?.label}/><QualityBadge label={result.target?.quality?.label}/></div>
        <details className="quality-details"><summary>解析品質の詳細を見る</summary><p>比較選手：{result.reference?.quality?.score ?? '-'} / 100　自分：{result.target?.quality?.score ?? '-'} / 100</p><p className="muted">この数値はフォーム点数ではなく、骨格推定の品質指標です。</p></details>

        <h2>5項目の比較</h2>
        <div className="feature-results">{(result.features||[]).map((row:any)=><article className="result-card" key={row['表示名']}><div className="result-card-head"><h3>{row['表示名']}</h3><span className={`level ${row['比較判定']}`}>{row['比較判定']}</span></div><div className="value-flow"><b>{row['比較選手表示']}</b><span>→</span><b>{row['自分表示']}</b></div><p>{row['差の方向']}</p><small>{row['計測内容']}</small></article>)}</div>

        <h2>今回優先して確認したいポイント</h2>
        <div className="advice-list">{(result.advice||[]).map((row:any,i:number)=><article className="advice" key={`${row['観点']}-${i}`}><div className="rank">{i+1}</div><div><h3>{row['観点']}</h3><p><b>比較結果：</b>{row['比較結果']}</p><p><b>動作の特徴：</b>{row['動作の特徴']}</p><p><b>改善の方向性：</b>{row['改善の方向性']}</p><p><b>練習例：</b>{row['練習例']}</p>{row['参考動画URL'] && <div className="practice-video"><div><b>参考動画</b><span>{row['参考動画提供元']}</span><strong>{row['参考動画タイトル']}</strong>{row['参考動画メモ'] && <small>{row['参考動画メモ']}</small>}</div><a href={row['参考動画URL']} target="_blank" rel="noopener noreferrer">▶ 参考動画を見る</a></div>}<small>研究上の位置づけ：{row['研究上の位置づけ']}</small></div></article>)}</div>

        <h2>身体負担に関連する動作</h2>
        <div className="body-load"><strong>{result.body_load?.overall_label}</strong><p>怪我の診断・予測ではなく、先行研究で議論される動作との照合です。</p>{(result.body_load?.regions||[]).map((row:any)=><div className="body-row" key={row['部位']}><b>{row['部位']}</b><span>{row['判定']}</span><small>{row['主な計測proxy']}</small></div>)}</div>

        <h2>インパクト候補</h2>
        <div className="two-col">
          <div className="card"><h3>比較選手</h3>{(result.reference?.impact_candidates||[]).map((c:any)=><label className="radio-row" key={c.frame}><input type="radio" name="ref-impact" checked={refImpact===c.frame} onChange={()=>setRefImpact(c.frame)}/><span>{c.time?.toFixed?.(3)}秒（frame {c.frame}）</span></label>)}</div>
          <div className="card"><h3>自分</h3>{(result.target?.impact_candidates||[]).map((c:any)=><label className="radio-row" key={c.frame}><input type="radio" name="tar-impact" checked={tarImpact===c.frame} onChange={()=>setTarImpact(c.frame)}/><span>{c.time?.toFixed?.(3)}秒（frame {c.frame}）</span></label>)}</div>
        </div>
        <button className="secondary full" type="button" onClick={()=>analyze(true)}>選んだインパクトで再計算</button>

        <div className="save-row">{selectedPlayer && <button className="primary" type="button" onClick={saveHistory}>この結果を{selectedPlayer.name}の履歴に保存</button>}<button className="danger" type="button" onClick={cleanupVideos}>アップロード動画を削除</button></div>
        <p className="muted center">動画はランダムURLで一時保存され、Blob設定により1日後にも自動削除されます。解析終了後は「アップロード動画を削除」を押してください。</p>
      </section>}

      {selectedPlayer && selectedPlayer.histories.length > 0 && <section className="step"><span>HISTORY</span><h2>{selectedPlayer.name} の解析履歴</h2><div className="history-list">{selectedPlayer.histories.map(h=><div className="history-item" key={h.id}><time>{new Date(h.createdAt).toLocaleString('ja-JP')}</time><b>{h.overall}</b><span>近い：{h.best}</span><span>差大：{h.lowest}</span></div>)}</div></section>}

      <footer>Batting Form Analyzer ver.11.1 · Vercel / Next.js / FastAPI / MediaPipe</footer>
    </main>
  );
}
