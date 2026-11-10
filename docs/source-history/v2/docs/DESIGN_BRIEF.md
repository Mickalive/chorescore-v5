# ChoreScore V2 — fiche design concrète

Cette fiche complète `DESIGN_CONTRACT.md` et `PRODUCT_BLUEPRINT.md`. Le contrat fixe les règles ; cette fiche donne une **direction visuelle positive et concrète** afin que le premier APK ressemble déjà à un vrai produit.

## Sensation recherchée

Trois mots : **chaleureux · léger · utile**.

ChoreScore doit évoquer une app mobile domestique contemporaine qu'on ouvre plusieurs fois par semaine, pas :
- un dashboard SaaS ;
- une app bancaire froide ;
- une app de gamification enfantine ;
- une app de couple moralisatrice ;
- une landing page d'abonnement déguisée en application.

Le produit doit sembler calme même lorsqu'il montre un déséquilibre. Les chiffres sont factuels ; le design ne dramatise pas automatiquement la relation entre les membres.

## Direction couleur

La palette exacte reste à implémenter/tester, mais doit respecter cette structure :
- **fond principal teinté chaud**, jamais blanc pur dominant ;
- une couleur d'action principale chaleureuse et nette ;
- une couleur secondaire douce pour surfaces/sections ;
- succès, danger, avertissement réservés aux états sémantiques ;
- texte principal très lisible, texte secondaire clairement hiérarchisé ;
- aucune couleur dédiée à un membre.

Éviter : bleu corporate dominant, vert médical, néons, gradients décoratifs omniprésents, arc-en-ciel par membre.

## Formes et surfaces

- coins légèrement arrondis, cohérents ;
- très peu d'ombres ;
- surfaces distinguées surtout par teinte, espacement et séparateurs ;
- une seule carte forte lorsqu'elle a réellement une fonction ;
- pas de « cartes dans des cartes » ;
- boutons primaires francs, secondaires discrets ;
- icônes simples avec labels quand l'action pourrait être ambiguë.

## Typographie et chiffres

- hiérarchie courte : titre écran, section, corps, annotation ;
- durées et soldes suffisamment grands pour être lus immédiatement ;
- unités en `h` / `min`, jamais en points ;
- noms des membres toujours visibles lorsque leurs valeurs sont comparées ;
- pas de légende de graphe qui oblige à mémoriser des couleurs.

## Écran Connexion

Visuel très simple : marque ChoreScore, proposition courte, méthodes de connexion. Aucun argumentaire Premium ici.

Les boutons Google/Facebook n'apparaissent comme actifs que lorsque les adapters sont réellement configurés. En mode démo/test, l'entrée dans la démo est clairement séparée de ces connexions.

## Racine Foyers

Doit respirer. Chaque foyer est une ligne/carte légère avec : nom, contexte utile minimal, chevron/zone tappable.

En haut ou dans une zone secondaire : `Options`.

`Créer un foyer` est facile à trouver sans devenir un énorme CTA marketing.

Premium : accès discret depuis Options ou une petite zone secondaire. **Aucun paywall au lancement.** Le statut du foyer peut être montré subtilement (`Essai`, `Standard`, `Pro`) lorsqu'utile.

## Ajouter une tâche

C'est l'écran qui doit sembler le plus rapide.

Composition recommandée :
1. libellé / PersistentTask ;
2. ligne compacte `Fait par` ;
3. ligne compacte `Fait pour` ;
4. grand choix simple `Durée | Chrono` ;
5. date/heure discrète ;
6. `Options avancées` repliées ;
7. action primaire de validation ;
8. historique immédiatement en dessous.

Ne pas transformer le formulaire en wizard multi-écrans.

L'historique ressemble à une liste transactionnelle : libellé + durée en premier, fait par/pour + date en secondaire, menu `…` pour modifier/supprimer/partager.

### Free au début du mois

Quand une archive antérieure existe, insérer dans le flux une petite surface douce, non bloquante. Référence de ton :

> **Nouveau mois 🌿** Ton historique précédent est bien au chaud. Avec ChoreScore Premium, tu peux le retrouver à tout moment.

CTA secondaire seulement (`Retrouver mon historique`). Le contenu du mois courant reste immédiatement visible.

## Score

Le haut d'écran doit répondre en quelques secondes à : **où en est le foyer ?**

Composition recommandée :
1. période ;
2. filtre tâche ;
3. synthèse des soldes ;
4. compensation/rattrapage lisible ;
5. barres de temps par membre ;
6. pondéré secondaire si Premium ;
7. historique filtré.

