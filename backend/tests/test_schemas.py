import pytest
from pydantic import ValidationError

from app.schemas import CampaignCreate, StreamOffersUpdate


def test_normalize_geos():
    data = CampaignCreate(name=" Demo ", geos=["au", " MX ", "au"], offer_id=1,
                          domain_id=2, group_id=3, traffic_source_id=4)
    assert data.name == "Demo"
    assert data.geos == ["AU", "MX"]


@pytest.mark.parametrize("geo", ["AUS", "A1", "", "AA-Z"])
def test_reject_bad_geo(geo):
    with pytest.raises(ValidationError):
        CampaignCreate(name="Test", geos=[geo], offer_id=1, domain_id=2,
                       group_id=3, traffic_source_id=4)


@pytest.mark.parametrize("shares", [[50, 49], [100, 1], [0, 0]])
def test_reject_invalid_shares(shares):
    with pytest.raises(ValidationError):
        StreamOffersUpdate(offers=[{"offer_id": i + 1, "share": s} for i, s in enumerate(shares)])


def test_reject_duplicate_offers():
    with pytest.raises(ValidationError):
        StreamOffersUpdate(offers=[{"offer_id": 1, "share": 50}, {"offer_id": 1, "share": 50}])


def test_valid_distribution():
    item = StreamOffersUpdate(offers=[
        {"offer_id": 1, "share": 34}, {"offer_id": 2, "share": 33},
        {"offer_id": 3, "share": 33}, {"offer_id": 4, "share": 0, "state": "disabled"},
    ])
    assert len(item.offers) == 4
