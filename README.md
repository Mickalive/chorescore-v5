# ChoreScore V5

**Un produit, un dépôt, développement direct sans automatisation GitHub.** Nous reprenons le moteur de calcul et le stockage de la V4. Nous reconstruisons l'expérience utilisateur et les intégrations réellement manquantes. Aucun système « factory / finalizer », aucune validation fondée sur le seul nombre de tests.

## Etat honnête

- **Base transférée** : code applicatif V4, règles de partage des charges, doubles soldes, SQLite local, groupes, membres, catégories et À faire.
- **Vérifié sur cette branche** : tests de domaine et repositories sur SQLite sur disque ; parcours dans le navigateur (groupe en points, tâche, dépense, édition depuis Balances, rechargement, complétion et langue). Voir [VERIFICATION.md](VERIFICATION.md) pour les limites exactes.
- **Non validé** : synchronisation entre téléphones, invitations réelles, OAuth, photos, rappels, qualité visuelle finale. La présence d'un écran ou d'un adaptateur ne vaut pas fonctionnement.
- **Mode de construction** : compilation et vérification directes. Les automatisations GitHub sont désactivées à la demande du propriétaire. Une compilation réussie n’est pas une validation produit.
- **Attention aux données** : V5 est une application Android distincte (package `app.chorescore.v5`). Les données locales de V4 ne sont pas transférées automatiquement.

## Mission sur GitHub

Suivre [l’issue nº 1](https://github.com/Mickalive/chorescore-v5/issues/1) et poursuivre la [PR unique nº 2](https://github.com/Mickalive/chorescore-v5/pull/2). [GITHUB_DELIVERY.md](GITHUB_DELIVERY.md) décrit les vérifications directes. Aucun worker GitHub ne poursuit le code en arrière-plan.

## Lire avant de coder

- [PRODUCT.md](PRODUCT.md) — contrat produit, esthétique et contraintes.
- [VERIFICATION.md](VERIFICATION.md) — preuves requises avant de déclarer un parcours terminé.
- [DELIVERY.md](DELIVERY.md) — ordre de travail et blocages réels.

## APK

Construire directement avec Java 17 et le SDK Android : `npm run prebuild`, puis `cd android && ./gradlew :app:assembleRelease`. Résultat : `android/app/build/outputs/apk/release/app-release.apk`. Signature de développement uniquement, pas de publication Play Store. Les anciens artefacts Actions restent des preuves historiques.

## Règle de construction

**Chaque amélioration aboutit à un parcours utilisable, reproductible et visible.** Supprimer les couches sans valeur. Préserver le code qui a prouvé son fonctionnement. Ne pas déclarer « fini » une simulation, un adaptateur no-op ou un composant seulement compilable.

## Développer et vérifier

Node 24 est requis pour les tests SQLite sur disque.

```sh
npm ci
npm run typecheck
npm test
npm start
```

Avec Chromium installé : `EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npm run test:web`. Ce scénario utilise la vraie base SQLite du navigateur ; il ne remplace pas les essais Android. `CHROME_BIN` et `EVIDENCE_DIR` sont facultatifs.

La connexion Google peut être configurée selon [FIREBASE_SETUP.md](docs/FIREBASE_SETUP.md). Le projet confirmé est `chorescore-a75b1`. Les transports Firebase et HTTP et les reprises SQLite sont implémentés et testés, notamment avec les règles Firestore sur émulateur officiel. Les identifiants publics OAuth/Firebase et l’activation du projet de production ne sont pas disponibles dans cet environnement ; aucun essai entre deux vrais téléphones n’est revendiqué.
