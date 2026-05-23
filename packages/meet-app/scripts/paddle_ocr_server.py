"""
PaddleOCR stdin/stdout JSON-lines server for timing sheet digit recognition.

Protocol:
- Reads JSON objects from stdin (one per line)
- Writes JSON responses to stdout (one per line)
- Sends {"type": "ready"} on startup

Request format:
  {"id": "1", "action": "recognize_digit", "image": "<base64 PNG/JPEG>"}

Response format:
  {"type": "result", "id": "1", "data": {"text": "5", "confidence": 0.97}}

Quit:
  {"action": "quit"}

Install dependencies:
  pip install paddlepaddle paddleocr Pillow
"""

import sys
import json
import base64
import io
import traceback

def main():
    # Import PaddleOCR (may take a few seconds on first load)
    try:
        from paddleocr import PaddleOCR
        from PIL import Image
        import numpy as np
    except ImportError as e:
        error_msg = json.dumps({
            "type": "error",
            "id": "init",
            "message": f"Missing dependency: {e}. Install with: pip install paddlepaddle paddleocr Pillow"
        })
        print(error_msg, flush=True)
        sys.exit(1)

    # Initialize PaddleOCR with lightweight model
    ocr = PaddleOCR(
        use_angle_cls=False,
        lang='en',
        det=False,  # No detection needed (we have pre-cropped digits)
        rec=True,
        rec_char_dict_path=None,  # Use default
        show_log=False,
    )

    # Signal ready
    print(json.dumps({"type": "ready"}), flush=True)

    # Process requests
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        action = request.get("action", "")
        request_id = request.get("id", "")

        if action == "quit":
            break

        if action == "recognize_digit":
            try:
                # Decode base64 image
                image_data = base64.b64decode(request["image"])
                image = Image.open(io.BytesIO(image_data)).convert("L")  # Grayscale

                # Convert to numpy array
                img_array = np.array(image)

                # Run OCR recognition
                result = ocr.ocr(img_array, det=False, rec=True, cls=False)

                text = "0"
                confidence = 0.0

                if result and result[0]:
                    for line_result in result[0]:
                        if line_result and len(line_result) >= 2:
                            recognized_text = str(line_result[1][0]).strip()
                            conf = float(line_result[1][1])
                            # Take first digit character found
                            for ch in recognized_text:
                                if ch.isdigit():
                                    text = ch
                                    confidence = conf
                                    break
                            break

                response = json.dumps({
                    "type": "result",
                    "id": request_id,
                    "data": {"text": text, "confidence": confidence}
                })
                print(response, flush=True)

            except Exception as e:
                error_response = json.dumps({
                    "type": "error",
                    "id": request_id,
                    "message": str(e)
                })
                print(error_response, flush=True)

        elif action == "recognize_strip":
            # Alternative: recognize a full strip image (line-level OCR)
            try:
                image_data = base64.b64decode(request["image"])
                image = Image.open(io.BytesIO(image_data)).convert("L")
                img_array = np.array(image)

                result = ocr.ocr(img_array, det=True, rec=True, cls=False)

                texts = []
                if result and result[0]:
                    for line_result in result[0]:
                        if line_result and len(line_result) >= 2:
                            texts.append({
                                "text": str(line_result[1][0]),
                                "confidence": float(line_result[1][1])
                            })

                response = json.dumps({
                    "type": "result",
                    "id": request_id,
                    "data": {"texts": texts}
                })
                print(response, flush=True)

            except Exception as e:
                error_response = json.dumps({
                    "type": "error",
                    "id": request_id,
                    "message": str(e)
                })
                print(error_response, flush=True)


if __name__ == "__main__":
    main()
