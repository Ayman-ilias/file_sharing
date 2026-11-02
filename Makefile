.PHONY: backend-test backend-lint backend-dev

backend-test:
	cd backend && uv run pytest -q

backend-lint:
	cd backend && uv run ruff check .

backend-dev:
	cd backend && COOKIE_SECURE=false uv run uvicorn app.main:create_app --factory --reload --port 8000 --no-server-header

.PHONY: frontend-dev frontend-test frontend-build frontend-design
frontend-dev:
	cd frontend && npm run dev

frontend-test:
	cd frontend && npm test && npx tsc -b --noEmit

frontend-build:
	cd frontend && npm run build

frontend-design:  ## re-copy CSS + icons from docs/design after a design change
	cd frontend && node scripts/extract-design.mjs
