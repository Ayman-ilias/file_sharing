"""Live updates. Task 6 of plan 2 replaces these stubs with the SSE broker."""

from fastapi import FastAPI


def notify_created(app: FastAPI, item_id: str) -> None:
    """Tell everyone who can see the item that it exists (stub until the broker lands)."""
