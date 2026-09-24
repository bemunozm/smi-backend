"""Florence-2-base LITROS fine-tune, ONNX Runtime inference (int8 by default).

Ported from `smi-frontend/scratchpad/ocr-train/florence-ft/{litros_runtime.py,
ftcommon.py}` — inference-only: no `TorchLitros`, no training/augmentation/
dataset/metrics code, no `transformers`/`torch` dependency. `TOPSQ_RATIO` is no
longer a module-level constant: it's read from `litros_config.json` (see
`ocr-python/models/litros_config.json`), falling back to the original default
(1.2) if the config predates that key.

Thread configuration (`cv2.setNumThreads`) is NOT done here at import time
(the original `ftcommon.py` did `cv2.setNumThreads(1)` at module load) — it's
centralized once in `worker.py`, since this module gets imported by a
long-lived process that also runs `litros.crnn` (which uses cv2 for panel
localization) and both should agree on one thread budget.
"""
from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps

LITERS_RE = re.compile(r"^\d{1,3}\.\d{3}$")
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)
# Fallback only — the models/litros_config.json shipped with the worker
# always carries an explicit "topsq_ratio" key (see ocr-python/README.md).
DEFAULT_TOPSQ_RATIO = 1.2


# --------------------------------------------------------------- preprocessing
def square_src(a: np.ndarray, prep: str, topsq_ratio: float = DEFAULT_TOPSQ_RATIO) -> np.ndarray:
    """Geometry step before the final resize.

    stretch: whole photo (will be stretched to res x res, like the stock Florence processor).
    topsq:   aspect-preserving; portrait photos are cropped to their upper part
             (height <= topsq_ratio*W), then letterboxed (black) to a square.
             Landscape photos are letterboxed whole.
    """
    if prep == "stretch":
        return a
    if prep != "topsq":
        raise ValueError(prep)
    h, w = a.shape[:2]
    if h > topsq_ratio * w:
        a = a[: int(round(topsq_ratio * w))]
        h = a.shape[0]
    s = max(h, w)
    if h == w:
        return a
    out = np.zeros((s, s, 3), np.uint8)
    y0, x0 = (s - h) // 2, (s - w) // 2
    out[y0 : y0 + h, x0 : x0 + w] = a
    return out


def to_pixels(
    a: np.ndarray, prep: str, res: int, topsq_ratio: float = DEFAULT_TOPSQ_RATIO
) -> np.ndarray:
    """RGB uint8 HxWx3 -> float32 1x3xRxR normalized (CLIP mean/std, same as the Florence processor)."""
    a = square_src(a, prep, topsq_ratio)
    h, w = a.shape[:2]
    interp = cv2.INTER_AREA if (h > res or w > res) else cv2.INTER_CUBIC
    a = cv2.resize(a, (res, res), interpolation=interp)
    x = (a.astype(np.float32) * (1.0 / 255.0) - MEAN) / STD
    return np.ascontiguousarray(x.transpose(2, 0, 1)[None])


def load_rgb(
    path: str,
    prep: str | None = None,
    res: int | None = None,
    topsq_ratio: float = DEFAULT_TOPSQ_RATIO,
) -> np.ndarray:
    """Decode (EXIF-aware via PIL). With prep/res, lets libjpeg decode at a reduced
    DCT scale when that still leaves >= res pixels on the side that ends up as the
    square (faster decode, same final input size)."""
    im = Image.open(path)
    if prep and res and im.format == "JPEG":
        w, h = im.size
        if im.getexif().get(0x0112, 1) in (5, 6, 7, 8):  # rotated 90 deg after transpose
            w, h = h, w
        if prep == "topsq":
            side = max(w, min(h, int(round(topsq_ratio * w))))
            k = res / side
            req = (math.ceil(w * k), math.ceil(h * k))
        else:
            req = (res, res)
        im.draft("RGB", req)
    im = ImageOps.exif_transpose(im).convert("RGB")
    return np.asarray(im)


