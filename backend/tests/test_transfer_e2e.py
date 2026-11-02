import hashlib
import os
import random
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.storage import storage_path
from tests.conftest import login, put_chunk, start_upload


@pytest.fixture
def chunk_1mib(monkeypatch):
    monkeypatch.setenv("CHUNK_SIZE", str(1024 * 1024))


def test_big_file_round_trip(chunk_1mib, client, make_client, app_settings):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    data = os.urandom(5 * 1024 * 1024 + 512 * 1024)  # 5.5 MiB → 6 chunks
    init = start_upload(a, data, recipients=[r.me["id"]], name="site.mp4").json()
    uid, cs = init["upload_id"], init["chunk_size"]
    order = list(range(6)) + [3]  # chunk 3 is sent twice
    random.Random(7).shuffle(order)

    def send(n):
        return put_chunk(a, uid, n, data[n * cs:(n + 1) * cs]).status_code

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert set(pool.map(send, order)) == {204}
    tmp_inode = os.stat(storage_path(app_settings.data_dir, "tmp", uid)).st_ino
    item = a.post(f"/api/uploads/{uid}/complete").json()
    stored = storage_path(app_settings.data_dir, "files", uid)
    assert hashlib.sha256(stored.read_bytes()).digest() == hashlib.sha256(data).digest()
    assert os.stat(stored).st_ino == tmp_inode  # moved, not copied
    assert [i["id"] for i in r.get("/api/items?section=private").json()["items"]] == [item["id"]]
