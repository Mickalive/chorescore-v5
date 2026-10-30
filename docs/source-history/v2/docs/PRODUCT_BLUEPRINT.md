# ChoreScore V2 — blueprint produit écran par écran

Ce document précise la forme du produit décrit par `MAIN_PROMPT.md`. En cas de conflit, `MAIN_PROMPT.md` prévaut. Il sert à empêcher les agents d'inventer des écrans, des parcours ou des hiérarchies différentes.

## 1. Connexion

Écran sobre et direct. En production : compte ChoreScore/email, Google, Facebook via `AuthGateway`. En développement sans secrets, montrer clairement le mode local/test ; ne jamais faire passer un faux OAuth pour une connexion réelle.

But : atteindre l'écran des foyers avec une identité fixe.

## 2. Racine — Foyers

Contenu principal uniquement :
- tous les foyers auxquels l'utilisateur appartient, y compris ceux rejoints par invitation ;
- `Créer un foyer` si l'entitlement le permet ;
- accès `Options` ;
- accès Premium/Upgrade **secondaire et discret** lorsque pertinent ;
- pour le propriétaire/payeur, accès discret aux `Options du foyer`.

Un compte gratuit peut rejoindre plusieurs foyers par invitation. Sa limite gratuite porte sur la création/possession d'un foyer gratuit, pas sur le nombre de foyers auxquels il peut appartenir.

Chaque foyer est une ligne/carte simple ouvrable. Son plan peut être signalé discrètement lorsqu'utile, puisque la facturation est attachée au foyer. Ne pas transformer la racine en dashboard statistique ni en vitrine de paiement.

L'utilisateur ne doit pas voir un paywall plein écran au démarrage. La grille canonique — essai complet 30 jours, Standard 2,99 €/mois/foyer jusqu'à 7 membres, Pro 5,99 €/mois/foyer à partir de 8 membres — apparaît lorsqu'il demande à voir les offres ou tente une fonction Premium.

## 3. Foyer ouvert

Navigation principale exactement :

`Ajouter une tâche | Score | To-do`

Le nom du foyer reste identifiable dans l'en-tête. Options et compte ne deviennent jamais un quatrième onglet.

Les capacités visibles dépendent du plan **de ce foyer**, pas d'un statut Premium global du compte.

## 4. Ajouter une tâche

### Zone de saisie

Doit rester rapide, avec les champs essentiels dans cet ordre mental :
1. quoi ? `label` libre ou PersistentTask ;
2. qui l'a fait ? `Fait par` ;
3. pour qui ? `Tout le monde` ou multi-sélection ;
4. combien de temps ? `Manuel | Chrono` ;
5. quand ? date/heure ;
6. `Options avancées` repliées : pondération si l'entitlement l'autorise et rares paramètres secondaires.

Le membre connecté est proposé par défaut dans `Fait par`, mais peut être remplacé par n'importe quel membre du foyer.

Sur un foyer Free, la saisie de base reste totalement utilisable. Si l'utilisateur demande la pondération, afficher à ce moment un message/upgrade contextuel expliquant la fonction Premium. Ne pas afficher une grosse bannière Premium en permanence dans le formulaire.

### PersistentTask

Un libellé peut rester ponctuel ou être enregistré comme PersistentTask. Les PersistentTask existantes doivent accélérer la saisie sans transformer l'écran en catalogue de tâches.

### Historique

Sous la saisie : flux chronologique des CompletedEntry accessibles, analogue à la liste des dépenses Tricount.

Chaque ligne montre au minimum : libellé, durée, fait par, fait pour, date/heure. Modifier/supprimer via menu compact/détail. Une action de partage permet de partager une entrée ou une sélection utile via le share sheet natif.

En Trial/Standard/Pro, l'historique est complet. En Free, il montre le **mois civil courant**. Les entrées plus anciennes restent persistées.

Lorsqu'une archive plus ancienne existe, afficher dans la page un **petit message chaleureux, non bloquant et visuellement secondaire**. Référence de ton :

> Nouveau mois 🌿 Ton historique précédent est bien au chaud. Avec ChoreScore Premium, tu peux le retrouver à tout moment.

Le message peut contenir une action discrète `Retrouver mon historique` / `Découvrir Premium`, mais jamais ouvrir automatiquement une modale.

## 5. Score

Score est la vue `Équilibres + statistiques`, pas un deuxième écran d'ajout.

