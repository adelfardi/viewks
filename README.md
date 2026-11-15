# viewks — console EKS

Front **React + Vite + TS** (nginx) · Back **Go** (client-go + AWS SDK v2) · docker compose.

### En ligne de commande (sans Docker) — recommandé
```bash
make install        # compile front + back en un binaire → ~/.local/bin/viewks (Go absent : compile via Docker)
viewks              # ouvre http://127.0.0.1:8088 dans le navigateur
viewks -addr 127.0.0.1:9000 -open=false -v
```
Le binaire utilise directement le réseau de la machine (DNS/routes VPN, comme kubectl).
Réglages : `~/.viewks/settings.json`.

### Avec Docker
```bash
docker compose up -d --build      # http://localhost:8088  (VIEWKS_PORT=xxxx pour changer)
```

## Fonctionnement
- **AWS** : lit `~/.aws/config` + `credentials`. « Se connecter » = flux SSO device-code : un onglet s'ouvre sur la page AWS,
  tu valides, le token est écrit dans `~/.aws/sso/cache` (même format que l'aws CLI : session partagée, refresh auto).
- **Kube** : fusionne tous les `~/.kube/config*` (sauf `*.old`, `*.bak`), contexte initial = `~/.kube/kubectx`.
  Les contextes EKS (`aws eks get-token` / `aws-iam-authenticator`) sont authentifiés en natif par le back
  (pas besoin de l'aws CLI dans le conteneur), avec le `AWS_PROFILE` du kubeconfig, `--role-arn` supporté.
  « Forcer ce profil » applique le profil choisi à tous les clusters.
- Contexte prod (`prd|prod` dans le nom/cluster/profil) : bandeau rouge + saisie du nom pour les actions destructives.
- **Lecture seule** : bloque delete / edit / scale / restart / shell côté back.

## Fonctions
Overview (nodes, CPU/mém via metrics-server ou requests, pods en erreur, deployments dégradés, warnings) ·
listes façon `kubectl get` (server-side printing, `wide`, tri, filtre texte ou `label=valeur`) pour toutes les ressources, CRDs incluses ·
détail (infos, YAML éditable, events) · logs en streaming (follow/previous/grep/download) · shell dans les pods (xterm) ·
scale · rollout restart · delete · cordon/uncordon · trigger/suspend de CronJob.

## Dev
```bash
cd backend && LISTEN_ADDR=:8081 go run .      # Go >= 1.26
cd frontend && npm i && npm run dev            # http://localhost:5173 (proxy /api -> :8081)
```
Les endpoints privés EKS doivent être joignables depuis l'hôte (VPN).

## CI/CD (GitHub Actions) — `.github/workflows/ci.yml`

| Job | Contenu |
|---|---|
| `backend` | `go vet`, build, **govulncheck** |
| `frontend` | typecheck + build, **npm audit** (deps embarquées, ≥ high) |
| `codeql` | **CodeQL** `security-extended` sur Go et TypeScript |
| `trivy-repo` | **Trivy fs** : dépendances, secrets, Dockerfiles → onglet *Security* ; bloque sur CRITICAL/HIGH corrigeables, secrets, misconfig HIGH |
| `images` | build → **scan Trivy de l'image** (bloquant avant push) → push **ghcr.io** + SBOM + provenance SLSA → signature **cosign** keyless |

Déclencheurs : push `main` (tags `main`, `latest`, `sha-xxxxxxx`), tag `v1.2.3` (tags `1.2.3`, `1.2`),
PR (build + scans, sans push), lancement manuel, re-scan hebdo le lundi (sans push).
Actions épinglées par SHA, mises à jour par Dependabot (`.github/dependabot.yml`, avec Go, npm, Docker).

Pré-requis côté GitHub : rien à créer, le `GITHUB_TOKEN` suffit pour ghcr.io. Les résultats CodeQL/Trivy
apparaissent dans *Security → Code scanning* (gratuit sur dépôt public ; dépôt privé : GitHub Advanced Security requis).

Utiliser les images publiées :
```bash
GHCR_OWNER=<user> docker compose -f docker-compose.yml -f docker-compose.ghcr.yml up -d
cosign verify ghcr.io/<user>/viewks-backend:latest \
  --certificate-identity-regexp 'https://github.com/<user>/.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Releases (binaires pour lancer viewks ailleurs) — `.github/workflows/release.yml`

```bash
git tag v1.0.0 && git push origin v1.0.0
```
→ la CI publie une **GitHub Release** avec `viewks_<version>_<os>_<arch>` pour linux / darwin / windows × amd64 / arm64
(`.tar.gz`, `.zip` pour Windows), `SHA256SUMS` et une attestation de provenance. Tag `v1.0.0-rc1` → pré-release.
Relancer la publication d'un tag existant : *Actions → Release → Run workflow*.

Installer sur une autre machine (Linux / macOS) :
```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/viewks/main/install.sh | VIEWKS_REPO=<owner>/viewks sh
# dépôt privé : ajouter GH_TOKEN=<token avec accès au repo>, ou : gh release download v1.0.0 -R <owner>/viewks -p '*linux_amd64*'
gh attestation verify viewks_1.0.0_linux_amd64.tar.gz -R <owner>/viewks   # optionnel : prouver que l'archive vient de la CI
```
Windows : télécharger le `.zip` de la release, lancer `viewks.exe`.
macOS, si l'archive vient du navigateur : `xattr -d com.apple.quarantine ./viewks`.

Aucun droit root : installation dans `~/.local/bin` (ou `VIEWKS_INSTALL_DIR`), le script refuse sudo.
Pré-requis sur la machine cible : `~/.aws/config` (profils SSO) et `~/.kube/config*`, accès réseau (VPN) aux clusters.
Pas besoin de l'aws CLI ni de kubectl. Construire localement les mêmes archives : `make dist`.
