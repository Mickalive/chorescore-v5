# Connecter Firebase sans terminal ni paiement

Projet : **chorescore-a75b1**. Conserver le forfait **Spark**, sans carte bancaire.
Ces étapes activent la connexion et fournissent la configuration publique de
l’application ; elles ne donnent pas accès au compte Google à l’assistant.

## 1. Activer Google

Ouvrir [Authentication → Fournisseurs](https://console.firebase.google.com/project/chorescore-a75b1/authentication/providers).
Cliquer **Commencer** si proposé, puis **Google → Activer**. Choisir son adresse
e-mail d’assistance, puis **Enregistrer**. Si Google est déjà activé, conserver
la configuration existante.

## 2. Télécharger la configuration Android

Ouvrir [Paramètres du projet → Général](https://console.firebase.google.com/project/chorescore-a75b1/settings/general).
Dans **Vos applications**, ouvrir l’application Android **app.chorescore.v5**.
Si elle n’existe pas : **Ajouter une application → Android**, saisir le nom de
package **app.chorescore.v5** et le surnom **ChoreScore Android**, puis
**Enregistrer l’application**.

Dans ses paramètres, ajouter ces empreintes si elles ne sont pas déjà présentes :

- SHA-1 : `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`
- SHA-256 : `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`

Elles viennent de `firebase/android-signing.json`, vérifié contre le candidat
de développement. Une future signature de distribution nécessitera ses propres
empreintes.

**Après activation de Google et enregistrement des empreintes**, cliquer
**Télécharger google-services.json**, puis joindre ce fichier à la conversation.
Il contient la configuration publique Android, sans clé privée. Ne pas créer
ni télécharger de clé de compte de service : ce serait un autre fichier.
Ne pas modifier les SDK/Gradle à la main : le raccordement sera fait dans le dépôt.

## Suite du raccordement

Valider le projet et le package du fichier, récupérer la clé API publique et
le client OAuth de type Web, préparer le candidat configuré, vérifier les règles
Firestore avant publication et tester les échanges entre comptes. Le fichier
seul ne déploie pas les règles et ne prouve pas la synchronisation.

Aucun Cloud Shell, mot de passe, jeton de connexion, compte de service,
Cloud Storage, Cloud Function ou passage au forfait Blaze n’est demandé.
