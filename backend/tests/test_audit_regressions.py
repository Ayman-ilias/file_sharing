"""One test per finding of the 2026-11-01 security audit of v1 (ip.py) that applies to plan 1."""

import re

from app.storage import storage_path
from tests.conftest import login

OPEN_ROUTES = {"/api/health", "/api/auth/register", "/api/auth/login"}


def test_v1_no_auth__every_api_route_needs_a_session(raw_client, app):
    """v1: no login on any route; anyone on the network could upload, read and delete."""
    # The OpenAPI schema is the public route list (FastAPI 0.162 wraps included routers,
    # so walking app.routes no longer reaches them).
    checked = 0
    for path, ops in app.openapi()["paths"].items():
        if not path.startswith("/api") or path in OPEN_ROUTES:
            continue
        url = re.sub(r"\{[^}]+\}", "x", path)
        for method in ops:
            r = raw_client.request(method.upper(), url, headers={"X-Requested-With": "fs"})
            assert r.status_code in (401, 422), (method, path, r.status_code)
            checked += 1
    assert checked >= 10


def test_v1_traversal_delete__ids_are_not_paths(client, app_settings):
    """v1: POST /delete/..%2f..%2ffile deleted any file the process could reach."""
    login(client, "a@southerniot.net")
    db_file = app_settings.data_dir / "app.db"
    for evil in ("..%2f..%2fapp.db", "..%2fapp.db", "%2e%2e%2fapp.db", "app.db"):
        r = client.delete(f"/api/items/{evil}")
        assert r.status_code in (404, 405), (evil, r.status_code)
    assert db_file.exists()


def test_v1_traversal_download__ids_are_not_paths(client):
    """v1: /download-folder/..%2f zipped the app's own folder."""
    login(client, "a@southerniot.net")
    for evil in ("..%2f..%2fapp.db", "..%2f", "%2e%2e"):
        r = client.get(f"/api/items/{evil}/download")
        assert r.status_code == 404 and "x-accel-redirect" not in r.headers


def test_v1_storage_ids_cannot_escape(tmp_path):
    """v1: user-supplied names reached os.path.join; now only 32-hex IDs build paths."""
    for evil in ("../../etc/passwd", "/etc/passwd", "..", "a" * 31 + "."):
        try:
            storage_path(tmp_path, "files", evil)
            raise AssertionError(f"accepted {evil!r}")
        except ValueError:
            pass


def test_v1_inline_html__never_served_inline(client, file_item, make_file_item, db_session):
    """v1: uploaded .html/.svg opened as pages on the same origin (stored XSS)."""
    from app.models import User

    owner = db_session.get(User, client.me["id"])
    for mime in ("text/html", "image/svg+xml", "application/xhtml+xml", "text/html; charset=utf-8"):
        it = make_file_item(name="evil.html", mime=mime, sender=owner)
        h = client.get(f"/api/items/{it.id}/download?inline=1").headers
        assert h["content-disposition"].startswith("attachment;"), mime
        assert h["content-type"] == "application/octet-stream", mime
        assert h["x-content-type-options"] == "nosniff"


def test_v1_filename_in_markup__returned_as_plain_data(client, make_client):
    """v1: a filename like +alert(document.domain)+ ran as JavaScript in an onsubmit attribute."""
    a = login(client, "a@southerniot.net")
    r = login(make_client(), "r@southerniot.net")
    payload = "+alert(document.domain)+ <script>x</script>"
    item = a.post("/api/items/text", json={"title": payload, "body": "b",
                                           "recipient_ids": [r.me["id"]]}).json()
    assert item["name"] == payload  # JSON data; the frontend renders it as text, never as markup


def test_v1_csrf__cross_site_post_rejected(raw_client):
    """v1: any website could make a visitor's browser delete files (no CSRF protection)."""
    for method, url in (("POST", "/api/auth/login"), ("DELETE", "/api/items/x"),
                        ("POST", "/api/items/text"), ("POST", "/api/auth/password")):
        r = raw_client.request(method, url)
        assert r.status_code == 403 and r.json() == {"detail": "csrf"}, url


def test_v1_huge_text__rejected(client, make_client, app_settings):
    """v1: no size limits; a 30 MB text was inlined into every page load."""
    a = login(client, "a@southerniot.net")
    r = login(make_client(), "r@southerniot.net")
    big = "a" * (app_settings.max_text_bytes + 1)
    resp = a.post("/api/items/text", json={"body": big, "recipient_ids": [r.me["id"]]})
    assert resp.status_code == 400 and resp.json()["detail"] == "too_large"


def test_v1_text_not_inlined_into_lists_of_other_people(client, make_client):
    """v1: every .txt was readable by everyone. Now private text reaches only its people."""
    a = login(client, "a@southerniot.net")
    r = login(make_client(), "r@southerniot.net")
    outsider = login(make_client(), "o@southerniot.net")
    a.post("/api/items/text", json={"body": "secret", "recipient_ids": [r.me["id"]]})
    page = outsider.get("/api/items?section=private").json()
    assert page["items"] == [] and "secret" not in str(outsider.get(
        "/api/items?section=global").json())


def test_v1_security_headers_everywhere(client, raw_client):
    """v1: no security headers at all."""
    for resp in (client.get("/api/health"), raw_client.get("/api/auth/me"),
                 raw_client.post("/api/items/text")):
        assert resp.headers["x-content-type-options"] == "nosniff"
        assert resp.headers["x-frame-options"] == "DENY"


def test_api_schema_not_public(raw_client):
    """Don't hand out a map of the API to anonymous visitors."""
    assert raw_client.get("/openapi.json").status_code == 404
    assert raw_client.get("/docs").status_code == 404
