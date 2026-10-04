from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SpeedRequest(StrictModel):
    seconds_per_interval: float = Field(..., ge=0.2, le=30)


class ConfigRequest(StrictModel):
    safe_limit_kw: Optional[float] = Field(default=None, gt=0, le=1000)
    phase_limit_kw: Optional[float] = Field(default=None, gt=0, le=500)
    auto_dispatch: Optional[bool] = None
    temperature_offset_c: Optional[float] = Field(default=None, ge=-10, le=10)
