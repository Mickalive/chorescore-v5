# Activation Google / Firebase — non activée dans cette branche

Cette branche implémente l'authentification Google. Elle **n'implémente pas encore le backend de collaboration**. Renseigner ces variables ne synchronise pas les groupes ; l'interface conserve l'indication de stockage local et les invitations distantes restent indisponibles.

## Projet et accès

La création doit se faire avec un compte Google légitime dans la console Firebase. Aucun compte Google ni credential Firebase utilisable n'est présent dans l'environnement. Ne pas inventer de projet, de token ou de connexion réussie. Créer un projet gratuit sans activer de facturation ; l'activation de services payants demanderait une décision distincte.

1. Créer un projet Firebase, puis activer le fournisseur **Google** dans Authentication.
2. Enregistrer l'application Android `app.chorescore.v5`. Ajouter l'empreinte SHA-1 de la clé qui signe réellement le candidat. Pour le candidat de développement généré par Expo, consulter `android/app/debug.keystore` avec `keytool` ; ne pas utiliser cette clé pour une publication de production.
3. Relever l'identifiant du projet, la clé API publique Firebase et l'identifiant OAuth de type **Web** associé au fournisseur Google.
4. Déclarer dans les paramètres de l'environnement et dans l'environnement de compilation :
   - `EXPO_PUBLIC_FIREBASE_PROJECT_ID`
   - `EXPO_PUBLIC_FIREBASE_API_KEY`
   - `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`
5. Reconstruire l'application : Expo incorpore ces valeurs publiques au bundle. Le module Google est intégré par autolinking et configuré avec le client Web explicite. Le téléphone doit disposer de Google Play Services.

Ces identifiants publics ne sont pas des autorisations d'accès aux données. Ne jamais placer de clé de compte de service, mot de passe, refresh token ou secret OAuth dans `EXPO_PUBLIC_*`, le dépôt ou les instructions sauvegardées.

## Ce que fait le code

`FirebaseAuthAdapter` utilise le véritable SDK natif Google pour obtenir un ID token, puis Firebase `accounts:signInWithIdp`. La session est conservée dans SecureStore. Le rafraîchissement passe par `securetoken.googleapis.com`, est mutualisé entre appels concurrents et ne peut pas ressusciter une session déconnectée. Le démarrage hors ligne peut lire la session locale ; `getIdToken()` n'autorise pas une requête distante avec un token expiré.

Apple et Facebook ne sont pas activés. Aucun faux compte social n'est généré. Les données des anciennes identités locales ne sont pas réattribuées automatiquement à un compte Google.

## Acceptation encore nécessaire

Connexion réelle, fermeture/réouverture, expiration/rafraîchissement, déconnexion, deuxième compte et refus d'accès. Les tests unitaires simulent les réponses réseau : ils vérifient le cycle de session, pas le fournisseur.

Le backend doit encore définir et vérifier l'isolation des groupes, les invitations ciblées conservant le `memberId`, l'outbox/deltas/tombstones, les conflits comptables et le stockage privé des photos. Tant que ces parcours n'ont pas fonctionné entre deux comptes/appareils, aucune release collaborative ne peut être déclarée prête.
