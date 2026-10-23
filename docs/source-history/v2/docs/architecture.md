# Architecture V2 — greenfield

## Principe

Architecture locale-first, testable, avec domaine indépendant des fournisseurs. Aucun code applicatif de V1 n'est une base.

Le produit possède **deux plans de données strictement séparés** :
1. un plan opérationnel nécessaire au fonctionnement/sync de ChoreScore ;
2. un plan analytique de recherche, dérivé et anonymisé, destiné aux statistiques et futurs produits de données.

Ne jamais confondre pseudonymisation opérationnelle et anonymisation de release.

## Couches cibles

- `src/domain/` : entités et calculs purs (`Household`, `Member`, `CompletedEntry`, `PersistentTask`, `TodoItem`, balances/compensations).
- `src/application/` : cas d'usage et ports.
- `src/infrastructure/` : persistence locale et adapters externes.
- `src/features/` : orchestration UI par fonctionnalité.
- `src/ui/` : composants/design system.
- `app/` : routes Expo Router uniquement.

Le Builder peut ajuster cette arborescence si une alternative reste plus simple, mais les dépendances doivent aller de l'UI/infrastructure vers l'application/domaine, jamais l'inverse.

## Ports obligatoires produit

- AuthGateway
- EntitlementGateway/BillingGateway
- SystemShareGateway
- NotificationGateway
- CalendarGateway
- SecureStorageGateway
- SyncGateway + repositories

Le share natif est une seule frontière système, pas un SDK par réseau social.

## Ports/services analytiques à prévoir

- `ResearchAnalyticsGateway` : émission secondaire de faits minimisés vers le backend analytique ;
- `TaskTaxonomyService` : transforme les libellés en catégories statistiques versionnées sans imposer de catégories dans l'UX ;
- `PrivacyTransformPipeline` : suppression/généralisation/agrégation ;
- `PrivacyReleaseGate` : bloque toute sortie non suffisamment anonymisée ;
- `ResearchQueryService` : agrégats/API statistique protégée ;
- `ConsentPolicyService` : politique de finalité/juridiction/préférences lorsque nécessaire.

Le domaine ChoreScore ne dépend jamais de ces services analytiques. Une panne ou désactivation de l'analytics ne doit pas casser Ajouter, Score, To-do ou la sync du foyer.

## Données produit

CompletedEntry stocke `performedByMemberId` et `beneficiaryMemberIds[]`. PersistentTask est facultative et crée un filtre Score. TodoItem est distincte et peut produire une CompletedEntry lorsqu'elle est validée.

## Plan opérationnel serveur

Le backend opérationnel doit pouvoir synchroniser les données de foyers entre appareils. Il ne peut donc pas être irréversiblement anonyme : il doit savoir à quel compte/foyer restituer les données.

Garde-fous :
- isolation tenant par foyer ;
- authz côté serveur ;
- chiffrement en transit et au repos ;
- minimisation des métadonnées ;
- identifiants opérationnels jamais exposés dans le produit analytique ;
- textes libres et données de compte jamais copiés tels quels vers l'analytics ;
- journaux d'accès/audit ;
- secrets/tokens via stockage protégé.

Ce store n'est jamais vendu.

## Plan analytique de recherche

Pipeline cible :

`Operational Store -> Privacy Transform -> Safe Aggregation -> Privacy Release Gate -> Research Data Product`

Le Research Analytics Store ne contient pas d'email, userId/memberId/householdId opérationnel, device/IP, nom, texte libre, adresse précise ou clé de jointure vers le store opérationnel.

Les libellés de tâches sont normalisés vers une taxonomie avant entrée dans le plan analytique. Les timestamps/localisations/démographies éventuelles sont généralisés selon le risque.

Les sorties externes sont des agrégats/cohortes, une API statistique protégée, des données synthétiques ou un environnement de recherche sécurisé. **Jamais un historique réel ligne-par-ligne d'un foyer.**

Voir `docs/DATA_PRODUCT_PRIVACY.md`.

## Privacy Release Gate

Toute sortie analytique externe doit vérifier au minimum :
- absence d'identifiants directs ;
- absence de texte libre ;
- absence de clés de jointure ;
- seuils de cohortes et suppression des cellules rares ;
- protection contre differencing/reconstruction ;
- provenance/version de transformation ;
- finalité/acheteur autorisé ;
- risque de ré-identification ;
- journal d'export.

Pour une API flexible, prévoir query budget/rate limit et differential privacy lorsque nécessaire.

## Sécurité

Secrets uniquement via configuration protégée. Les adapters externes non configurés doivent être explicitement indisponibles, jamais simulés comme réussis.

Le mode `demo-premium` est un entitlement de test isolé et ne doit jamais devenir un moyen d'activer Premium en production.

## Greenfield reuse gate

Avant de reprendre une brique de V1, vérifier :
1. aucune dépendance au vieux modèle ;
2. API petite et claire ;
3. tests V2 dédiés ;
4. gain réel par rapport à une réécriture ;
5. audit indépendant.
