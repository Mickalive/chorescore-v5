# ChoreScore V2 — feuille de route canonique

## Autorité et usage

Cette feuille de route traduit `MAIN_PROMPT.md` en ordre de construction. Elle ne peut jamais contredire la constitution produit ni `governance/RELEASE_DEFINITION.json`.

Tous les agents doivent lire avant d'agir :
- `MAIN_PROMPT.md` ;
- `docs/ROADMAP.md` ;
- `docs/PRODUCT_BLUEPRINT.md` ;
- `docs/DESIGN_CONTRACT.md` ;
- `docs/DESIGN_BRIEF.md` ;
- `docs/MONETIZATION.md` ;
- `docs/SUBSCRIPTION_REFERENCE_V1.md` ;
- `docs/DATA_PRODUCT_PRIVACY.md` ;
- `docs/REFERENCE_SCENARIOS.json` ;
- `docs/QUALITY_GATES.md` ;
- leur roadmap de rôle.

Le Builder construit une tranche sans casser les tranches futures. L'Auditor contrôle le critère courant, les quality gates et les invariants déjà acquis. Le Director choisit la prochaine tranche en suivant cette séquence, sauf réparation obligatoire d'un finding.

## Produit final visé

`Connexion -> Foyers -> [Ajouter une tâche + historique | Score + équilibres + historique filtré | To-do]`

Le produit final doit notamment permettre :
- identité réelle par compte/email, Google ou Facebook ;
- plan/billing attaché à chaque foyer ;
- essai complet 30 jours ;
- un foyer gratuit créé/possédé, invitations vers plusieurs foyers autorisées sans achat personnel ;
- Standard 2,99 €/mois/foyer jusqu'à 7 membres ;
- Pro 5,99 €/mois/foyer à partir de 8 membres ;
- Free : historique visible + Score du mois civil courant, sans pondération ni planification To-do ;
- Trial/Standard/Pro : archive complète, pondération et To-do ;
- démo testable Premium entièrement débloquée sans achat réel, avec bascule Free déterministe ;
- CompletedEntry avec `Fait par`, `Fait pour`, durée manuelle ou chrono ;
- PersistentTask facultative, une PersistentTask = un filtre Score ;
- Score avec soldes fait-par/fait-pour, compensations, graphes réel/pondéré et historique filtré ;
- To-do Premium convertie en CompletedEntry après validation et saisie du temps ;
- partage par share sheet natif ;
- notifications et calendrier derrière des ports honnêtes ;
- Options personnelles et Options du foyer selon les droits ;
- UX feel-good, KISS, accessible et non moralisatrice ;
- direction visuelle concrète et cohérente définie par `DESIGN_BRIEF.md` ;
- backend opérationnel sécurisé pour sync ;
- **plan analytique de recherche séparé et anonymisé**, conçu pour produire à terme des statistiques vendables sans exposer les historiques de foyers ;
- preuves visuelles reproductibles ;
- APK Android compilé, installé, lancé et traversé par un golden path E2E.

## Invariants transversaux

1. Le domaine ne dépend d'aucun fournisseur externe.
2. `CompletedEntry`, `PersistentTask` et `TodoItem` restent trois objets distincts.
3. Le temps réel reste la métrique principale ; aucun système de points abstraits.
4. Les services externes non configurés sont indisponibles, jamais simulés.
5. Le partage passe par le share sheet système, pas par un SDK social spécifique.
6. Toute tranche conserve les critères déjà acceptés.
7. La V1 n'est jamais une base ; seules des briques isolées passent le greenfield reuse gate.
8. L'UX et le design font partie de l'acceptation dès le début ; un écran terminé ne peut pas rester visuellement provisoire.
9. La grille d'abonnement confirmée n'est jamais réinventée par un agent.
10. Une limitation gratuite masque/restreint l'accès ; elle ne détruit jamais les données.
11. Le quota de création/possession d'un foyer ne bloque jamais l'acceptation d'une invitation.
12. Le store opérationnel et le Research Analytics Store sont séparés ; le premier n'est jamais vendu.
13. Un UUID ou hash stable n'est jamais considéré comme anonymisation suffisante.
14. Aucun texte libre ou identifiant opérationnel n'entre dans un produit de données externe.
15. Toute sortie analytique externe doit passer par `PrivacyReleaseGate`.
16. `docs/REFERENCE_SCENARIOS.json` fournit les valeurs de référence pour les maths et le golden path.

