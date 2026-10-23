# Déploiement reproductible du serveur de collaboration

Ce dossier fournit un déploiement à **un seul processus écrivain**, avec TLS
automatique, volume persistant et sauvegarde vérifiée. Il ne crée aucun compte
cloud : sans projet Firebase réel et sans nom de domaine, le serveur ne peut
pas authentifier d'utilisateur ni être exposé en HTTPS public.

## Prérequis externes réels

- Un projet Firebase gratuit avec le fournisseur Google activé et l'application
  Android `app.chorescore.v5` enregistrée avec l'empreinte de la clé de
  signature réellement utilisée (voir `FIREBASE_SETUP.md`).
- Un serveur Linux avec Docker et Docker Compose, et un nom DNS qui pointe vers
  lui (ports 80 et 443 joignables). Caddy obtient le certificat TLS.
- Un volume disque pour `data/` et un autre pour `backups/`, sauvegardés hors
  machine.

Sans ces éléments, les tests HTTP locaux restent valables mais aucune
collaboration entre téléphones n'est prouvée.

## Installation

```sh
cd deploy
cp .env.example .env
# Renseigner FIREBASE_PROJECT_ID et COLLAB_DOMAIN, jamais de secret ici.
mkdir -p data backups
sudo chown -R 1000:1000 data backups
docker compose config
docker compose up -d --build
docker compose ps
curl -fsS https://"$COLLAB_DOMAIN"/health
```

`FIREBASE_PROJECT_ID` est un identifiant public. Aucune clé de compte de service
ni token n'est nécessaire : le serveur vérifie les ID tokens Firebase avec les
certificats publics de Google. Le port du serveur n'est pas publié ; seul Caddy
écoute sur 80/443 et termine TLS. `/health` est le seul endpoint non authentifié.

## Sauvegarde et restauration

La sauvegarde utilise `VACUUM INTO` : elle est cohérente pendant que le serveur
écrit (WAL), sans arrêter l'application. Le script vérifie l'intégrité SQLite,
copie les médias privés, écrit un manifeste SHA-256 et refuse d'écraser une
restauration existante sans `--force`.

```sh
# Depuis deploy/
docker compose --profile ops run --rm backup

# Vérifier les fichiers produits
ls -l backups/
```

Restauration (arrêter le serveur d'abord, un seul écrivain) :

```sh
docker compose stop app caddy
node ../scripts/backend/restore.mjs \
  backups/collab-<horodatage>.sqlite \
  data/collab.sqlite \
  backups/collab-<horodatage>.media \
  data/media --force
docker compose up -d
```

Planifier la sauvegarde hors du conteneur, par exemple chaque nuit :

```cron
15 3 * * * cd /srv/chorescore/deploy && docker compose --profile ops run --rm backup >> /var/log/chorescore-backup.log 2>&1
```

Conserver plusieurs générations hors du serveur. Une sauvegarde non restaurée et
testée n'est pas une preuve de reprise.

## Ce que cette configuration ne prouve pas

- Aucun projet Firebase, domaine ou serveur n'est fourni par ce dépôt.
- Aucun test à deux téléphones réels n'a été exécuté.
- Les migrations de schéma ne sont pas automatisées ; le schéma actuel est créé
  idempotemment au démarrage et ne doit pas être modifié sans migration testée.
- La limitation de débit et la révocation globale de session restent à traiter
  côté hébergement/identité.
