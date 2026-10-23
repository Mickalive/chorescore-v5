# ChoreScore V2 — quality gates

Ces gates s'ajoutent aux critères V2-00..V2-07. Un critère n'est pas « fini » parce que le code compile : il doit produire un comportement réel, cohérent avec le blueprint, le design contract, la fiche design concrète, le modèle d'entitlements et la politique de confidentialité des données.

## QG-1 — Aucun faux produit

Avant acceptation d'un critère :
- aucun bouton visible sans comportement réel ou état explicitement indisponible ;
- aucun placeholder/TODO/lorem/demo trompeur dans une fonction déclarée terminée ;
- aucune intégration externe présentée comme active si elle ne l'est pas ;
- aucun écran hérité conceptuellement de la V1 s'il ne correspond pas à la V2 ;
- aucun paywall qui prétend qu'une donnée a été supprimée alors qu'elle est seulement verrouillée ;
- aucun paywall automatique au démarrage ou simple changement d'écran ;
- aucun écran déclaré terminé qui conserve une mise en page manifestement provisoire/générique incompatible avec `docs/DESIGN_BRIEF.md`.

## QG-2 — Référence déterministe

`docs/REFERENCE_SCENARIOS.json` est la fixture canonique de test/démo.

À mesure que les fonctions existent, les tests doivent prouver exactement les valeurs attendues : filtres, soldes réels, soldes pondérés, compensations, historique, conversion To-do -> CompletedEntry, états Premium/Free et reset mensuel.

La fixture reste limitée aux environnements test/démo. Elle ne doit jamais devenir une donnée utilisateur de production.

La démo testable démarre avec l'entitlement `demo-premium` complet, sans achat réel, et peut basculer de façon déterministe vers `demo-free` pour vérifier les restrictions.

## QG-3 — UX écran par écran

Le candidat doit respecter `docs/PRODUCT_BLUEPRINT.md` : hiérarchie des écrans, placement de l'historique, ordre mental des actions, Score, To-do, Options, upgrade et états vides/erreurs.

Toute divergence importante est `mustFix`, même si les tests unitaires sont verts.

Les upsells Premium sont **contextuels** : ils apparaissent quand l'utilisateur demande une capacité Premium, ou via un accès volontaire secondaire. Une bannière/paywall omniprésent ou automatique est `mustFix`.

## QG-4 — Design et accessibilité

Le candidat doit respecter **à la fois** `docs/DESIGN_CONTRACT.md` et `docs/DESIGN_BRIEF.md`.

Le contrat fixe les contraintes ; la fiche design fixe la direction concrète. Un écran peut donc être rejeté même sans bug fonctionnel s'il :
- ressemble à un template générique ou à un prototype non fini ;
- casse le langage visuel entre écrans ;
- réintroduit un blanc dominant, un dashboard SaaS, des cartes imbriquées ou une identité par couleur de membre ;
- place Premium avant la valeur du produit ;
- surcharge le geste principal ;
- rend les chiffres/graphes moins lisibles que la structure définie dans la fiche design.

Au plus tard en V2-05, fournir la **galerie visuelle reproductible** prévue par `DESIGN_BRIEF.md`, au minimum :
- connexion ;
- racine foyers sans paywall agressif ;
- Ajouter une tâche + historique peuplé Premium ;
- Ajouter Free au début d'un nouveau mois avec message d'archive chaleureux/non bloquant ;
- Score Premium réel/pondéré + historique filtré ;
- Score Free limité au mois courant ;
- To-do Premium peuplée ;
- mini-formulaire de complétion ;
- To-do Free avant/après tentative d'une action Premium ;
- upsell historique ;
- Options ;
- share card ;
- au moins un état vide/erreur pertinent.

Les preuves peuvent être captures Android ou autre rendu déterministe suffisamment fidèle au produit mobile. Elles doivent être conservées comme artefacts d'audit. Les checks accessibilité incluent contraste, labels, ordre de focus/lecture, touch targets, grandes tailles de texte et reduce-motion lorsque pertinent.

## QG-5 — Entitlements et non-destruction

Les tests doivent prouver au minimum :
- essai complet = 30 jours ;
- Standard = 2,99 EUR/mois/foyer et maximum 7 membres ;
- Pro = 5,99 EUR/mois/foyer et requis à partir de 8 membres ;
- plan/billing attaché au foyer, jamais propagé globalement au compte ;
- un compte gratuit peut créer/posséder un foyer gratuit ;
- un compte gratuit peut rejoindre plusieurs foyers par invitation sans achat personnel ;
- les droits utilisés dans chaque foyer invité viennent du plan de ce foyer ;
- un foyer supplémentaire créé/possédé dispose de son propre état de plan/billing ;
- gratuit : historique visible et Score limités au mois civil courant ;
- passage au mois suivant : anciens calculs/entrées disparaissent des vues gratuites mais les données persistent ;
- si une archive antérieure existe, les pages d'historique affichent un message chaleureux/non bloquant indiquant qu'elle n'est pas perdue et que Premium la restaure ;
- upgrade : les données historiques redeviennent immédiatement accessibles ;
- downgrade : aucune CompletedEntry, PersistentTask, donnée de pondération ou TodoItem n'est supprimée ;
- gratuit : pondération inactive ;
- gratuit : planification To-do inactive ;
- démo/test : Premium complet utilisable sans transaction réelle et clairement isolé de la production.

