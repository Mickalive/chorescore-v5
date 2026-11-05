# ChoreScore V2 — constitution produit et technique

## Autorité

Ce dépôt est un **rebuild greenfield**. L'ancien dépôt `Mickalive/Chorescore` est une archive : aucune app, aucun modèle métier, aucun test produit et aucune migration de l'ancienne V1 ne constituent une base de confiance. Une brique technique ancienne peut être réimplémentée ou reprise seulement si elle est isolée, comprise, utile à la V2 et auditée comme telle.

Ordre d'autorité : sécurité/droit > ce fichier > `governance/RELEASE_DEFINITION.json` > `docs/ROADMAP.md` > `docs/PRODUCT_BLUEPRINT.md` / `docs/MONETIZATION.md` / `docs/QUALITY_GATES.md` / `docs/DESIGN_CONTRACT.md` / `docs/DATA_PRODUCT_PRIVACY.md` / `docs/SUBSCRIPTION_REFERENCE_V1.md` > `docs/architecture.md` > rôle > tâche active.

Une suite de tests verte ne vaut jamais validation produit si l'UX, la sécurité, la confidentialité ou le comportement divergent de cette constitution.

## Produit

**ChoreScore est un Tricount du temps domestique, avec un planning To-do partagé. KISS.**

Après connexion, l'utilisateur voit ses **foyers**. Dans un foyer, la navigation principale comporte exactement :

1. **Ajouter une tâche**
2. **Score**
3. **To-do**

Pas d'onglet Historique, Classement, Bilan, Profil ou Foyer supplémentaire dans cette navigation.

## Identité, foyers et abonnement

En production, l'utilisateur se connecte avec sa propre identité : compte ChoreScore/email, Google ou Facebook. L'identité connectée est fixe ; `Fait par` est une donnée d'une entrée, pas une façon de changer d'identité.

L'écran racine affiche tous les foyers auxquels l'utilisateur appartient, `Créer un foyer` lorsque ses droits le permettent, `Options` et un accès **Premium / Upgrade** secondaire lorsque pertinent.

### Grille commerciale canonique héritée de V1

- **Essai complet : 30 jours**.
- **Gratuit : un foyer créé/possédé gratuitement**, saisie de base, historique visible + Score limités au mois civil courant, pas de pondération, pas de planification To-do.
- **Standard : 2,99 € / mois / foyer, jusqu'à 7 membres**.
- **Pro : 5,99 € / mois / foyer, requis à partir de 8 membres**.
- Les offres payantes donnent notamment pondération, historique avancé, export PDF, multi-foyers créés/possédés et To-do V2.
- **La facturation est attachée au foyer**, pas à un abonnement global unique du compte.

Un compte gratuit peut **rejoindre plusieurs foyers auxquels il est invité sans devoir payer lui-même**. Dans chaque foyer, les capacités disponibles viennent du plan de ce foyer. La limite gratuite porte sur la création/possession d'un foyer gratuit ; un foyer supplémentaire créé/possédé doit disposer de son propre état de plan/billing.

Chaque foyer possède son propre état de plan/billing, son propriétaire/payeur et ses droits. Les droits d'un foyer ne se propagent jamais à un autre.

Tout utilisateur a des Options personnelles (notifications, confidentialité, légal, préférences). Le payeur/propriétaire voit en plus les Options du foyer : abonnement, administration, membres et permissions disponibles selon le plan. Cela ne devient pas un quatrième onglet.

Le modèle collaboratif par défaut repose sur la confiance, comme Tricount : les membres peuvent saisir, corriger et organiser pour les autres. Des permissions fines peuvent être proposées selon le plan du propriétaire.

## Freemium, archive et démo

La version gratuite reste réellement utilisable. Les vues gratuites d'historique et Score montrent uniquement le **mois civil courant**. À chaque changement de mois, l'historique visible et le Score repartent visuellement sur le nouveau mois.

**Les anciennes données ne sont jamais effacées.** Elles restent persistées mais deviennent hors de la fenêtre gratuite. Un upgrade Trial/Standard/Pro les rend immédiatement à nouveau accessibles partout.

Lorsqu'une archive plus ancienne existe en Free, les pages d'historique affichent un petit message chaleureux, discret et non bloquant indiquant que l'historique n'est pas perdu et que Premium permet de le retrouver. Pas de paywall automatique au démarrage ni à chaque changement d'écran. L'upsell apparaît surtout lorsque l'utilisateur demande une capacité Premium.

La version testable/démo démarre avec un **entitlement Premium de test entièrement débloqué**, sans transaction réelle, afin de permettre l'exploration et les audits de toutes les fonctions. Ce mode doit pouvoir basculer de façon déterministe en Free pour les tests. Il est strictement isolé de la production.

La pondération et les TodoItem créées pendant une période Premium ne sont jamais détruites après downgrade ; elles réapparaissent après upgrade.

## Ajouter une tâche = saisie + historique

