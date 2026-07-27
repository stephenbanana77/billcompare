import json
import sys


def main():
    status = {"ready": False, "gpu": False}
    try:
        import paddle
        import paddleocr
        from PIL import Image
        status.update({
            "ready": True,
            "gpu": bool(paddle.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0),
            "paddle": paddle.__version__,
            "paddleocr": paddleocr.__version__,
            "python": sys.version.split()[0],
        })
    except Exception as error:
        status["error"] = str(error)
    print(json.dumps(status, ensure_ascii=False))
    return 0 if status["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
