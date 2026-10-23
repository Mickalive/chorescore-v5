# ChoreScore — constitution produit

## Principe

**KISS. ChoreScore est un Tricount du temps domestique, avec une To-do partagée.**

Une suite de tests verte ne valide pas un produit qui ne respecte pas cette constitution.

# 1. Connexion, écran racine et foyers

En production, l'utilisateur se connecte avec son propre compte : compte ChoreScore, Google ou Facebook. Son identité connectée est fixe : il ne peut pas changer arbitrairement « qui je suis » dans l'application.

Après connexion, l'écran racine affiche :
- les foyers auxquels l'utilisateur appartient ;
- `Créer un foyer` si son quota d'abonnement le permet encore ;
- un accès simple à `Options` pour tout le monde.

Le nombre de foyers autorisés dépend d'un quota numérique du palier d'abonnement (`householdLimit` ou équivalent). Ne jamais simplifier en `gratuit = 1 / premium = plusieurs`. Les limites/prix exacts viennent de la configuration canonique de facturation.

## Options

Tout utilisateur dispose d'un accès `Options` pour ses réglages personnels, notifications, confidentialité, informations légales et autres préférences générales.

Le payeur/propriétaire d'un foyer dispose en plus, depuis l'écran racine ou l'accès Options associé au foyer, d'un petit accès **Options du foyer** contenant les fonctions d'administration qui lui appartiennent : abonnement/quota, gestion du foyer et, selon le plan, permissions fines des membres. Cela ne doit pas devenir un quatrième onglet à l'intérieur du foyer.

# 2. Dans un foyer : exactement 3 onglets

1. **Ajouter une tâche**
2. **Score**
3. **To-do**

Pas d'onglet Historique, Classement, Bilan, Profil ou Foyer supplémentaire.

# 3. Ajouter une tâche = saisie + historique complet

Cet onglet est l'équivalent de la liste des dépenses Tricount.

En haut : formulaire minimal pour enregistrer une réalisation.

Une `CompletedEntry` contient au minimum :
- `label` : libellé libre ;
- `performedByMemberId` : **fait par qui** ;
- `beneficiaryMemberIds[]` : **fait pour qui** ;
- durée réelle ;
- foyer ;
- date/heure ;
- `persistentTaskId` facultatif ;
- pondération facultative avancée.

## Fait par

Par défaut, `Fait par` sélectionne l'utilisateur connecté, mais l'utilisateur peut choisir **n'importe quel membre du foyer**. Il est donc possible d'ajouter aujourd'hui une tâche qui a en réalité été faite par quelqu'un d'autre.

L'identité de connexion ne change pas : on distingue toujours `createdBy` / `modifiedBy` de `performedBy` si une traçabilité est nécessaire.

## Fait pour

Comme dans Tricount, une réalisation peut avoir été faite :
- pour **tout le foyer** ;
- ou uniquement pour **1, 2, 3... membres sélectionnés**.

Le formulaire fournit un sélecteur multiple simple. `Tout le monde` est un raccourci pratique. Il doit toujours y avoir au moins un bénéficiaire.

Par défaut, lorsqu'aucun cas particulier n'est choisi, la saisie peut proposer `Tout le monde` afin de rester rapide.

## Durée

Il existe exactement deux façons de renseigner la durée :
- **manuellement** ;
- **chrono**.

**1 minute réelle = 1 minute réelle.**

## Historique complet

Sous la zone d'ajout : **tout l'historique chronologique du foyer**, comme la liste des dépenses Tricount.

Chaque entrée reste indépendante et affiche de façon compacte : tâche, durée, fait par, fait pour, date. Les membres peuvent modifier/supprimer les entrées dans le modèle de confiance par défaut.

# 4. PersistentTask = filtre de Score

Une `PersistentTask` est facultative. Elle sert à :
- accélérer la prochaine saisie ;
- mémoriser éventuellement une pondération par défaut ;
- créer **exactement un filtre stable dans Score**.

**Une PersistentTask = un filtre.**

