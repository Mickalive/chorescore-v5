# Instructions de contribution assistée

Lire dans cet ordre : `MAIN_PROMPT.md`, `governance/RELEASE_DEFINITION.json`, la fiche du rôle, `docs/RELEASE_STATUS.json`, `directives/TASKS.json`, la directive active, puis le canon produit/architecture.

La fiche de poste définit le pouvoir du rôle ; une tâche ne peut jamais l'agrandir.

## Invariants

- `EXPO_PUBLIC_DATA_MODE=demo` reste le mode sûr par défaut.
- La démo utilise des données locales synthétiques et fonctionne sans réseau au runtime.
- Aucun secret, paiement, Firebase réel, analytics ou déploiement.
- Aucun agent ne change de branche, ne committe, ne pousse ou ne fusionne.
- Aucun agent ne modifie `.github/**`, `.opencode/**`, `MAIN_PROMPT.md`, `AGENTS.md`, `governance/**`, `directives/DIRECTOR.md`, les dépendances ou lockfiles.
- Un audit avec au moins un `mustFix: true` interdit l'intégration.
- Aucun placeholder ou succès simulé n'est présenté comme terminé.

## Rôles

- Mobile : `app/**`, `src/**`, `tests/**`.
- Backend : `functions/src/**`, `functions/test/**`, `docs/security/**` et règles/config Firebase autorisées.
- Auditeur : `reports/audits/**` uniquement.
- Directeur : tâches/directives dynamiques, `docs/RELEASE_STATUS.json`, `docs/NEXT_CYCLE.md`, `reports/director/**`.

Le **seul workflow actif** est `.github/workflows/chorescore-factory.yml`. Mobile et Backend travaillent en lanes parallèles ; leurs auditeurs sont indépendants et parallèles. Les candidats sont des artefacts temporaires, jamais des branches persistantes. `lab/chorescore` est l'unique état produit accepté.

## Vérifications de référence

```bash
npm run check
EXPO_PUBLIC_DATA_MODE=demo npx --no-install expo export --platform android
npm audit --omit=dev --audit-level=high
npm --prefix functions run check
npm --prefix functions audit --omit=dev --audit-level=high
```

La livraison `demo-rc` n'est terminée qu'après l'APK standalone et son smoke Android API 35 sans Metro ni réseau, conformément au prompt maître.
