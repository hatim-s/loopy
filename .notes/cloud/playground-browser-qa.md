# Playground browser QA

Verified in Hatim's personal Chrome on the running local dashboard at http://127.0.0.1:15072 after the pagination repair. Authentication used only the generated playground credential with Hatim's explicit permission. The credential was not printed or copied into evidence. No workflow was launched or changed during this inspection.

- Overview shows 528 retained runs, 64 failures, zero awaiting and zero running. All 15 loopies are discoverable.
- Runs paginated from 1–50 to 51–100 and back. The Failed filter selected only failed rows.
- Failed run `4f0c059e-0992-4791-867b-766a226e5940` shows its pinned source, failed `repository-report` node, attempt 1 of 1, finished receipt, and the exact `PLAYGROUND_CONTROLLED_FAILURE` message.
- Succeeded security-review run `37cfe27b-0241-4846-a617-bf9d23fa93f7` shows its 35-second approval node and resolved hook payload `{"approved":true}`.
- Logs and runtime events populated. Opening event 16913 showed its transaction, run identity and retained record.
- Chrome's captured error console returned no entries at the end of this inspection. This is limited to the captured session, not a proof that no historical browser error occurred.

The overview screenshot is `evidence/playground-overview-final.png`. Failure and approval detail screenshots are `evidence/playground-failed-run.png` and `evidence/playground-approval-run.png`. The authenticated overview tab is retained as the user-facing dashboard.

One presentation limitation remains. Some failed-run summaries begin with minified bundle stderr rather than the authored error. The full failure detail exposes the controlled error, but the list preview is less useful. This inspection did not change failure formatting or claim responsive/accessibility coverage beyond the current desktop view.
