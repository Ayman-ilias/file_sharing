import sqlite3


def test_tables_exist_and_wal(client, app_settings):
    con = sqlite3.connect(app_settings.data_dir / "app.db")
    names = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    assert {"users", "sessions", "items", "item_recipients", "folder_entries", "uploads",
            "audit_log", "vault_keys", "vault_items"} <= names
    assert con.execute("pragma journal_mode").fetchone()[0] == "wal"


def test_deleting_item_cascades_recipients(db_session, make_user, make_item):
    from app.models import Item, ItemRecipient

    a, r = make_user("a@southerniot.net"), make_user("r@southerniot.net")
    item = make_item(a, recipients=[r])
    assert db_session.query(ItemRecipient).count() == 1
    db_session.delete(db_session.get(Item, item.id))
    db_session.commit()
    assert db_session.query(ItemRecipient).count() == 0


def test_foreign_keys_enforced(db_session):
    from sqlalchemy.exc import IntegrityError

    from app.models import ItemRecipient

    db_session.add(ItemRecipient(item_id="nope", user_id=999))
    try:
        db_session.commit()
        raise AssertionError("expected a foreign key error")
    except IntegrityError:
        db_session.rollback()