Les soldes ne doivent pas ressembler à un classement gagnant/perdant. Présenter les valeurs et le rattrapage de façon neutre.

Graphes : barres simples, valeurs directement affichées, noms directement liés aux barres. Aucun donut décoratif par défaut.

### Score Free

Semaine/Mois courant restent normaux. Une action sur archive/Année/Depuis le début ouvre alors seulement l'upsell contextuel. Ne pas assombrir ou « casser » tout l'écran parce que l'utilisateur est Free.

## To-do

Premium/démo : liste scannable, séparant naturellement `À faire` et éventuellement les échéances proches sans devenir un gestionnaire de projet.

Chaque ligne : check clair, titre, assigné, date si présente. Détails secondaires en ouverture.

Le check ouvre un mini-formulaire court `Fait par · Temps · Fait pour` avant validation.

Free : l'onglet reste utilisable comme découverte du concept. Pas de modal immédiate. L'upsell apparaît lorsqu'on tente réellement de créer/planifier une tâche Premium.

## Upsell / paywall

Le paywall est un **écran de réponse à une intention**, jamais une étape obligatoire du parcours initial.

Ordre du contenu :
1. fonction demandée (`Planifier les tâches`, `Retrouver l'historique`, `Activer la pondération`) ;
2. bénéfice concret en une phrase ;
3. plans disponibles ;
4. action d'achat/restauration quand réellement branchée ;
5. retour immédiat au produit.

Ne jamais perdre un formulaire commencé lorsque l'upsell apparaît.

Référence commerciale : Essai complet 30 jours ; Standard 2,99 €/mois/foyer jusqu'à 7 membres ; Pro 5,99 €/mois/foyer à partir de 8 membres. Les prix affichés par l'app de production proviennent du billing configuré.

## Share cards

Visuelles, reconnaissables, très lisibles sur mobile. Peu de texte. Montrer uniquement la sélection choisie par l'utilisateur.

Une carte Score peut contenir : période, foyer si l'utilisateur l'autorise, noms visibles déjà sélectionnés, temps/soldes, signature ChoreScore discrète.

Aucun slogan culpabilisant généré automatiquement. `#ChargeMentale` peut être proposé comme élément de partage si le produit le décide, jamais imposé.

## Options

Écran calme, liste de réglages classique. Séparer clairement :
- compte/personnel ;
- notifications ;
- confidentialité/données ;
- légal ;
- abonnement ;
- Options du foyer pour owner/payeur.

Les réglages recherche/analytics doivent être compréhensibles et séparés des réglages nécessaires au fonctionnement du compte.

## États visuels à concevoir explicitement

Le Builder ne doit pas improviser ces états à la fin :
- foyer vide ;
- historique vide ;
- Score sans données ;
- chrono actif ;
- erreur de persistence/sync ;
- mode offline ;
- Free avec archive antérieure ;
- Free demandant To-do ;
- Premium/démo ;
- gros foyer avec nombreux membres ;
- texte système agrandi ;
- contenu très long/localisé.

## Galerie de référence obligatoire

Au plus tard V2-05, conserver des captures reproductibles au minimum de :
1. connexion ;
2. racine foyers ;
3. Ajouter Premium avec historique ;
4. Ajouter Free nouveau mois + note d'archive ;
5. Score Premium ;
6. Score Free ;
7. To-do Premium ;
8. mini-form de complétion ;
9. To-do Free avant/après tentative de création ;
10. upsell historique ;
11. Options ;
12. share card.

## Critères visuels de rejet

Rejeter si :
- le produit paraît être un template générique ;
- la majorité de l'écran est blanche sans raison ;
- les écrans ont des styles différents entre eux ;
- les champs/actions sont plus nombreux que le geste métier ne le nécessite ;
- les graphes nécessitent une légende couleur pour identifier les membres ;
- Premium domine visuellement le produit avant une intention d'achat ;
- les écrans demo/test diffèrent visuellement du vrai Premium ;
- un écran terminé contient encore un placeholder, une mise en page provisoire ou un composant manifestement jetable.

## Règle de finition

Le premier APK n'est pas jugé seulement sur « ça marche ». Il doit donner l'impression d'un **petit produit cohérent et volontaire**, même si certaines intégrations réseau restent désactivées faute de secrets. La cohérence visuelle, la densité, les états Free/Premium et les micro-interactions font partie de la définition de fini.
