# ChoreScore V5 — instructions for coding agents

You are building a real mobile PRODUCT, not a demonstration, architecture experiment or build factory.

## Non-negotiable target
Deliver a cohesive, attractive, installable Android app for shared household **tasks and expenses**, with real cross-device collaboration. Meet ALL V3/V4 product requirements specified in `CODEX_MISSION.md`, `PRODUCT.md` and `docs/V4_CONSTITUTION.md`. Historical docs describe desired behavior, NOT proof it has been implemented.

## Ground rules
- **One repo, one product, direct development.** The owner has explicitly stopped all GitHub automations. Do not recreate or enable Actions workflows, OpenCode workers, scheduled repair loops or parallel writers. Implement and verify directly in the existing branch / PR; preserve executable local test scripts. No paid services.
- **Finish user journeys end-to-end**, including persistence, errors, navigation, and actual device behavior. Do not count a stub, `return null`, `no-op`, E2E mock, interface or green typecheck as a completed feature.
- **Preserve tested domain invariants and customer data**. Never silently reinterpret time/points or exchange currencies, merge members by name, duplicate todo completions or compromise tenant isolation.
- **Design matters**. Rebuild the UI from a coherent visual system inspired by ChoreScore V1 (see `Mickalive/Chorescore`) rather than merely changing color tokens. Capture real screens, fix tiny touch targets/keyboard/safe-area issues and audit FR/EN.
- Work on a single branch / PR across sequential vertical slices. Each slice must have demonstrable value. Run `npm ci`, `npm run typecheck`, relevant tests, and direct Android device verification where available. A build is a build, not proof that the app works.
- Use Expo / React Native conventions, typed small components and genuine platform APIs. Delete obsolete complexity rather than piling on wrappers.
- Do not put credentials, production keys or test-user secrets in git. Firebase project/provider enablement requires legitimate project access; implement secure integration and document exact remaining environment config, **never** fake success.
- Never claim tests or screenshots you did not actually run or view. When cloud/emulator access is unavailable, say exactly what was and wasn't tested, then continue independent work.

## Execution
Read `docs/CROSS_REPOSITORY_REQUIREMENTS.md` and its pinned historical source manifest, then `CODEX_MISSION.md`, then `PRODUCT.md`, `VERIFICATION.md`, `docs/V4_CONSTITUTION.md`, and the code. Implement rather than merely writing an audit. Do not ask the owner for code-review decisions on every minor change. Only surface true external credential/product-design blockers.
