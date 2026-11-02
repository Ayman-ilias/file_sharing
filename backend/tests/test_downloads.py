from urllib.parse import unquote

import pytest

from app.storage import accel_path, storage_path
from tests.conftest import login


def test_download_returns_accel_header_not_bytes(client, file_item):
    r = client.get(f"/api/items/{file_item.id}/download")
    assert r.status_code == 200 and r.content == b""
    sid = file_item.storage_id
    assert r.headers["x-accel-redirect"] == f"/protected/files/{sid[:2]}/{sid}"
    assert r.headers["cache-control"] == "private, no-store"
    assert r.headers["x-content-type-options"] == "nosniff"


@pytest.mark.parametrize("mime,inline_ok,sandbox", [
    ("application/pdf", True, False), ("image/png", True, True), ("image/jpeg", True, True),
    ("image/webp", True, True), ("video/mp4", True, True), ("text/html", False, False),
    ("image/svg+xml", False, False), ("application/zip", False, False),
    ("text/plain", False, False),
])
def test_inline_only_for_safe_types(client, file_item, make_file_item, db_session,
                                    mime, inline_ok, sandbox):
    from app.models import User

    owner = db_session.get(User, client.me["id"])
    it = make_file_item(name="f", mime=mime, sender=owner)
    h = client.get(f"/api/items/{it.id}/download?inline=1").headers
    if inline_ok:
        assert h["content-disposition"].startswith("inline;") and h["content-type"].startswith(mime)
    else:
        assert h["content-disposition"].startswith("attachment;")
        assert h["content-type"] == "application/octet-stream"
    assert ("content-security-policy" in h) == sandbox
    if sandbox:
        assert h["content-security-policy"] == "sandbox"
    # without ?inline=1 everything is an attachment
    plain = client.get(f"/api/items/{it.id}/download").headers
    assert plain["content-disposition"].startswith("attachment;")


def test_filename_with_quotes_and_unicode_encoded(client, file_item, make_file_item, db_session):
    from app.models import User

    owner = db_session.get(User, client.me["id"])
    name = 'রিপোর্ট "final"; x.pdf'
    it = make_file_item(name=name, sender=owner)
    cd = client.get(f"/api/items/{it.id}/download").headers["content-disposition"]
    assert cd.startswith("attachment; filename*=UTF-8''")
    encoded = cd.split("''", 1)[1]
    assert '"' not in encoded and ";" not in encoded and " " not in encoded
    assert unquote(encoded) == name


def test_outsider_gets_404_for_download_delete_and_entries(client, make_client, file_item):
    stranger = login(make_client(), "stranger@southerniot.net")
    for method, url in [("get", f"/api/items/{file_item.id}/download"),
                        ("delete", f"/api/items/{file_item.id}"),
                        ("get", f"/api/items/{file_item.id}/entries")]:
        r = getattr(stranger, method)(url)
        assert r.status_code == 404 and r.json() == {"detail": "not_found"}, url


def test_recipient_can_download(client, make_client, make_file_item, db_session):
    from app.models import User

    login(client, "owner@southerniot.net")
    rahim = login(make_client(), "rahim@southerniot.net")
    owner = db_session.get(User, client.me["id"])
    it = make_file_item(sender=owner, recipients=[db_session.get(User, rahim.me["id"])])
    assert rahim.get(f"/api/items/{it.id}/download").status_code == 200


def test_delete_removes_file_and_writes_audit(client, file_item, db_session, app_settings):
    from app.models import AuditLog, Item

    item_id, name = file_item.id, file_item.name
    path = storage_path(app_settings.data_dir, "files", file_item.storage_id)
    assert path.exists()
    assert client.delete(f"/api/items/{item_id}").status_code == 204
    assert not path.exists()
    db_session.expire_all()
    assert db_session.get(Item, item_id) is None
    log = db_session.query(AuditLog).filter_by(action="delete").one()
    assert log.item_name == name and log.actor_id == client.me["id"]
    assert client.delete(f"/api/items/{item_id}").status_code == 404


def test_anyone_who_sees_a_global_item_can_delete_it(client, make_client, make_file_item,
                                                      db_session):
    from app.models import User

    login(client, "owner@southerniot.net")
    other = login(make_client(), "other@southerniot.net")
    owner = db_session.get(User, client.me["id"])
    it = make_file_item(sender=owner, is_global=True)
    assert other.delete(f"/api/items/{it.id}").status_code == 204


def test_text_item_has_no_download(client, make_client):
    a = login(client, "owner@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    item = a.post("/api/items/text",
                  json={"body": "x", "recipient_ids": [r.me["id"]], "is_global": False}).json()
    resp = a.get(f"/api/items/{item['id']}/download")
    assert resp.status_code == 400 and resp.json()["detail"] == "not_a_file"


def test_folder_entries_and_single_file_download(client, db_session, make_item, app_settings):
    from uuid import uuid4

    from app.models import FolderEntry, User

    login(client, "owner@southerniot.net")
    owner = db_session.get(User, client.me["id"])
    folder = make_item(owner, kind="folder", name="firmware-v3.2", file_count=2, is_global=True)
    sids = []
    for rel in ("app.hex", "config/gw.json"):
        sid = uuid4().hex
        p = storage_path(app_settings.data_dir, "files", sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"x")
        db_session.add(FolderEntry(id=uuid4().hex, item_id=folder.id, relative_path=rel,
                                   size=1, storage_id=sid, mime="application/octet-stream"))
        sids.append(sid)
    db_session.commit()
    entries = client.get(f"/api/items/{folder.id}/entries").json()
    assert [e["relative_path"] for e in entries] == ["app.hex", "config/gw.json"]
    r = client.get(f"/api/items/{folder.id}/entries/{entries[1]['id']}/download")
    assert r.headers["x-accel-redirect"] == accel_path("files", sids[1])
    assert unquote(r.headers["content-disposition"].split("''", 1)[1]) == "gw.json"
    # deleting the folder removes every entry's file
    assert client.delete(f"/api/items/{folder.id}").status_code == 204
    assert not any(storage_path(app_settings.data_dir, "files", s).exists() for s in sids)


def test_storage_path_rejects_non_hex_ids(tmp_path):
    for bad in ["../etc/passwd", "/abs", "ab", "g" * 32, "A" * 32, "a" * 31 + "/"]:
        with pytest.raises(ValueError):
            storage_path(tmp_path, "files", bad)
    with pytest.raises(ValueError):
        storage_path(tmp_path, "../x", "a" * 32)
