# Batting Form Analyzer ver.11.0 — Vercel edition

Streamlit版 ver.10.1 の解析ロジックを、スマホ向けの Next.js UI + FastAPI に移植した最初のVercel版です。

## 構成

- `frontend/` — Next.js 16.4。スマホUI、選手履歴(localStorage)、Vercel Blobへの動画アップロード
- `backend/` — FastAPI + MediaPipe + OpenCV。既存の `analysis_engine.py` / `risk_analysis.py` を再利用
- `vercel.toml` — Vercel Servicesで2サービスを1つのURLにまとめる設定

## Vercelへのデプロイ

1. GitHubに新しいリポジトリ `batting-form-analyzer-vercel` を作る。
2. このフォルダの**中身**をすべてアップロードする。
3. Vercelで `Add New / Project` → GitHubの新リポジトリをImport。
4. Root Directoryは変更せず `./` のまま。`vercel.toml` が frontend/backend を指定します。
5. Vercel StorageでBlob Storeを作成し、このProjectに接続する。
6. Deploy。
7. `/api/health` が `{"ok":true,...}` を返すか確認する。

## 動画アップロード

Vercel FunctionsのHTTPリクエストは4.5MB制限があるため、動画はブラウザからVercel Blobへ直接送ります。Python APIにはBlob URLだけを送ります。

ver.11.0初版では、解析中にPythonから取得できるようBlobはランダムURLのpublic objectとして保存します。UIに削除ボタンを設け、さらにBlob TTLを1日に設定しています。より厳密なプライバシーが必要な運用では、次版でPrivate Blob + signed GET URLに切り替えてください。

## Vercel上の注意

MediaPipe/OpenCVはPython Functionとしては比較的重い依存です。VercelのLarge Functions/Fluid Computeが必要になる場合があります。デプロイでFunction package sizeエラーが出た場合はProject Environment Variablesに `VERCEL_SUPPORT_LARGE_FUNCTIONS=1` を追加してRedeployしてください。

初回解析ではMediaPipeのPose/Handモデルを `/tmp/bfa_models` に取得します。Function instanceが入れ替わると再取得されることがあります。

## 解析結果

- 100点スコアは主表示に使いません。
- `かなり近い / やや近い / 差がある / 大きく異なる` の4段階比較です。
- 「骨格検出品質」はフォームの良し悪しではなく解析品質です。
- 怪我・筋力・地面反力・真の身体重心を動画だけから診断しません。

## ローカル開発

最新のVercel CLIでServicesを起動します。

```bash
npm install -g vercel@latest
vercel dev -L
```

または各サービスを個別に起動できます。
