from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All configuration comes from environment variables (see the roadmap's Settings table)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    shared_password: SecretStr
    allowed_email_domain: str = "southerniot.net"
    global_email: str = "global@southerniot.net"
    data_dir: Path = Path("./data")
    cookie_secure: bool = True
    session_days: int = 30
    item_ttl_days: int = 30
    max_file_size: int = 10 * 1024**3
    max_text_bytes: int = 1024**2
    max_batch_files: int = 5000
    chunk_size: int = 16 * 1024**2
    disk_margin: int = 2 * 1024**3
    vault_quota: int = 200 * 1024**2
    trust_x_real_ip: bool = True


@lru_cache
def get_settings() -> Settings:
    return Settings()
