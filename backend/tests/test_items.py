from datetime import UTC, datetime, timedelta

from tests.conftest import TEST_SHARED_PASSWORD, login


def _text(client, body="hello", recipients=(), is_global=False, title=None):
    payload = {"body": body, "recipient_ids": list(recipients), "is_global": is_global}
    if title is not None:
        payload["title"] = title
    return client.post("/api/items/text", json=payload)


def _ids(client, section):
    r = client.get(f"/api/items?section={section}")
    assert r.status_code == 200, r.text
    return [i["id"] for i in r.json()["items"]]


def test_private_text_visible_to_sender_and_recipient_only(client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    n = login(make_client(), "nusrat@southerniot.net")
    resp = _text(a, "cfg", [r.me["id"]], title="cfg")
    assert resp.status_code == 201, resp.text
    item = resp.json()
    assert item["kind"] == "text" and item["text_body"] == "cfg"
    assert item["sender"] == {"id": a.me["id"], "username": "ayman"}
    assert item["recipients"] == [{"id": r.me["id"], "username": "rahim"}]
    assert _ids(a, "private") == [item["id"]]
    assert _ids(r, "private") == [item["id"]]
    assert _ids(n, "private") == []
    assert _ids(a, "global") == []


def test_global_text_in_everyones_global_section(client, make_client):
    a = login(client, "ayman@southerniot.net")
    n = login(make_client(), "nusrat@southerniot.net")
    item = _text(a, "for all", is_global=True).json()
    assert _ids(n, "global") == [item["id"]] and _ids(n, "private") == []
    assert _ids(a, "global") == [item["id"]] and _ids(a, "private") == []


def test_global_account_sees_only_global(client, make_client):
    a = login(make_client(), "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    g_item = _text(a, "everyone", is_global=True).json()
    _text(a, "private", [r.me["id"]])
    client.post("/api/auth/login",
                json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert _ids(client, "private") == []
    assert _ids(client, "global") == [g_item["id"]]


def test_global_account_may_only_post_global(client, make_client):
    r = login(make_client(), "rahim@southerniot.net")
    client.post("/api/auth/login",
                json={"email": "global@southerniot.net", "password": TEST_SHARED_PASSWORD})
    assert _text(client, "x", [r.me["id"]]).status_code == 403
    assert _text(client, "x", is_global=True).status_code == 201


def test_text_limits(client, make_client, app_settings):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    too_big = "a" * (app_settings.max_text_bytes + 1)
    assert _text(a, too_big, [r.me["id"]]).json()["detail"] == "too_large"
    assert _text(a, "   \n\t ", [r.me["id"]]).json()["detail"] == "empty"
    assert _text(a, "hi").json()["detail"] == "no_recipients"
    # exactly at the limit is fine; multi-byte characters count as bytes
    assert _text(a, "a" * app_settings.max_text_bytes, [r.me["id"]]).status_code == 201
    bangla = "ক" * (app_settings.max_text_bytes // 3 + 1)  # 3 bytes each in UTF-8
    assert _text(a, bangla, [r.me["id"]]).json()["detail"] == "too_large"


def test_untitled_text_named_after_first_line(client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    item = _text(a, "\n\n  Gateway IP: 10.10.8.51\nmore", [r.me["id"]]).json()
    assert item["name"] == "Gateway IP: 10.10.8.51"
    long_first = "x" * 200 + "\nrest"
    assert len(_text(a, long_first, [r.me["id"]]).json()["name"]) == 80
    assert _text(a, "body", [r.me["id"]], title="   ").json()["name"] == "body"


def test_global_drops_people(client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    item = _text(a, "both", [r.me["id"]], is_global=True).json()
    assert item["is_global"] is True and item["recipients"] == []
    assert _ids(r, "private") == [] and _ids(r, "global") == [item["id"]]


def test_cannot_send_to_self_disabled_global_or_unknown(client, make_client, db_session):
    from app.models import User

    a = login(client, "ayman@southerniot.net")
    gone = login(make_client(), "gone@southerniot.net")
    u = db_session.query(User).filter_by(username="gone").one()
    u.disabled_at = datetime.now(UTC)
    db_session.commit()
    glob = db_session.query(User).filter_by(is_global=True).one()
    for bad in (a.me["id"], gone.me["id"], glob.id, 99999):
        resp = _text(a, "x", [bad])
        assert resp.status_code == 400 and resp.json()["detail"] == "unknown_recipient", bad


def test_expired_items_hidden(client, make_client, make_item, db_session):
    from app.models import User

    a = login(client, "ayman@southerniot.net")
    me = db_session.get(User, a.me["id"])
    old = make_item(me, is_global=True, expires_at=datetime.now(UTC) - timedelta(seconds=1))
    fresh = make_item(me, is_global=True)
    assert _ids(a, "global") == [fresh.id] and old.id not in _ids(a, "global")


def test_html_in_title_kept_as_plain_text(client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    title = '<img src=x onerror=alert(1)> "q" ../x'
    assert _text(a, "b", [r.me["id"]], title=title).json()["name"] == title


def test_nfc_names(client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    assert _text(a, "b", [r.me["id"]], title="Café").json()["name"] == "Café"


def test_pagination_has_no_gaps_or_repeats(client, make_item, db_session):
    from app.models import User

    a = login(client, "ayman@southerniot.net")
    me = db_session.get(User, a.me["id"])
    base = datetime.now(UTC) - timedelta(hours=5)
    made = []
    for i in range(120):
        ts = base if i < 7 else base + timedelta(seconds=i)  # 7 items share one timestamp
        made.append(make_item(me, is_global=True, created_at=ts).id)
    seen, cursor, pages = [], None, 0
    while True:
        url = "/api/items?section=global&limit=50" + (f"&before={cursor}" if cursor else "")
        page = a.get(url).json()
        seen += [i["id"] for i in page["items"]]
        pages += 1
        cursor = page["next"]
        if cursor is None:
            break
    assert pages == 3 and len(seen) == 120 and len(set(seen)) == 120 and set(seen) == set(made)


def test_list_parameters_validated(client):
    a = login(client, "ayman@southerniot.net")
    assert a.get("/api/items?section=nope").status_code == 422
    assert a.get("/api/items?section=global&limit=0").status_code == 422
    assert a.get("/api/items?section=global&limit=201").status_code == 422
    assert a.get("/api/items?section=global&before=garbage!!").status_code == 400


def test_items_need_sign_in(raw_client):
    assert raw_client.get("/api/items?section=global").status_code == 401


def test_list_sends_a_preview_not_the_whole_text(client, make_client):
    """Review fix: 50 big texts would make every list page ~50 MB (the v1 30 MB-page mistake)."""
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    body = "\n".join(f"line {i} " + "x" * 50 for i in range(500))  # ~29 KB, 500 lines
    created = _text(a, body, [r.me["id"]]).json()
    assert created["text_body"] == body and created["text_truncated"] is False  # sender gets it all
    listed = r.get("/api/items?section=private").json()["items"][0]
    assert listed["text_truncated"] is True and listed["line_count"] == 500
    assert len(listed["text_body"]) == 2000 and body.startswith(listed["text_body"])
    full = r.get(f"/api/items/{created['id']}").json()
    assert full["text_body"] == body and full["text_truncated"] is False


def test_short_text_is_not_truncated(client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    _text(a, "one\ntwo", [r.me["id"]])
    listed = r.get("/api/items?section=private").json()["items"][0]
    assert listed["text_body"] == "one\ntwo" and listed["text_truncated"] is False
    assert listed["line_count"] == 2


def test_get_single_item_respects_visibility(client, make_client):
    a = login(client, "ayman@southerniot.net")
    r = login(make_client(), "rahim@southerniot.net")
    o = login(make_client(), "outsider@southerniot.net")
    item = _text(a, "secret", [r.me["id"]]).json()
    assert r.get(f"/api/items/{item['id']}").status_code == 200
    resp = o.get(f"/api/items/{item['id']}")
    assert resp.status_code == 404 and resp.json() == {"detail": "not_found"}
