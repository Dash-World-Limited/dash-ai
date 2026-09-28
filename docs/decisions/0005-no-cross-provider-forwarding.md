# ADR 0005 — Never forward one provider's answers to another

**Status:** accepted

**Decision.** History sent to a provider contains the user's turns and only that provider's own
earlier answers. Demo answers are never sent anywhere. Enforced in `ContextBuilder` (Android) and
`filterHistoryForProvider` (API), with tests on both sides.

**Consequences.** When a user switches provider mid-chat, the new provider sees the user's
questions but not the previous provider's answers. This is the transparent, privacy-preserving
default; an explicit opt-in to share answers could be added later.
