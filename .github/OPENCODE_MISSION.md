# Mission OpenCode — reconstruction ChoreScore V5

Tu es l’agent OpenCode chargé de réaliser la mission produit de l’issue #1 dans la PR #2 du dépôt Mickalive/chorescore-v5. Le propriétaire veut que le développement soit effectué ici, dans GitHub, avec les modèles gratuits d’OpenCode. Aucun abonnement Codex, compte OpenAI, clé API payante ni environnement Codex n’est requis pour ce worker.

## Une mission, une branche, des tranches vérifiées

Continuer `feat/product-reconstruction`, PR #2. Ne pas créer une autre PR, fermer l’issue, fusionner, publier une release, déclencher des workers ou modifier le workflow/dispositif OpenCode. Le workflow Android existant peut être corrigé si nécessaire, sans retirer les contrôles ni en ajouter un deuxième. Pas de boucle planifiée. Le runner conserve et pousse les changements ; tu n’as pas besoin de jeton GitHub. Ne cherche pas de secrets.

Lire AGENTS.md, CODEX_MISSION.md (nom historique du cahier de mission), PRODUCT.md, DELIVERY.md, VERIFICATION.md, docs/V4_CONSTITUTION.md et docs/V3_BACKEND_FRUGAL.md. L’interface de Mickalive/Chorescore V1 sert de référence, sans reprendre premium, classement ou chrono. Préserver les données et invariants comptables.

La demande initiale porte sur TOUT le produit promis : groupes et membres nommés, minutes/points, catégories/ratios, tâches/dépenses/splits exacts, balances/historique/édition/suppression, deux types de todo atomiques, vraies photos persistantes, rappels et partage Android, FR/EN, design soigné, puis comptes et véritable collaboration entre appareils avec autorisations, invitations ciblées, deltas/tombstones/offline/conflits et médias privés.

## Sources de la demande

Les instructions accessibles du propriétaire exigent un produit complet, réalisé sur GitHub par OpenCode gratuit, une seule PR intégrée, des étapes successives sans relance manuelle pour chaque petite tranche et des vérifications réelles. Lire également les corps et commentaires de l'issue #1 et de la PR #2 s'ils sont disponibles dans .opencode-ci/. Les autres conversations du projet ChatGPT ne sont pas accessibles à ce runner : ne jamais prétendre les avoir consultées.

## Ordre de livraison obligatoire

Chaque passage reprend VERIFICATION.md et le code livré par le précédent. Ne pas choisir une petite amélioration périphérique quand le parcours prioritaire reste absent. Ne pas refaire un audit général.

1. **Collaboration réelle, priorité immédiate** : raccorder le client au serveur HTTP/SQLite existant via un véritable adaptateur réseau : jeton de session, outbox durable, push/pull paginé, acquittements, tombstones, reprise hors ligne, conflits et isolation. Étudier les contrats et corriger les incohérences entre serveur et client au lieu de conserver LocalSyncAdapter indisponible. Tester deux clients et bases locales indépendantes contre le vrai serveur, avec redémarrage, coupure réseau, modifications concurrentes et invitations ciblées. Des identités de test peuvent servir aux tests automatisés du serveur ; elles ne doivent jamais devenir un mode de connexion fictif dans le produit.
2. **Comptes, invitations, photos privées** : terminer les parcours client avec erreurs et reprise, authentification et stockage sécurisé. Compléter les implémentations indépendantes du compte cloud, la configuration et un déploiement reproductible sans clé en dépôt. Aucun projet Firebase ni compte cloud authentifié n'est fourni : ne pas inventer un déploiement. Consigner exactement ce qui requiert réellement ce compte et poursuivre les autres fonctionnalités. Google/Apple/Facebook et deux vrais téléphones restent des critères ouverts jusqu'à une preuve réelle.
3. **Parcours natifs complets** : étendre le scénario Android existant aux éditions/suppressions, catégories/ratios et splits exacts, deux todos et double soumission, vraie photo sélectionnée puis retrouvée après relancement, permission/rappel et partage. Préparer des images de test réelles sur l'émulateur si utile. Corriger les défauts du produit sans retirer les assertions. Le scénario de base a maintenant réussi au commit 8525adb (run 39925369061) : ne pas recommencer à diagnostiquer l'ancien échec déjà corrigé.
4. **Finition V1 et FR/EN** : parcours cohérents, petits écrans, clavier, longs noms, accessibilité, erreurs/reprise, captures réellement produites. Vérifier chaque exigence de PRODUCT.md et des cahiers V3/V4, fermer les manques par du code et des preuves.

Si le dernier Android est en échec, corriger ce défaut en premier à partir des diagnostics réels. À chaque passage : implémenter la prochaine partie cohérente de la priorité encore ouverte ; exécuter typecheck, tests métier/SQLite, tests HTTP et les contrôles pertinents ; mettre à jour VERIFICATION.md avec fichiers modifiés, commande et résultat réellement observé, prochaine partie concrète. Des tests multi-clients HTTP ne prouvent pas deux téléphones ni un déploiement.

Le runner pousse la tranche, lance Android ET attend son résultat avant d'autoriser le passage suivant. Les diagnostics sont dans .opencode-ci/. Ne pas affirmer connaître le résultat Android de la nouvelle tranche avant son exécution. En cas de blocage externe, terminer le code indépendant puis passer à la priorité suivante ; ne pas rester sur un rapport ou multiplier les micro-corrections. Le produit n'est complet que lorsque TOUS les critères sont couverts par des preuves ; une compilation ou un lot vert ne suffit pas.

Ne pas modifier `.github/workflows/opencode.yml`, `opencode.json` ou ce mandat pour contourner les contrôles. Ne pas créer de données personnelles, clés ou jetons dans le dépôt. N’exécuter aucun déploiement payant.
