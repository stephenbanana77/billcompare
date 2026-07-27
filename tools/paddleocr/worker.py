"""Persistent JSONL worker for PaddleOCR page-image recognition."""

import json
import os
import sys
import traceback
from pathlib import Path


def normalize_result(result, page, width, height):
    data = result if isinstance(result, dict) else dict(result)
    texts = data.get("rec_texts", []) or []
    scores = data.get("rec_scores", []) or []
    polygons = data.get("rec_polys", []) or []
    boxes = []
    for text, score, polygon in zip(texts, scores, polygons):
        clean_text = str(text).strip()
        points = polygon.tolist() if hasattr(polygon, "tolist") else polygon
        if not clean_text or not isinstance(points, (list, tuple)) or len(points) != 4:
            continue
        try:
            clean_points = [[float(point[0]), float(point[1])] for point in points]
            clean_score = float(score)
        except (TypeError, ValueError, IndexError):
            continue
        boxes.append({
            "page": page,
            "text": clean_text,
            "score": clean_score,
            "polygon": clean_points,
        })
    return {"page": page, "width": width, "height": height, "boxes": boxes}


class PaddleEngine:
    def __init__(self):
        self._ocr = None

    def load(self):
        if self._ocr is not None:
            return self._ocr
        from paddleocr import PaddleOCR

        device = os.getenv("PADDLEOCR_DEVICE", "cpu").strip().lower() or "cpu"
        kwargs = {
            "lang": "ch",
            "device": device,
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
        }
        if device == "cpu":
            # Paddle 3.3 + PP-OCRv6 on Windows currently fails in oneDNN for this model.
            kwargs["enable_mkldnn"] = False
        detector = os.getenv("PADDLEOCR_DETECTION_MODEL", "").strip()
        recognizer = os.getenv("PADDLEOCR_RECOGNITION_MODEL", "").strip()
        if detector:
            kwargs["text_detection_model_name"] = detector
        if recognizer:
            kwargs["text_recognition_model_name"] = recognizer
        self._ocr = PaddleOCR(**kwargs)
        return self._ocr

    def recognize(self, images):
        from PIL import Image

        ocr = self.load()
        pages = []
        for index, image_path in enumerate(images, start=1):
            path = Path(image_path).resolve()
            if not path.is_file():
                raise ValueError(f"image not found: {path.name}")
            with Image.open(path) as image:
                width, height = image.size
            predictions = list(ocr.predict(str(path)))
            boxes = []
            for prediction in predictions:
                normalized = normalize_result(prediction, index, width, height)
                boxes.extend(normalized["boxes"])
            pages.append({"page": index, "width": width, "height": height, "boxes": boxes})
        return pages


def respond(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    engine = PaddleEngine()
    for raw_line in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = str(request.get("id", "")).strip()
            images = request.get("images", [])
            if not request_id or not isinstance(images, list) or not images:
                raise ValueError("id and images are required")
            respond({"id": request_id, "ok": True, "pages": engine.recognize(images)})
        except Exception as error:
            print(traceback.format_exc(), file=sys.stderr, flush=True)
            respond({"id": request_id, "ok": False, "error": str(error)})


if __name__ == "__main__":
    main()