# --------------------------------------------------------------- output parsing
def parse_output(raw: str) -> dict:
    """Parse model text into {'liters','dollars','price'}; invalid/unknown -> None."""
    txt = raw.replace("<s>", "").replace("</s>", "").replace("<pad>", "")
    compact = re.sub(r"\s+", "", txt)
    fields = {}
    for part in compact.split("|"):
        m = re.match(r"^([LDP]):(.*)$", part)
        if m and m.group(1) not in fields:
            fields[m.group(1)] = m.group(2)
    liters = fields.get("L")
    if liters is None and "|" not in compact and ":" not in compact:
        liters = compact  # tolerate a bare number
    liters = liters if liters is not None and LITERS_RE.fullmatch(liters) else None
    d = fields.get("D")
    dollars = int(d) if d is not None and re.fullmatch(r"\d{1,6}", d) else None
    p = fields.get("P")
    price = float(p) if p is not None and re.fullmatch(r"\d{1,3}\.\d", p) else None
    return {"liters": liters, "dollars": dollars, "price": price}


# --------------------------------------------------------------- ONNX runtime
@dataclass
class FlorenceResult:
    liters: str | None
    confidence: float
    raw: str


class FlorenceReader:
    """ONNX Runtime inference for the fine-tuned Florence-2 LITROS model.
    Load once (~0.9s), reuse across requests (batch size 1)."""

    def __init__(self, model_dir: str, threads: int = 4, files: dict[str, str] | None = None):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        with open(os.path.join(model_dir, "litros_config.json"), encoding="utf-8") as fh:
            self.cfg = json.load(fh)
        self.topsq_ratio = float(self.cfg.get("topsq_ratio", DEFAULT_TOPSQ_RATIO))

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        files = files or {}

        def mk(name: str):
            filename = files.get(name, f"{name}.int8.onnx")
            return ort.InferenceSession(
                os.path.join(model_dir, filename), so, providers=["CPUExecutionProvider"]
            )

        self.vis, self.enc, self.dec = mk("vision"), mk("encoder"), mk("decoder")
        self.tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        n_layers, n_heads, head_dim = self.cfg["n_layers"], self.cfg["n_heads"], self.cfg["head_dim"]
        self.kv = [f"{t}{i}" for i in range(n_layers) for t in ("k", "v")]
        self.empty = np.zeros((1, n_heads, 0, head_dim), np.float32)

    def read(self, path: str) -> FlorenceResult:
        c = self.cfg
        pix = to_pixels(
            load_rgb(path, c["prep"], c["res"], self.topsq_ratio), c["prep"], c["res"], self.topsq_ratio
        )
        return self._read_pixels(pix)

    def _read_pixels(self, pix: np.ndarray) -> FlorenceResult:
        c = self.cfg
        feats = self.vis.run(None, {"pixel_values": pix})[0]
        cross = self.enc.run(None, {"image_features": feats})
        feed = {f"cross_{n}": x for n, x in zip(self.kv, cross)}
        past = [self.empty] * len(self.kv)
        seq = [c["decoder_start_token_id"]]
        conf = 1.0
        for t in range(c["max_new_tokens"]):
            feed["input_ids"] = np.array([[seq[-1]]], np.int64)
            feed["position_ids"] = np.array([[t]], np.int64)
            for n, x in zip(self.kv, past):
                feed[f"past_{n}"] = x
            out = self.dec.run(None, feed)
            past = out[1:]
            if t == 0:
                nxt = c["bos"]
            else:
                lg = out[0][0]
                nxt = int(lg.argmax())
                e = np.exp(lg - lg[nxt])
                conf = min(conf, float(1.0 / e.sum()))
            seq.append(nxt)
            if nxt == c["eos"]:
                break
        raw = self.tok.decode(seq, skip_special_tokens=True)
        parsed = parse_output(raw)
        return FlorenceResult(liters=parsed["liters"], confidence=round(conf, 4), raw=raw)
