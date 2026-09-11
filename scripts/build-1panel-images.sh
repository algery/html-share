#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ENV_FILE="${1:-${ROOT_DIR}/1panel-build.local}"
OUTPUT_ROOT="${2:-${ROOT_DIR}/release}"

if [[ ! -f "${BUILD_ENV_FILE}" ]]; then
  echo "Missing build environment file: ${BUILD_ENV_FILE}" >&2
  echo "Copy deploy/1panel-build.env.example to 1panel-build.local and fill it first." >&2
  exit 1
fi

read_build_value() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}=//p" "${BUILD_ENV_FILE}" | tail -n 1 | tr -d '\r')"
  if [[ -z "${value}" ]]; then
    echo "Missing ${key} in ${BUILD_ENV_FILE}" >&2
    exit 1
  fi
  printf '%s' "${value}"
}

IMAGE_TAG="$(read_build_value HTML_SHARE_IMAGE_TAG)"
TARGET_PLATFORM="$(read_build_value HTML_SHARE_PLATFORM)"
DATABASE_HOST="$(read_build_value HTML_SHARE_DATABASE_HOST)"
NEXT_PUBLIC_APP_URL="$(read_build_value NEXT_PUBLIC_APP_URL)"
NEXT_PUBLIC_DEMO_URL="$(read_build_value NEXT_PUBLIC_DEMO_URL)"
NEXT_PUBLIC_API_URL="$(read_build_value NEXT_PUBLIC_API_URL)"
NEXT_PUBLIC_DINGTALK_CLIENT_ID="$(read_build_value NEXT_PUBLIC_DINGTALK_CLIENT_ID)"
NEXT_PUBLIC_DINGTALK_CORP_ID="$(read_build_value NEXT_PUBLIC_DINGTALK_CORP_ID)"

validate_public_url() {
  local key="$1"
  local value="$2"
  if [[ ! "${value}" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]*)(:[0-9]+)?/?$ ]]; then
    echo "Invalid ${key}: ${value}" >&2
    echo "Use a production origin such as https://app.example.com with no spaces." >&2
    exit 1
  fi
}

validate_public_url NEXT_PUBLIC_APP_URL "${NEXT_PUBLIC_APP_URL}"
validate_public_url NEXT_PUBLIC_DEMO_URL "${NEXT_PUBLIC_DEMO_URL}"
validate_public_url NEXT_PUBLIC_API_URL "${NEXT_PUBLIC_API_URL}"

NORMALIZED_APP_URL="${NEXT_PUBLIC_APP_URL%/}"
NORMALIZED_DEMO_URL="${NEXT_PUBLIC_DEMO_URL%/}"
NORMALIZED_API_URL="${NEXT_PUBLIC_API_URL%/}"
if [[ "${NORMALIZED_APP_URL}" != "${NORMALIZED_API_URL}" ]]; then
  echo "NEXT_PUBLIC_API_URL must equal NEXT_PUBLIC_APP_URL in the two-domain deployment." >&2
  exit 1
fi
if [[ "${NORMALIZED_APP_URL}" == "${NORMALIZED_DEMO_URL}" ]]; then
  echo "NEXT_PUBLIC_DEMO_URL must use the separate content domain." >&2
  exit 1
fi

case "${TARGET_PLATFORM}" in
  linux/amd64) EXPECTED_ARCH=amd64 ;;
  linux/arm64) EXPECTED_ARCH=arm64 ;;
  *)
    echo "Unsupported HTML_SHARE_PLATFORM: ${TARGET_PLATFORM}" >&2
    echo "Use linux/amd64 or linux/arm64." >&2
    exit 1
    ;;
esac

