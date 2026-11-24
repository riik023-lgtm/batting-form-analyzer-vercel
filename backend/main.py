from __future__ import annotations

import math
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any

import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, HttpUrl

import analysis_engine_v113 as engine
import risk_analysis

app = FastAPI(title="Batting Form Analyzer API", version="11.5")


class Roi(BaseModel):
    # ver.11.3: 実映像に対する2D矩形ROI。すべて0〜1の割合。
    x: float | None = Field(0.08, ge=0.0, le=1.0)
    y: float = Field(0.08, ge=0.0, le=1.0)
    width: float = Field(0.84, ge=0.12, le=1.0)
    height: float = Field(0.84, ge=0.18, le=1.0)
    # ver.11.2の古いクライアント互換用
    center: float | None = Field(None, ge=0.0, le=1.0)


class RoiRequest(BaseModel):
    video_url: HttpUrl


class AnalyzeRequest(BaseModel):
    reference_url: HttpUrl
    target_url: HttpUrl
    batter_side: str = "右打者"
    selected_features: list[str]
    reference_roi: Roi = Roi()
    target_roi: Roi = Roi()
    # ver.11.4: STEP 3でユーザーが指定した動画時刻（秒）。
    # 実際のFPSは解析後に判明するため、サーバー側で最寄りフレームへ変換する。
    reference_impact_time: float | None = Field(None, ge=0.0)
    target_impact_time: float | None = Field(None, ge=0.0)
    # 旧クライアント互換
    reference_impact_frame: int | None = None
    target_impact_frame: int | None = None


def _download(url: str, prefix: str) -> Path:
    suffix = Path(url.split("?")[0]).suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}:
        suffix = ".mp4"
    path = Path(tempfile.gettempdir()) / f"bfa_{prefix}_{uuid.uuid4().hex}{suffix}"
    try:
        headers = {}
        if ".private.blob.vercel-storage.com" in url:
            token = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()
            if not token:
                raise HTTPException(
                    status_code=500,
                    detail="Private Blobの読取トークンが設定されていません。Vercel Storage接続でread-write tokenを有効にしてください。",
                )
            headers["Authorization"] = f"Bearer {token}"
        with requests.get(url, stream=True, timeout=(15, 120), headers=headers) as response:
            response.raise_for_status()
            with path.open("wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
    except HTTPException:
        path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"動画を取得できませんでした: {exc}") from exc
    return path


def _finite(value: Any):
    try:
        v = float(value)
        return v if math.isfinite(v) else None
    except Exception:
        return value if value is not None else None


def _records(df):
    if df is None:
        return []
    rows = []
    for record in df.to_dict(orient="records"):
        rows.append({k: _finite(v) for k, v in record.items()})
    return rows


def _quality(analysis):
    details = analysis.quality_details or {}
    return {
        "label": analysis.quality_label,
        "score": _finite(analysis.quality_score),
        "overall_detection_rate": _finite(details.get("overall_detection_rate")),
        "impact_window_detection_rate": _finite(details.get("impact_window_detection_rate")),
        "key_joint_visibility": _finite(details.get("key_joint_visibility")),
    }


def _analysis_meta(analysis):
    return {
        "fps": _finite(analysis.fps),
        "frame_count": int(analysis.frame_count),
        "impact_frame": int(analysis.impact_frame),
        "impact_time": _finite(analysis.impact_frame / max(analysis.fps, 1e-6)),
        "impact_candidates": [
            {"frame": int(f), "time": _finite(f / max(analysis.fps, 1e-6))}
            for f in list(dict.fromkeys([analysis.impact_frame] + list(analysis.impact_candidates)))[:3]
        ],
        "stance_frame": int(analysis.stance_frame),
        "quality": _quality(analysis),
        "extra_metrics": {k: _finite(v) for k, v in (analysis.extra_metrics or {}).items()},
    }


@app.get("/api/health")
def health():
    return {"ok": True, "version": "11.5", "runtime": "python", "roi": "2d-crop", "impact": "manual-time"}


@app.post("/api/suggest-roi")
def suggest_roi(payload: RoiRequest):
    video_path = _download(str(payload.video_url), "roi")
    try:
        roi = engine.suggest_batter_roi(video_path)
        return {
            "x": _finite(roi.get("x", 0.08)),
            "y": _finite(roi.get("y", 0.08)),
            "width": _finite(roi.get("width", 0.84)),
            "height": _finite(roi.get("height", 0.84)),
            "confidence": _finite(roi.get("confidence", 0.0)),
        }
    finally:
        video_path.unlink(missing_ok=True)


@app.post("/api/analyze")
def analyze(payload: AnalyzeRequest):
    if payload.batter_side not in {"右打者", "左打者"}:
        raise HTTPException(status_code=400, detail="打席を選択してください。")
    if len(payload.selected_features) != 5:
        raise HTTPException(status_code=400, detail="比較項目は5項目選択してください。")

    ref_path = _download(str(payload.reference_url), "reference")
    tar_path = _download(str(payload.target_url), "target")
    output_dir = Path(tempfile.gettempdir()) / f"bfa_result_{uuid.uuid4().hex}"
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        result = engine.run_analysis(
            reference_original_path=ref_path,
            target_original_path=tar_path,
            batter_side=payload.batter_side,
            selected_feature_names=payload.selected_features,
            output_dir=output_dir,
            reference_batter_roi=payload.reference_roi.model_dump(),
            target_batter_roi=payload.target_roi.model_dump(),
        )

        ref_manual_frame = payload.reference_impact_frame
        tar_manual_frame = payload.target_impact_frame

        if payload.reference_impact_time is not None:
            ref_fps = max(float(result["reference_analysis"].fps), 1e-6)
            ref_manual_frame = int(round(payload.reference_impact_time * ref_fps))
        if payload.target_impact_time is not None:
            tar_fps = max(float(result["target_analysis"].fps), 1e-6)
            tar_manual_frame = int(round(payload.target_impact_time * tar_fps))

        # ユーザーが指定した側だけ手動時刻を使い、未指定側は自動推定を維持する。
        if ref_manual_frame is not None or tar_manual_frame is not None:
            result = engine.recalculate_with_manual_impacts(
                result,
                ref_manual_frame if ref_manual_frame is not None else result["reference_analysis"].impact_frame,
                tar_manual_frame if tar_manual_frame is not None else result["target_analysis"].impact_frame,
                payload.selected_features,
                payload.batter_side,
            )

        result["body_load"] = risk_analysis.assess_body_load(
            result["reference_analysis"], result["target_analysis"], payload.batter_side
        )
        result["research_advice"] = risk_analysis.research_based_advice(
            result["reference_analysis"], result["target_analysis"]
        )

        body = result["body_load"]
        return {
            "version": "11.5",
            "overall_comparison_label": result.get("overall_comparison_label", "評価保留"),
            "best_item": result.get("best_item", ""),
            "lowest_item": result.get("lowest_item", ""),
            "features": _records(result.get("score_dataframe")),
            "advice": _records(result.get("advice_dataframe")),
            "research_advice": _records(result.get("research_advice")),
            "body_load": {
                "overall_label": body.get("overall_label", ""),
                "regions": _records(body.get("regions")),
                "limitations": body.get("limitations", ""),
            },
            "reference": _analysis_meta(result["reference_analysis"]),
            "target": _analysis_meta(result["target_analysis"]),
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        ref_path.unlink(missing_ok=True)
        tar_path.unlink(missing_ok=True)
