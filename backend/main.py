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

import analysis_engine as engine
import risk_analysis

app = FastAPI(title="Batting Form Analyzer API", version="11.1")


class Roi(BaseModel):
    center: float = Field(0.5, ge=0.0, le=1.0)
    width: float = Field(0.6, ge=0.18, le=1.0)


class RoiRequest(BaseModel):
    video_url: HttpUrl


class AnalyzeRequest(BaseModel):
    reference_url: HttpUrl
    target_url: HttpUrl
    batter_side: str = "右打者"
    selected_features: list[str]
    reference_roi: Roi = Roi()
    target_roi: Roi = Roi()
    reference_impact_frame: int | None = None
    target_impact_frame: int | None = None


def _download(url: str, prefix: str) -> Path:
    suffix = Path(url.split("?")[0]).suffix.lower()
    if suffix not in {".mp4", ".mov", ".m4v", ".avi", ".mkv"}:
        suffix = ".mp4"
    path = Path(tempfile.gettempdir()) / f"bfa_{prefix}_{uuid.uuid4().hex}{suffix}"
    try:
        with requests.get(url, stream=True, timeout=(15, 120)) as response:
            response.raise_for_status()
            with path.open("wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
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
    return {"ok": True, "version": "11.1", "runtime": "python"}


@app.post("/api/suggest-roi")
def suggest_roi(payload: RoiRequest):
    video_path = _download(str(payload.video_url), "roi")
    try:
        roi = engine.suggest_batter_roi(video_path)
        return {
            "center": _finite(roi.get("center", 0.5)),
            "width": _finite(roi.get("width", 0.6)),
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

        if payload.reference_impact_frame is not None or payload.target_impact_frame is not None:
            result = engine.recalculate_with_manual_impacts(
                result,
                payload.reference_impact_frame if payload.reference_impact_frame is not None else result["reference_analysis"].impact_frame,
                payload.target_impact_frame if payload.target_impact_frame is not None else result["target_analysis"].impact_frame,
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
            "version": "11.1",
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
        # /tmp is ephemeral; no user video is intentionally retained here.
