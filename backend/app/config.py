from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    keitaro_base_url: str = ""
    keitaro_api_key: str = ""
    database_url: str = "sqlite:///./adrobot.db"
    google_redirect_url: str = "https://www.google.com/"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def configured(self) -> bool:
        return self.keitaro_base_url.startswith(("http://", "https://")) and bool(
            self.keitaro_api_key and self.keitaro_api_key != "CHANGE_ME"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
