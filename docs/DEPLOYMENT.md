# Déploiement reproductible du serveur de collaboration

Ce dossier fournit un déploiement à **un seul processus écrivain**, avec TLS
automatique, volume persistant, stockage privé des médias et sauvegarde
vérifiée. Le projet Firebase ChoreScore existe (ID public
`chorescore-a75b1`), mais son fournisseur Google, son application Android, ses
empreintes et son client OAuth ne sont pas encore validés. Sans fournisseur
Google activé et sans nom de domaine, le serveur ne peut pas authentifier
d'utilisateur ni être exposé en HTTPS public. Le code client
(`RemoteSyncAdapter`, `HttpMediaGateway`) est raccordé à cette URL quand elle
est fournie ; cela ne remplace pas un déploiement réel.

Le projet Firebase **ne déploie pas** ce serveur : il ne faut pas s'attendre à
ce que `chorescore-a75b1` fasse tourner le processus HTTP/SQLite. Le serveur
doit être hébergé séparément, puis son URL publique doit être injectée dans
`EXPO_PUBLIC_COLLAB_URL` au build Android.

Ce déploiement est désormais **optionnel** pour une collaboration gratuite :
sans `EXPO_PUBLIC_COLLAB_URL`, l'application utilise Firestore Spark
directement (`FirebaseSyncTransport`, règles du dossier `firebase/`). Le
serveur reste l'autorité de référence et le seul chemin qui valide les ledgers
côté serveur, sauvegarde la base et stocke les photos hors Firestore.

## Prérequis externes réels

- Le projet Firebase gratuit `chorescore-a75b1` avec le fournisseur Google
  activé et l'application Android `app.chorescore.v5` enregistrée avec
  l'empreinte de la clé de signature réellement utilisée (voir
  `FIREBASE_SETUP.md`). L'identifiant du projet est public et déjà proposé par
  défaut dans `deploy/.env.example`.
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

Une fois `https://$COLLAB_DOMAIN/health` vérifié, transmettre cette URL de base
au build Android via `EXPO_PUBLIC_COLLAB_URL` et reconstruire l'APK. Cette URL
est prioritaire sur Firestore. Sans elle mais avec une session Google et les
règles Firestore déployées, l'application utilise Firestore Spark ; sans aucun
des deux, elle reste locale.

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

- Le projet Firebase existe, mais la configuration des fournisseurs, des
  empreintes Android et du client OAuth Web n'est pas validée ici.
- Aucun domaine ni serveur public n'est fourni par ce dépôt ; la configuration
  décrite n'a pas été déployée depuis ce runner.
- `RemoteSyncAdapter`, les médias privés, la compensation autoritaire et la
  sauvegarde ont du code et des tests HTTP locaux ; ils ne prouvent ni une mise
  en ligne réelle ni deux téléphones authentifiés.
- Les migrations de schéma ne sont pas automatisées ; le schéma actuel est créé
  idempotemment au démarrage et ne doit pas être modifié sans migration testée.
- La limitation de débit et la révocation globale de session restent à traiter
  côté hébergement/identité.
