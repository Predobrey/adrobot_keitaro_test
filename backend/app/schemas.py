import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class CampaignCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    geos: list[str] = Field(min_length=1, max_length=50)
    offer_id: int = Field(gt=0)
    domain_id: int = Field(gt=0)
    group_id: int = Field(gt=0)
    traffic_source_id: int = Field(gt=0)

    @field_validator("name")
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Campaign name cannot be blank")
        return v

    @field_validator("geos")
    @classmethod
    def normalize_geos(cls, values: list[str]) -> list[str]:
        values = [x.strip().upper() for x in values]
        if any(not re.fullmatch(r"[A-Z]{2}", x) for x in values):
            raise ValueError("GEO must be ISO 3166-1 alpha-2 country codes")
        return list(dict.fromkeys(values))


class StreamOffer(BaseModel):
    offer_id: int = Field(gt=0)
    share: int = Field(ge=0, le=100)
    state: Literal["active", "disabled"] = "active"


class StreamOffersUpdate(BaseModel):
    offers: list[StreamOffer] = Field(min_length=1)

    @model_validator(mode="after")
    def valid_distribution(self):
        ids = [o.offer_id for o in self.offers]
        if len(ids) != len(set(ids)):
            raise ValueError("Offer IDs must be unique")
        active = [o for o in self.offers if o.state == "active"]
        if not active:
            raise ValueError("At least one active offer is required")
        if sum(o.share for o in active) != 100:
            raise ValueError("Active offer shares must sum to 100%")
        if any(o.share for o in self.offers if o.state == "disabled"):
            raise ValueError("Disabled offers must have 0% share")
        return self
