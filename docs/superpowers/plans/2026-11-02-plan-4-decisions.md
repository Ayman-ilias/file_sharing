# Plan 4 (My storage): decisions made by an agent panel, 2026-11-02

The owner was unsure about two plan choices and asked for them to be decided by agents. Method (the `solve-without-guessing` decision procedure):

1. An independent corner-case review of the plan: 4 critical, 9 important and 11 minor findings.
2. Round 1: five read-only reviewers (security/crypto, staff user advocate, browser platform engineer, design guardian, maintainer/ops). They read the real plan, spec, design and code, and were not told the lead's view.
3. Round 2: a debate. Each reviewer saw the others' positions and the lead's earlier view, then answered four new questions taken from the corner-case review.
4. Three fresh judges decided the points still split.

| Question | Decided | How |
|---|---|---|
| Vault upload interrupted by a reload | Restart after re-pick; no resume across reloads | 5/5 reviewers. Resume would reuse AES-GCM nonces when a file changes but keeps its name, size and date. That leaks plaintext XORs and lets ciphertexts be forged under the long-lived data key |
| Honest limit in the UI (spec §3.7) | Reword the mockup's false sentence in place; no new toggle | 5/5 after the debate (security and browser changed from "toggle as well") |
| Who may set up or erase My storage | Setup needs your own login password; erase needs ERASE plus the login password | Added during the debate by 4/5 reviewers: an account on the shared starting password can be impersonated by any colleague |
| Photo grid | Small encrypted thumbnail in the item's metadata | 5/5 (iPhone memory; a 12 MP photo decodes to about 48 MB) |
| A tab opened later | Opens locked | 4/5 |
| Unlock across tabs already open | Shared (the spec says so); each tab keeps its own idle timer | judges 3/3 |
| Space held by an interrupted upload | The server cancels idle (> 5 min) vault uploads when a new one starts; "Not enough space" also offers [Cancel it] | 5/5; the button by judges 2/3 |
| Telling the user after an interrupted upload | `beforeunload` warning plus a one-time toast next time | judges 2/3 (iOS Safari doesn't show `beforeunload`) |

**Where the lead was wrong:**
- It kept "Not even the server admin can read them." and only added a toggle. The sentence is false under spec §3.7, because whoever controls the server can change the app it serves.
- It had not seen that a typed ERASE alone lets anyone using the shared starting password wipe a colleague's vault.

**Rejected:**
- **Resumable vault uploads:** IV reuse, plus extra stored state.
- **Docs-only honest text:** the spec says the UI.
- **A key handshake for new tabs:** any same-origin script could request the key.
- **Not counting idle reservations:** splits what "reserved" means, and still counts toward the 20-upload limit.
- **Cancelling on vault open:** it could kill a live upload in another tab.

The binding details are in `2026-11-02-plan-4-my-storage.md`, section "Decisions and corner-case additions".