Les libellés libres non persistants ne créent jamais de nouveaux filtres, même s'ils se répètent. Ils restent visibles individuellement dans l'historique complet et sont tous regroupés sous le seul filtre **Autres** dans Score.

Une PersistentTask n'est ni une réalisation ni une To-do.

# 5. Score = statistiques + équilibres + historique filtré

Score est l'équivalent fonctionnel de la vue **Équilibres** de Tricount, enrichi de statistiques.

Il ne remplace pas l'historique complet sous Ajouter une tâche, mais il peut afficher **en dessous l'historique correspondant exactement au filtre et à la période sélectionnés**.

## Périodes

- Semaine
- Mois
- Année
- Depuis le début

## Filtres

- Toutes
- une entrée par `PersistentTask`
- Autres

Aucun filtre automatique créé depuis les libellés ponctuels.

## Calcul de l'équilibre — logique Tricount

Le calcul doit tenir compte de **fait par** et **fait pour**.

Pour chaque CompletedEntry de durée réelle `D` et de bénéficiaires `B` :
- le membre `performedBy` reçoit un crédit de `+D` ;
- chaque bénéficiaire reçoit une charge de `-D / |B|` ;
- si le membre qui a fait la tâche fait lui-même partie des bénéficiaires, il reçoit naturellement son crédit puis sa propre quote-part de charge.

Le solde réel d'un membre est la somme de ces crédits et charges sur la période/filtre.

Exemples :
- A fait 60 min pour A+B : A = +30 min net, B = -30 min ;
- A fait 60 min uniquement pour B : A = +60 min, B = -60 min ;
- A fait 60 min uniquement pour A : solde net 0 pour cette entrée.

La somme de tous les soldes est zéro. À partir des soldes positifs/négatifs, l'app calcule une **proposition simple de compensation pair-à-pair**, comme Tricount : qui doit rattraper combien de temps auprès de qui.

## Statistiques réelles

Afficher clairement :
- solde/avance/retard réel de chaque membre ;
- proposition `qui doit combien de temps à qui` ;
- total de temps réellement effectué par chaque membre ;
- un graphique simple en barres avec **le nom du membre directement associé à chaque barre** et les heures/minutes lisibles.

**Ne pas dépendre d'une couleur permanente par membre.** Les couleurs peuvent servir à la lisibilité du graphique, mais l'identité est portée par le nom/label ; l'app doit fonctionner avec n'importe quel nombre raisonnable de membres sans palette identitaire limitée.

## Pondération

La pondération est une option avancée, coefficient 1 par défaut, qui ne modifie jamais la durée réelle.

Pour l'équilibre pondéré, appliquer exactement la même logique `fait par / fait pour` mais avec `Dpondere = Dreel × coefficient`.

Afficher après la partie réelle :
- soldes/compensations en heures pondérées ;
- second graphique des heures pondérées par membre.

Le temps réel reste toujours la métrique principale. Aucun point abstrait.

## Historique filtré dans Score

Sous les statistiques/graphes, afficher la liste des CompletedEntry qui correspondent **à la période et au filtre sélectionnés**.

Donc :
- Ajouter une tâche = historique **complet** ;
- Score = historique **contextuel/filtré** sous les statistiques.

# 6. To-do = planning futur

Une `TodoItem` représente quelque chose à faire dans le futur.

Elle peut être :
- sans date précise ;
- datée / avec deadline ;
- assignée à un membre ;
- faite pour tout le monde ou certains membres si pertinent ;
- accompagnée d'une note ;
- dotée d'un reminder/notification ;
- synchronisable avec un calendrier lorsque l'intégration réelle existe ;
- liée facultativement à une PersistentTask.

Les membres peuvent par défaut créer/modifier/assigner/réorganiser les To-do pour le foyer. Les permissions fines peuvent être limitées par le propriétaire selon son plan.

## Validation d'une To-do

Chaque To-do possède un check de validation clair.

