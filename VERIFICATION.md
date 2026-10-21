# Vérification de la mission V5 — en cours

Aucune déclaration de produit terminé. Les captures ci-dessous proviennent du navigateur, avec la vraie base SQLite WASM et des données créées par le test. Elles ne prouvent pas le fonctionnement Android ou multi-téléphone.

Sources lues : `AGENTS.md`, `CODEX_MISSION.md`, `PRODUCT.md`, les deux documents V3/V4 présents dans `docs/`, la [constitution V3 originale](https://github.com/Mickalive/chorescore-v3/blob/f922d347bc9989a717101bce274ca459902f6ff0/docs/V3_CONSTITUTION.md) et la [constitution V4 originale](https://github.com/Mickalive/chorescore-v3/blob/24041c9ff0adc9d88af534ef7e019699915d6ebe/docs/V4_CONSTITUTION.md). La copie V4 du dépôt est identique à cette source. Référence visuelle : composants et écran principal de `Mickalive/Chorescore`.

| Parcours promis | Implémentation et preuve actuelle | Manque explicite |
| --- | --- | --- |
| Groupes, membres, minutes/points | Sélecteur à la création, dernier nom non validé inclus, garde contre double soumission ; test navigateur avec rechargement + SQLite sur disque | Essais Android, groupes nombreux et longs noms |
| Identité persistée | Identifiant local distinct par installation ; identité des installations existantes conservée ; toutes les routes attendent la restauration | Identité locale sans autorisation cloud |
| Tâches/dépenses | Saisie et notes testées dans le navigateur ; soldes +4,5 points et +0,50 CHF attendus ; parser monétaire exact, rejet des fractions de centime et des dépassements | Date/heure actuellement limitée aux choix prédéfinis ; essais natifs complets et compensation non vérifiés |
| Catégories et ratios | Catégories sélectionnables dans À faire ; ratio snapshoté à la complétion, remplaçable par égal/custom ; tests de conservation historique | Revue visuelle Android du gestionnaire |
| Balances, édition/suppression | Modification de 9 à 20 points depuis Balances, note conservée, solde +10 et dépense retrouvés après rechargement ; suppression/liens photos testés sur SQLite | Suppression par dialogue natif et gros historique non validés ; chargement initial des ledgers encore complet |
| À faire tâche/dépense | Relecture dans transaction sérialisée : un seul succès pour deux complétions concurrentes ; rollback ledger/todo/outbox ; custom shares exactes ; parcours tâche réel dans le navigateur | Double appui Android et parcours dépense Android non exécutés |
| Photos | Champ partagé avec aperçu plein écran ; registre et liens SQLite transactionnels ; nettoyage réessayable des fichiers non référencés ; refus des chemins de traversée | Choix/copie/réouverture d'une vraie photo sur Android non vérifiés ; aucun stockage cloud |
| Rappels | API Expo Notifications, canal Android, permission, identifiant stable par todo, annulation à la complétion/suppression, refus des dates passées | Tests du contrat natif avec mocks seulement ; notification réellement reçue non prouvée ; ponctualité soumise aux réglages Android |
| Partage | Adaptateur natif existant conservé | Feuille système non ouverte pendant cette vérification |
| OAuth | Connexion Google native + Firebase Auth REST, SecureStore, rafraîchissement sérialisé et protection contre résurrection après déconnexion | Aucun projet Firebase configuré ; vrais comptes non testés ; Apple/Facebook indisponibles |
| Synchronisation/invitations | Séquences locales persistantes ; curseurs d'acquittement corrigés ; écriture pendant upload et acquittements partiels testés | `LocalSyncAdapter` reste indisponible. Backend, règles de sécurité, invitation inter-téléphones et résolution distante des conflits à implémenter. Aucun test à deux comptes/appareils |
| Interface FR/EN | Groupes remanié, composants réutilisables, icônes et hauteur des onglets avec safe area, touches de 48 px ; clés FR/EN vérifiées ; langue conservée après rechargement en 360×800 et 412×915 | Pas de revue visuelle Android/iOS ; les grands formulaires restent partiellement monolithiques |

## Contrôles exécutés

- `npm ci --no-audit --no-fund` : réinstallation depuis le lockfile réussie.
- `npm run typecheck` : passe.
- `npm test` : **55 tests exécutés, 55 réussis**, dont les repositories réels sur SQLite sur disque via le pilote Node. Ce pont de test ne valide pas le pont Expo Android.
- `EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npm run test:web` : parcours navigateur réel réussi, aucune erreur JavaScript observée. Groupe, tâche, dépense, édition, persistance, complétion et langue vérifiés.
- Prébuild Android : réussi. Compilation Gradle ARM64 + x86_64 : première configuration corrigée (JDK 17/proxy/CA), puis échec réseau HTTP 503 sur deux artifacts AndroidX de `dl.google.com`. Ne pas assimiler cet échec à une compilation réussie.
- Émulateur API 35 lancé sans KVM ; connexion directe à son ADB obtenue, mais démarrage complet et installation de l'application non validés.
- Un seul workflow Android, désormais déclenché sur PR et exécutant les tests avec Node 24. Résultat de la CI à relever sur la PR.

## Captures observées — navigateur uniquement

[Groupes vide](docs/evidence/groups-empty-web.png) · [Groupes rempli](docs/evidence/groups-filled-web.png) · [Ajouter tâche](docs/evidence/add-task-web.png) · [Ajouter dépense](docs/evidence/add-expense-web.png) · [Balances](docs/evidence/balances-web.png) · [À faire](docs/evidence/todos-web.png) · [Options EN, petit écran](docs/evidence/settings-en-small-web.png).

Reproduire avec Node 24, `npm ci`, puis `npm test`. Pour le navigateur : Chromium installé, `EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 npm run test:web`. `CHROME_BIN` permet de préciser son chemin ; les captures sont écrites dans `/tmp/chorescore-web-evidence` ou `EVIDENCE_DIR`.

Prochain verrou d'acceptation : installer le candidat Android et exécuter les parcours natifs. La collaboration requiert ensuite un vrai projet Firebase et son backend sécurisé ; ni les tests de callbacks réseau, ni les réponses Firebase simulées des tests unitaires ne constituent cette preuve.
