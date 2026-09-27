"""LITROS: local ONNX ensemble (Florence-2 fine-tuned + CRNN) for reading the
liters display of a fuel dispenser from a photo.

Submodules:
    florence  Florence-2-base LITROS fine-tune, ONNX Runtime (vision+encoder+decoder).
    crnn      CRNN-CTC digit reader with a pure-OpenCV panel localizer.
    ensemble  Agreement rule combining both readers into a single result.

No training/experiment code lives here — this package is inference-only. See
`worker.py` (one level up) for the persistent JSON-lines process that wires
these together for the Node backend.
"""

__version__ = "litros-v1"
