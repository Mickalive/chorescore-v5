# ChoreScore V2 — produit de données, recherche et anonymisation

## Objectif

ChoreScore doit pouvoir devenir, en plus de l'application grand public, une source de statistiques de haute qualité sur le travail domestique : répartition du temps, types de tâches, bénéficiaires, saisonnalité, taille/composition des foyers, écarts de contribution et évolution dans le temps.

Acheteurs/usages potentiels : universités, sociologues, instituts de recherche, offices statistiques, administrations, observatoires de l'égalité, instituts de sondage et autres organismes légitimes de recherche/politiques publiques.

**La valeur commerciale ne doit jamais dépendre de la vente d'historiques individuels ou ménage-par-ménage.** Le produit externe est constitué d'agrégats, de cohortes, d'indicateurs, de requêtes statistiques protégées ou, si nécessaire, de données synthétiques/accès en environnement sécurisé.

## Principe cardinal : anonymisation ≠ pseudonymisation

Remplacer un nom, un email ou un householdId par un UUID n'anonymise pas une donnée. Si une observation peut être reliée à un compte, un membre ou un foyer avec des informations supplémentaires, elle reste pseudonymisée et doit être traitée comme donnée personnelle.

Le système distingue donc strictement deux mondes.

### A. Operational Store — données produit

Nécessaire au fonctionnement de ChoreScore : comptes, foyers, membres, CompletedEntry, PersistentTask, TodoItem, sync, billing, invitations et permissions.

- tenant isolation stricte par foyer ;
- chiffrement en transit et au repos ;
- contrôles d'accès et journaux d'audit ;
- identifiants opérationnels conservés uniquement ici ;
- textes libres (`label`, notes Todo, noms de foyers, noms de membres) conservés uniquement selon le besoin produit ;
- ce store **n'est jamais vendu ni exposé comme produit de données**.

Un backend de synchronisation ne peut pas être irréversiblement anonyme : il doit savoir à quel compte/foyer restituer les données. La confidentialité y repose donc sur minimisation, pseudonymisation, chiffrement, isolation et contrôle d'accès, pas sur une fausse promesse d'anonymat.

### B. Research Analytics Store — données dérivées

Store séparé, alimenté uniquement par une pipeline de transformation contrôlée. Il ne contient aucun identifiant permettant de revenir vers le store opérationnel.

Interdits dans le Research Analytics Store :
- userId / accountId / memberId / householdId opérationnels ;
- email, téléphone, OAuth subject ;
- IP, device ID, advertising ID ;
- nom de membre ou de foyer ;
- texte libre de tâche ou notes ;
- coordonnées GPS/adresse précise ;
- timestamp exact si une granularité plus grossière suffit ;
- secret ou table de correspondance permettant de réidentifier.

La clé analytique stable d'un foyer ou d'un membre n'est pas exportée aux acheteurs. Si une clé temporaire est nécessaire à une étape interne de calcul, elle est rotative, compartimentée et détruite/isolée avant la release externe.

## Pipeline d'anonymisation

`Operational Store -> Privacy Transform -> Safe Aggregation -> Privacy Release Gate -> Research Data Products`

### 1. Minimisation

Ne sélectionner que les variables nécessaires au produit statistique demandé.

### 2. Suppression des identifiants

Suppression irréversible des identifiants directs et des métadonnées techniques inutiles.

### 3. Normalisation sémantique des tâches

Les libellés libres restent utiles au produit mais sont dangereux dans un dataset. Avant la couche analytique, ils sont transformés en une taxonomie contrôlée, par exemple :
- cuisine ;
- vaisselle ;
- ménage/nettoyage ;
- linge ;
- courses/approvisionnement ;
- administratif ;
- soins/enfants/personnes ;
- entretien/bricolage ;
- déchets ;
- autre.

La taxonomie peut évoluer/versionner. **Le texte brut n'est jamais exporté dans le Research Analytics Store commercial.**

### 4. Généralisation

Selon le besoin :
- timestamp -> semaine/mois, jour de semaine ou tranche horaire ;
- durée -> agrégats ou buckets lorsque la précision ligne-à-ligne n'est pas nécessaire ;
- taille du foyer -> classes lorsque les grandes tailles deviennent rares ;
- localisation éventuelle -> zone suffisamment large (par ex. grande région/canton seulement si le risque le permet) ;
- démographie éventuelle -> classes d'âge et catégories structurées.

### 5. Suppression des cellules rares

Aucun résultat externe n'est publié pour une combinaison de dimensions dont la cohorte est trop petite. Le seuil est un paramètre de sécurité versionné, jamais un choix de l'acheteur.

Prévoir également la suppression complémentaire afin qu'une cellule masquée ne puisse pas être reconstruite par simple soustraction d'autres totaux.

### 6. Protection contre les requêtes de reconstruction

Pour une API/statistical query service :
- dimensions autorisées en liste blanche ;
- seuils de cohortes ;
- rate limits et query budget ;
- protection contre requêtes quasi-identiques/differencing ;
- bruit différentiel/differential privacy lorsqu'une interface de requêtes flexible rend cela nécessaire ;
- journalisation et détection d'abus.

