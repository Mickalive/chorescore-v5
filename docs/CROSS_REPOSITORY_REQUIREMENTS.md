# ChoreScore — continuité des cinq dépôts

Ce document consolide les sources récupérées dans les cinq dépôts le 23 octobre 2026. Il complète la mission V5 ; il ne remplace pas les cahiers originaux. Les snapshots sont dans [source-history](source-history/manifest.json), avec dépôt, commit, chemin et SHA-256 pour chaque fichier. Les instructions archivées décrivent leur époque et ne commandent pas l'exécution V5.

## Sources retrouvées

| Dépôt | Sources effectivement récupérées | Usage pour V5 |
| --- | --- | --- |
| Mickalive/Chorescore | main et lab/chorescore ; MAIN_PROMPT, décisions, architecture, composants visuels et écrans | Qualité visuelle V1, hiérarchie, métriques, palette turquoise/jaune ; comprendre les anciennes décisions |
| Mickalive/Chorescore-V2 | main et lab/chorescore-v2, commit e847f87292744928744bdb40f283291a7b06b2be ; constitution, blueprint, design, privacy, scénarios et calculs | Parcours compacts, fait-par/fait-pour, calculs et séparation opérationnel/recherche ; anciennes politiques commerciales explicitement abandonnées |
| Mickalive/chorescore-v3 | main, historique complet, lab/chorescore-v3 et lab/chorescore-v4 | Vraies constitutions V3/V4 supprimées de main mais encore récupérables ; backend frugal, migration, leçons Android |
| Mickalive/chorescore-v4 | API GitHub : taille 0, aucune branche | Dépôt vide, aucun cahier ou code à inventer ; V4 se trouve dans le dépôt V3, branche lab/chorescore-v4, commit 24041c9ff0adc9d88af534ef7e019699915d6ebe |
| Mickalive/chorescore-v5 | AGENTS, CODEX_MISSION, PRODUCT, DELIVERY, VERIFICATION, code, issue #1 et PR #2 | Produit cible et branche de livraison feat/product-reconstruction |

Les issues des cinq dépôts ont été recensées. V2/V3/V4 n'en avaient pas ; dans V1, les 33 entrées étaient surtout des PR Dependabot, avec une issue d'activation des anciennes protections/agents et une PR de récupération de cycle. Les commentaires V1/V3 consultés ne contenaient aucun commentaire du propriétaire. Ces échanges ne remplacent pas les constitutions. Les conversations privées du projet ChatGPT ne sont pas accessibles par ces dépôts.

## Résolution des changements de cap

Les instructions actuelles du propriétaire, PRODUCT.md et CODEX_MISSION.md V5 prévalent. V4 précise V3 ; V3 abandonne explicitement plusieurs politiques V1/V2. Une ancienne mention « complete », une factory verte ou des centaines de tests ne constitue aucune preuve actuelle.

| Sujet | Évolution historique | Décision finale à appliquer |
| --- | --- | --- |
| Modèle économique | V1/V2 : abonnements, essai, limites et archive payante ; V3/V4 : gratuit | Tout gratuit, groupes illimités, aucune archive verrouillée, ni paywall ni paiement à réintroduire |
| Temps et points | V1/V2 : chrono et minutes ; V3 : suppression du chrono, unité libre | Minutes ou points choisis à la création ; provenance historique conservée lors d'un changement ; jamais de conversion inventée |
| Navigation | V2 : Ajouter tâche/Score/To-do ; V3/V4 : Ajouter/Balances/À faire | Trois onglets dans le groupe, Options hors onglets ; aucun classement ni dashboard intermédiaire |
| Historique | V2/V3 : sous Ajouter ; V4 : déplacé dans Balances | Membres sous Ajouter ; historique paginé et édition/suppression dans Balances |
| Design | V1 turquoise/jaune ; V2 chaud ; V3 graphite ; V4 retour chaud ; demande V5 : préférence V1 | Reprendre la qualité de composition V1 avec captures réelles, sans restaurer ses fonctions abandonnées ; densité et accessibilité V2/V4 |
| Catégories | PersistentTask facultative puis catégories libres et ratios V4 | Aucun catalogue imposé ; défauts modifiables ; snapshots de ratios ; catégories renommables/supprimables sans réécrire le passé |
| Identité | Anciens modes démo/test et identité locale | Compte stable ; rôle fait-par distinct du compte connecté ; aucun faux OAuth ou faux multi-appareil ; sessions de test réservées aux tests |
| Exécution | Anciennes factories Builder/Auditor/Director/finalizer | Développement direct dans la même branche/PR ; automatisations GitHub et OpenCode arrêtées à la demande du propriétaire |

## Exigences cumulatives à terminer et prouver

