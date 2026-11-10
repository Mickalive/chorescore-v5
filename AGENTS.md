# ChoreScore V5 — instructions for coding agents

You are building a real mobile PRODUCT, not a demonstration, architecture experiment or build factory.

## Non-negotiable target
Deliver a cohesive, attractive, installable Android app for shared household **tasks and expenses**, with real cross-device collaboration. Meet ALL V3/V4 product requirements specified in `CODEX_MISSION.md`, `PRODUCT.md` and `docs/V4_CONSTITUTION.md`. Historical docs describe desired behavior, NOT proof it has been implemented.

## Ground rules
- **One repo, one product.** On 2 November 2026 the owner explicitly requested a programme that reads all historical specifications, audits, implements and iterates. A single bounded free OpenCode writer and independent verification are authorized. Use the same branch/PR, preserve the strongest tested progress, never publish a report-only change as a repair, and never weaken existing tests or security to make checks green. No parallel writers, automatic merges, deployments or paid services. Standard GitHub-hosted jobs must only run in a public repository, where runners are free. Real external credentials remain external requirements, never fabricated completion.
- **Finish user journeys end-to-end**, including persistence, errors, navigation, and actual device behavior. Do not count a stub, `return null`, `no-op`, E2E mock, interface or green typecheck as a completed feature.
- **Preserve tested domain invariants and customer data**. Never silently reinterpret time/points or exchange currencies, merge members by name, duplicate todo completions or compromise tenant isolation.
- **Design matters**. Rebuild the UI from a coherent visual system inspired by ChoreScore V1 (see `Mickalive/Chorescore`) rather than merely changing color tokens. Capture real screens, fix tiny touch targets/keyboard/safe-area issues and audit FR/EN.
- Work on a single branch / PR across sequential vertical slices. Each slice must have demonstrable value. Run `npm ci`, `npm run typecheck`, relevant tests, and direct Android device verification where available. A build is a build, not proof that the app works.
- Use Expo / React Native conventions, typed small components and genuine platform APIs. Delete obsolete complexity rather than piling on wrappers.
- Do not put credentials, production keys or test-user secrets in git. Firebase project/provider enablement requires legitimate project access; implement secure integration and document exact remaining environment config, **never** fake success.
- The owner has stopped the manual Cloud Shell troubleshooting path. Do not ask them to repeat terminal commands or debug setup scripts; continue independently and report unavailable external access honestly.
- Never claim tests or screenshots you did not actually run or view. When cloud/emulator access is unavailable, say exactly what was and wasn't tested, then continue independent work.

## Execution
Begin each iteration with `.opencode-ci/latest-checks.md` when present: the current baseline takes priority over historical failure logs. Read `.github/PRODUCT_AUTOPILOT.md`, `CODEX_MISSION.md`, `PRODUCT.md` and `docs/CROSS_REPOSITORY_REQUIREMENTS.md` with its pinned historical manifest. Consult the original V3/V4 section relevant to the concrete repair. For `VERIFICATION.md`, read only the leading summary first (use `limit: 40`), then locate a specific relevant section if needed; do not reload its entire chronological history on every pass. Read targeted source ranges (normally at most 200 lines), implement and test one actual behavior. Do not restart the audit/matrix, rewrite already working features, or spend a pass reading CI internals when the product failure is identified. Do not ask the owner for code-review decisions on minor changes. Only surface true external credential/product-design blockers.
