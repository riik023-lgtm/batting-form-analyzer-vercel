'use client';

import { upload } from '@vercel/blob/client';
import { useEffect, useMemo, useRef, useState } from 'react';

const FEATURE_OPTIONS = [
  ['身体を開くな', '身体の開き'],
  ['割れを作れ', '割れ'],
  ['ボールを引きつけろ', 'ボールの引きつけ'],
  ['軸をぶらすな', '軸のブレ'],
  ['壁を作れ', '前脚の壁'],
  ['頭を残せ', '頭の残り'],
  ['体重移動をしろ', '体重移動'],
  ['腰を使え', '腰の回転'],
] as const;

type Roi = { x: number; y: number; width: number; height: number };
type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se';
type DragState = {
  mode: DragMode;
  startX: number;
  startY: number;
  startRoi: Roi;
};

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

const DEFAULT_ROI: Roi = { x: 0.08, y: 0.08, width: 0.84, height: 0.84 };
const PORTRAIT_ROI: Roi = { x: 0.05, y: 0.12, width: 0.90, height: 0.82 };
const LANDSCAPE_ROI: Roi = { x: 0.08, y: 0.08, width: 0.84, height: 0.84 };
const MIN_ROI_WIDTH = 0.16;
const MIN_ROI_HEIGHT = 0.20;
const PUBLIC_APP_URL = 'https://batting-form-analyzer-vercel.vercel.app/';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRoi(input: Partial<Roi>): Roi {
  let width = clamp(Number(input.width ?? DEFAULT_ROI.width), MIN_ROI_WIDTH, 1);
  let height = clamp(Number(input.height ?? DEFAULT_ROI.height), MIN_ROI_HEIGHT, 1);
  let x = clamp(Number(input.x ?? DEFAULT_ROI.x), 0, 1 - width);
  let y = clamp(Number(input.y ?? DEFAULT_ROI.y), 0, 1 - height);
  if (x + width > 1) x = 1 - width;
  if (y + height > 1) y = 1 - height;
  return { x, y, width, height };
}