Ordre recommandé :
1. sélecteur de période `Semaine | Mois | Année | Depuis le début` ;
2. filtre `Toutes | chaque PersistentTask | Autres` ;
3. soldes réels / avance-retard ;
4. proposition `qui doit rattraper combien auprès de qui` ;
5. graphique simple du temps réel effectué par membre, noms et valeurs directement lisibles ;
6. section pondérée secondaire lorsque Premium ;
7. historique correspondant exactement à la période + au filtre courants.

Chaque PersistentTask crée exactement un filtre. Les libellés ponctuels ne créent jamais de filtre individuel ; ils appartiennent à `Autres`.

Les graphes ne dépendent pas d'une couleur identitaire fixe par membre. Le nom est toujours l'identifiant visuel principal.

### État gratuit

Pour un foyer Free :
- Score porte uniquement sur le **mois civil courant** ;
- `Semaine` et `Mois` restent utilisables dans cette fenêtre ;
- `Année`, `Depuis le début` et les données antérieures sont Premium ;
- la section pondérée n'est pas active ;
- l'archive antérieure reste persistée.

Si l'utilisateur appuie sur une période/option Premium, ouvrir un **upsell contextuel** bref. Si une archive antérieure existe, le même petit message chaleureux que sous Ajouter peut être affiché dans la page. Aucun paywall automatique à l'ouverture de Score.

Le passage au mois suivant produit un nouveau Score mensuel sans effacer les données persistées.

Le partage du Score courant utilise le share sheet système et peut produire une carte ChoreScore propre, limitée aux informations sélectionnées/visibles.

## 6. To-do

Écran de travail futur, distinct des réalisations passées.

### État Trial / Standard / Pro

Une To-do peut être sans date, datée/deadline, assignée, faite pour tout ou partie du foyer, liée à une PersistentTask, accompagnée d'une note et d'un rappel. La liste reste simple et scannable.

### État gratuit

L'onglet reste visible. L'utilisateur peut comprendre ce que permet To-do sans subir un paywall à l'entrée. Lorsqu'il tente de **créer/planifier** une tâche, afficher l'upgrade contextuel Premium. Un état vide peut expliquer sobrement que la planification fait partie de Premium avec une action secondaire pour en savoir plus.

Aucune TodoItem existante n'est supprimée après downgrade.

### Check vert — tâche faite

Le check ouvre un mini-formulaire : `Fait par`, durée réelle, `Fait pour`. Validation atomique : TodoItem terminée + CompletedEntry créée. La nouvelle entrée apparaît immédiatement dans l'historique et modifie Score.

## 7. Options

### Options personnelles

Notifications, confidentialité, légal, préférences, compte/connexion et autres réglages individuels.

### Options du foyer

Visibles au propriétaire/payeur selon ses droits : abonnement du foyer, administration, membres, restauration/gestion de l'achat et permissions fines disponibles selon le plan.

Un accès volontaire aux offres Premium peut exister ici sans interruption automatique ailleurs.

## 8. Mode démo / test

La version testable doit démarrer dans un **foyer démo Premium entièrement débloqué** pour permettre l'exploration de toutes les fonctions sans achat réel : archive, pondération, To-do, partage et autres capacités implémentées.

Ce mode doit être explicitement identifiable comme démo/test dans l'infrastructure et ne jamais simuler un abonnement payé. Il doit également offrir aux tests un moyen déterministe de basculer vers Free afin de vérifier les restrictions et messages de conversion.

## 9. États obligatoires

Chaque écran important doit avoir : état vide utile, erreur/récupération, fonctionnement offline/local honnête, état Free/Premium lorsque différent, grandes tailles de texte, actions externes non configurées expliquées.

## 10. Interdictions UX

- pas de dashboard générique avant les foyers ;
- pas d'onglet Historique séparé ;
- pas de Classement/Leaderboard ;
- pas de points abstraits ;
- pas de catégories ménagères obligatoires ;
- pas de commentaires moraux ou relationnels automatiques ;
- pas de faux boutons Google/Facebook/calendrier/share/paiement ;
- pas d'interface dominée par des cartes blanches imbriquées ;
- pas de paywall au démarrage ou à chaque changement d'écran ;
- pas de bannière Premium omniprésente ;
- pas de message mensonger de suppression des données historiques ;
- pas de limitation empêchant un utilisateur gratuit d'accepter une invitation ;
- pas de placeholder visible dans un critère déclaré terminé.
