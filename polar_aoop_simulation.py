"""Simplified closed-loop simulation of the Polar-AOOP profiling float.

This is an educational model, not a vehicle-control law. It models:
  * constant float mass and piston-controlled displaced volume,
  * vertical motion from buoyancy, drag, and gravity,
  * pressure/depth, temperature, salinity, and conductivity sensors,
  * an upward acoustic ice check and thermal safety check near the surface,
  * open-water surfacing or an ice-abort descent to 10--20 m.

Run:
    python polar_aoop_simulation.py
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum, auto
import math
import random
from typing import List, Optional


class Phase(Enum):
    DESCENDING = auto()
    PROFILING = auto()
    ASCENDING = auto()
    ICE_CHECK = auto()
    SURFACED = auto()
    ICE_HOLD = auto()


@dataclass
class Environment:
    """Idealized ocean profile and optional overhead ice."""

    ice_base_depth_m: Optional[float] = None
    surface_temperature_c: float = -1.2
    ice_freezing_point_c: float = -1.5

    def water_temperature_c(self, depth_m: float) -> float:
        # Cold near-surface water and a mild deep-water gradient.
        return self.surface_temperature_c + 0.012 * min(depth_m, 300.0)

    def water_salinity_psu(self, depth_m: float) -> float:
        return 33.5 + 0.004 * min(depth_m, 300.0)

    def water_density_kg_m3(self, depth_m: float) -> float:
        # Compact approximation sufficient for demonstrating control behavior.
        return 1027.0 + 0.18 * min(depth_m, 300.0) / 100.0

    def ice_distance_m(self, depth_m: float) -> Optional[float]:
        if self.ice_base_depth_m is None:
            return None
        return max(0.0, depth_m - self.ice_base_depth_m)


@dataclass
class SensorSample:
    time_s: float
    phase: Phase
    depth_m: float
    pressure_bar: float
    temperature_c: float
    salinity_psu: float
    conductivity_m_s_cm: float


@dataclass
class FloatConfig:
    mass_kg: float = 102.7
    neutral_volume_m3: float = 0.1000
    stroke_magnitude_m3: float = 0.0001  # 100 mL
    max_depth_m: float = 200.0
    target_depth_m: float = 100.0
    surface_check_depth_m: float = 2.0
    ice_abort_distance_m: float = 0.30
    ice_hold_depth_m: float = 15.0
    piston_rate_m3_s: float = 0.0001 / 10.0
    vertical_drag: float = 0.8
    effective_mass_kg: float = 130.0
    simulation_step_s: float = 0.25
    max_simulation_time_s: float = 1800.0


@dataclass
class PolarAOOP:
    environment: Environment
    config: FloatConfig = field(default_factory=FloatConfig)
    phase: Phase = Phase.DESCENDING
    time_s: float = 0.0
    depth_m: float = 0.0
    vertical_velocity_m_s: float = 0.0
    displaced_volume_m3: float = 0.0
    piston_target_volume_m3: float = 0.0
    samples: List[SensorSample] = field(default_factory=list)
    event_log: List[str] = field(default_factory=list)
    rng: random.Random = field(default_factory=lambda: random.Random(7))

    def __post_init__(self) -> None:
        self.displaced_volume_m3 = self.config.neutral_volume_m3
        self.piston_target_volume_m3 = (
            self.config.neutral_volume_m3 - self.config.stroke_magnitude_m3
        )
        self.event_log.append("Dive cycle started")

    @property
    def density_kg_m3(self) -> float:
        return self.config.mass_kg / self.displaced_volume_m3

    def log_sensors(self) -> None:
        temperature = self.environment.water_temperature_c(self.depth_m)
        salinity = self.environment.water_salinity_psu(self.depth_m)
        conductivity = 0.8 + 0.02 * salinity + 0.001 * temperature
        self.samples.append(
            SensorSample(
                time_s=self.time_s,
                phase=self.phase,
                depth_m=self.depth_m,
                pressure_bar=max(0.0, self.depth_m / 10.0),
                temperature_c=temperature + self.rng.gauss(0.0, 0.01),
                salinity_psu=salinity + self.rng.gauss(0.0, 0.005),
                conductivity_m_s_cm=conductivity + self.rng.gauss(0.0, 0.002),
            )
        )

    def set_piston_target(self, volume_m3: float) -> None:
        self.piston_target_volume_m3 = volume_m3

    def move_piston(self, dt: float) -> None:
        delta = self.piston_target_volume_m3 - self.displaced_volume_m3
        max_delta = self.config.piston_rate_m3_s * dt
        self.displaced_volume_m3 += max(-max_delta, min(max_delta, delta))

    def update_vertical_dynamics(self, dt: float) -> None:
        water_density = self.environment.water_density_kg_m3(self.depth_m)
        buoyancy_minus_weight = (
            (water_density * self.displaced_volume_m3 - self.config.mass_kg) * 9.81
        )
        drag = self.config.vertical_drag * self.vertical_velocity_m_s
        acceleration = (buoyancy_minus_weight - drag) / self.config.effective_mass_kg
        self.vertical_velocity_m_s += acceleration * dt
        self.vertical_velocity_m_s = max(-2.0, min(2.0, self.vertical_velocity_m_s))
        self.depth_m = max(
            0.0, min(self.config.max_depth_m, self.depth_m - self.vertical_velocity_m_s * dt)
        )

    def perform_ice_check(self) -> bool:
        distance = self.environment.ice_distance_m(self.depth_m)
        temperature = self.environment.water_temperature_c(self.depth_m)
        ice_detected = distance is not None and distance <= self.config.ice_abort_distance_m
        thermal_warning = temperature <= self.environment.ice_freezing_point_c
        self.event_log.append(
            "Ice check: "
            f"distance={distance if distance is not None else 'clear'} m, "
            f"temperature={temperature:.2f} C, "
            f"thermal_warning={thermal_warning}"
        )
        return ice_detected or thermal_warning

    def transition(self) -> None:
        if self.phase == Phase.DESCENDING and self.depth_m >= self.config.target_depth_m:
            self.phase = Phase.PROFILING
            self.set_piston_target(self.config.neutral_volume_m3)
            self.event_log.append(f"Reached target depth {self.depth_m:.1f} m; profiling")
        elif self.phase == Phase.PROFILING and abs(self.vertical_velocity_m_s) < 0.03:
            self.phase = Phase.ASCENDING
            self.set_piston_target(
                self.config.neutral_volume_m3 + self.config.stroke_magnitude_m3
            )
            self.event_log.append("Profile complete; ascent started")
        elif self.phase == Phase.ASCENDING and self.depth_m <= self.config.surface_check_depth_m:
            self.phase = Phase.ICE_CHECK
            self.set_piston_target(self.config.neutral_volume_m3)
        elif self.phase == Phase.ICE_CHECK:
            if self.perform_ice_check():
                self.phase = Phase.ICE_HOLD
                self.set_piston_target(
                    self.config.neutral_volume_m3 - self.config.stroke_magnitude_m3
                )
                self.event_log.append(
                    f"Ice obstruction/thermal risk; holding at {self.config.ice_hold_depth_m:.1f} m"
                )
            else:
                self.phase = Phase.SURFACED
                self.vertical_velocity_m_s = 0.0
                self.depth_m = 0.0
                self.event_log.append("Open water confirmed; surfaced and transmitting")
        elif self.phase == Phase.ICE_HOLD and self.depth_m >= self.config.ice_hold_depth_m:
            self.vertical_velocity_m_s = 0.0
            self.event_log.append("Deep sleep entered")

    def run(self) -> None:
        while (
            self.time_s < self.config.max_simulation_time_s
            and self.phase != Phase.SURFACED
            and not (
                self.phase == Phase.ICE_HOLD
                and self.depth_m >= self.config.ice_hold_depth_m
            )
        ):
            dt = self.config.simulation_step_s
            self.move_piston(dt)
            self.update_vertical_dynamics(dt)
            self.log_sensors()
            self.time_s += dt
            self.transition()

        if self.phase not in (Phase.SURFACED, Phase.ICE_HOLD):
            raise RuntimeError("Simulation timed out before reaching a terminal state")


def run_scenario(name: str, environment: Environment) -> PolarAOOP:
    vehicle = PolarAOOP(environment=environment)
    vehicle.run()
    print(f"\n{name}: {vehicle.phase.name}")
    print(f"  elapsed: {vehicle.time_s:.1f} s")
    print(f"  final depth: {vehicle.depth_m:.1f} m")
    print(f"  sensor samples: {len(vehicle.samples)}")
    for event in vehicle.event_log:
        print(f"  - {event}")
    return vehicle


if __name__ == "__main__":
    open_water = run_scenario("Open-water profile", Environment())
    ice_case = run_scenario(
        "Ice-overhead profile",
        Environment(ice_base_depth_m=1.8, surface_temperature_c=-1.8),
    )
    assert open_water.phase is Phase.SURFACED
    assert ice_case.phase is Phase.ICE_HOLD
