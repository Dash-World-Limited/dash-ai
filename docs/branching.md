# Branches and releases

## Where things stand (October 2026)

The repository has no `main` branch yet. Every branch was created by Claude sessions and is named
after them:

| Branch | What it holds | Relationship |
| --- | --- | --- |
| `claude/mvp-foundation` | The first milestone (backend, Android foundations). Default branch today. | Base of everything below |
| `claude/epic-fermi-fmpda0` | Hardened backend, native Android UI, the web app. PR #1 → `claude/mvp-foundation` (open, green, not merged) | `mvp-foundation` + 34 commits up to `ada951c` |
| `feature/release-hardening-parity` | This milestone: release hardening and web/Android parity | `claude/epic-fermi-fmpda0` + new commits |
| `claude/ui-brain-5p58su` | One commit of standalone HTML dashboard design studies ("UI CONCEPTS") | `mvp-foundation` + 1 unrelated commit; not part of the product |

Nothing below has been done: it changes repository settings and needs the owner's decision.

## Recommended long-term structure

- **`main`** — what is in production. Protected: pull requests only, required checks (CI and Android
  app workflows), at least one human review, no force-push, no deletion. The repository's default
  branch.
- **`develop`** (optional) — integration of finished milestones before a release. Only worth having
  once there is a release rhythm; until then milestones can go straight to `main` through a PR.
- **`feature/<topic>`** — one milestone or change each, branched from `main` (or `develop`), merged by
  PR and then deleted. AI sessions can work on these branches too; the name describes the work, not the
  tool.
- **Tags** `vX.Y.Z` on `main` for releases; the release workflow builds from a tag.

## A safe, non-destructive path to `main`

Every step keeps existing branches and history; nothing is renamed, rewritten or deleted.

1. Review and merge PR #1 (`claude/epic-fermi-fmpda0` → `claude/mvp-foundation`) when you are satisfied.
2. Create `main` from `claude/mvp-foundation` at that merge commit (a new branch pointing at the same
   commit; the old branch stays).
3. In Settings → General, make `main` the default branch. In Settings → Branches, protect `main` as
   above.
4. Retarget the open milestone PR (`feature/release-hardening-parity`) to `main`.
5. Leave the `claude/*` branches in place until you are sure nothing else points at them; delete
   them later only if you wish (each is fully contained in `main` except `claude/ui-brain-5p58su`,
   which holds the design studies: keep it, or copy the files to `docs/` first).

Steps 2 to 4 change repository settings, so they wait for your go-ahead.