function resizeRoi(start: Roi, mode: DragMode, dx: number, dy: number): Roi {
  const r = normalizeRoi(start);
  const right = r.x + r.width;
  const bottom = r.y + r.height;

  if (mode === 'move') {
    return {
      ...r,
      x: clamp(r.x + dx, 0, 1 - r.width),
      y: clamp(r.y + dy, 0, 1 - r.height),
    };
  }

  let x0 = r.x;
  let y0 = r.y;
  let x1 = right;
  let y1 = bottom;

  if (mode.includes('w')) x0 = clamp(r.x + dx, 0, x1 - MIN_ROI_WIDTH);
  if (mode.includes('e')) x1 = clamp(right + dx, x0 + MIN_ROI_WIDTH, 1);
  if (mode.includes('n')) y0 = clamp(r.y + dy, 0, y1 - MIN_ROI_HEIGHT);
  if (mode.includes('s')) y1 = clamp(bottom + dy, y0 + MIN_ROI_HEIGHT, 1);

  return normalizeRoi({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

function uid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function fileUrl(file: File | null) {
  return file ? URL.createObjectURL(file) : '';
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      response.ok
        ? '解析サーバーから読み取れない応答が返されました。'
        : `解析サーバーでエラーが発生しました（HTTP ${response.status}）。`
    );
  }
  if (!response.ok) {
    throw new Error(data?.detail || data?.error || `解析に失敗しました（HTTP ${response.status}）。`);
  }
  return data;
}

function VideoCropCard({
  title,
  file,
  roi,
  onChange,
  impactTime,
  impactPreview,
  onImpactSet,
  onImpactClear,
}: {
  title: string;
  file: File | null;
  roi: Roi;
  onChange: (roi: Roi) => void;
  impactTime: number | null;
  impactPreview: string;
  onImpactSet: (time: number, preview: string) => void;
  onImpactClear: () => void;
}) {
  const url = useMemo(() => fileUrl(file), [file]);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const initializedUrlRef = useRef('');
  const [drag, setDrag] = useState<DragState | null>(null);
  const [videoSize, setVideoSize] = useState({ width: 16, height: 9 });
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  useEffect(() => {
    if (!drag) return;

    const handleMove = (event: PointerEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dx = (event.clientX - drag.startX) / rect.width;
      const dy = (event.clientY - drag.startY) / rect.height;
      onChange(resizeRoi(drag.startRoi, drag.mode, dx, dy));
    };

    const handleUp = () => setDrag(null);
    window.addEventListener('pointermove', handleMove, { passive: false });
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [drag, onChange]);

  function beginDrag(event: React.PointerEvent, mode: DragMode) {
    event.preventDefault();
    event.stopPropagation();
    setDrag({
      mode,
      startX: event.clientX,
      startY: event.clientY,
      startRoi: normalizeRoi(roi),
    });
  }

  function handleMetadata(event: React.SyntheticEvent<HTMLVideoElement>) {
    const video = event.currentTarget;
    const width = Math.max(1, video.videoWidth || 16);
    const height = Math.max(1, video.videoHeight || 9);
    setVideoSize({ width, height });
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setCurrentTime(video.currentTime || 0);

    if (url && initializedUrlRef.current !== url) {
      initializedUrlRef.current = url;
      onChange(height > width ? PORTRAIT_ROI : LANDSCAPE_ROI);
    }
  }

  function seekBy(delta: number) {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    const maxTime = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : Math.max(0, currentTime + delta);
    const next = clamp(video.currentTime + delta, 0, maxTime);
    video.currentTime = next;
    setCurrentTime(next);
  }

  function captureImpact() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    video.pause();

    const safe = normalizeRoi(roi);
    const sx = Math.round(safe.x * video.videoWidth);
    const sy = Math.round(safe.y * video.videoHeight);
    const sw = Math.max(2, Math.round(safe.width * video.videoWidth));
    const sh = Math.max(2, Math.round(safe.height * video.videoHeight));
    const maxWidth = 600;
    const scale = Math.min(1, maxWidth / sw);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    onImpactSet(video.currentTime, canvas.toDataURL('image/jpeg', 0.9));
  }

  const safeRoi = normalizeRoi(roi);
  const portrait = videoSize.height > videoSize.width;

  return (
    <section className="card crop-card">
      <div className="section-title-row">
        <h3>{title}</h3>
        <span className="muted">赤枠内だけを解析</span>
      </div>

      <p className="crop-help">
        四隅の丸を動かして、スイング中の全身が入るように囲んでください。
        中央の「＋」を動かすと枠全体を移動できます。手足やバットが出ないよう少し余白を残すのがおすすめです。
      </p>

      {file ? (
        <>
          <div className={`crop-stage-shell ${portrait ? 'portrait' : 'landscape'}`}>
            <div
              className="crop-stage"
              ref={stageRef}
              style={{ aspectRatio: `${videoSize.width} / ${videoSize.height}` }}
            >
              <video
                ref={videoRef}
                className="crop-video"
                src={url}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={handleMetadata}
                onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
              />

              <div
                className="crop-box"
                style={{
                  left: `${safeRoi.x * 100}%`,
                  top: `${safeRoi.y * 100}%`,
                  width: `${safeRoi.width * 100}%`,
                  height: `${safeRoi.height * 100}%`,
                }}
              >
                <button type="button" aria-label="左上を動かす" className="crop-handle nw" onPointerDown={(e) => beginDrag(e, 'nw')} />
                <button type="button" aria-label="右上を動かす" className="crop-handle ne" onPointerDown={(e) => beginDrag(e, 'ne')} />
                <button type="button" aria-label="左下を動かす" className="crop-handle sw" onPointerDown={(e) => beginDrag(e, 'sw')} />
                <button type="button" aria-label="右下を動かす" className="crop-handle se" onPointerDown={(e) => beginDrag(e, 'se')} />
                <button type="button" aria-label="枠全体を動かす" className="crop-move" onPointerDown={(e) => beginDrag(e, 'move')}>＋</button>
              </div>
            </div>
          </div>

          <div className="impact-setter">
            <div className="impact-setter-head">
              <div>
                <strong>インパクトを指定</strong>
                <p>動画を止めて、バットがボールに当たる瞬間に合わせてください。</p>
              </div>
              <span>{currentTime.toFixed(3)}秒{duration > 0 ? ` / ${duration.toFixed(2)}秒` : ''}</span>
            </div>

            <div className="impact-nudge-row">
              <button type="button" onClick={() => seekBy(-0.033)}>−0.03秒</button>
              <button type="button" className="impact-set-button" onClick={captureImpact}>この瞬間をインパクトに設定</button>
              <button type="button" onClick={() => seekBy(0.033)}>＋0.03秒</button>
            </div>

            {impactTime !== null && impactPreview ? (
              <div className="impact-confirmed">
                <div className="impact-confirmed-title">
                  <div><b>設定したインパクト</b><span>{impactTime.toFixed(3)}秒</span></div>
                  <button type="button" onClick={onImpactClear}>設定を解除</button>
                </div>
                <img src={impactPreview} alt={`${title}で指定したインパクト`} />
              </div>
            ) : (
              <div className="impact-auto-note">未指定の場合は、解析時に自動推定したインパクトを使用します。</div>
            )}
          </div>
        </>
      ) : <div className="empty-video">動画を選択してください</div>}
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
  const [referenceRoi, setReferenceRoi] = useState<Roi>(DEFAULT_ROI);
  const [targetRoi, setTargetRoi] = useState<Roi>(DEFAULT_ROI);
  const [referenceBlobUrl, setReferenceBlobUrl] = useState('');
  const [targetBlobUrl, setTargetBlobUrl] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [referenceImpactTime, setReferenceImpactTime] = useState<number | null>(null);
  const [targetImpactTime, setTargetImpactTime] = useState<number | null>(null);
  const [referenceImpactPreview, setReferenceImpactPreview] = useState('');
  const [targetImpactPreview, setTargetImpactPreview] = useState('');

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

  async function copyShareLink() {
    try {
      await navigator.clipboard.writeText(PUBLIC_APP_URL);
      setShareStatus('共有リンクをコピーしました。');
    } catch {
      setShareStatus(`共有リンク：${PUBLIC_APP_URL}`);
    }
  }

  async function shareApp() {
    const payload = {
      title: '打撃フォーム分析',
      text: '比較選手と自分の打撃フォームを動画から比較できるアプリです。',
      url: PUBLIC_APP_URL,
    };
    try {
      if (navigator.share) {
        await navigator.share(payload);
        setShareStatus('共有画面を開きました。');
      } else {
        await copyShareLink();
      }
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') {
        await copyShareLink();
      }
    }
  }

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
      access: 'private',
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
      const [a, b] = await Promise.all([readJsonResponse(r1), readJsonResponse(r2)]);
      setReferenceRoi(normalizeRoi(a));
      setTargetRoi(normalizeRoi(b));
      setStatus('赤枠を確認し、必要なら四隅を動かしてください。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '自動推定に失敗しました。赤枠を手動で調整してください。');
      setStatus('');
    }
  }

  async function analyze() {
    setError(''); setResult(null); setUploadProgress(0);
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
          reference_roi: normalizeRoi(referenceRoi),
          target_roi: normalizeRoi(targetRoi),
          reference_impact_time: referenceImpactTime,
          target_impact_time: targetImpactTime,
        }),
      });
      const data = await readJsonResponse(response);
      setResult(data);
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
        <div className="version">BATTING FORM ANALYZER · ver.11.5</div>
        <h1>打撃フォーム分析</h1>
        <p>比較選手との「違い」を動画から見つけ、改善の優先順位を整理します。</p>
      </header>

      <div className="notice">フォームの良し悪しや怪我の発生確率を採点するアプリではありません。単眼動画から取得できる運動学的な特徴を比較します。</div>

      <section className="share-card">
        <div className="share-copy">
          <strong>このアプリを共有</strong>
          <span>Productionを公開設定にしていれば、このリンクからスマホ・PCで利用できます。</span>
          <code>{PUBLIC_APP_URL}</code>
        </div>
        <div className="share-actions">
          <button type="button" className="primary" onClick={shareApp}>共有する</button>
          <button type="button" className="secondary" onClick={copyShareLink}>リンクをコピー</button>
        </div>
        {shareStatus && <small className="share-status">{shareStatus}</small>}
      </section>

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
          <label className="upload-card"><strong>比較選手の動画</strong><input type="file" accept="video/*" onChange={(e)=>{setReferenceFile(e.target.files?.[0]||null);setReferenceBlobUrl('');setReferenceRoi(DEFAULT_ROI);setReferenceImpactTime(null);setReferenceImpactPreview('');setResult(null)}}/><small>{referenceFile?.name || '2〜5秒程度がおすすめ'}</small></label>
          <label className="upload-card"><strong>自分の動画</strong><input type="file" accept="video/*" onChange={(e)=>{setTargetFile(e.target.files?.[0]||null);setTargetBlobUrl('');setTargetRoi(DEFAULT_ROI);setTargetImpactTime(null);setTargetImpactPreview('');setResult(null)}}/><small>{targetFile?.name || '同じ向き・近い画角がおすすめ'}</small></label>
        </div>
        <div className="card feature-card"><h3>比較する5項目</h3><div className="feature-grid">{FEATURE_OPTIONS.map(([key,label])=><label key={key} className={selectedFeatures.includes(key)?'feature selected':'feature'}><input type="checkbox" checked={selectedFeatures.includes(key)} onChange={()=>toggleFeature(key)}/><span>{label}</span></label>)}</div><p className="muted">{selectedFeatures.length} / 5 選択中</p></div>
      </section>

      <section className="step">
        <span>STEP 3</span><h2>解析範囲とインパクトを決める</h2>
        <p className="step-guide">① 赤枠の四隅を動かして打者を囲み、② 動画をインパクトの瞬間で止めて設定してください。インパクトを指定しない場合だけ自動推定を使います。</p>
        <button className="secondary full" type="button" onClick={suggestRoi} disabled={!referenceFile || !targetFile}>2本とも自動で打者位置を探す</button>
        <VideoCropCard
          title="比較選手"
          file={referenceFile}
          roi={referenceRoi}
          onChange={(next) => { setReferenceRoi(next); setReferenceImpactTime(null); setReferenceImpactPreview(''); }}
          impactTime={referenceImpactTime}
          impactPreview={referenceImpactPreview}
          onImpactSet={(time, preview) => { setReferenceImpactTime(time); setReferenceImpactPreview(preview); }}
          onImpactClear={() => { setReferenceImpactTime(null); setReferenceImpactPreview(''); }}
        />
        <VideoCropCard
          title="自分"
          file={targetFile}
          roi={targetRoi}
          onChange={(next) => { setTargetRoi(next); setTargetImpactTime(null); setTargetImpactPreview(''); }}
          impactTime={targetImpactTime}
          impactPreview={targetImpactPreview}
          onImpactSet={(time, preview) => { setTargetImpactTime(time); setTargetImpactPreview(preview); }}
          onImpactClear={() => { setTargetImpactTime(null); setTargetImpactPreview(''); }}
        />
      </section>

      <section className="step">
        <span>STEP 4</span><h2>解析</h2>
        <button className="primary full" type="button" onClick={analyze} disabled={!referenceFile || !targetFile || selectedFeatures.length!==5}>高精度解析を開始</button>
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
        <div className="advice-list">{(result.advice||[]).map((row:any,i:number)=><article className="advice" key={`${row['観点']}-${i}`}><div className="rank">{i+1}</div><div><h3>{row['観点']}</h3><p><b>比較結果：</b>{row['比較結果']}</p><p><b>動作の特徴：</b>{row['動作の特徴']}</p><p><b>改善の方向性：</b>{row['改善の方向性']}</p><p><b>練習例：</b>{row['練習例']}</p>{row['参考動画URL'] && <div className="practice-video"><div><b>参考動画（日本語優先）</b><span>{row['参考動画提供元']}</span><strong>{row['参考動画タイトル']}</strong>{row['参考動画メモ'] && <small>{row['参考動画メモ']}</small>}</div><div className="practice-video-actions"><a href={row['参考動画URL']} target="_blank" rel="noopener noreferrer">▶ 日本語動画を見る</a>{row['予備動画URL'] && <a className="practice-fallback" href={row['予備動画URL']} target="_blank" rel="noopener noreferrer">海外版も見る</a>}</div></div>}<small>研究上の位置づけ：{row['研究上の位置づけ']}</small></div></article>)}</div>

        <h2>身体負担に関連する動作</h2>
        <div className="body-load"><strong>{result.body_load?.overall_label}</strong><p>怪我の診断・予測ではなく、先行研究で議論される動作との照合です。</p>{(result.body_load?.regions||[]).map((row:any)=><div className="body-row" key={row['部位']}><b>{row['部位']}</b><span>{row['判定']}</span><small>{row['主な計測proxy']}</small></div>)}</div>

        <div className="save-row">{selectedPlayer && <button className="primary" type="button" onClick={saveHistory}>この結果を{selectedPlayer.name}の履歴に保存</button>}<button className="danger" type="button" onClick={cleanupVideos}>アップロード動画を削除</button></div>
        <p className="muted center">動画はPrivate Blobに一時保存されます。解析終了後は「アップロード動画を削除」を押してください。</p>
      </section>}

      {selectedPlayer && selectedPlayer.histories.length > 0 && <section className="step"><span>HISTORY</span><h2>{selectedPlayer.name} の解析履歴</h2><div className="history-list">{selectedPlayer.histories.map(h=><div className="history-item" key={h.id}><time>{new Date(h.createdAt).toLocaleString('ja-JP')}</time><b>{h.overall}</b><span>近い：{h.best}</span><span>差大：{h.lowest}</span></div>)}</div></section>}

      <footer>Batting Form Analyzer ver.11.5 · Vercel / Next.js / FastAPI / MediaPipe</footer>
    </main>
  );
}
