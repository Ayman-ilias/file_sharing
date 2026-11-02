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


def test_transfer_columns_exist(client, app_settings):
    con = sqlite3.connect(app_settings.data_dir / "app.db")
    names = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    assert "batches" in names
    cols = {r[1] for r in con.execute("pragma table_info(uploads)")}
    assert {"received_bytes", "updated_at", "item_id", "storage_id"} <= cols
    bcols = {r[1] for r in con.execute("pragma table_info(batches)")}
    assert {"id", "user_id", "name", "file_count", "recipient_ids", "is_global", "created_at",
            "updated_at", "completed_at", "item_id"} <= bcols


def test_new_settings_defaults(app_settings):
    assert app_settings.max_user_reserved == 20 * 1024**3
    assert app_settings.max_user_uploads == 20
    assert app_settings.max_streams_per_user == 10
    assert app_settings.stale_after_hours == 24


def test_0002_upgrades_a_database_with_existing_uploads(tmp_path):
    """Adding NOT NULL columns must work on a table that already has rows."""
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, text

    from app.db import BACKEND_DIR

    url = f"sqlite:///{tmp_path / 'old.db'}"
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "0001")
    eng = create_engine(url)
    with eng.begin() as c:
        c.execute(text("insert into users (id, email, username, is_global, created_at) "
                       "values (1, 'a@x', 'a', 0, '2026-11-01 10:00:00')"))
        c.execute(text("insert into uploads (id, user_id, target, client_key, name, size, mime, "
                       "chunk_size, received, recipient_ids, is_global, created_at) values "
                       "('" + "a" * 32 + "', 1, 'share', 'k', 'f', 9, 'x', 4, '[0]', '[]', 0, "
                       "'2026-11-01 10:00:00')"))
    command.upgrade(cfg, "head")
    with eng.begin() as c:
        row = c.execute(text("select received_bytes, updated_at, created_at from uploads")).one()
    assert row[0] == 0 and row[1] == row[2]


def test_batches_store_failed_paths(client, app_settings):
    con = sqlite3.connect(app_settings.data_dir / "app.db")
    assert "failed_paths" in {r[1] for r in con.execute("pragma table_info(batches)")}
