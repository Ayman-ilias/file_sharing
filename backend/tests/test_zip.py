import io
import os
import zipfile
from uuid import uuid4

import pytest

from app.storage import storage_path
from tests.conftest import login


@pytest.fixture
def folder(client, db_session, make_item, app_settings):
    """A Global folder with real files: app.hex (10 B) and a Bangla-named file (1.5 MiB)."""
    from app.models import FolderEntry, User

    login(client, "owner@southerniot.net")
    owner = db_session.get(User, client.me["id"])
    item = make_item(owner, kind="folder", name="firmware-v3.2", file_count=2, is_global=True)
    contents = {"app.hex": b"0123456789", "কনফিগ/gw.json": os.urandom(1536 * 1024)}
    for rel, data in contents.items():
        sid = uuid4().hex
        p = storage_path(app_settings.data_dir, "files", sid)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        db_session.add(FolderEntry(id=uuid4().hex, item_id=item.id, relative_path=rel,
                                   size=len(data), storage_id=sid))
    db_session.commit()
    return item, contents


def test_zip_names_bytes_and_utf8_flag(client, folder):
    item, contents = folder
    resp = client.get(f"/api/items/{item.id}/zip")
    assert resp.status_code == 200 and resp.headers["content-type"] == "application/zip"
    assert resp.headers["cache-control"] == "private, no-store"
    assert resp.headers["content-disposition"].startswith("attachment; filename*=UTF-8''")
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    assert sorted(zf.namelist()) == sorted(contents)
    for name, data in contents.items():
        assert zf.read(name) == data
    bangla = zf.getinfo("কনফিগ/gw.json")
    assert bangla.flag_bits & 0x800 and bangla.compress_type == zipfile.ZIP_STORED


def test_zip_content_length_is_exact(client, folder):
    item, _ = folder
    resp = client.get(f"/api/items/{item.id}/zip")
    assert int(resp.headers["content-length"]) == len(resp.content)


def test_zip_streams_in_small_pieces(folder, app_settings, db_session):
    from app.models import Item
    from app.transfers import folder_zip

    item, _ = folder
    pieces = list(folder_zip(db_session.get(Item, item.id), app_settings.data_dir))
    assert len(pieces) > 2 and max(len(p) for p in pieces) <= int(1.1 * 1024 * 1024)


def test_zip64_entry_over_4_gib(tmp_path, db_session, make_user, make_item, app_settings):
    """A sparse 4 GiB + 1 file: the length is known up front and the zip opens."""
    from app.models import FolderEntry
    from app.transfers import folder_zip

    u = make_user("big@southerniot.net")
    item = make_item(u, kind="folder", name="big", file_count=1, is_global=True)
    sid = uuid4().hex
    p = storage_path(app_settings.data_dir, "files", sid)
    p.parent.mkdir(parents=True, exist_ok=True)
    size = 4 * 1024**3 + 1
    with open(p, "wb") as fh:
        fh.truncate(size)  # sparse: no real disk used
    db_session.add(FolderEntry(id=uuid4().hex, item_id=item.id, relative_path="disk.img",
                               size=size, storage_id=sid))
    db_session.commit()
    zs = folder_zip(item, app_settings.data_dir)
    expected = len(zs)
    out = tmp_path / "out.zip"
    with open(out, "wb") as fh:
        for piece in zs:
            fh.write(piece)
    assert out.stat().st_size == expected
    info = zipfile.ZipFile(out).getinfo("disk.img")
    assert info.file_size == size


def test_zip_outsider_404_and_text_400(client, make_client, folder):
    item, _ = folder
    a = login(make_client(), "rahim@southerniot.net")
    assert a.get(f"/api/items/{item.id}/zip").status_code == 200  # Global: everyone can
    r = login(make_client(), "nusrat@southerniot.net")
    text = r.post("/api/items/text", json={"body": "x", "recipient_ids": [a.me["id"]]}).json()
    assert r.get(f"/api/items/{text['id']}/zip").json()["detail"] == "not_a_folder"
    assert login(make_client(), "zed@southerniot.net").get(
        f"/api/items/{text['id']}/zip").status_code == 404