Une réalisation crée une **CompletedEntry indépendante**. Deux réalisations identiques restent deux entrées.

Champs cœur :
- `label` libre ;
- `performedByMemberId` = **fait par qui** ;
- `beneficiaryMemberIds[]` = **fait pour qui** ;
- durée réelle ;
- foyer ;
- date/heure ;
- `persistentTaskId` facultatif ;
- pondération avancée facultative lorsque l'entitlement l'autorise ;
- traçabilité `createdBy/modifiedBy` si nécessaire.

`Fait par` sélectionne par défaut l'utilisateur connecté mais peut être changé pour n'importe quel membre du foyer. `Fait pour` permet `Tout le monde` ou n'importe quel sous-ensemble non vide des membres.

Il existe exactement deux modes de durée : **durée manuelle** ou **chrono**. **1 minute réelle = 1 minute réelle.**

Sous la saisie se trouve l'historique chronologique du foyer, comme les dépenses dans Tricount. En Trial/Standard/Pro, il est complet. En Free, il montre le mois civil courant avec l'indication d'archive décrite ci-dessus. Chaque ligne montre de façon compacte quoi, durée, fait par, fait pour, date. Modifier/supprimer via interaction compacte.

## PersistentTask

Une `PersistentTask` est facultative. Elle sert uniquement à accélérer la saisie, mémoriser éventuellement une pondération par défaut et créer **exactement un filtre stable dans Score**.

**Une PersistentTask = un filtre Score.** Les libellés non persistants ne créent jamais de filtres, même s'ils se répètent. Ils restent individuellement dans l'historique accessible et sont regroupés sous **Autres** dans Score.

PersistentTask n'est ni une réalisation ni une To-do. Les PersistentTask ne sont pas supprimées au changement de mois gratuit.

## Score = statistiques + équilibres + historique filtré

Score est l'équivalent d'**Équilibres** de Tricount enrichi de statistiques.

Périodes : **Semaine / Mois / Année / Depuis le début**. Pour un foyer Free, Semaine/Mois fonctionnent dans le mois civil courant ; Année, Depuis le début et toute archive antérieure nécessitent Premium.

Filtres : **Toutes / chaque PersistentTask / Autres**. Le filtre s'applique aux calculs, graphes et historique contextuel.

Pour une CompletedEntry de durée `D`, faite par `P` pour `N` bénéficiaires :
- `P` reçoit un crédit `+D` ;
- chaque bénéficiaire reçoit `-D/N` ;
- si P est bénéficiaire, sa propre quote-part se compense naturellement.

La somme des soldes du foyer vaut zéro. Les soldes servent à proposer simplement **qui doit rattraper combien de temps auprès de qui**, comme les remboursements Tricount.

Score affiche au minimum :
- soldes/avance-retard réels ;
- proposition de compensation pair-à-pair ;
- temps réellement effectué par membre ;
- graphique en barres avec **nom + valeur directement lisibles**.

L'identité d'un membre ne dépend pas d'une couleur fixe. Les couleurs servent seulement à la lisibilité.

La pondération est Premium, avancée, coefficient 1 par défaut, et ne change jamais le temps réel. La même logique fait-par/fait-pour produit une section secondaire d'**heures pondérées** : soldes/compensations + graphique pondéré. Aucun point abstrait.

Sous les statistiques, Score affiche l'**historique correspondant exactement à la période et au filtre sélectionnés**.

## To-do = planning futur Premium

`TodoItem` représente quelque chose à faire. La planification To-do est Premium/essai. Elle peut être sans date, datée/deadline, assignée à un membre, destinée à tout ou partie du foyer, liée à une PersistentTask, accompagnée de notes et d'un rappel, et synchronisable avec un calendrier lorsque l'intégration réelle est active.

Pour un foyer Free, l'onglet reste visible. La tentative de créer/planifier une To-do déclenche alors un upsell contextuel. Un downgrade ne détruit aucune TodoItem existante.

Lorsqu'une To-do est marquée faite :
1. mini-formulaire ;
2. `Fait par` par défaut = membre qui valide, mais modifiable ;
3. durée réelle demandée ;
4. `Fait pour` repris ou modifié ;
5. TodoItem terminée ;
6. création d'une CompletedEntry indépendante ;
7. mise à jour immédiate de l'historique et de Score.

## Partage

Le partage utilise **uniquement le share sheet natif du système**. Android/iOS proposent les applications installées compatibles.

Le partage est contextuel : entrée, sélection d'historique, Score courant, équilibres/graphes, historique filtré, To-do/planning. Des share cards ChoreScore peuvent être générées, mais l'utilisateur choisit ce qu'il partage et l'app n'invente jamais de jugement culpabilisant.

## Backend produit et produit de données

ChoreScore doit être conçu dès le départ pour deux usages serveur distincts.

### 1. Backend opérationnel

Le backend opérationnel conserve/synchronise les données nécessaires au produit : comptes, foyers, membres, entrées, To-do, billing, invitations et permissions.

