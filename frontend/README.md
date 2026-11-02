# Frontend

React + TypeScript + Vite. Plain CSS ported from the approved mockup, keeping the same class names, so the app looks exactly like [docs/design/mockup.html](../docs/design/mockup.html).

```
frontend/
├── public/                      logo.png (original), mark.png, logo-full.png
├── src/
│   ├── main.tsx, App.tsx        entry, routes (/login, /)
│   ├── styles/                  tokens, app, background: copied from the mockup
│   ├── api/                     fetch client (cookie session, CSRF header), API types
│   ├── lib/                     linkify, formatting (bytes, times)
│   └── features/
│       ├── auth/                login and register page, session hook
│       ├── layout/              animated background, header, top tabs, profile drawer, password nudge
│       ├── sharing/             upload card, recipient picker, Private/Global switch, item cards, photo peek
│       ├── uploads/             chunked parallel uploader, speed and ETA
│       └── vault/               My storage: lock screen, client-side crypto, auto-lock, item cards
└── e2e/                         Playwright flows and screenshot checks against docs/design/reference
```

Built by plans 3 and 4 in `docs/superpowers/plans/`.
