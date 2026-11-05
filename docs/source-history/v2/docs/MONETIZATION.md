# ChoreScore V2 — modèle freemium et abonnements

Ce document reprend **la dernière grille V1 effectivement codée** puis l'adapte au produit V2. Les comportements sont pilotés par des entitlements, jamais par des conditions dispersées dans l'UI.

## Grille commerciale héritée de V1

### Essai complet

- **30 jours** ;
- toutes les fonctions Premium activées pendant l'essai ;
- aucune donnée n'est détruite à la fin de l'essai.

### Gratuit

- l'utilisateur peut **créer/posséder un foyer gratuit** ;
- il peut rejoindre sans payer les foyers auxquels il est invité ;
- saisie CompletedEntry manuelle ou chrono ;
- `Fait par` et `Fait pour` ;
- PersistentTask ;
- partage système ;
- historique visible limité au **mois civil courant** ;
- Score limité au **mois civil courant** ;
- aucune pondération ;
- aucune planification To-do.

### Standard

- **2,99 € / mois / foyer** ;
- jusqu'à **7 membres** dans le foyer ;
- fonctions Premium du foyer ;
- historique complet ;
- pondération ;
- To-do ;
- export PDF/avancé ;
- possibilité de créer/posséder plusieurs foyers, chaque foyer payant gardant son propre abonnement ;
- fonctions avancées prévues par l'entitlement.

### Pro

- **5,99 € / mois / foyer** ;
- requis **à partir de 8 membres** ;
- mêmes fonctions cœur Premium que Standard ;
- capacité de taille supérieure du foyer.

La V1 attachait la facturation au foyer. V2 conserve ce principe : le plan effectif et les droits payants sont résolus au niveau du foyer, avec un propriétaire/payeur. L'utilisateur peut appartenir à plusieurs foyers sans mélanger leurs abonnements ni leurs données.

Les prix restent configurables pour localisation, stores et évolutions commerciales ; **2,99 € / 5,99 € sont les références canoniques V1**, pas des constantes métier à répéter dans le code.

## Mode démo / test

La version testable utilisée par la Factory, les QA, les captures et le golden path doit disposer d'un **entitlement Premium complet débloqué** afin que l'intégralité du produit soit testable sans achat réel.

Règles :
- ce mode est explicitement `demo/test`, jamais présenté comme un abonnement réel ;
- aucune transaction ni faux checkout n'est nécessaire pour accéder aux fonctions Premium dans ce mode ;
- pondération, archive, To-do et autres fonctions Premium doivent être réellement utilisables dans la démo ;
- le mode démo doit aussi pouvoir basculer vers un **état Free déterministe** pour tester les restrictions, les messages d'archive et les transitions d'entitlement ;
- le code de production ne doit pas pouvoir activer silencieusement cet entitlement de test.

## Entitlements

Le modèle expose au minimum :
- `plan: free | trial | standard | pro` ;
- `memberLimit` ;
- `canCreateAdditionalOwnedHousehold` ou équivalent ;
- `scoreArchiveAccess` ;
- `historyArchiveAccess` ;
- `weightingEnabled` ;
- `todoPlanningEnabled` ;
- `advancedExportEnabled` ;
- `finePermissionsEnabled` si retenu.

Le nombre de foyers **rejoints par invitation** n'est pas limité par le fait que le compte soit gratuit. La limite gratuite concerne la création/possession d'un foyer gratuit. Un foyer invité apporte ses propres droits selon son propre plan.

Ne jamais déduire tous les droits uniquement du nom du plan dans l'UI. Les écrans consomment des capacités résolues par `EntitlementGateway`.

## Historique gratuit et reset mensuel intelligent

Pour le plan gratuit, les vues d'historique et Score n'affichent que les CompletedEntry appartenant au **mois civil courant**.

À chaque changement de mois :
- l'historique visible sous Ajouter une tâche repart sur le nouveau mois ;
- le Score gratuit repart visuellement sur le nouveau mois ;
- soldes, graphes, statistiques et historique filtré antérieurs quittent la fenêtre gratuite ;
- **aucune CompletedEntry n'est supprimée ni écrasée** ;
- les données antérieures restent persistées ;
- un upgrade Trial/Standard/Pro les rend immédiatement à nouveau visibles partout.

`Semaine` reste disponible lorsqu'elle tombe dans le mois courant. `Mois` = mois courant. `Année`, `Depuis le début` et la consultation de mois antérieurs nécessitent `scoreArchiveAccess`.

