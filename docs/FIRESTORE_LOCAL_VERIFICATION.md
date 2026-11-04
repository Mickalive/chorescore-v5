# Vérification locale des règles Firestore

Commande pour le développeur, sans connexion Google ni modification du projet réel :

```sh
bash scripts/firebase/run-local-rules.sh
```

Toute la suite, y compris les tests de règles habituellement exclus sans émulateur :

```sh
bash scripts/firebase/run-local-rules.sh npm test
```

Prérequis : Docker, Node et les dépendances npm du dépôt. Le lanceur utilise
l’image officielle Google épinglée par digest, avec sa propre version Java,
charge les règles du dépôt, choisit un port localhost disponible et impose
le projet `demo-chorescore-audit`. Il supprime uniquement son propre conteneur
à la fin, même si les tests échouent. Aucun service Firebase payant n’est créé.

Version vérifiée le 4 novembre 2026 : cloud-firestore-emulator 1.23.0.
Les 255 tests ont passé sans skip. Les tests hostiles emploient les vrais
clients REST et les règles réellement chargées. Cela ne valide ni OAuth Google
réel, ni le déploiement des règles, ni la collaboration entre deux téléphones.

GitHub conserve aussi son scénario officiel Firebase CLI ; ce lanceur est
l’alternative locale lorsque le téléchargement du JAR par cette CLI échoue.
