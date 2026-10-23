# Serveur de collaboration — tranche en cours

Ce serveur HTTP est implémenté et testé, avec stockage privé des médias, sauvegarde/restauration vérifiées et artefacts de déploiement TLS dans `deploy/`. Il **n’est ni déployé** (aucun compte/projet cloud fourni) et n’a pas été exercé entre deux téléphones réels.

## Exécution

Node 24, `npm ci`, puis `npm run build:backend`. Définir `FIREBASE_PROJECT_ID` (identifiant public du vrai projet) et `COLLAB_DATABASE` (chemin absolu d’une base sur volume persistant), puis `npm run start:backend`. L’écoute par défaut est `127.0.0.1:8787`. Un hébergement doit fournir HTTPS, volume persistant, sauvegardes et un unique processus écrivain ; ce composant n’est pas adapté à plusieurs instances avec disques éphémères. Aucun hébergement payant n’a été créé. Voir [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) pour Docker Compose, Caddy et la sauvegarde.

L’authentification exige un ID token Firebase signé RS256, avec audience, émetteur et expiration vérifiés contre les certificats publics de Google. Aucun compte de service ni clé privée n’est nécessaire à cette vérification. La production ne prend pas en charge les tokens non signés des émulateurs. La source de certificat injectable est uniquement utilisée par les tests : le point d’entrée `main.ts` utilise la source Google fixe.

## Contrat HTTP

Tous les endpoints sauf `/health` exigent `Authorization: Bearer <Firebase ID token>`.

- `GET /groups` : groupes accessibles au compte, identité de membre et rôle.
- `POST /groups` : `{id, ownerMemberId, ownerName, name, unit, members:[{id,name}]}`. Identifiants conservés, unité `minutes` ou `points`.
- `GET /groups/:id/deltas?since=0` : événements ordonnés par révision de groupe, pages de 100 événements et `hasMore`. Chaque événement contient les changements complets et versions des entités ; `value:null` est une suppression. Avancer le curseur uniquement après application transactionnelle locale.
- `POST /groups/:id/mutations` : `{operationId, changes:[{collection,id,baseVersion,value}]}`. Lot atomique, idempotent avec le même contenu ; erreur 409 pour version dépassée. Conserver l’édition locale et demander une résolution : ne jamais écraser silencieusement.
- `POST /groups/:id/invites` : propriétaire seulement, `{memberId}` d’un membre nommé non lié. Retourne un jeton aléatoire à partager, valable sept jours ; seule son empreinte est stockée.
- `POST /groups/:id/invites/:token/revoke` : propriétaire seulement.
- `POST /invites/:token/accept` : rattache le compte au membre ciblé sans recréer son identité ni fusionner par nom. Répétable par le même compte ; un autre compte est refusé.
- `POST /groups/:id/todos/:todoId/complete` : paramètres métier de `todoCompletionService`, sans todo/household/identité d’audit fournis par le client. Écriture ledger et complétion dans la même transaction. Une seconde complétion échoue, même depuis un autre compte.

Les membres autorisés peuvent écrire les tâches, dépenses, todos, modèles, catégories, profils de membres et réglages du groupe. Un membre nommé non lié peut être créé ou renommé, mais son `userId` reste serveur : seul le propriétaire modifie les réglages du groupe, et les identités de membre, propriétaire et dates d’adhésion sont préservées. Les ACL, groupes et adhésions ne sont jamais accessibles par les mutations génériques. Tous les membres référencés doivent appartenir au groupe. Les calculs utilisent le domaine commun à l’application. Les soldes ne sont pas des données acceptées du client.

## Vérification exécutée

`npm run test:backend` compile puis lance un vrai serveur HTTP sur un port local, avec une vraie base SQLite sur disque. Le test utilise deux identités signées par une clé RSA de test et une troisième identité non autorisée, via le même vérificateur cryptographique. Il vérifie audience/expiration/signature, isolation, invitation ciblée et réutilisation, révocation/expiration, rejet d’ACL forgées, identité d’audit imposée, idempotence, conflit de version, rollback de lot, complétion simultanée, pagination de 102 événements et redémarrage avec données/accès/accusés conservés.

`npm test -- tests/clientCollaboration.test.ts` raccorde deux jeux de repositories indépendants au vrai serveur HTTP/SQLite via `RemoteSyncAdapter` (le même adaptateur que l’application) : création de groupe, invitation ciblée sans doublon, ajout/renommage de membre gardant le même identifiant, réglages de groupe, soldes identiques au centime/point, pull paginé au-delà de 100 événements, panne réseau avec outbox conservée puis `startSync`, conflit 409 qui préserve l’édition locale et reste visible, résolution par une édition ultérieure, tombstone, redémarrage du serveur et refus d’une identité étrangère. Les repositories clients de ce test sont en mémoire ; la persistance SQLite est couverte séparément par `tests/sqlite.test.ts`.

**Ce test ne constitue pas une connexion réelle à Firebase ou un essai sur deux téléphones.** Le projet Firebase n’existe pas encore et aucun service distant n’est déployé.

## Exploitation

- Sauvegarde cohérente en ligne : `node scripts/backend/backup.mjs <base.sqlite> <destination> [médias]`, puis `node scripts/backend/restore.mjs ... --force` après arrêt du serveur. Le test `backend-tests/backup.test.cjs` crée un groupe et un média privé, sauvegarde, continue d’écrire, restaure et vérifie groupe, intégrité et absence de la photo postérieure.
- Déploiement : `deploy/docker-compose.yml` (serveur non publié, Caddy TLS automatique, volume persistant) et `deploy/Caddyfile`. Aucun secret n’est requis pour vérifier les ID tokens Firebase ; seul `FIREBASE_PROJECT_ID` est nécessaire.
- Médias privés : upload sous ACL de groupe avant référence, vérification de signature, SHA-256, index de références borné, refus des références inter-groupes et collecte des fichiers orphelins après 24 h.

## Travail restant avant activation

Déployer ce serveur avec un vrai domaine et un vrai projet Firebase, puis vérifier le flux complet sur deux appareils authentifiés. L’interface de synchronisation existe mais son rendu Android n’a pas encore été observé. Ajouter la limitation de débit et la révocation de session côté hébergement/identité. Aucune compensation n’est exposée par l’API serveur ; elle devra être ajoutée comme opération atomique auditée avant d’être annoncée collaborativement.
