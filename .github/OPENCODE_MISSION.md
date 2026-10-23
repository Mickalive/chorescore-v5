# Mission OpenCode — reconstruction ChoreScore V5

Tu es l’agent OpenCode chargé de réaliser la mission produit de l’issue #1 dans la PR #2 du dépôt Mickalive/chorescore-v5. Le propriétaire veut que le développement soit effectué ici, dans GitHub, avec les modèles gratuits d’OpenCode. Aucun abonnement Codex, compte OpenAI, clé API payante ni environnement Codex n’est requis pour ce worker.

## Une mission, une branche, des tranches vérifiées

Continuer `feat/product-reconstruction`, PR #2. Ne pas créer une autre PR, fermer l’issue, fusionner, publier une release, déclencher des workers ou modifier le workflow/dispositif OpenCode. Le workflow Android existant peut être corrigé si nécessaire, sans retirer les contrôles ni en ajouter un deuxième. Pas de boucle planifiée. Le runner conserve et pousse les changements ; tu n’as pas besoin de jeton GitHub. Ne cherche pas de secrets.

Lire AGENTS.md, CODEX_MISSION.md (nom historique du cahier de mission), PRODUCT.md, DELIVERY.md, VERIFICATION.md, docs/V4_CONSTITUTION.md et docs/V3_BACKEND_FRUGAL.md. L’interface de Mickalive/Chorescore V1 sert de référence, sans reprendre premium, classement ou chrono. Préserver les données et invariants comptables.

La demande initiale porte sur TOUT le produit promis : groupes et membres nommés, minutes/points, catégories/ratios, tâches/dépenses/splits exacts, balances/historique/édition/suppression, deux types de todo atomiques, vraies photos persistantes, rappels et partage Android, FR/EN, design soigné, puis comptes et véritable collaboration entre appareils avec autorisations, invitations ciblées, deltas/tombstones/offline/conflits et médias privés.

1. Examiner `.opencode-ci/` si ce répertoire existe : résultats et diagnostics du dernier workflow Android en échec. Le contrôle natif de 39703613298 a échoué après compilation ; corriger la cause réelle, pas les assertions pour obtenir du vert. Le code `scripts/android/verify-device.py` est un essai du vrai APK sans mocks.
2. Choisir la prochaine tranche fonctionnelle nécessaire, l’implémenter et corriger les régressions. Ne pas s’arrêter à un audit, un plan ou des fichiers de statut.
3. Exécuter npm run typecheck, npm test, npm run test:backend et les contrôles pertinents. Le workflow Android est distinct et sera lancé après publication des corrections ; ne pas prétendre en connaître le résultat avant son exécution.
4. Tenir VERIFICATION.md concis et exact : ce qui fonctionne, scénario réellement exécuté, résultat observé, critère encore ouvert et prochaine tranche. Ne pas affirmer avoir vu une capture si le modèle n’a pas pu la lire. Un test avec identités RSA locales ne prouve pas Firebase ni deux téléphones.
5. Préserver une tranche cohérente dans le temps disponible. Continuer le code jusqu’à son contrôle ; la durée du worker est bornée. Ne jamais déclarer l’ensemble terminé parce qu’une tranche passe.

Le backend HTTP/SQLite existe et est testé séparément, mais n’est pas encore déployé ou raccordé au client. LocalSyncAdapter est encore indisponible. Il n’existe pas de projet Firebase configuré. Terminer le code indépendant sans fausse synchro, identités fictives présentées comme OAuth ni nouveau service payant ; décrire précisément une véritable dépendance à un compte personnel si nécessaire.

Ne pas modifier `.github/workflows/opencode.yml`, `opencode.json` ou ce mandat pour contourner les contrôles. Ne pas créer de données personnelles, clés ou jetons dans le dépôt. N’exécuter aucun déploiement payant.