Chaque ligne doit être reliée dans VERIFICATION.md à une implémentation et une preuve exécutée. « Présent dans le code » ne signifie pas « validé ».

| Famille | Exigences conservées et preuve attendue |
| --- | --- |
| Groupes/membres | Groupes illimités ; choix minutes/points ; noms libres dès création et ensuite ; renommage stable ; options ; suppression confirmée ; comptes liés distingués des membres nommés |
| Identité/invitation | Connexions sociales réellement configurées ; session persistante ; invitation ciblée expirable/révocable ; partage et deep link ; accepter depuis un autre appareil conserve exactement memberId et tout son historique, sans fusion par nom |
| Collaboration | Client réellement raccordé au backend autoritaire ; deux comptes et bases distinctes ; droits serveur ; outbox persistante, deltas paginés et curseurs transactionnels, tombstones, idempotence, reprise offline, conflits explicites ; aucune comparaison aveugle entre révisions serveur et locales |
| Tâches | Titre libre, performer sélectionnable, bénéficiaires non vides, unité du groupe, parts égales/custom, catégorie/ratio facultatif, date/heure, note/photo ; validation exacte et persistance |
| Dépenses | Payeur, bénéficiaires, montant en unités mineures entières, parts égales/custom exactes, devise, date/heure, note/photo ; absence de mélange implicite entre devises |
| Balances/historique | Deux ledgers zéro-somme séparés ; solde principal perpétuel ; filtres semaine/mois/année ; pagination réelle au repository ; edit/delete/share depuis Balances ; effet équivalent au replay comptable et aucun état UI périmé |
| Compensation | Désactivée par défaut ; accord et taux explicites ; aperçu avant/après ; vraie opération auditable atomique ; taux/devise/unité snapshotés ; aucune surcompensation ni réinterprétation après changement de taux |
| À faire | Tâche ET dépense, assignation/bénéficiaires/catégorie/note/échéance/rappel ; mini-formulaire à la complétion ; exactement une écriture + todo terminé, transactionnel même au double appui et lors de la concurrence distante |
| Photos | Vrai sélecteur Android, copie privée, aperçu/réouverture après redémarrage, remplacement/suppression sans fuite ; stockage cloud privé et ACL ; téléchargement paresseux, aucune URL privée dans l'analytics |
| Notifications/partage | Vrai rappel reçu sur Android, permission/refus, annulation ; préférences ; partage système pour invitation/tâche/dépense ; calendrier uniquement si intégration réelle, jamais présenté comme opérationnel sur la base d'un port vide |
| Options/UX | Profil, FR/EN persistés et complets, confidentialité/consentements, légal exact, notifications, déconnexion ; erreurs/reprise/offline, vide/rempli, deux tailles, grands textes, clavier et safe areas ; aucune interprétation morale ni identité par couleur seule |
| Coût/performance | Tests sur 50 000 anciennes écritures : navigation sans full scan distant, pas de N+1 racine, pas de recharge à chaque onglet ; balances matérialisées incrémentales et reconstruisibles ; trois modifications = seulement les deltas ; écritures/bytes/appels bornés et mesurés |
| Données/recherche | Préserver les modules privacy V2/V3 ; analytics asynchrone et désactivable sans casser le produit ; checkpoint incrémental ; cache de classification versionné ; pas de LLM synchrone par saisie ; aucune sortie externe d'IDs, noms, notes, photos, texte libre ou historiques individuels ; consentement/transparence ; agrégats contrôlés par Privacy Release Gate |
| Livraison | Tests métier, vrais repositories SQLite, HTTP/ACL hostiles et coûts ; export Android/iOS si possible ; APK release installé et scénarios réellement traversés ; captures et résultats liés au commit ; deux appareils et vrai backend pour accepter la collaboration |

## Priorité d'implémentation

1. Corriger une éventuelle régression Android prouvée ; sinon raccorder le client au serveur sécurisé existant et vérifier les conflits/invitations/reprises avec deux bases indépendantes.
2. Terminer l'authentification, les liens et médias privés, puis les parcours Android photo/rappel/deux todos/édition/suppression/custom splits/compensation.
3. Fermer les régressions de pagination/coût, les exigences privacy, Options et finition visuelle avec captures.
4. Valider le déploiement authentifié et deux appareils quand un compte cloud réel est disponible. Ne pas déclarer le produit collaboratif complet auparavant ; terminer toutes les parties indépendantes du compte.

Cette liste n'autorise pas à effacer les preuves ni à remplacer les tests natifs par des mocks. Les hypothèses sur l'existant doivent être recontrôlées dans V5 ; le dépôt V3 main s'annonce lui-même local-only, donc copier son APK ne répond pas à la mission.
