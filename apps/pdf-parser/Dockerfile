FROM python:3.12-slim
WORKDIR /worker
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
COPY apps/pdf-parser/requirements.txt .
RUN pip install --no-cache-dir torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt
COPY apps/pdf-parser/worker.py apps/pdf-parser/engine.py apps/pdf-parser/smoke.py ./
ENV MINERU_DEVICE_MODE=cpu MINERU_MODEL_SOURCE=modelscope OMP_NUM_THREADS=2 PYTHONUNBUFFERED=1
ENV HF_HOME=/models/huggingface MODELSCOPE_CACHE=/models/modelscope MODELSCOPE_HOME=/models/modelscope-config
ENV FTLANG_CACHE=/models/fasttext
RUN useradd --create-home worker && mkdir /models && chown worker:worker /models
USER worker
EXPOSE 8010
CMD ["python", "worker.py"]
