#!/usr/bin/env sh
# Compile viewks pour toutes les plateformes et produit les archives + SHA256SUMS dans dist/.
# Pré-requis : front déjà copié dans backend/web (make web). Usage : scripts/dist.sh v1.2.3
set -eu
VERSION="${1:-dev}"
TARGETS="${TARGETS:-linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist"
rm -rf "$OUT" && mkdir -p "$OUT"

[ -f "$ROOT/backend/web/index.html" ] || { echo "backend/web/index.html absent : lance 'make web' d'abord" >&2; exit 1; }

for t in $TARGETS; do
  os="${t%/*}"; arch="${t#*/}"
  name="viewks_${VERSION#v}_${os}_${arch}"
  bin="viewks"; [ "$os" = windows ] && bin="viewks.exe"
  work="$OUT/$name"; mkdir -p "$work"
  echo "→ $os/$arch"
  (cd "$ROOT/backend" && CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -buildvcs=false -trimpath -ldflags="-s -w -X main.version=$VERSION" -o "$work/$bin" .)
  cp "$ROOT/README.md" "$work/"
  if [ "$os" = windows ]; then
    (cd "$OUT" && zip -qr "$name.zip" "$name")
  else
    tar -C "$OUT" -czf "$OUT/$name.tar.gz" "$name"
  fi
  rm -rf "$work"
done

(cd "$OUT" && sha256sum viewks_* > SHA256SUMS)
ls -lh "$OUT"
