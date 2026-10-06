# Android release hardening (review, no device yet)

Reviewed in code and covered by automated tests (Robolectric, the desktop UI harness, Kotlin core).
**Not yet run on a physical device**: the Samsung A55 pass is still to do (see the checklist at the end).

| Area | How the app behaves | Evidence |
| --- | --- | --- |
| Lifecycle / backgrounding | The chat lives in an activity-scoped ViewModel; an answer keeps streaming while the app is in the background and is saved as it ends. If the process is killed mid-answer, the partial answer is shown as Stopped when the chat is reopened. | `ChatSession.open` (core), `ChatSessionTest` |
| Stream cancellation | Stop cancels the request and tells the server (best effort); the partial answer and finished tools are kept, running tools marked stopped. | `ChatSessionTest`, `stoppingGenerationKeepsThePartialAnswer` |
| Losing the connection mid-answer | **Fixed in this milestone.** Previously the answer waited for the 90 s read timeout. Now, when the device goes offline (live mode), the answer ends at once as failed, text kept, Retry offered; nothing is sent to the unreachable server. Demo Mode is unaffected. Request-level failures now also mark the answer retryable. | `ChatSessionTest` "a lost connection…", `losingTheConnectionEndsAStreamingAnswerWithRetryInsteadOfHanging` |
| Back online | Pending sync (renames, deletes, offline chats) is pushed and server changes pulled. | `ChatViewModel`, `ConversationSyncTest` |
| Configuration changes | Rotation, theme and font-scale changes keep the chat, composer text and streaming answer (ViewModel); sheets use `rememberSaveable`. A share is never processed twice on recreation. | `MainActivity` (`savedInstanceState == null`) |
| Back | **Fixed in this milestone:** system Back closes an open history drawer on Home and Chat before leaving the screen. Chat → Back returns to Home; Home → Back leaves the app. Sheets and dialogs close on Back (Material). | `AndroidPlatformTest.systemBackClosesTheOpenHistoryDrawerBeforeLeavingHome` |
| Session restoration | The session token is kept in encrypted storage; a 401 signs the device out with an explanation. Shared-device sign-out wipes local data (see security.md). | `AccountIsolationTest`, existing UI tests |
| File picker | The system document picker (no storage permission); type and size are checked before upload; unreadable files say why on their chip. | `DocumentsScreen`, `FileRules` tests |
| Share into DASH AI | **New in this milestone:** "Share → DASH AI" from other apps for text, PDF, Word, text files and images. The share waits until onboarding and sign-in are done, then opens a new chat with the text ready to edit and the files attaching; nothing is sent automatically. Only `content://` items from other apps are accepted: `file://` paths and DASH AI's own storage are refused, so no app can make DASH AI upload its private files. More than 5 files, or refused items, are reported. | `AndroidPlatformTest` (parsing, safety), `sharedTextAndFilesOpenANewChatReadyToEdit`, `aShareWaitsUntilOnboardingAndSignInAreDone` |
| Error and recovery states | Provider failures show Retry / Change provider / Continue later, never switching automatically; offline is announced; sign-in offline explains instead of failing. | Existing UI tests |

## Device checklist (Samsung A55, to do)

Install `dash-ai-debug-apk` from the latest green **Android app** run, then: rotate during an answer;
background the app mid-answer and return; toggle aeroplane mode mid-answer; Back with the drawer open;
share a PDF and a page of text from Files/Chrome; pick a Word file; sign out and check nothing remains;
TalkBack through Home and Chat; dark mode and the largest font size.