Le reset mensuel ne supprime jamais les PersistentTask : elles restent les filtres/raccourcis stables du foyer.

### Message d'archive gratuit

Sur les écrans comportant un historique, lorsqu'un utilisateur Free possède des données plus anciennes que le mois courant, afficher un **petit message chaleureux et non bloquant**, intégré à la page.

Intention de ton : léger, rassurant, feel-good, pas culpabilisant et pas anxiogène. Exemple de référence :

> « Nouveau mois 🌿 Ton historique précédent est bien au chaud. Avec ChoreScore Premium, tu peux le retrouver à tout moment. »

Le texte exact peut évoluer avec le design, mais il doit toujours communiquer trois choses :
1. la fenêtre gratuite a changé de mois ;
2. les données ne sont pas perdues ;
3. Premium permet de les retrouver.

Pas de modal automatique pour ce message, pas de compte à rebours, pas de faux danger, pas de paywall plein écran au lancement.

## Pondération Premium

En gratuit :
- la durée réelle fonctionne normalement ;
- le coefficient effectif est 1 ;
- aucune modification de pondération ;
- aucune section pondérée active dans Score.

En Trial/Standard/Pro, la pondération est disponible.

Après downgrade, les poids déjà stockés restent conservés, mais le produit gratuit utilise le temps réel/coefficient effectif 1 et n'expose pas l'édition Premium. Un nouvel upgrade restaure les données de pondération sans perte.

## To-do Premium

La planification To-do est disponible en Trial/Standard/Pro :
- tâche avec ou sans date ;
- assignation ;
- bénéficiaires ;
- deadline ;
- notes ;
- reminder ;
- calendrier lorsque l'intégration réelle est configurée ;
- conversion en CompletedEntry après check + saisie du temps.

En gratuit, l'onglet To-do reste à sa place dans la navigation canonique mais affiche un état Premium utile avec possibilité d'upgrade. Il ne permet pas de créer/planifier de nouvelles TodoItem.

Après downgrade, aucune TodoItem existante n'est détruite. Elle reste persistée et redevient accessible après upgrade.

## Multi-foyers et invitations

La règle canonique V2 est :
- un compte gratuit peut créer/posséder **un foyer gratuit** ;
- il peut **rejoindre plusieurs foyers par invitation** sans devoir devenir Premium lui-même ;
- les capacités disponibles dans un foyer invité dépendent du plan de ce foyer ;
- pour créer/posséder des foyers supplémentaires, chacun doit disposer de son propre état de plan/billing (trial, Standard ou Pro selon le cas) ;
- les droits d'un foyer ne se propagent jamais à un autre foyer.

Cette règle préserve la viralité des invitations tout en restant cohérente avec une facturation **par foyer**.

## Upgrade : contextuel, jamais agressif

L'utilisateur ne doit pas être accueilli par un paywall ni subir une sollicitation de paiement avant d'avoir utilisé le produit.

L'upgrade apparaît surtout **au moment où une action Premium est demandée** :
- ouvrir un historique antérieur au mois courant ;
- choisir `Année` / `Depuis le début` ;
- activer/modifier une pondération ;
- créer ou planifier une To-do ;
- créer/posséder un foyer supplémentaire ;
- utiliser une autre fonction explicitement Premium.

Le paywall contextuel explique brièvement **ce que cette action débloque**, permet de revenir immédiatement au produit et n'efface jamais la saisie en cours.

L'écran racine peut contenir un accès Premium/Upgrade discret dans Options ou dans une zone secondaire, mais pas une bannière omniprésente ni une interruption automatique.

Le produit peut montrer qu'il existe des données historiques conservées, mais ne doit jamais prétendre qu'elles sont détruites. L'intérêt commercial vient de la valeur accumulée, pas d'une fausse urgence.

## BillingGateway / EntitlementGateway

Le domaine et l'UI ne dépendent jamais directement d'un fournisseur de paiement.

La V1 utilisait Stripe côté backend ; V2 garde le contrat fournisseur-agnostique :
- `BillingGateway` gère achat/restauration/état de facturation du foyer ;
- `EntitlementGateway` traduit cet état en capacités produit ;
- adapters StoreKit / Google Play Billing lorsque les règles des stores l'exigent ;
- Stripe ou autre adapter sur les canaux où il est permis ;
- restauration et synchronisation d'abonnement prévues proprement.

Aucun paiement factice ne doit être présenté comme réel dans une RC locale.
