# Développement direct de ChoreScore V5

À la demande du propriétaire, les automatisations GitHub Android et OpenCode sont désactivées ; leurs workflows et la configuration du worker sont supprimés de la PR. Ne pas les recréer ni les réactiver.

Le travail reste dans `feat/product-reconstruction` et la [PR #2](https://github.com/Mickalive/chorescore-v5/pull/2). Implémenter et vérifier directement le produit, sans worker ni relance automatique. Les scénarios et leurs limites sont consignés dans [VERIFICATION.md](VERIFICATION.md).

Vérifications directes : `npm run typecheck`, `npm test`, `npm run test:backend`, `npm run test:web`. Après installation du SDK Android et Java 17 : `npm run prebuild`, puis `cd android && ./gradlew :app:assembleRelease`. Le parcours appareil reste exécutable avec `python3 scripts/android/verify-device.py android/app/build/outputs/apk/release/app-release.apk` et ADB connecté à un appareil de test.

Une compilation ou un test navigateur ne prouve pas le fonctionnement natif. Aucun service payant, activation de facturation ou publication Play Store sans demande explicite.
