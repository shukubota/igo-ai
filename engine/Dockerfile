FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── レイヤー順に注意 ───────────────────────────────────────────────
# モデル(約294MB)をコードより先にCOPYする。逆順にすると、コードを1行
# 直すたびにモデルのレイヤーも無効化され、294MBが再pushされる。
COPY models/model.onnx /models/model.onnx
ENV MODEL_PATH=/models/model.onnx

# 変更頻度の高いコードは最後
COPY *.py /app/

ENV PORT=8080
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1
