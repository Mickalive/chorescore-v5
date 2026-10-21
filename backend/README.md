# Serveur de collaboration — tranche en cours

Ce serveur HTTP est implémenté et testé, mais **n’est ni déployé ni raccordé à l’application mobile**. `LocalSyncAdapter` reste indisponible. Il ne prouve donc pas encore la collaboration entre téléphones.

## Exécution

Node 24, `npm ci`, puis `npm run build:backend`. Définir `FIREBASE_PROJECT_ID` (identifiant public du vrai projet) et `COLLAB_DATABASE` (chemin absolu d’une base sur volume persistant), puis `npm run start:backend`. L’écoute par défaut est `127.0.0.1:8787`. Un hébergement doit fournir HTTPS, volume persistant, sauvegardes et un unique processus écrivain ; ce composant n’est pas adapté à plusieurs instances avec disques éphémères. Aucun hébergement payant n’a été créé.

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

Les membres autorisés peuvent écrire les tâches, dépenses, todos, modèles et catégories de leur groupe. Les ACL, groupes et adhésions ne sont jamais accessibles par les mutations génériques. Tous les membres référencés doivent appartenir au groupe. Les calculs utilisent le domaine commun à l’application. Les soldes ne sont pas des données acceptées du client.

## Vérification exécutée

`npm run test:backend` compile puis lance un vrai serveur HTTP sur un port local, avec une vraie base SQLite sur disque. Le test utilise deux identités signées par une clé RSA de test et une troisième identité non autorisée, via le même vérificateur cryptographique. Il vérifie audience/expiration/signature, isolation, invitation ciblée et réutilisation, révocation/expiration, rejet d’ACL forgées, identité d’audit imposée, idempotence, conflit de version, rollback de lot, complétion simultanée, pagination de 102 événements et redémarrage avec données/accès/accusés conservés.

**Ce test ne constitue pas une connexion réelle à Firebase ou un essai sur deux téléphones.** Le projet Firebase n’existe pas encore et aucun service distant n’est déployé.

## Travail restant avant activation

Raccorder le client avec curseurs/versions/outbox transactionnels et résolution des conflits visible, sans réutiliser la comparaison de révisions locales/distantes du matérialiseur historique. Ajouter le stockage privé des photos (les pièces jointes non vides sont actuellement refusées), les compensations et options de groupe, les opérations de gestion des membres et les protections d’exploitation (limites de débit, sauvegarde/restauration, révocation des sessions). Vérifier le flux complet sur deux appareils authentifiés auprès du vrai projet. Ne pas activer une bannière « synchronisé » avant ces vérifications.
