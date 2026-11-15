# viewks — console EKS

Console web locale pour gérer des clusters EKS : connexion AWS SSO, navigation entre contextes et namespaces,
pods, deployments, logs, shell et commandes de base.

Back **Go** (client-go + AWS SDK v2) · Front **React + Vite + TS** · un seul binaire, ou docker compose.

## Installation

### Depuis les releases (recommandé)
Linux / macOS, **sans root** (installe dans `~/.local/bin`, le script refuse `sudo`) :
```bash
curl -fsSL https://raw.githubusercontent.com/adelfardi/viewks/main/install.sh | VIEWKS_REPO=adelfardi/viewks sh
viewks
```
- Version précise : `VIEWKS_VERSION=v0.1.0`. Autre dossier : `VIEWKS_INSTALL_DIR=$HOME/bin`.
- Mettre à jour : relancer la même commande.
- Windows : télécharger `viewks_<version>_windows_amd64.zip` sur la
  [page des releases](https://github.com/adelfardi/viewks/releases), dézipper, lancer `viewks.exe` (pas besoin d'être admin).
- macOS, si l'archive a été téléchargée par le navigateur : `xattr -d com.apple.quarantine ./viewks`.
- Optionnel, prouver que l'archive vient bien de la CI : `gh attestation verify <archive> -R adelfardi/viewks`.

Pré-requis sur la machine : `~/.aws/config` (profils SSO) et `~/.kube/config*`, accès réseau (VPN) aux clusters.
Pas besoin de l'aws CLI, de kubectl ni de Docker.

### Depuis les sources
```bash
make install        # front + back en un binaire → ~/.local/bin/viewks (Go absent : compile via Docker)
```

### Avec Docker
```bash
docker compose up -d --build      # build local → http://localhost:8088  (VIEWKS_PORT=xxxx pour changer)
GHCR_OWNER=adelfardi docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d   # images publiées
docker compose down               # arrêter
```

## Utilisation
```bash
viewks                                     # ouvre http://127.0.0.1:8088
viewks -addr 127.0.0.1:9000 -open=false -v # autre port, sans navigateur, logs des requêtes
viewks -version
```
Le binaire utilise directement le réseau de la machine (DNS et routes VPN, comme kubectl).
Réglages : `~/.viewks/settings.json`. Garder l'écoute sur `127.0.0.1` : l'outil agit avec tes droits AWS et kube.

## Fonctionnement
- **AWS** : lit `~/.aws/config` + `credentials`. « Se connecter » = flux SSO device-code : un onglet s'ouvre sur la page AWS,
  tu valides, le token est écrit dans `~/.aws/sso/cache` (même format que l'aws CLI : session partagée, refresh auto).
- **Kube** : fusionne tous les `~/.kube/config*` (sauf `*.old`, `*.bak`), contexte initial = `~/.kube/kubectx`.
  Les contextes EKS (`aws eks get-token` / `aws-iam-authenticator`) sont authentifiés en natif par le back
  (pas besoin de l'aws CLI), avec le `AWS_PROFILE` du kubeconfig, `--role-arn` supporté.
  « Forcer ce profil » applique le profil choisi à tous les clusters.
- Contexte prod (`prd|prod` dans le nom/cluster/profil) : bandeau rouge + saisie du nom pour les actions destructives.
- **Lecture seule** : bloque delete / edit / scale / restart / shell côté back.

## Fonctions
Overview (nodes, CPU/mém via metrics-server ou requests, pods en erreur, deployments dégradés, warnings) ·
listes façon `kubectl get` (server-side printing, `wide`, tri, filtre texte ou `label=valeur`) pour toutes les ressources, CRDs incluses ·
détail (infos, YAML éditable, events) · logs en streaming (follow/previous/grep/download) · shell dans les pods (xterm) ·
scale · rollout restart · delete · cordon/uncordon · trigger/suspend de CronJob · thèmes clair/sombre.

## Développement
```bash
cd backend && LISTEN_ADDR=127.0.0.1:8081 go run . -open=false   # Go >= 1.26
cd frontend && npm i && npm run dev                              # http://localhost:5173 (proxy /api -> :8081)
make dist                                                        # archives toutes plateformes dans dist/ (comme la CI)
```

## Publier une version

Les versions suivent le [semver](https://semver.org/lang/fr/) : `vMAJEUR.MINEUR.CORRECTIF`
(correctif = bug, mineur = fonctionnalité, majeur = changement incompatible).

1. **Vérifier que `main` est au vert** : la CI doit passer sur le dernier commit.
   ```bash
   git switch main && git pull
   gh run list --workflow ci.yml --branch main --limit 1     # doit afficher « success »
   ```
2. **Choisir le numéro** à partir de la dernière version :
   ```bash
   git describe --tags --abbrev=0          # ex. v0.1.0 → prochaine : v0.1.1, v0.2.0 ou v1.0.0
   ```
3. **Créer et pousser le tag** (annoté, avec un message) :
   ```bash
   git tag -a v0.2.0 -m "viewks v0.2.0"
   git push origin v0.2.0
   ```
4. **Suivre la publication** (≈ 5 min) :
   ```bash
   gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')
   ```
5. **Vérifier** la release et tester l'installation :
   ```bash
   gh release view v0.2.0
   curl -fsSL https://raw.githubusercontent.com/adelfardi/viewks/main/install.sh | VIEWKS_REPO=adelfardi/viewks sh
   viewks -version                          # doit afficher v0.2.0
   ```

Ce que produit un tag :
- **GitHub Release** (`release.yml`) : `viewks_<version>_<os>_<arch>` pour linux / darwin / windows × amd64 / arm64
  (`.tar.gz`, `.zip` pour Windows), `SHA256SUMS`, attestation de provenance, notes générées depuis les commits.
- **Images Docker** (`ci.yml`) : `ghcr.io/adelfardi/viewks-{backend,frontend}:0.2.0` et `:0.2`, signées.

Cas particuliers :
- **Pré-release** : un tag avec suffixe (`v0.2.0-rc1`) est publié comme pré-release ; `install.sh` sans `VIEWKS_VERSION` l'ignore.
- **Republier** un tag existant (après un échec de la CI par exemple) : *Actions → Release → Run workflow*, saisir le tag ;
  ou `gh workflow run release.yml -f tag=v0.2.0`.
- **Annuler** une version publiée par erreur :
  ```bash
  gh release delete v0.2.0 --yes --cleanup-tag     # supprime la release et le tag distant
  git tag -d v0.2.0                                # supprime le tag local
  ```
  Préférer publier un correctif (`v0.2.1`) si quelqu'un a pu installer la version.

## CI/CD (GitHub Actions)

`ci.yml`, à chaque push et PR :

| Job | Contenu |
|---|---|
| `backend` | `go vet`, build, **govulncheck** |
| `frontend` | typecheck + build, **npm audit** (deps embarquées, ≥ high) |
| `codeql` | **CodeQL** `security-extended` sur Go et TypeScript |
| `trivy-repo` | **Trivy fs** : dépendances, secrets, Dockerfiles → onglet *Security* ; bloque sur CRITICAL/HIGH corrigeables, secrets, misconfig HIGH |
| `images` | build → **scan Trivy de l'image** (bloquant avant push) → push **ghcr.io** + SBOM + provenance SLSA → signature **cosign** keyless |

Déclencheurs : push `main` (images `main`, `latest`, `sha-xxxxxxx`), tag `v1.2.3` (images `1.2.3`, `1.2`),
PR (build + scans, sans push), lancement manuel, re-scan hebdo le lundi (sans push).
Résultats des scans : *Security → Code scanning*. Actions épinglées par SHA, mises à jour par Dependabot
(`.github/dependabot.yml`, avec Go, npm, Docker).

Vérifier la signature d'une image :
```bash
cosign verify ghcr.io/adelfardi/viewks-backend:latest \
  --certificate-identity-regexp 'https://github.com/adelfardi/viewks/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