## V2-00 — Socle greenfield

Objectif : créer la nouvelle application et les frontières techniques correctes dès le départ.

Livrables : Expo/React Native TypeScript propre ; routing minimal ; séparation domain/application/infrastructure/UI ; tests/typecheck/export Android ; ports Auth, Entitlement/Billing, SystemShare, Notification, Calendar, SecureStorage, Sync et **ResearchAnalyticsGateway** ; adapters locaux honnêtes ; architecture d'entitlements au niveau foyer ; shell visuel foyers -> trois onglets ; premiers tokens/composants conformes au design contract et à la fiche design.

`ResearchAnalyticsGateway` est seulement une frontière secondaire à ce stade : aucune collecte réseau factice, aucune dépendance du domaine à l'analytics.

Interdit : copier `app/`, `src/`, tests ou modèle métier de V1 comme fondation.

Gate : check/test/export Android verts + audit architecture/design + preuve que désactiver analytics ne casse aucune fonction produit.

## V2-01 — Identité, foyers, abonnement et Options

Objectif : faire exister le niveau global de l'application et le contrat commercial.

Livrables : session locale/testable avec identité fixe ; User/Household/Member ; plan/billing par foyer ; écran racine ; Upgrade contextuel ; essai 30 jours ; un foyer gratuit créé/possédé ; invitations multiples autorisées ; Standard/Pro avec seuils 7/8 membres et tarifs configurables ; Options personnelles et du foyer ; contrats email/Google/Facebook sans faux OAuth.

Gate : tests identité, isolation, invitations, plan par foyer, essai, droits, création de foyers et upgrade + audit UX/design.

## V2-02 — Réalisations, chrono et historique

Objectif : livrer le cœur transactionnel façon Tricount.

Livrables : navigation `Ajouter une tâche | Score | To-do` ; CompletedEntry indépendante ; Fait par n'importe quel membre ; Fait pour sous-ensemble non vide ; durée manuelle/chrono ; PersistentTask facultative ; pondération seulement selon entitlement ; modification/suppression ; historique sous Ajouter ; persistance locale et reprise du chrono.

Free montre le mois civil courant. Trial/Standard/Pro montrent l'archive complète. Aucune CompletedEntry n'est supprimée au changement de mois ou downgrade.

Préparer une **normalisation analytique séparée** des libellés : le produit garde le texte libre, mais aucune future donnée de recherche ne doit dépendre de l'export de ce texte brut.

Gate : scénarios déterministes + audit données/UX/design.

## V2-03 — Score, équilibres et fenêtre gratuite

Objectif : transformer les entrées en équilibre de temps compréhensible.

Livrables : semaine/mois/année/depuis le début ; Free limité au mois civil courant ; Année/Depuis le début/archive Premium ; reset mensuel sans destruction ; upgrade restaure immédiatement l'archive ; filtres Toutes/une par PersistentTask/Autres ; algorithme +D au performedBy et -D/N aux bénéficiaires ; somme des soldes = zéro ; compensations pair-à-pair ; temps effectué ; barres nommées ; pondéré secondaire seulement Premium ; historique contextuel période + filtre.

Gate : valeurs exactes des scénarios de référence, cas 2/3/N membres, reset mensuel, upgrade/downgrade et audit visuel contre `DESIGN_BRIEF.md`.

## V2-04 — To-do Premium et conversion en réalisation

Objectif : ajouter le futur sans contaminer l'historique.

Trial/Standard/Pro : TodoItem datée ou non, assignation, bénéficiaires, note, deadline, reminder, calendrier via port, lien PersistentTask, check de complétion, mini-formulaire `Fait par + durée + Fait pour`, création atomique d'une CompletedEntry puis mise à jour historique + Score.

Free : onglet présent mais création/planification déclenche seulement alors l'upsell contextuel, aucune TodoItem détruite après downgrade.