Aucune technique unique (`k-anonymity`, suppression des noms, etc.) n'est considérée suffisante à elle seule.

## Produits de données autorisés

### 1. Agrégats/cubes statistiques

Exemples :
- minutes moyennes/médianes par catégorie de tâche et taille de foyer ;
- distribution de la charge entre membres ;
- proportion de tâches faites pour tout le foyer vs bénéficiaires spécifiques ;
- saisonnalité/jour de semaine ;
- indicateurs d'équilibre dans le temps ;
- utilisation des tâches planifiées vs réalisées.

### 2. API statistique protégée

Permettre aux chercheurs de demander des agrégats sur des dimensions autorisées sans accès aux lignes sources.

### 3. Exports de recherche sous contrat

Exports agrégés dédiés à un projet de recherche, après Privacy Release Gate.

### 4. Données synthétiques

Lorsque des chercheurs ont besoin d'un format microdata pour tester des méthodes, préférer des microdonnées synthétiques générées depuis les distributions plutôt que de livrer des historiques réels de foyers.

### 5. Environnement sécurisé / clean room

Pour des projets exceptionnels nécessitant plus de granularité, privilégier un environnement contrôlé où le chercheur exécute des analyses et ne peut exporter que des résultats qui repassent le Privacy Release Gate.

## Ce qui n'est jamais vendu

- profils ou historiques individuels ;
- historique identifiable ou pseudonymisé d'un foyer ;
- listes de membres ;
- textes libres ;
- comptes/emails ;
- clés de jointure vers les données opérationnelles ;
- données permettant de cibler commercialement une personne/un foyer ;
- datasets « anonymisés » uniquement par remplacement d'identifiants.

## Variables sociologiques facultatives

Des variables de recherche telles que tranche d'âge, genre, présence d'enfants, type de ménage, activité professionnelle ou région peuvent accroître fortement la valeur scientifique.

Règles :
- jamais inférées depuis le prénom, le comportement ou un profil social ;
- collectées uniquement de façon structurée et facultative ;
- finalité recherche/statistique clairement expliquée ;
- consentement/choix et retrait supportés lorsque requis par la base juridique et la juridiction ;
- valeurs généralisées avant release externe ;
- combinaisons rares supprimées.

## Transparence et gouvernance

La collecte et la transformation vers un produit de données doivent être décrites clairement dans la politique de confidentialité et dans les informations fournies aux utilisateurs : finalités, catégories de données, durée, anonymisation, catégories de destinataires et droits applicables.

L'architecture doit permettre :
- preuve/version de la notice de confidentialité acceptée/présentée ;
- préférences/consentements par finalité lorsque nécessaires ;
- désactivation de l'alimentation analytique lorsque la politique ou le droit l'exige ;
- suppression/rectification dans le store opérationnel ;
- impossibilité de retrouver une personne dans une release **déjà réellement anonymisée**, puisqu'aucune clé de retour n'y existe.

La base juridique exacte (consentement, intérêt légitime, recherche/statistique, etc.) dépend de la juridiction et du produit de données : elle doit être validée juridiquement avant activation commerciale. L'architecture ne doit pas présupposer une base juridique unique.

## Privacy Release Gate obligatoire

Aucun dataset, agrégat ou résultat analytique ne quitte l'environnement ChoreScore sans un gate machine + gouvernance qui vérifie au minimum :
- absence d'identifiants directs ;
- absence de texte libre ;
- absence de clés de jointure opérationnelles ;
- cohortes minimales ;
- contrôle des dimensions rares ;
- contrôle de reconstruction/differencing ;
- provenance et version de la transformation ;
- finalité/acheteur autorisés ;
- contrat interdisant tentative de ré-identification et redistribution non autorisée ;
- audit de risque de ré-identification pour les nouvelles familles de produits.

## Architecture technique cible

Ports/services à prévoir :
- `ResearchAnalyticsGateway` : émission d'événements minimisés depuis le produit/backend ;
- `TaskTaxonomyService` : normalisation des libellés vers taxonomie versionnée ;
- `PrivacyTransformPipeline` : suppression/généralisation/agrégation ;
- `PrivacyReleaseGate` : validation de toute sortie externe ;
- `ResearchQueryService` : API statistique protégée ;
- `ConsentPolicyService` : règles de finalité/juridiction et préférences utilisateurs lorsque nécessaires.

Le domaine fonctionnel ChoreScore (`CompletedEntry`, `Score`, `TodoItem`) ne dépend d'aucun de ces services analytiques. La collecte statistique est une sortie secondaire contrôlée, jamais une raison de contaminer la logique produit.

## Critère de succès

Le système est correctement conçu seulement si une compromission ou vente du Research Analytics Store **ne permet pas raisonnablement de retrouver un foyer ou une personne**, et si les données opérationnelles permettant de faire fonctionner ChoreScore ne sont jamais confondues avec le produit de données commercial.