## QG-6 — Performance perceptible

Pour les parcours locaux cœur :
- pas d'attente réseau artificielle ;
- saisie/validation immédiatement reflétée dans l'UI ;
- listes raisonnables virtualisées ou bornées correctement ;
- aucun recalcul de Score perceptiblement bloquant sur des volumes domestiques réalistes ;
- le chrono et les données survivent aux reprises prévues.

## QG-7 — Golden path Android obligatoire

Avant V2-07 complet, le repo doit fournir un script `npm run e2e:android` (ou contrat équivalent explicitement appelé par la Factory) exécuté sur l'APK installé, réseau désactivé lorsque le scénario est local.

Il doit automatiser au minimum le `goldenPath` de `docs/REFERENCE_SCENARIOS.json` :
1. démarrer dans le foyer démo avec Premium test débloqué ;
2. vérifier qu'aucun paywall réel n'interrompt le démarrage ;
3. vérifier les trois onglets ;
4. créer une CompletedEntry avec Fait par/Fait pour ;
5. vérifier l'historique ;
6. vérifier Score et un résultat chiffré attendu ;
7. terminer une To-do en renseignant le temps ;
8. vérifier qu'une seule CompletedEntry est créée et que Score change ;
9. déclencher un contexte de share sheet système quand la plateforme le permet ;
10. basculer en Free déterministe ;
11. vérifier qu'une action Premium déclenche un upsell contextuel et non un paywall au lancement ;
12. exécuter le scénario de changement de mois : anciennes entrées cachées mais persistées ;
13. vérifier le petit message d'archive non bloquant ;
14. repasser en Premium test et vérifier que l'archive réapparaît.

Le test E2E produit un dossier de preuves : résultat machine lisible + captures aux checkpoints utiles. Un simple lancement de l'app n'est pas une preuve suffisante de V2-07.

## QG-8 — Audit de régression cumulative

À chaque cycle, l'Auditor contrôle aussi les invariants des critères déjà acceptés. Une nouvelle fonction qui casse un flux antérieur entraîne `repair`/`reject`, même si le critère courant est localement correct.

## QG-9 — Privacy-first research data

À partir de V2-06, le candidat doit respecter `docs/DATA_PRODUCT_PRIVACY.md`.

### Séparation obligatoire

Les tests/audits doivent prouver :
- le store opérationnel nécessaire à la sync est séparé du Research Analytics Store ;
- désactiver `ResearchAnalyticsGateway` ne casse aucune fonction produit ;
- le store opérationnel n'est jamais exposé comme produit de données ;
- aucune clé de jointure externe ne permet de revenir du plan analytique au compte/foyer.

### Schéma analytique interdit

Un schéma ou export analytique échoue automatiquement s'il contient :
- user/account/member/household ID opérationnel ;
- email/téléphone/OAuth subject ;
- IP/device/advertising ID ;
- nom de membre ou de foyer ;
- `label` ou note libre brute ;
- adresse/GPS précis ;
- clé stable permettant une reconstruction longitudinale foyer-par-foyer sans Privacy Release Gate.

### Taxonomie et généralisation

- le texte libre est transformé en taxonomie statistique versionnée avant analytics externe ;
- timestamps, localisation et éventuelles données démographiques sont généralisés lorsque nécessaire ;
- aucune variable sociologique sensible/riche n'est inférée depuis un prénom ou un comportement.

### Privacy Release Gate

Aucune sortie externe n'est acceptée sans preuve machine/gouvernance de :
- suppression des identifiants et textes libres ;
- seuil de cohortes/cellules rares ;
- suppression complémentaire lorsque nécessaire ;
- protection contre differencing/reconstruction ;
- provenance + version de transformation ;
- finalité/destinataire autorisés ;
- journal d'export ;
- évaluation du risque de ré-identification pour tout nouveau type de produit.

Pour une API de requêtes flexibles, le design doit prévoir query budget/rate limit et differential privacy lorsque nécessaire.

### Produits externes autorisés

- agrégats/cohortes ;
- API statistique protégée ;
- exports agrégés de recherche ;
- données synthétiques ;
- environnement sécurisé/clean room.

**Un export de lignes réelles foyer-par-foyer, même pseudonymisées, est `mustFix` et release-blocking.**
