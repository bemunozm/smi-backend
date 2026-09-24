"""CRNN-CTC digit reader with a pure-OpenCV panel localizer, ONNX Runtime only.

Ported from `smi-frontend/scratchpad/ocr-train/crnn/{pipeline.py,localize.py,
decode.py}` (no torch branch — the original `Recognizer` supported a torch
checkpoint path for experiments, dropped here) plus the x0.5 confidence rule
from `predict.py:44-45` (applied when the $ cross-check disagrees), now
folded into `read()` below instead of living in a separate CLI script.

EXIF orientation: the original research pipeline (`predict.py`) decoded with
`cv2.imdecode(np.fromfile(f), cv2.IMREAD_COLOR)` and never handled EXIF at
all — a real gap, since most phone photos carry an EXIF orientation tag and
`cv2.imdecode`'s default auto-rotation behavior has changed across OpenCV
versions/builds. `decode_image_exif_safe` below decodes with the
`IMREAD_IGNORE_ORIENTATION` flag (so no implicit rotation happens regardless
of the installed OpenCV build) and then applies the EXIF orientation
explicitly, matching what `PIL.ImageOps.exif_transpose` does (used by
`litros.florence.load_rgb`), so both readers see the same upright image.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image

# --------------------------------------------------------------- constants
IN_H, IN_W = 40, 160
CHARSET = "0123456789.?"  # '?' = internal reject token (partially cut glyph)
NCLASS = len(CHARSET) + 1  # + CTC blank (index 0)
LITERS_RE = re.compile(r"^\d{1,3}\.\d{3}$")
LITERS_LIKE = re.compile(r"^[\d?]{0,3}\.[\d?]{3}$")
PRICE_RE = re.compile(r"^\d{3}\.\d$")
DOLLARS_RE = re.compile(r"^\d{1,7}$")
DOLLARS_MIN_CONF = 0.9
PADS_TTA = [(0.06, 0.12), (0.10, 0.22), (0.03, 0.05)]
WORK = 640  # longest side used for panel detection
_EXIF_ORIENTATION_TAG = 0x0112


# --------------------------------------------------------------- EXIF-safe decode
def _apply_exif_orientation(img: np.ndarray, orientation: int) -> np.ndarray:
    """Mirrors `PIL.ImageOps.exif_transpose`'s orientation->transform table."""
    if orientation == 2:
        return cv2.flip(img, 1)
    if orientation == 3:
        return cv2.rotate(img, cv2.ROTATE_180)
    if orientation == 4:
        return cv2.flip(img, 0)
    if orientation == 5:
        return cv2.transpose(img)
    if orientation == 6:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if orientation == 7:
        return cv2.flip(cv2.transpose(img), -1)
    if orientation == 8:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img  # 1 (normal) or any unrecognized value


def decode_image_exif_safe(path: str) -> np.ndarray:
    """Decode an image file to a BGR ndarray (cv2 convention), applying EXIF
    orientation explicitly instead of relying on the installed OpenCV build's
    default JPEG auto-rotation (which differs across versions/builds)."""
    data = np.fromfile(path, dtype=np.uint8)
    flags = cv2.IMREAD_COLOR | cv2.IMREAD_IGNORE_ORIENTATION
    img = cv2.imdecode(data, flags)
    if img is None:
        raise ValueError(f"could not decode image: {path}")
    orientation = 1
    try:
        with Image.open(path) as im:
            orientation = int(im.getexif().get(_EXIF_ORIENTATION_TAG, 1))
    except Exception:
        orientation = 1
    return _apply_exif_orientation(img, orientation)


# --------------------------------------------------------------- panel localization
def _warm_map(small: np.ndarray) -> np.ndarray:
    b, g, r = (c.astype(np.float32) for c in cv2.split(small))
    warm = r - b  # orange & pink have R >> B; sky/white glare do not
    m = r * np.clip((warm + 10) / 60.0, 0, 1)  # brightness weighted by warmth; clip negatives
    return cv2.GaussianBlur(m, (0, 0), 1.2)


def _iou(a: tuple, b: tuple) -> float:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    ix = max(0, min(ax1, bx1) - max(ax0, bx0))
    iy = max(0, min(ay1, by1) - max(ay0, by0))
    inter = ix * iy
    u = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    return inter / max(u, 1e-6)


