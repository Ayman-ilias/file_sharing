.PHONY: backend-test backend-lint backend-dev

backend-test:
	cd backend && uv run pytest -q

backend-lint:
	cd backend && uv run ruff check .

backend-dev:
	cd backend && COOKIE_SECURE=false uv run uvicorn app.main:create_app --factory --reload --port 8000
