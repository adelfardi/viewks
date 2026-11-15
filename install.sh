#!/usr/bin/env sh
# Installe le binaire viewks depuis les GitHub Releases (Linux / macOS).
# Aucun droit root : installation dans le dossier de l'utilisateur, jamais de sudo.
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/viewks/main/install.sh | VIEWKS_REPO=<owner>/viewks sh
#
# Variables : VIEWKS_REPO (owner/repo, requis), VIEWKS_VERSION (défaut : dernière release),
#             VIEWKS_INSTALL_DIR (défaut : ~/.local/bin), GH_TOKEN (dépôt privé),
#             VIEWKS_DOWNLOAD_URL (miroir des assets : <url>/<version>/<fichier>).
# Dépôt privé avec la CLI gh : gh release download -R <owner>/viewks -p '*linux_amd64*'
set -eu

REPO="${VIEWKS_REPO:?VIEWKS_REPO=owner/repo requis}"
DIR="${VIEWKS_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${VIEWKS_VERSION:-}"
BASE="${VIEWKS_DOWNLOAD_URL:-https://github.com/$REPO/releases/download}"

# viewks s'exécute avec les droits AWS/kube de l'utilisateur : l'installer en root
# (ou via sudo) le mettrait dans le HOME de root avec ses réglages. On refuse.
if [ "$(id -u)" -eq 0 ] && [ "${VIEWKS_ALLOW_ROOT:-}" != 1 ]; then
  echo "Ne lance pas ce script en root / avec sudo : il s'installe dans ton dossier (~/.local/bin)." >&2
  echo "(forcer quand même : VIEWKS_ALLOW_ROOT=1)" >&2
  exit 1
fi
if ! mkdir -p "$DIR" 2>/dev/null || [ ! -w "$DIR" ]; then
  echo "$DIR n'est pas accessible en écriture. Choisis un dossier à toi : VIEWKS_INSTALL_DIR=\$HOME/bin" >&2
  exit 1
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in linux|darwin) ;; *) echo "OS non supporté : $os (Windows : télécharger le .zip de la release)" >&2; exit 1 ;; esac
arch="$(uname -m)"
case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "arch non supportée : $arch" >&2; exit 1 ;; esac

auth=""
[ -n "${GH_TOKEN:-}" ] && auth="Authorization: Bearer $GH_TOKEN"
api() { curl -fsSL ${auth:+-H "$auth"} -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$REPO/$1"; }

if [ -z "$VERSION" ]; then
  VERSION="$(api releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$VERSION" ] || { echo "aucune release trouvée pour $REPO (dépôt privé ? définir GH_TOKEN)" >&2; exit 1; }
fi

name="viewks_${VERSION#v}_${os}_${arch}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

dl() { # asset -> fichier ; public : URL directe, privé : endpoint API des assets (avec GH_TOKEN)
  if [ -z "$auth" ]; then
    curl -fsSL -o "$2" "$BASE/$VERSION/$1"
    return
  fi
  id="$(api "releases/tags/$VERSION" | tr ',' '\n' | grep -B3 "\"name\": *\"$1\"" | sed -n 's/.*"id": *\([0-9]*\).*/\1/p' | tail -1)"
  [ -n "$id" ] || { echo "asset $1 introuvable dans $VERSION" >&2; exit 1; }
  curl -fsSL -H "$auth" -H "Accept: application/octet-stream" -o "$2" "https://api.github.com/repos/$REPO/releases/assets/$id"
}

echo "→ viewks $VERSION ($os/$arch) depuis $REPO"
dl "$name.tar.gz" "$tmp/$name.tar.gz"
dl SHA256SUMS "$tmp/SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then sha="sha256sum"; else sha="shasum -a 256"; fi
(cd "$tmp" && grep " $name.tar.gz\$" SHA256SUMS > sum && $sha -c sum >/dev/null 2>&1) \
  || { echo "checksum invalide : archive corrompue ou altérée, installation annulée" >&2; exit 1; }

tar -C "$tmp" -xzf "$tmp/$name.tar.gz"
cp "$tmp/$name/viewks" "$DIR/viewks.tmp" && chmod 755 "$DIR/viewks.tmp" && mv -f "$DIR/viewks.tmp" "$DIR/viewks"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$DIR/viewks" 2>/dev/null || true
echo "✓ installé : $DIR/viewks"
"$DIR/viewks" -version

case ":$PATH:" in
  *":$DIR:"*) echo "Lance : viewks" ;;
  *)
    case "${SHELL:-}" in
      */zsh)  rc="$HOME/.zshrc" ;;
      */fish) rc="" ;;
      *)      rc="$HOME/.bashrc" ;;
    esac
    echo
    echo "$DIR n'est pas dans ton PATH. Ajoute-le :"
    if [ -n "$rc" ]; then
      echo "  echo 'export PATH=\"$DIR:\$PATH\"' >> $rc && . $rc"
    else
      echo "  fish_add_path $DIR"
    fi
    echo "ou lance directement : $DIR/viewks"
    ;;
esac
