#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project)}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-go-ai}"
REPO="${REPO:-go-ai}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}"

[ -f models/model.onnx ] || { echo "models/model.onnx がありません。scripts/fetch_model.sh を先に実行してください"; exit 1; }

gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format=docker --location="$REGION"

gcloud builds submit --tag "$IMAGE" .

gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --cpu 2 \
  --memory 4Gi \
  --concurrency 4 \
  --min-instances 0 \
  --max-instances 3 \
  --timeout 60s \
  --cpu-boost \
  --set-env-vars "ORT_THREADS=2,ALLOW_ORIGINS=*"

echo
echo "URL: $(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
