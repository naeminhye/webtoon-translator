FROM python:3.11-slim

# OpenCV (pulled in by paddleocr) runtime libraries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 libglib2.0-0 libgl1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake the Korean models into the image so the first request isn't a
# multi-minute download.
RUN python -c "from paddleocr import PaddleOCR; PaddleOCR(lang='korean', \
use_doc_orientation_classify=False, use_doc_unwarping=False, \
use_textline_orientation=False)"

COPY server.py .

EXPOSE 8868
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "8868", "--preload"]
