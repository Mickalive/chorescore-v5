#!/usr/bin/env bash
# Official Google emulator only; no Firebase login, billing or production data.
set -euo pipefail
project_root=$(cd "$(dirname "$0")/../.." && pwd)
image=gcr.io/google.com/cloudsdktool/google-cloud-cli@sha256:c3b114528245d315af73d92d95d8e2fed9747ce29003ad46232f22b4542da036
container_id=''
cleanup() {
  result=$?
  if [ -n "$container_id" ]; then docker rm -f "$container_id" >/dev/null 2>&1 || true; fi
  exit "$result"
}
trap cleanup EXIT
container_id=$(docker create --memory=2g --cpus=2 --label chorescore.test=firestore \
  --publish 127.0.0.1::8080 --entrypoint java "$image" -Xmx1024m \
  -cp /google-cloud-sdk/platform/cloud-firestore-emulator/cloud-firestore-emulator.jar \
  com.google.cloud.datastore.emulator.firestore.CloudFirestore \
  --host 0.0.0.0 --port 8080 --project_id demo-chorescore-audit \
  --rules /tmp/chorescore.rules --single_project_mode --single_project_mode_error)
docker cp "$project_root/firebase/firestore.rules" "$container_id:/tmp/chorescore.rules"
docker start "$container_id" >/dev/null
endpoint=$(docker port "$container_id" 8080/tcp)
[[ "$endpoint" =~ ^127\.0\.0\.1:[0-9]+$ ]]
ready=false
for attempt in $(seq 1 45); do
  if curl --fail --silent --max-time 1 "http://$endpoint/" >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then docker logs "$container_id"; exit 1; fi
export FIRESTORE_EMULATOR_HOST="$endpoint" FIREBASE_PROJECT_ID=demo-chorescore-audit
cd "$project_root"
if [ "$#" -eq 0 ]; then node scripts/firebase/verify-rules.cjs; else "$@"; fi