Quand elle est marquée comme faite :
1. l'app ouvre un mini-formulaire ;
2. `Fait par` vaut par défaut le membre qui valide, mais peut être changé pour n'importe quel membre du foyer ;
3. l'app demande la durée réelle ;
4. `Fait pour` reprend les bénéficiaires de la To-do s'ils sont définis, sinon permet de choisir ;
5. la To-do passe terminée ;
6. une CompletedEntry indépendante est créée ;
7. elle apparaît immédiatement dans l'historique complet et dans Score.

# 7. Partage natif et viralité

Le partage doit être **facile et contextuel dans toute l'application** via le partage natif du téléphone et les applications/réseaux disponibles.

Au minimum :
- depuis Ajouter une tâche : partager une entrée ou une portion sélectionnée de l'historique ;
- depuis Score : partager le Score courant (période + filtre), les équilibres/compensations et/ou une image/carte des graphes ;
- depuis l'historique filtré de Score : partager cette sélection ;
- depuis To-do : partager une To-do ou un planning utile lorsque pertinent.

Le contenu partagé peut être présenté sous forme de **share card ChoreScore** claire, reconnaissable et visuellement attractive afin de favoriser la viralité (par exemple autour du partage de charge domestique / #ChargeMentale), sans inventer de jugement moral ou de texte culpabilisant.

L'utilisateur choisit ce qu'il partage. Ne jamais exposer automatiquement plus d'informations personnelles que ce qui est visible/sélectionné dans le contenu partagé.

# 8. Collaboration et identité

Le fonctionnement par défaut repose sur la confiance, comme Tricount : les membres peuvent saisir/corriger les réalisations et To-do pour les autres membres.

L'identité de connexion reste fixe. `Fait par` est une donnée de l'entrée, pas une usurpation de l'identité connectée.

# 9. Notifications et calendrier

Les préférences peuvent couvrir :
- nouvelle réalisation ;
- modification/suppression ;
- nouvelle To-do assignée ;
- deadline/rappel ;
- autres événements utiles explicitement configurés.

Elles doivent être réglables pour éviter le spam.

OAuth, push distant, calendrier, paiement et synchronisation réseau ne sont jamais simulés comme réels dans une RC locale.

# 10. Design

Direction : **feel-good, chaleureuse, contemporaine, énergique mais pas enfantine**.

- éviter le blanc dominant ;
- fonds teintés doux ;
- surfaces colorées légères ;
- graphes lisibles avec noms directement visibles ;
- ne pas lier l'identité des membres à une palette finie de couleurs ;
- typographie nette ;
- peu de texte ;
- partage visuellement attractif ;
- aucun commentaire moral/relationnel automatique ;
- accessibilité/contrastes conservés.

# 11. Trois objets métier distincts

- `CompletedEntry` = réalisation passée, avec `performedByMemberId` + `beneficiaryMemberIds`.
- `PersistentTask` = raccourci + **filtre Score** facultatif.
- `TodoItem` = tâche future.

Ne jamais fusionner ces concepts.

# 12. Critères de rejet immédiat

Rejeter tout candidat qui :
- met Ajouter/Score/To-do au niveau global plutôt qu'à l'intérieur d'un foyer ;
- ne permet pas de choisir `Fait par` parmi les membres du foyer ;
- ne permet pas de choisir `Fait pour` parmi un ou plusieurs membres ;
- calcule Score sans tenir compte des bénéficiaires ;
- crée automatiquement des filtres Score depuis les libellés non persistants ;
- dépend d'une couleur fixe par membre ;
- supprime l'historique complet sous Ajouter une tâche ;
- ne montre pas l'historique filtré sous Score ;
- ne permet pas le partage contextuel du Score/historique ;
- marque une To-do terminée sans demander le temps et créer une CompletedEntry ;
- remplace les heures par des points ;
- ajoute des messages moraux/relationnels ;
- rend l'UX inutilement complexe.

**Structure finale : Connexion -> Foyers -> [Ajouter une tâche + historique complet | Score/Équilibres + stats + historique filtré | To-do].**
