#!/bin/sh
set -eu

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID}"
: "${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET}"
: "${OPENAI_API_KEY:?Set OPENAI_API_KEY}"

REGION="${REGION:-northamerica-northeast1}"
SERVICE_NAME="${SERVICE_NAME:-work-activation-assistant}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-work-activation-assistant}"
BUILD_SERVICE_ACCOUNT="${BUILD_SERVICE_ACCOUNT:-work-activation-builder}"
WORK_ACCOUNT="${WORK_ACCOUNT:-leslee@calibrateconsulting.ca}"
SERVICE_API_TOKEN="${SERVICE_API_TOKEN:-$(openssl rand -hex 32)}"
JOB_SECRET="${JOB_SECRET:-$(openssl rand -hex 32)}"
ROTATE_SECRETS="${ROTATE_SECRETS:-0}"

gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com gmail.googleapis.com calendar-json.googleapis.com

gcloud iam service-accounts describe "$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SERVICE_ACCOUNT" --display-name="Work Activation Assistant"
gcloud iam service-accounts describe "$BUILD_SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$BUILD_SERVICE_ACCOUNT" --display-name="Work Activation Build"

for role in roles/datastore.user roles/secretmanager.secretAccessor roles/secretmanager.secretVersionAdder; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com" --role="$role" >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$BUILD_SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com" --role="roles/run.builder" >/dev/null

ensure_secret() {
  name="$1"
  value="$2"
  if ! gcloud secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gcloud secrets create "$name" --data-file=- >/dev/null
  elif [ "$ROTATE_SECRETS" = "1" ]; then
    printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  fi
}

ensure_secret "work-assistant-google-client-secret" "$GOOGLE_CLIENT_SECRET"
ensure_secret "work-assistant-openai-api-key" "$OPENAI_API_KEY"
ensure_secret "work-assistant-service-api-token" "$SERVICE_API_TOKEN"
ensure_secret "work-assistant-job-secret" "$JOB_SECRET"
gcloud secrets describe work-assistant-google-token >/dev/null 2>&1 || printf '{}' | gcloud secrets create work-assistant-google-token --data-file=-

SERVICE_API_TOKEN="$(gcloud secrets versions access latest --secret=work-assistant-service-api-token)"
JOB_SECRET="$(gcloud secrets versions access latest --secret=work-assistant-job-secret)"

gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 || gcloud firestore databases create --database='(default)' --location=nam5 --type=firestore-native

BOOTSTRAP_BASE_URL="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)' 2>/dev/null || true)"
BOOTSTRAP_BASE_URL="${BOOTSTRAP_BASE_URL:-https://placeholder.invalid}"

gcloud run deploy "$SERVICE_NAME" \
  --quiet \
  --source=. \
  --region="$REGION" \
  --service-account="$SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com" \
  --build-service-account="projects/$PROJECT_ID/serviceAccounts/$BUILD_SERVICE_ACCOUNT@$PROJECT_ID.iam.gserviceaccount.com" \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=8 \
  --cpu-throttling \
  --set-env-vars="PUBLIC_BASE_URL=$BOOTSTRAP_BASE_URL,GOOGLE_REDIRECT_URI=$BOOTSTRAP_BASE_URL/oauth/google/callback,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID,WORK_GMAIL_ACCOUNT=$WORK_ACCOUNT,CALENDAR_IDS=primary,TIME_ZONE=America/Vancouver,WORKDAY_START=9,WORKDAY_END=17,OPENAI_MODEL=gpt-5-mini,GOOGLE_TOKEN_SECRET=work-assistant-google-token" \
  --set-secrets="GOOGLE_CLIENT_SECRET=work-assistant-google-client-secret:latest,OPENAI_API_KEY=work-assistant-openai-api-key:latest,SERVICE_API_TOKEN=work-assistant-service-api-token:latest,JOB_SECRET=work-assistant-job-secret:latest"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)')"
gcloud run services update "$SERVICE_NAME" --region="$REGION" --update-env-vars="PUBLIC_BASE_URL=$SERVICE_URL,GOOGLE_REDIRECT_URI=$SERVICE_URL/oauth/google/callback"

gcloud scheduler jobs describe work-activation-weekdays --location="$REGION" >/dev/null 2>&1 && \
  gcloud scheduler jobs update http work-activation-weekdays --location="$REGION" --schedule="0 8 * * 1-5" --time-zone="America/Vancouver" --uri="$SERVICE_URL/jobs/daily" --http-method=POST --update-headers="x-job-secret=$JOB_SECRET" >/dev/null || \
  gcloud scheduler jobs create http work-activation-weekdays --location="$REGION" --schedule="0 8 * * 1-5" --time-zone="America/Vancouver" --uri="$SERVICE_URL/jobs/daily" --http-method=POST --headers="x-job-secret=$JOB_SECRET" >/dev/null

printf '\nDeployment complete.\nService URL: %s\nOAuth redirect URI: %s/oauth/google/callback\n' "$SERVICE_URL" "$SERVICE_URL"
printf 'The NotePlan API token remains in Secret Manager and is not printed.\n'