if [[ ! "${IMAGE_TAG}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Invalid HTML_SHARE_IMAGE_TAG: ${IMAGE_TAG}" >&2
  exit 1
fi
if [[ ! "${DATABASE_HOST}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || [[ "${DATABASE_HOST}" == "localhost" ]] || [[ "${DATABASE_HOST}" == "127.0.0.1" ]]; then
  echo "Invalid HTML_SHARE_DATABASE_HOST: ${DATABASE_HOST}" >&2
  echo "Use the PostgreSQL container name resolvable on the external Docker network." >&2
  exit 1
fi

command -v docker >/dev/null || {
  echo "Docker is required." >&2
  exit 1
}
docker info >/dev/null
docker buildx inspect --bootstrap >/dev/null

SERVER_IMAGE="html-share-server:${IMAGE_TAG}"
WORKER_IMAGE="html-share-worker:${IMAGE_TAG}"
WEB_IMAGE="html-share-web:${IMAGE_TAG}"
NODE_BASE_IMAGE="${HTML_SHARE_NODE_BASE_IMAGE:-node:24-alpine}"

echo "Building ${SERVER_IMAGE} for ${TARGET_PLATFORM}"
docker buildx build \
  --platform "${TARGET_PLATFORM}" \
  --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}" \
  --target server \
  --tag "${SERVER_IMAGE}" \
  --load \
  "${ROOT_DIR}"

echo "Building ${WORKER_IMAGE} for ${TARGET_PLATFORM}"
docker buildx build \
  --platform "${TARGET_PLATFORM}" \
  --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}" \
  --target worker \
  --tag "${WORKER_IMAGE}" \
  --load \
  "${ROOT_DIR}"

echo "Building ${WEB_IMAGE} for ${TARGET_PLATFORM}"
docker buildx build \
  --platform "${TARGET_PLATFORM}" \
  --build-arg "NODE_BASE_IMAGE=${NODE_BASE_IMAGE}" \
  --target web \
  --tag "${WEB_IMAGE}" \
  --build-arg "NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}" \
  --build-arg "NEXT_PUBLIC_DEMO_URL=${NEXT_PUBLIC_DEMO_URL}" \
  --build-arg "NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}" \
  --build-arg "NEXT_PUBLIC_DINGTALK_CLIENT_ID=${NEXT_PUBLIC_DINGTALK_CLIENT_ID}" \
  --build-arg "NEXT_PUBLIC_DINGTALK_CORP_ID=${NEXT_PUBLIC_DINGTALK_CORP_ID}" \
  --load \
  "${ROOT_DIR}"

IMAGES=("${SERVER_IMAGE}" "${WORKER_IMAGE}" "${WEB_IMAGE}")
for image in "${IMAGES[@]}"; do
  actual_arch="$(docker image inspect --format '{{.Architecture}}' "${image}")"
  if [[ "${actual_arch}" != "${EXPECTED_ARCH}" ]]; then
    echo "Architecture mismatch for ${image}: expected ${EXPECTED_ARCH}, got ${actual_arch}" >&2
    exit 1
  fi

  docker run --rm --platform "${TARGET_PLATFORM}" --entrypoint sh "${image}" -c \
    'if [ -d /workspace ]; then scan_root=/workspace; elif [ -d /app ]; then scan_root=/app; else exit 1; fi; test -z "$(find "$scan_root" -path "*/node_modules" -prune -o -type f \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" -o -name "*.p12" -o -name "*.pfx" -o -name "credentials*" \) ! -name ".env.example" -print -quit)" && for path in "$scan_root"/apps/server/dist "$scan_root"/apps/worker/dist "$scan_root"/apps/web/server.js "$scan_root"/apps/web/.next "$scan_root"/apps/web/public "$scan_root"/packages/*/dist "$scan_root"/packages/db/src/generated; do if [ -e "$path" ] && grep -R -l -m1 "/Users/\|sk-ant-\|sk-proj-\|ANTHROPIC_API_KEY\|OPENAI_API_KEY\|BEGIN.*PRIVATE KEY" "$path" >/dev/null 2>&1; then exit 1; fi; done'
done

PACKAGE_NAME="html-share-${IMAGE_TAG}-${EXPECTED_ARCH}"
PACKAGE_DIR="${OUTPUT_ROOT}/${PACKAGE_NAME}"
if [[ -e "${PACKAGE_DIR}" ]]; then
  echo "Output already exists: ${PACKAGE_DIR}" >&2
  exit 1
fi

mkdir -p "${OUTPUT_ROOT}"
STAGE_DIR="$(mktemp -d "${OUTPUT_ROOT}/.${PACKAGE_NAME}.XXXXXX")"
cleanup() {
  if [[ -n "${STAGE_DIR:-}" && -d "${STAGE_DIR}" ]]; then
    rm -rf -- "${STAGE_DIR}"
  fi
}
trap cleanup EXIT

cp "${ROOT_DIR}/compose.1panel.yaml" "${STAGE_DIR}/compose.yaml"
sed \
  -e "s/^HTML_SHARE_IMAGE_TAG=.*/HTML_SHARE_IMAGE_TAG=${IMAGE_TAG}/" \
  -e "s|^HTML_SHARE_PLATFORM=.*|HTML_SHARE_PLATFORM=${TARGET_PLATFORM}|" \
  -e "s|@1Panel-postgresql-vHO6:|@${DATABASE_HOST}:|" \
  -e "s|^APP_HOST=.*|APP_HOST=${NORMALIZED_APP_URL#https://}|" \
  -e "s|^DEMO_HOST=.*|DEMO_HOST=${NORMALIZED_DEMO_URL#https://}|" \
  -e "s|^APP_AUTH_URL=.*|APP_AUTH_URL=${NORMALIZED_APP_URL}|" \
  -e "s|^APP_WEB_URL=.*|APP_WEB_URL=${NORMALIZED_APP_URL}|" \
  -e "s|^DEMO_AUTH_URL=.*|DEMO_AUTH_URL=${NORMALIZED_DEMO_URL}|" \
  -e "s|^DEMO_WEB_URL=.*|DEMO_WEB_URL=${NORMALIZED_DEMO_URL}|" \
  -e "s|^NEXT_PUBLIC_APP_URL=.*|NEXT_PUBLIC_APP_URL=${NORMALIZED_APP_URL}|" \
  -e "s|^NEXT_PUBLIC_DEMO_URL=.*|NEXT_PUBLIC_DEMO_URL=${NORMALIZED_DEMO_URL}|" \
  -e "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=${NORMALIZED_API_URL}|" \
  -e "s|^DINGTALK_CLIENT_ID=.*|DINGTALK_CLIENT_ID=${NEXT_PUBLIC_DINGTALK_CLIENT_ID}|" \
  -e "s|^DINGTALK_CORP_ID=.*|DINGTALK_CORP_ID=${NEXT_PUBLIC_DINGTALK_CORP_ID}|" \
  -e "s|^NEXT_PUBLIC_DINGTALK_CLIENT_ID=.*|NEXT_PUBLIC_DINGTALK_CLIENT_ID=${NEXT_PUBLIC_DINGTALK_CLIENT_ID}|" \
  -e "s|^NEXT_PUBLIC_DINGTALK_CORP_ID=.*|NEXT_PUBLIC_DINGTALK_CORP_ID=${NEXT_PUBLIC_DINGTALK_CORP_ID}|" \
  "${ROOT_DIR}/deploy/1panel.env.example" >"${STAGE_DIR}/production.env.example"
cp "${ROOT_DIR}/deploy/1panel/app.locations.conf" "${STAGE_DIR}/app.locations.conf"
cp "${ROOT_DIR}/deploy/1panel/demo.locations.conf" "${STAGE_DIR}/demo.locations.conf"

docker save "${IMAGES[@]}" | gzip -6 >"${STAGE_DIR}/images.tar.gz"
if command -v sha256sum >/dev/null; then
  (cd "${STAGE_DIR}" && sha256sum images.tar.gz >SHA256SUMS)
else
  (cd "${STAGE_DIR}" && shasum -a 256 images.tar.gz >SHA256SUMS)
fi

{
  echo "platform=${TARGET_PLATFORM}"
  echo "database_host=${DATABASE_HOST}"
  for image in "${IMAGES[@]}"; do
    docker image inspect --format 'image={{index .RepoTags 0}} id={{.Id}} os={{.Os}} arch={{.Architecture}}' "${image}"
  done
} >"${STAGE_DIR}/manifest.txt"

mv "${STAGE_DIR}" "${PACKAGE_DIR}"
STAGE_DIR=""
trap - EXIT

echo "Package ready: ${PACKAGE_DIR}"
echo "Upload this directory to the 1Panel server; it contains no production secrets."
