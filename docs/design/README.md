# Approved design (final, 2026-11-01)

`mockup.html` is the approved UI (main screens). `states.html` (added 2026-11-02, same CSS) is part of the approved design: every other action and state: vault edit/delete menus and forms, first-time setup, erase, auto-lock warning, full storage, the Send-to picker, failed uploads, empty/loading/error lists, card edge cases, register/login errors, profile feedback, the global account view, and phone behaviour. Open it in a browser; it runs from this folder. The frontend must reproduce it exactly: same layout, colours, spacing, text and behaviour.

`reference/` holds screenshots of each state at 1300px wide:

| File | State |
|---|---|
| sharing-desktop.png | Sharing tab, Private section (default view) |
| sharing-global.png | Sharing tab, Global section |
| storage-locked.png | My storage, locked |
| storage-open.png | My storage, unlocked |
| profile.png | Profile drawer open |

Phone-width references are captured with Playwright at a 390px viewport in plan 3. Headless Chrome cannot open a window that narrow.

Assets: `assets/mark.png` and `assets/logo-full.png` are cropped from the original logo. `sample-photo.jpg` and `Site-Survey-Report.pdf` are mockup-only sample content.