Gate : conversion, absence de double comptage, persistance, downgrade/upgrade et audit UX/design.

## V2-05 — Partage, notifications, design et accessibilité

Objectif : rendre le produit réellement agréable et partageable dès le premier APK.

Livrables : share sheet natif pour les contextes utiles ; share cards lorsque pertinentes ; notifications via port ; aucun SDK social spécifique ; design conforme **à `DESIGN_CONTRACT.md` et `DESIGN_BRIEF.md`** ; Premium contextuel ; message d'archive Free chaleureux/non bloquant ; états Free/Trial/Standard/Pro cohérents ; accessibilité ; galerie de captures reproductibles définie dans la fiche design.

Gate : partage système réel dans l'environnement testable, tests UI/accessibilité, preuves visuelles complètes et audit visuel bloquant. Une UI générique/provisoire est un finding même si le code fonctionne.

## V2-06 — Backend, sync, auth, billing, privacy analytics et sécurité

Objectif : rendre l'architecture serveur prête pour production **sans mélanger fonctionnement du produit et valorisation des données**.

### Backend opérationnel

Livrables : adapters/contrats production auth/sync/invitations/billing ; billing provider-agnostic par foyer ; autorisations membres/propriétaire/payeur ; SecureStorage ; offline/sync/conflits ; push/calendrier ; restauration achats/entitlements ; chiffrement et isolation tenant ; documentation ; aucun secret ni faux service actif.

### Research Analytics Plane

Livrables/contrats :
- `ResearchAnalyticsGateway` ;
- `TaskTaxonomyService` versionné ;
- `PrivacyTransformPipeline` ;
- `PrivacyReleaseGate` ;
- schémas du Research Analytics Store ne contenant aucun ID opérationnel, texte libre ou clé de jointure ;
- généralisation des timestamps/localisation/démographie lorsque pertinente ;
- suppression des cellules/cohortes rares ;
- protections contre differencing/reconstruction ;
- query budget/rate limit et capacité differential privacy pour API flexible ;
- audit/export log ;
- politique de consentement/finalité/juridiction configurable ;
- contrats acheteurs interdisant ré-identification et redistribution non autorisée.

Les produits externes autorisés sont agrégats/cohortes, API statistique protégée, données synthétiques et environnement sécurisé. **Aucun export foyer-par-foyer réel ou pseudonymisé.**

Gate : tests frontières/sécurité/billing/privacy, tests négatifs d'exfiltration d'IDs/textes libres, audit dépendances, modèle de menace de ré-identification, documentation et aucun finding high/critical connu.

## V2-07 — APK final et golden path

Le trusted release job doit : réinstaller les dépendances lockées ; relancer tous les checks ; exporter Android ; prebuild ; compiler l'APK release ; installer/lancer sans Metro ; exécuter `e2e:android` ; vérifier Premium test + Free, reset mensuel non destructif, message d'archive, upsell contextuel et checkpoints visuels ; publier APK + preuves.

Le build final doit aussi exécuter les tests statiques/contractuels garantissant que le schéma analytique ne contient pas d'identifiants ou textes libres interdits lorsque V2-06 les implémente.

Un simple lancement/pid n'est jamais suffisant.

## Règle de progression

Séquence normale : V2-00 -> V2-01 -> V2-02 -> V2-03 -> V2-04 -> V2-05 -> V2-06 -> V2-07.

Un finding `mustFix` interrompt la progression. Une implémentation anticipée ne permet jamais de sauter un critère. Le Director peut découper un critère en plusieurs cycles cohérents, mais ne peut pas affaiblir son outcome ni ses quality gates.

## Définition de fini

ChoreScore V2 n'est fini que lorsque le parcours canonique fonctionne, les entitlements commerciaux fonctionnent sans destruction de données, la démo Premium est testable, l'UX/design est conforme au contrat **et à la fiche concrète**, le backend opérationnel est sécurisé, la frontière analytique est privacy-first et incapable de livrer des historiques ré-identifiables, les ports externes sont honnêtes, V2-00 à V2-06 sont acceptés indépendamment, et V2-07 fournit un APK traversé par le golden path Android.