def find_panels(img: np.ndarray, max_cands: int = 8) -> list[dict]:
    """Returns list of candidate dicts (in ORIGINAL image coords):
    {rect: ((cx,cy),(w,h),angle) minAreaRect, box:(x0,y0,x1,y1), score}"""
    H, W = img.shape[:2]
    s = WORK / max(H, W)
    small = cv2.resize(img, (int(W * s), int(H * s)), interpolation=cv2.INTER_AREA)
    h, w = small.shape[:2]
    m = _warm_map(small)
    hi = float(np.percentile(m, 99.5))
    if hi < 20:
        return []
    cands = []
    k = max(3, int(min(h, w) * 0.012) | 1)
    kh = max(5, int(min(h, w) * 0.05) | 1)
    masks = []
    for frac in (0.3, 0.4, 0.5, 0.6, 0.72):
        th = (m >= hi * frac).astype(np.uint8) * 255
        th = cv2.morphologyEx(th, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
        masks.append(cv2.morphologyEx(th, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))))
        # horizontal close: joins fragments of one panel split by glare/digits
        masks.append(
            cv2.morphologyEx(
                th, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (kh, max(3, k // 2)))
            )
        )
    for th in masks:
        cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            area = cv2.contourArea(c)
            if area < h * w * 0.002:
                continue
            (cx, cy), (rw, rh), ang = cv2.minAreaRect(c)
            if rw < rh:  # normalize so rw is the long side, angle in (-45,45]
                rw, rh = rh, rw
                ang = ang - 90
            while ang <= -45:
                ang += 90
            while ang > 45:
                ang -= 90
            if abs(ang) > 30 or rh < 8:
                continue
            ar = rw / max(rh, 1e-6)
            if not (1.6 <= ar <= 9.0):
                continue
            hull = cv2.convexHull(c)
            solidity = area / max(cv2.contourArea(hull), 1e-6)
            rect_fill = area / max(rw * rh, 1e-6)
            if rect_fill < 0.55 or solidity < 0.7:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            score = rect_fill * solidity * np.sqrt(area / (h * w))
            cands.append(
                {
                    "rect": ((cx / s, cy / s), (rw / s, rh / s), ang),
                    "box": (x / s, y / s, (x + bw) / s, (y + bh) / s),
                    "score": float(score),
                    "ar": float(ar),
                }
            )
    cands.sort(key=lambda d: -d["score"])  # NMS
    keep = []
    for c in cands:
        if all(_iou(c["box"], k["box"]) < 0.5 for k in keep):
            keep.append(c)
        if len(keep) >= max_cands:
            break
    return keep


def crop_rect(img: np.ndarray, rect: tuple, pad_x: float = 0.06, pad_y: float = 0.12) -> np.ndarray:
    """Deskewed crop of a minAreaRect with padding."""
    (cx, cy), (rw, rh), ang = rect
    rw2, rh2 = rw * (1 + 2 * pad_x), rh * (1 + 2 * pad_y)
    M = cv2.getRotationMatrix2D((cx, cy), ang, 1.0)
    M[0, 2] += rw2 / 2 - cx
    M[1, 2] += rh2 / 2 - cy
    return cv2.warpAffine(
        img, M, (int(round(rw2)), int(round(rh2))), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
    )


# --------------------------------------------------------------- CTC decode
def greedy_decode(logp: np.ndarray) -> tuple[str, list[float], float]:
    """logp: (T, C) log-probs -> (text, per-char max prob list, min blank prob on blank frames)."""
    p = np.exp(logp)
    best = p.argmax(-1)
    text: list[str] = []
    confs: list[float] = []
    prev = 0
    for t, k in enumerate(best):
        if k != 0 and k != prev:
            text.append(CHARSET[k - 1])
            confs.append(p[t, k])
        elif k != 0 and k == prev:
            confs[-1] = max(confs[-1], p[t, k])
        prev = k
    blank_frames = p[best == 0, 0]
    blank_min = float(blank_frames.min()) if blank_frames.size else 1.0
    return "".join(text), [float(c) for c in confs], blank_min


def read_confidence(confs: list[float], blank_min: float) -> float:
    """Per-read confidence = min over emitted chars' max-prob and the weakest blank frame."""
    if not confs:
        return 0.0
    return float(min(min(confs), blank_min))


# --------------------------------------------------------------- recognizer
def _prep(crop: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    g = cv2.resize(g, (IN_W, IN_H), interpolation=cv2.INTER_AREA).astype(np.float32)
    return ((g - g.mean()) / (g.std() + 8.0))[None]


class CrnnRecognizer:
    """ONNX Runtime inference for the CRNN-CTC digit reader. Load once, reuse."""

    def __init__(self, model_path: str, threads: int = 1):
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0].name

    def _logp(self, X: np.ndarray) -> np.ndarray:
        return self.sess.run(None, {self.inp: X})[0]

    def read_crops(self, crops: list[np.ndarray]) -> list[dict]:
        if not crops:
            return []
        X = np.stack([_prep(c) for c in crops]).astype(np.float32)
        lp = self._logp(X)
        out = []
        for i in range(len(crops)):
            text, confs, bmin = greedy_decode(lp[i])
            out.append(
                {
                    "raw": text,
                    "conf": read_confidence(confs, bmin),
                    "conf_mean": float(np.mean(confs)) if confs else 0.0,
                }
            )
        return out


def _cross_check(liters: str | None, dollars: str | None, price: str | None) -> bool | None:
    """True/False/None: does $ ~= liters x price? (price 1.0 or 100.0 if unknown)."""
    if liters is None or dollars is None:
        return None
    L, D = float(liters), int(dollars)
    prices = [float(price)] if price else [1.0, 100.0]
    return any(abs(L * p - D) <= 1.0 + 0.002 * D for p in prices)


def _localize_and_read(img: np.ndarray, rec: CrnnRecognizer, max_cands: int = 8, tta: bool = False) -> dict:
    """Full localize -> recognize -> pick-by-format pass. Returns the same shape
    as the original research `read_image` (minus the raw `cands` list, unused
    by the worker)."""
    cands = find_panels(img, max_cands=max_cands)
    pads = PADS_TTA if tta else PADS_TTA[:1]
    crops = [crop_rect(img, c["rect"], pad_x=px, pad_y=py) for c in cands for (px, py) in pads]
    reads = rec.read_crops(crops)
    k = len(pads)
    for i, c in enumerate(cands):
        rs = reads[i * k : (i + 1) * k]
        if k == 1:
            c.update(rs[0])
            continue
        # vote across paddings; confidence = mean conf of agreeing reads x agreement ratio
        votes: dict[str, list[float]] = {}
        for r in rs:
            votes.setdefault(r["raw"], []).append(r["conf"])
        raw, confs = max(votes.items(), key=lambda kv: (len(kv[1]), sum(kv[1])))
        c.update(
            raw=raw,
            conf=float(np.mean(confs)) * len(confs) / k,
            conf_mean=float(np.mean(confs)),
            variants=[r["raw"] for r in rs],
        )
    lit = [c for c in cands if LITERS_RE.match(c["raw"])]
    like = [c for c in cands if LITERS_LIKE.match(c["raw"])]
    res = {
        "liters": None,
        "confidence": 0.0,
        "dollars": None,
        "price": None,
        "raw": "",
        "localized": bool(like),
        "check": None,
        "n_cands": len(cands),
    }
    if not lit:
        if like:
            best = max(like, key=lambda c: c["conf"])
            res["raw"] = best["raw"]
        return res
    best = max(lit, key=lambda c: c["conf"])
    (bx, by), (bw, bh), _ = best["rect"]
    res.update(liters=best["raw"], confidence=best["conf"], raw=best["raw"])
    # $ panel: above LITROS, horizontally overlapping; PRECIO: below.
    above = [
        c
        for c in cands
        if DOLLARS_RE.match(c["raw"]) and c["rect"][0][1] < by - 0.5 * bh and abs(c["rect"][0][0] - bx) < 0.6 * bw
    ]
    below = [
        c
        for c in cands
        if PRICE_RE.match(c["raw"]) and c["rect"][0][1] > by + 0.5 * bh and abs(c["rect"][0][0] - bx) < 0.6 * bw
    ]
    if above:
        d = min(above, key=lambda c: by - c["rect"][0][1])
        if d["conf"] >= DOLLARS_MIN_CONF:  # $ panel is often washed out: only trust confident reads
            res["dollars"] = d["raw"]
            res["dollars_conf"] = d["conf"]
    if below:
        p = min(below, key=lambda c: c["rect"][0][1] - by)
        res["price"] = p["raw"]
    res["check"] = _cross_check(res["liters"], res["dollars"], res["price"])
    return res


@dataclass
class CrnnResult:
    liters: str | None
    confidence: float
    raw: str


def read(path: str, rec: CrnnRecognizer) -> CrnnResult:
    """EXIF-safe decode -> localize -> recognize -> the x0.5 cross-check
    confidence penalty (ported from `predict.py:44-45`)."""
    img = decode_image_exif_safe(path)
    res = _localize_and_read(img, rec)
    conf = res["confidence"]
    if res["check"] is False:
        conf *= 0.5
    return CrnnResult(liters=res["liters"], confidence=round(float(conf), 4), raw=res["raw"])
