# CODEX MISSION — ChoreScore V5 FINAL PRODUCT

## Objective and background
The owner has already endured V1, V2, V3 and V4, repeated complicated CI/agent factories and releases whose features did not work. **Do not release another dressed-up V4 or just an APK.** Build ChoreScore as a real, polished, reliable collaborative mobile application. The only objective is a product users can actually use.

Repository: `Mickalive/chorescore-v5` (main has reusable V4 domain/accounting code, local SQLite, screens and one Android workflow). Earlier promises are in `docs/V4_CONSTITUTION.md` and `docs/V3_BACKEND_FRUGAL.md`. The user's preferred visual experience was V1 (`Mickalive/Chorescore`); V2 had a warmer palette, but V1 was perceived as more attractive. Do not resurrect V1's paywall/leaderboard/chrono: V4 **removed** these deliberately. Treat `PRODUCT.md` as final functional scope.

## Practical brief (implement all, not placeholders)
**Groups and accounts**: launch to Groups after persisted auth, real Google/Apple/Facebook social sign-in where supported/configured; add any number of groups; new group asks name, contribution unit (minutes or points), and member names before saving. Group cards show count and Options, NOT Invite. Named member identities are permanent and can later be linked to a real user via targeted invitation without duplication/replaying any old ledger.

**Real collaboration**: data is SQLite local-first with secure cloud backend (prefer Firebase Auth + Firestore + Storage, unless simpler robust equivalent is justified). Authenticated members see the same group on different phones. Secure invite link created AFTER group exists, accepted on another phone with same member id; deep link works end-to-end. Sync only deltas (including deletions), survive offline edits and reconnects, enforce per-group authorization/tenant isolation and deterministic balance correctness. Must test two separate accounts/devices (or credible separate emulator instances with genuine backend); no local-only invite dressed as shared.

**Ajouter**: two modes **Tâche**/**Dépense**; performer/payer, multiple beneficiaries, equal and custom splits, category *created by the user* (zero imposed categories), optional per-category default task ratio with override, note, optional persistent photo, date/time, native share, correctly localized FR/EN; task unit minutes/points chosen per group, NO chrono. Manage Categories immediately below submission button. In Ajouter, Members section instead of editable history.

**Balances**: distinct task and money ledgers, money grouped by currency, all-time balance plus week/month/year history filters, paginated history, tap entries to edit/delete/share. Editing/deleting from here must update balances without stale state; preserve exact sum-zero and monetary cent precision. Cross-ledger compensation ONLY if expressly enabled + explicit agreed rate; NEVER implicit FX conversion or historical reinterpretation.

**À faire**: create task or expense todo, assign, deadline/reminder, note/category. Completing prompts required task/expense details, including splits, and **atomically** marks todo complete + produces exactly one ledger entry, even if tapped twice/offline. Reminders must really fire on Android when scheduled.

**Media and native integrations**: actual Android system share sheet for text/URL; photo selection from device, persist real private file, preview and reopen it after app relaunch, eventual cloud storage/access only for authorized members, prevent orphaned files on edits/deletions. No mock images presented as stored media.

**Options and quality**: group options members/invites/unit/currencies/categories/compensation/delete, general options language FR/EN/profile/privacy/notifications/legal/signout. Complete accurate French typography and translations. Android/iOS safe areas, touch targets, loading/empty/offline/error states, accessibility, keyboard handling, huge history, long names/text. Free forever, no premium/demo/paywall.

## Known false-completion traps to fix first
1. V4/V5 `LocalSyncAdapter` is a NO-OP; `LocalAuthAdapter` Google/Apple/Facebook return null. A local-only owner has the SAME fixed ID on every phone — unsafe to treat as multiuser. Implement real identities and syncing before enabling cross-device invite.
2. `LocalNotificationAdapter` and `LocalCalendarAdapter` are NO-OP. Do not call them working.
3. V5 `LocalAttachmentAdapter` and `LocalSystemShareAdapter` were added, but functionality has never been proven on Android. Verify Expo 57 APIs at runtime, fix pick result/content:// copies, photo edit/remove and image rendering. Do NOT confuse generated APK with photo feature verification.
4. `app/(tabs)/add.tsx`, `balances.tsx` and `todos.tsx` are enormous monolithic screens (~1,900 / ~1,400 / ~1,450 lines). Rebuild into maintainable components without breaking ledger logic.
5. Group creation UI has no initial unit selector; backend defaults to minutes. Restore option at group creation.
6. The V5 style change so far mostly swaps theme tokens; V1-level design requires actual screen redesign, informative grouping, visual hierarchy, typography, icons, empty/loading states and verified real screenshots.
7. Previously reported 'complete' checks were not proof. Avoid assumptions, test the actual flows.

## Work order — ONE continuous coding task, small verified slices
A. Read V3/V4 original requirements, inspect current code; compile a succinct requirements-to-implementation matrix **with explicit missing behavior** (keep in `VERIFICATION.md`). No lengthy reports.
B. Redesign navigation and all main screens as coherent V1-inspired polished UI; create and inspect screenshots where tooling permits. Keep new design tokens and components modest/simple.
C. Make every single-device core feature complete and reliable. Focus on actual SQLite transactions, splits, category defaults, editing balances, todo completion, FR/EN, proper native photos/sharing/reminders. Run runtime/manual or emulator tests. Do not advance a broken critical journey.
D. Implement real authenticated multi-device collaboration behind properly configured cloud backend: cloud data model, security rules, robust invitation token/identity linking, sync revisions/conflict policies, private media storage. Use emulator and separate user tests; where account credentials are unavailable, complete independently implementable code, tests/rules and document *precisely* the external step needed to activate it.
E. Test integrated Android app (and iOS if available), fix UX and regressions, produce release candidate APK from single workflow, and provide reproducible evidence by flow. Stop adding features only after all required flows meet acceptance.

## Acceptance / proof
- Build passes `npm ci`, `npm run typecheck`, Android Gradle APK, and relevant domain + integration tests.
- **On-device**: install/run APK, create group with 2+ names and points/minutes choice; create custom category/ratio, task with custom weights, expense with cent-exact custom shares, photo and note; restart app, revisit every piece of data; edit/delete from Balances, correct balances; create and complete both todo types once; receive actual reminder; open native share sheet.
- **Two-device**: account A creates group and named B; sends link; account B accepts exact member; both see same group and writes, including reconnect/offline tests; verify security rules prevent unrelated account from reading data. Invite must not create duplicate member.
- **Visual**: screenshots for empty/filled Groups, Add task/expense, Balances, Todos, settings and invitation on representative Android screen sizes; owner reviews finished experience, not dozens of broken prototypes.
- Provide simple final report listing each scenario, actual observable evidence and anything still blocked. If a real backend account/SDK credentials cannot be configured in execution environment, do **not** claim fully working collaborative release. Leave clear setup and tests; no fake remote mode.

## Operating rules
Do code and tests, NOT elaborate project governance. One branch, one integrated PR; iterate until it is usable. Keep original V3/V4 docs for specification traceability, but never inherit their `complete` claims. Never stop at baseline migration, theme-only changes, an APK build, or empty README work. Preserve successful local domain behavior and migrations. Do not hardcode provider keys/secrets or provision paid services without approval. Do not demand owner manually verify every step: use emulator automation and actual tests to the greatest extent available.
