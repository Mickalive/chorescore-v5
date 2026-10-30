# Connecter ChoreScore à ton Firebase

Ce guide ouvre un terminal **gratuit chez Google**, déjà relié à ton compte. Ce n’est pas une automation GitHub. Tu n’as pas besoin d’installer un logiciel sur ton ordinateur ni de créer une clé privée.

## 1. Autoriser Google

Si Google affiche **Autoriser Cloud Shell**, clique **Autoriser** avec le compte qui possède `chorescore-a75b1`.

## 2. Lancer la configuration

Dans le terminal en bas, colle cette seule commande puis appuie sur Entrée :

```sh
python3 scripts/firebase/connect-project.py --apply
```

Le programme vérifie que la facturation est désactivée. Il prépare l’application Android et la base Firestore gratuite, enregistre la signature du candidat et publie les règles de sécurité du dépôt. Une base existante conserve ses données et sa région ; les anciennes règles sont sauvegardées avant remplacement. Aucun forfait Blaze, carte bancaire, Cloud Storage ou Cloud Function n’est activé.

## 3. Activer Google si le programme le demande

Ouvre le lien Firebase affiché, clique **Google**, puis **Activer**, choisis ton adresse e-mail d’assistance et clique **Enregistrer**. Si Firebase propose d’abord **Commencer**, clique dessus pour initialiser Authentication. Reviens au terminal et appuie sur Entrée.

Si Google demande une mise à niveau payante, n’accepte pas : ce parcours ne l’exige pas.

## 4. Me transmettre le résultat public

À la fin, le terminal affiche un petit bloc avec trois lignes `EXPO_PUBLIC_...`. Copie **uniquement ce bloc** dans notre conversation. Ce sont les paramètres publics de l’application, pas un mot de passe ni un jeton de connexion. Je pourrai alors intégrer le raccordement au bon projet et poursuivre les essais.

N’envoie jamais la sortie de `gcloud auth print-access-token`, un jeton de session, une clé privée ou un fichier de compte de service.

Le programme peut être relancé si une étape n’est pas encore prête. Son code est dans `scripts/firebase/connect-project.py`. Les cinq tests de protocole locaux ne prouvent pas que la configuration a été appliquée sur ton projet ; seule une exécution Google réussie le confirmera. Le déploiement des règles ne remplace pas les essais de connexion et de synchronisation entre téléphones.
