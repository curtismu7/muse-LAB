#!/usr/bin/env bash
# Deploy the MOCK-ONLY build to the SE cluster. The first deploy is OWNER-APPROVED: this script refuses to run unless
# OWNER_APPROVED=1 is set by the owner. It never builds or pushes an image; it applies manifests for an image already in the registry.
#
#   OWNER_APPROVED=1 NAMESPACE=<ns> IMAGE=<registry>/<repo>/muse:<sha> SE_HOST=<host> [APP_NAME=muse] [MODE=mock] k8s/deploy.sh [--dry-run]
#
# MODE=mock (default) is the mock-only build: live mode is refused even if a Secret <APP_NAME>-real exists.
# MODE=live is the owner's real build and needs the Secret (ALLOW_LIVE=1 and the tenant settings). APP_NAME names every object.
#
# --dry-run renders and prints the manifests, applies nothing, and fails if any __TOKEN__ is left unreplaced.
# It needs neither OWNER_APPROVED nor a cluster. NAMESPACE has no default (the owner decides).
#
# After a deploy (not done by this script): verify by CONTENT, not 200. GET /api/health must say demo-health/1, and the
# served page must contain the hosted banner. Check the registry manifest and the pod's imageID match IMAGE, then hand over the https:// URL.
set -euo pipefail
cd "$(dirname "$0")"

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
need() { [ -n "${!1:-}" ] || { echo "refusing: set $1 (see the usage line)" >&2; exit 2; }; }
need IMAGE; need SE_HOST
APP_NAME="${APP_NAME:-muse}"; MODE="${MODE:-mock}"
case "$APP_NAME" in *[!a-z0-9-]*|"") echo "refusing: APP_NAME must be a plain name" >&2; exit 2;; esac
case "$MODE" in mock|live) ;; *) echo "refusing: MODE must be mock or live" >&2; exit 2;; esac
case "$IMAGE" in
  *:latest|*:HEAD|*:|*[!A-Za-z0-9._:/@-]*|"") echo "refusing: IMAGE must carry an explicit immutable tag or digest, not latest/HEAD" >&2; exit 2;;
  *:*) ;;
  *) echo "refusing: IMAGE has no tag" >&2; exit 2;;
esac
case "$SE_HOST" in *[!a-z0-9.-]*|"") echo "refusing: SE_HOST must be a plain host name" >&2; exit 2;; esac
if [ "$DRY" = 0 ]; then
  [ "${OWNER_APPROVED:-}" = "1" ] || { echo "refusing: the first SE deploy is owner-approved (set OWNER_APPROVED=1)" >&2; exit 2; }
  need NAMESPACE
  case "$NAMESPACE" in *[!a-z0-9-]*|"") echo "refusing: NAMESPACE must be a plain name" >&2; exit 2;; esac
fi

render() {
  local out; out="$(sed -e "s|__IMAGE__|$IMAGE|g" -e "s|__SE_HOST__|$SE_HOST|g" -e "s|__NAME__|$APP_NAME|g" -e "s|__MODE__|$MODE|g" "$1")"
  if left="$(printf '%s\n' "$out" | grep -oE '__[A-Z0-9_]+__' | sort -u)" && [ -n "$left" ]; then
    echo "refusing: unreplaced placeholder(s) in $1: $(echo $left)" >&2; exit 3
  fi
  printf '%s\n---\n' "$out"
}
FILES="clients-pvc.yaml deployment.yaml service.yaml certificate.yaml ingress.yaml"
if [ "$DRY" = 1 ]; then for f in $FILES; do render "$f"; done; exit 0; fi
for f in $FILES; do render "$f" | kubectl -n "$NAMESPACE" apply -f -; done
kubectl -n "$NAMESPACE" rollout status deployment/"$APP_NAME" --timeout=120s
kubectl -n "$NAMESPACE" wait certificate/"$APP_NAME" --for=condition=Ready --timeout=600s || echo "certificate not Ready yet: check 'kubectl describe certificate $APP_NAME'" >&2
