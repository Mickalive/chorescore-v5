# Vérification de la mission V5 — en cours

Aucune déclaration de produit terminé. Les captures ci-dessous proviennent du navigateur, avec la vraie base SQLite WASM et des données créées par le test. Elles ne prouvent pas le fonctionnement Android ou multi-téléphone.

Sources lues : `AGENTS.md`, `CODEX_MISSION.md`, `PRODUCT.md`, les deux documents V3/V4 présents dans `docs/`, la [constitution V3 originale](https://github.com/Mickalive/chorescore-v3/blob/f922d347bc9989a717101bce274ca459902f6ff0/docs/V3_CONSTITUTION.md) et la [constitution V4 originale](https://github.com/Mickalive/chorescore-v3/blob/24041c9ff0adc9d88af534ef7e019699915d6ebe/docs/V4_CONSTITUTION.md). La copie V4 du dépôt est identique à cette source. Référence visuelle : composants et écran principal de `Mickalive/Chorescore`.

| Parcours promis | Implémentation et preuve actuelle | Manque explicite |
| --- | --- | --- |
| Groupes, membres, minutes/points | Sélecteur à la création, dernier nom non validé inclus, garde contre double soumission ; test navigateur avec rechargement + SQLite sur disque | Essais Android, groupes nombreux et longs noms |
| Suppression du groupe | Propriétaire seulement, confirmation par nom exact, annulation et persistance de suppression testées dans le navigateur ; isolation, rollback, lignes privées et liens photo vérifiés sur SQLite et mémoire | Annulation réelle des rappels et nettoyage physique Android à vérifier ; cloud non raccordé |
| Identité persistée | Identifiant local distinct par installation ; identité des installations existantes conservée ; toutes les routes attendent la restauration | Identité locale sans autorisation cloud |
| Tâches/dépenses | Saisie et notes testées dans le navigateur ; soldes +4,5 points et +0,50 CHF attendus ; parser monétaire exact, rejet des fractions de centime et des dépassements | Date/heure précise et rejet des dates impossibles vérifiés dans le navigateur, annulation sans modification et valeur retrouvée à l’édition ; essais natifs complets et compensation non vérifiés |
| Catégories et ratios | Création avec poids par défaut non modifiés corrigée ; ratio 1:3 donnant +6 pour 8 points, modification en 3:1 sans réécriture historique, override custom et totaux +22/−22 points vérifiés dans le navigateur ; sélection dans À faire | Revue visuelle Android du gestionnaire |
| Balances, édition/suppression | Modification de 9 à 20 points depuis Balances, note conservée, solde +10 et dépense retrouvés après rechargement ; suppression/liens photos testés sur SQLite | Suppression par dialogue natif et gros historique non validés ; chargement initial des ledgers encore complet |
| À faire tâche/dépense | Relecture dans transaction sérialisée : un seul succès pour deux complétions concurrentes ; rollback ledger/todo/outbox ; custom shares exactes ; parcours tâche et dépense custom réels dans le navigateur, total final +2,01/−2,01 CHF conservé après rechargement | Double appui Android et parcours dépense Android non exécutés |
| Photos | Champ partagé avec aperçu plein écran ; registre et liens SQLite transactionnels ; nettoyage réessayable des fichiers non référencés ; refus des chemins de traversée | Choix/copie/réouverture d'une vraie photo sur Android non vérifiés ; aucun stockage cloud |
| Rappels | API Expo Notifications, canal Android, permission, identifiant stable par todo, annulation à la complétion/suppression, refus des dates passées | Tests du contrat natif avec mocks seulement ; notification réellement reçue non prouvée ; ponctualité soumise aux réglages Android |
| Partage | Adaptateur natif existant conservé | Feuille système non ouverte pendant cette vérification |
| OAuth | Connexion Google native + Firebase Auth REST, SecureStore, rafraîchissement sérialisé et protection contre résurrection après déconnexion | Aucun projet Firebase configuré ; vrais comptes non testés ; Apple/Facebook indisponibles |
| Synchronisation/invitations | Écritures UI et outbox regroupées en transaction ; panne disque injectée sur l’outbox avec rollback et reprise vérifiés ; séquences locales persistantes et acquittements corrigés | `LocalSyncAdapter` reste indisponible. Serveur HTTP/SQLite implémenté et testé séparément (voir `backend/README.md`) : ACL, invitations ciblées, événements paginés, conflits optimistes et complétion atomique. Raccordement mobile, stockage privé des photos et déploiement à réaliser. Aucun test à deux comptes/appareils |
| Interface FR/EN | Groupes remanié, composants réutilisables, icônes et hauteur des onglets avec safe area, touches de 48 px ; clés FR/EN vérifiées ; langue conservée après rechargement en 360×800 et 412×915 | Pas de revue visuelle Android/iOS ; les grands formulaires restent partiellement monolithiques |

## Contrôles exécutés

- `npm ci --no-audit --no-fund` : réinstallation depuis le lockfile réussie.
- `npm run typecheck` : passe.
- `npm run test:backend` : scénario HTTP réel réussi avec comptes signés par clé de test, SQLite sur disque, redémarrage, isolation, révocation/expiration, conflit, rollback, double complétion et pagination. Aucun vrai compte Firebase/appareil dans ce scénario.
- `npm test` : **60 tests exécutés, 60 réussis**, dont les repositories réels sur SQLite sur disque via le pilote Node. Ce pont de test ne valide pas le pont Expo Android.
- `EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npm run test:web` : parcours navigateur réel réussi, aucune erreur JavaScript observée. Groupe, tâche, dépense, édition, persistance, complétion et langue vérifiés.
- Prébuild Android : réussi. Après correction JDK/proxy/CA et rétablissement du réseau, compilation Gradle ARM64 + x86_64 réussie en 11 min 28 s. Candidat local de 65 Mo, SHA-256 `8cd3fc854c9cafa8175b2924569992171574dac289eb7fbdf08b50190235b408`, code mobile du commit `e5a9f52`. Cette compilation ne prouve aucun parcours natif.
- Émulateur API 35 lancé sans KVM : connexion directe à ADB et démarrage complet obtenus (`sys.boot_completed=1`, Android 15). Après démarrage sur écran 412×915, journaux système `DeadSystemException` et service `package` indisponible ; installation non confirmée, aucune capture applicative obtenue. Le contrôle natif passe au runner CI accéléré KVM, sans simulation ni compte E2E.
- Un seul workflow Android, désormais déclenché sur PR et exécutant les tests avec Node 24. Après rétablissement du réseau, branche poussée et [PR nº 2](https://github.com/Mickalive/chorescore-v5/pull/2) ouverte en brouillon. Workflow Android du commit `69e88e6` réussi ([exécution 39701219229](https://github.com/Mickalive/chorescore-v5/actions/runs/39701219229)). Workflow du commit `e5a9f52` également réussi ([exécution 39702200817](https://github.com/Mickalive/chorescore-v5/actions/runs/39702200817)). Contrôle natif ajouté au même workflow, résultat à relever après sa première exécution : lancement du vrai APK, groupe, écritures, redémarrage et feuille de partage.

## Captures observées — navigateur uniquement

[Répartitions personnalisées](docs/evidence/custom-splits-web.png) · [Suppression du groupe](docs/evidence/delete-group-web.png) · [Saisie date/heure](docs/evidence/date-time-web.png) · [Groupes vide](docs/evidence/groups-empty-web.png) · [Groupes rempli](docs/evidence/groups-filled-web.png) · [Ajouter tâche](docs/evidence/add-task-web.png) · [Ajouter dépense](docs/evidence/add-expense-web.png) · [Balances](docs/evidence/balances-web.png) · [À faire](docs/evidence/todos-web.png) · [Options EN, petit écran](docs/evidence/settings-en-small-web.png).

Reproduire avec Node 24, `npm ci`, puis `npm test`. Pour le navigateur : Chromium installé, `EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npm run test:web`. `CHROME_BIN` permet de préciser son chemin ; les captures sont écrites dans `/tmp/chorescore-web-evidence` ou `EVIDENCE_DIR`.

Prochain verrou d'acceptation : installer le candidat Android et exécuter les parcours natifs. La collaboration requiert ensuite un vrai projet Firebase et son backend sécurisé ; ni les tests de callbacks réseau, ni les réponses Firebase simulées des tests unitaires ne constituent cette preuve.

Candidat local du code mobile `5eefb93` également compilé avec succès (incrémental, 58 s), SHA-256 `496e6aa018be847663d72cd21817c25426054be949277f3bea90f0a4ad262ac0`. Toujours aucune validation native à déduire de cette compilation.


## Mise à jour GitHub — 23 octobre 2026

- OpenCode a livré le commit `8525adb` : renommage des membres conservant leur identifiant et correction du sélecteur du scénario Android.
- [Run Android 39925369061](https://github.com/Mickalive/chorescore-v5/actions/runs/39925369061) **réussi** sur ce commit : TypeScript, tests métier/SQLite, tests HTTP serveur, compilation release et étape `Verify installed release APK on Android` effectivement exécutés et réussis. Ce scénario couvre le lancement, groupe, tâche/dépense, balances, redémarrage et partage ; il ne prouve pas les photos/rappels ni la collaboration. Les anciennes mentions « premier résultat natif à relever » ci-dessus sont dépassées par ce résultat.
- Les cinq dépôts ont été recensés et les cahiers historiques récupérés, y compris V4 dans la branche du dépôt V3 (le dépôt V4 lui-même est vide). Références, évolution des exigences et critères cumulatifs : [CROSS_REPOSITORY_REQUIREMENTS.md](docs/CROSS_REPOSITORY_REQUIREMENTS.md).
- La série `39971192327` a été annulée pour intégrer ces sources avant reprise ; elle n'est pas présentée comme une livraison. La prochaine priorité reste le raccordement réel client/serveur, pas un nouveau renommage périphérique.
