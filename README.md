# ChoreScore V5

**Un produit, un dépôt, un workflow Android.** Nous reprenons le moteur de calcul et le stockage de la V4. Nous reconstruisons l'expérience utilisateur et les intégrations réellement manquantes. Aucun système « factory / finalizer », aucune validation fondée sur le seul nombre de tests.

## Etat honnête

- **Base transférée** : code applicatif V4, règles de partage des charges, doubles soldes, SQLite local, groupes, membres, catégories et À faire.
- **Vérifié sur cette branche** : tests de domaine et repositories sur SQLite sur disque ; parcours dans le navigateur (groupe en points, tâche, dépense, édition depuis Balances, rechargement, complétion et langue). Voir [VERIFICATION.md](VERIFICATION.md) pour les limites exactes.
- **Non validé** : synchronisation entre téléphones, invitations réelles, OAuth, photos, rappels, qualité visuelle finale. La présence d'un écran ou d'un adaptateur ne vaut pas fonctionnement.
- **Mode de construction** : un APK de test Android ARM64 + x86_64 sur chaque PR et changement de main. Une compilation réussie n'est pas une validation produit.
- **Attention aux données** : V5 est une application Android distincte (package `app.chorescore.v5`). Les données locales de V4 ne sont pas transférées automatiquement.

## Lire avant de coder

- [PRODUCT.md](PRODUCT.md) — contrat produit, esthétique et contraintes.
- [VERIFICATION.md](VERIFICATION.md) — preuves requises avant de déclarer un parcours terminé.
- [DELIVERY.md](DELIVERY.md) — ordre de travail et blocages réels.

## APK

GitHub → Actions → **Android candidate APK** → dernier run réussi → télécharger `ChoreScore-V5-APK`. Signature de développement uniquement, pas de publication Play Store.

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

La connexion Google peut être configurée selon [FIREBASE_SETUP.md](docs/FIREBASE_SETUP.md). Aucun projet Firebase n'est actuellement configuré. Le backend de collaboration reste à implémenter ; activer Google ne synchronise pas les groupes.
