# Décisions produit canoniques

1. ChoreScore est une **application mobile** Expo/React Native.
2. Le concept est volontairement simple : **un Tricount des tâches ménagères**.
3. L'utilisateur crée ou choisit un **foyer** puis enregistre des **entrées de travail domestique**.
4. Une entrée contient au minimum : **nom libre de la tâche**, **personne**, **durée réelle**, **foyer**, **date/heure**.
5. Le nom est toujours libre. Il n'existe aucune catégorie obligatoire, aucun catalogue de tâches et aucune obligation de créer une définition de tâche au préalable.
6. La durée peut être saisie manuellement ou obtenue avec un chrono. Un chrono terminé devient une entrée ordinaire du journal.
7. Le journal du foyer fonctionne comme un registre : ajout, modification et suppression d'entrées réelles.
8. Le bilan principal agrège le **temps réel** par membre et sa part du temps total du foyer.
9. **1 minute réelle reste 1 minute réelle.** Le temps affiché et stocké n'est jamais transformé.
10. Une pondération facultative peut exister uniquement dans `Options avancées` lors de l'ajout ou de la modification d'une entrée. Elle vaut 1 par défaut, reste invisible dans le parcours simple et ne sert qu'à une vue secondaire de contribution pondérée.
11. L'application ne parle jamais de « points » comme métrique principale.
12. ChoreScore n'est pas une todo list et ne gère pas des tâches « à faire », « actives » ou « archivées » dans le parcours cœur.
13. Le foyer est un objet de premier rang : création, choix/changement de foyer, membres et isolation des données.
14. Le bilan de base permet de consulter **semaine, mois, année et depuis le début**. Ces quatre horizons ne sont pas premium.
15. Pour chaque période, l'app affiche le temps total du foyer, le temps de chaque membre et sa part du total en pourcentage.
16. L'interface doit être légère et mobile : une action principale évidente pour ajouter une entrée, peu de texte permanent, pas de batterie de boutons sur chaque ligne, actions rares dans un menu/détail.
17. **L'application n'interprète pas les chiffres et ne commente pas les personnes.** Aucun message du type « discutez des écarts », « ceci n'est pas un verdict », « votre contribution est... », conseil relationnel, encouragement, culpabilisation ou commentaire automatique sur l'équilibre. Elle affiche les données ; l'utilisateur en tire ses propres conclusions.
18. L'essai complet dure 30 jours.
19. Après l'essai, l'offre gratuite conserve un foyer, les entrées libres, la saisie manuelle/chrono et le bilan en temps réel sur semaine/mois/année/depuis le début.
20. Premium ajoute notamment pondération avancée facultative, analyses comparatives/filtres avancés, export et foyers multiples.
21. Standard coûte 2,99 €/mois pour 1 à 7 personnes. Pro coûte 5,99 €/mois à partir de 8 personnes ; mêmes fonctionnalités, seule la taille change.
22. La RC utilise uniquement des données locales, fonctionne hors ligne et ne simule jamais un paiement ou une synchronisation réelle.
23. Les informations légales et de confidentialité restent dans les écrans appropriés et ne doivent pas encombrer le parcours principal.

## Direction visuelle

La palette peut servir de base mais n'est pas une obligation de composition. Le design doit privilégier hiérarchie, espace, typographie, lisibilité et simplicité plutôt que multiplier les cartes colorées.

| Usage | Couleur |
| --- | --- |
| Fond doux | `#F1FAEE` |
| Bleu clair | `#A8DADC` |
| Texte principal | `#264653` |
| Texte secondaire | `#457B9D` |
| Action | `#2A9D8F` |
| Accent | `#E9C46A` |
| Attention | `#F4A261` |
| Erreur | `#E76F51` |
