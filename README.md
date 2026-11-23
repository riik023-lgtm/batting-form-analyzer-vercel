# Batting Form Analyzer ver.11.3 — Vercel edition

ver.11.3では、STEP 3の解析範囲指定を2D矩形クロップへ変更しました。

## ver.11.3の主な変更

- 「左寄り / 中央 / 右寄り / 画面全体」ボタンを廃止
- 横位置・幅のスライダーを廃止
- 赤枠の四隅をマウス / 指で直接ドラッグしてリサイズ
- 赤枠中央の「＋」をドラッグして枠全体を移動
- 縦動画・横動画を自動判定して、実映像と赤枠の座標を一致
- Python側も x / y / width / height を使って実際に2Dクロップ
- MediaPipeへ渡す前にクロップ画像の最大辺を1280pxへ縮小
- 自動打者位置推定も縦横の複数領域を探索
- JSON以外のサーバーエラーでも画面に分かりやすいエラーを表示
- Private Vercel Blob / Container Runtime構成はver.11.2から継続

## GitHubへアップロード

このZIPの中身を既存の `batting-form-analyzer-vercel` リポジトリへアップロードしてください。

上書き:
- `frontend/app/page.tsx`
- `frontend/app/globals.css`
- `backend/main.py`
- `README.md`

新規:
- `backend/analysis_engine_v113.py`

既存の次のファイルは削除しません:
- `backend/analysis_engine.py`
- `backend/risk_analysis.py`
- `backend/Dockerfile`
- `backend/requirements.txt`
- `vercel.toml`

Commit message例:
`Update to ver.11.3 draggable crop`

Vercelが自動デプロイした後、
`/api/health`
を開き、`version: 11.3` と `roi: 2d-crop` が返れば新バックエンドが反映されています。
