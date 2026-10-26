# Firebase / Google — code prêt, configuration à terminer

Le propriétaire a créé le projet Firebase **ChoreScore**, dont l'identifiant
public confirmé est **`chorescore-a75b1`** :
https://console.firebase.google.com/u/0/project/chorescore-a75b1/overview

Cette création ne prouve pas encore l'activation du fournisseur Google, la
configuration Android/OAuth ni une connexion réelle depuis un téléphone. Aucun
secret de compte de service ne doit être ajouté au dépôt.

## Trois niveaux à ne pas confondre

| Niveau | État réel |
| --- | --- |
| Code du dépôt | `FirebaseAuthAdapter` (SDK natif Google + Firebase REST, SecureStore, rafraîchissement), `RemoteSyncAdapter` (jeton réel, outbox durable, push/pull paginé, conflits, tombstones), `HttpMediaGateway` (médias privés), compensation autoritaire et sauvegarde/restauration côté serveur. |
| Configuration | Projet Firebase créé. Fournisseur Google, client OAuth Web/Android, empreinte SHA-1 et clé API publique **non fournis/non validés** dans cet environnement. |
| Preuve réelle | Aucune connexion Google réelle, aucun déploiement HTTPS, aucun essai sur deux téléphones n'a été exécuté ici. Les tests HTTP locaux ne remplacent pas ces preuves. |

## Paramètres publics transmis au build

Le workflow Android transmet les quatre variables de dépôt suivantes (il ne
contient aucun secret et n'est pas modifié par le worker, qui n'a pas la
permission GitHub `workflows`) :

- `EXPO_PUBLIC_FIREBASE_PROJECT_ID` — facultatif : le code utilise déjà
  `chorescore-a75b1` par défaut, cette variable permet de surcharger ;
- `EXPO_PUBLIC_FIREBASE_API_KEY` — clé API **publique** du projet Firebase ;
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` — client OAuth de type **Web** ;
- `EXPO_PUBLIC_COLLAB_URL` — URL HTTPS du serveur de ce dépôt une fois déployé.

Le défaut public `chorescore-a75b1` est aussi présent dans
`deploy/.env.example` pour le serveur. Sans clé API et sans client OAuth Web,
`firebaseAuthConfig()` renvoie `null` et l'application reste locale : elle
n'invente ni identifiant ni session.

Sans les deux valeurs OAuth manquantes, l'application reste en mode local
honnête : elle ne fabrique ni compte Google ni session de collaboration. La clé
API Firebase et le client Web sont publics mais ne sont pas des autorisations
d'accès aux données ; le serveur vérifie cryptographiquement chaque ID token.

## Activation exacte dans la console

1. Ouvrir le projet `chorescore-a75b1`. Ne pas activer de facturation ni de
   service payant.
2. Dans **Authentication**, activer le fournisseur **Google** et renseigner
   l'écran de consentement OAuth.
3. Dans **Paramètres du projet > Vos applications**, enregistrer l'application
   Android `app.chorescore.v5`. Ajouter l'empreinte **SHA-1** de la clé qui
   signe réellement le candidat (et SHA-256 si Play App Signing est utilisé).
   Après téléchargement de l'APK, lancer
   `bash scripts/android/verify-apk-identity.sh release/ChoreScore-V5.apk`
   (avec `ANDROID_HOME` défini) pour obtenir le package, l'unicité du signataire
   et les empreintes SHA-1/SHA-256 à enregistrer. Le script est autonome et
   n'est pas appelé par le workflow actuel. Une empreinte de debug ne doit pas
   être utilisée pour une publication.
4. Dans le fournisseur Google, relever l'**ID client OAuth de type Web** créé
   pour Firebase. L'ID client Android, s'il est créé séparément, doit porter le
   package `app.chorescore.v5` et la même empreinte de signature.
5. Renseigner les variables de dépôt (jamais dans un fichier suivi) :
   - `EXPO_PUBLIC_FIREBASE_API_KEY`
   - `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`
   - `EXPO_PUBLIC_COLLAB_URL` (seulement après un déploiement HTTPS vérifié)
   - facultatif : `EXPO_PUBLIC_FIREBASE_PROJECT_ID` pour surcharger le défaut
   - facultatif : `ANDROID_EXPECTED_SHA1` pour faire échouer le build si la clé
     de signature ne correspond pas à celle déclarée dans Firebase.
6. Reconstruire l'APK. Expo incorpore ces valeurs publiques au bundle ; le
   module Google est autolinké et configuré avec le client Web explicite. Le
   téléphone doit disposer de Google Play Services.

Le projet Firebase ne déploie pas automatiquement le serveur HTTP/SQLite de ce
dépôt. Le serveur et son URL HTTPS sont décrits dans `DEPLOYMENT.md` ; tant
qu'ils ne sont pas réellement en ligne, `EXPO_PUBLIC_COLLAB_URL` doit rester
vide et la synchronisation entre appareils reste indisponible.

## Ce que le code fait déjà

`FirebaseAuthAdapter` utilise le véritable SDK natif Google pour obtenir un ID
token, puis Firebase `accounts:signInWithIdp`. La session est conservée dans
SecureStore. Le rafraîchissement passe par `securetoken.googleapis.com`, est
mutualisé entre appels concurrents et ne peut pas ressusciter une session
déconnectée. Le démarrage hors ligne lit la session locale ; une requête
distante n'est jamais signée avec un token expiré.

`RemoteSyncAdapter` exige un vrai ID token pour chaque requête, conserve un
outbox durable, pousse des lots bornés avec versions de base, applique les
deltas paginés/tombstones et laisse les conflits visibles pour décision.
`HttpMediaGateway` téléverse et relit les photos sous ACL de groupe. Le serveur
valide les compensations à taux snapshoté et fournit sauvegarde/restauration.

Apple et Facebook ne sont pas activés : leurs adapters renvoient explicitement
`null`, sans faux compte social. Aucune donnée d'une identité locale n'est
réattribuée automatiquement à un compte Google.

## Acceptation encore nécessaire (preuves, pas code)

- Connexion Google réelle, fermeture/réouverture, expiration/rafraîchissement,
  déconnexion, deuxième compte et refus d'accès.
- `EXPO_PUBLIC_COLLAB_URL` réellement en HTTPS, invitation ciblée acceptée,
  synchronisation et médias privés entre deux appareils authentifiés.
- Rendu Android observé de l'état de synchronisation et d'un conflit.
- Apple/Facebook si ces fournisseurs doivent être livrés.

Les tests unitaires simulent les réponses réseau : ils vérifient le cycle de
session, pas le fournisseur. Les tests HTTP vérifient isolation, invitations,
deltas, conflits, complétion atomique et collecte des médias sur un serveur
local ; ils ne prouvent ni un déploiement ni deux téléphones.