Il ne peut pas être irréversiblement anonyme, puisqu'il doit restituer les bonnes données aux bons foyers. Il doit donc être :
- strictement isolé par tenant/foyer ;
- chiffré en transit et au repos ;
- minimisé ;
- protégé par authz côté serveur ;
- audité ;
- jamais vendu ni exposé à des acheteurs de données.

### 2. Research Analytics Store anonymisé

Une pipeline séparée dérive des faits statistiques du store opérationnel pour constituer à terme un **produit de données anonymisé** destiné notamment aux sociologues, universités, instituts de recherche, offices statistiques, administrations et observatoires.

**Anonymisation ne signifie jamais remplacement des noms par des IDs.** Aucun produit externe ne doit contenir d'identifiant compte/foyer/membre, clé de jointure, email, device/IP, nom, texte libre, adresse précise ou historique ménage-par-ménage ré-identifiable.

Les libellés libres sont transformés en **taxonomie statistique versionnée** avant analytics ; le texte brut n'est pas vendu. Les timestamps, localisations ou variables démographiques éventuelles sont généralisés selon le risque.

Les produits de données autorisés sont :
- agrégats/cohortes statistiques ;
- API de requêtes statistiques protégée ;
- exports de recherche agrégés sous contrôle ;
- données synthétiques ;
- environnement sécurisé/clean room lorsque plus de granularité est nécessaire.

**Jamais de vente de lignes foyer-par-foyer, même pseudonymisées.**

Toute sortie externe passe par un `PrivacyReleaseGate` contrôlant au minimum identifiants, texte libre, cohortes minimales, cellules rares, risques de differencing/reconstruction, provenance et risque de ré-identification. Les requêtes flexibles doivent pouvoir utiliser rate limits/query budgets et differential privacy lorsque nécessaire.

Les variables sociologiques facultatives (par ex. tranche d'âge, genre, type de ménage, enfants, région) ne sont jamais inférées depuis les noms ou comportements : elles sont structurées, facultatives, transparentes et soumises aux règles de finalité/juridiction applicables.

La politique détaillée est dans `docs/DATA_PRODUCT_PRIVACY.md`. La base juridique exacte de la collecte/valorisation doit être validée avant activation commerciale ; l'architecture doit permettre consentements/préférences et transparence sans présupposer une base juridique unique.

## Dépendances / frontières obligatoires dès le socle

Le domaine ne dépend directement d'aucun fournisseur externe. Prévoir des ports/adapters explicites pour :
- `AuthGateway` ;
- `EntitlementGateway` / `BillingGateway` ;
- `SystemShareGateway` ;
- `NotificationGateway` ;
- `CalendarGateway` ;
- `SecureStorageGateway` ;
- `SyncGateway` / repositories ;
- deep links/invitations ;
- `ResearchAnalyticsGateway` pour émettre des faits minimisés vers la couche analytique sans contaminer le domaine.

Les adapters de développement peuvent être locaux, mais **aucun OAuth, paiement, push, calendrier distant, sync réseau ou pipeline analytics ne doit être présenté comme réel sans configuration réelle**.

## UX / design

Direction : **feel-good, chaleureuse, contemporaine, énergique mais pas enfantine**.

- éviter le blanc dominant ;
- fonds teintés doux et surfaces colorées légères ;
- typographie nette ;
- formulaires courts ;
- graphes lisibles avec noms et temps ;
- aucune palette identitaire finie par membre ;
- peu de texte permanent ;
- Premium contextuel, non agressif ;
- message d'archive Free doux et non bloquant ;
- aucune interprétation morale/psychologique automatique ;
- accessibilité, grandes tailles de texte, contrastes, états vides et erreurs font partie du produit.

Les agents doivent suivre `docs/PRODUCT_BLUEPRINT.md`, `docs/DESIGN_CONTRACT.md`, `docs/REFERENCE_SCENARIOS.json`, `docs/MONETIZATION.md`, `docs/SUBSCRIPTION_REFERENCE_V1.md`, `docs/DATA_PRODUCT_PRIVACY.md` et `docs/QUALITY_GATES.md`.

## Objets métier à ne jamais fusionner

- `CompletedEntry` = réalisation passée avec fait-par + fait-pour ;
- `PersistentTask` = raccourci + filtre Score ;
- `TodoItem` = travail futur.

## Condition terminale

La factory ne s'arrête que lorsque tous les critères de release sont prouvés, aucun finding bloquant n'est ouvert, l'UX est conforme, les entitlements sont prouvés sans destruction de données, le mode démo Premium est testable et isolé, les dépendances externes sont honnêtement encapsulées, l'architecture backend sépare correctement données opérationnelles et analytics anonymisé, et un **APK Android reproductible est réellement compilé, installé, lancé et traversé par le golden path E2E**.

**Construire la V2 depuis zéro. Réutiliser seulement des briques isolées après audit, jamais l'ancienne app comme fondation.**
