const state = {
  running: false,
  scenario: "open",
  phase: "descend",
  depth: 0,
  elapsed: 0,
  timer: null,
  targetDepth: 100,
  holdDepth: 0,
  hazardAtSurface: false,
  surfaceHazardDistance: null,
  surfaceHazardType: null,
  massKg: 102.7,
  neutralVolumeM3: 0.1,
  displacedVolumeM3: 0.1,
  volumeFlowMlPerTick: 0,
  transmitProgress: 0,
  cycleNumber: 0,
  autoCycleTimer: null,
};

const $ = (id) => document.getElementById(id);
const phases = ["descend", "profile", "ascend", "scan"];
const phaseCopy = {
  descend: ["Descending through water column", "DIVE CYCLE"],
  profile: ["Neutral density / profiling", "PROFILING"],
  ascend: ["Expanding displacement chamber", "ASCENDING"],
  scan: ["Scanning overhead conditions", "ICE CHECK"],
  surfaced: ["Surface link established", "SURFACED"],
  hold: ["Balancing in mid-water column", "HOLD DEPTH"],
  transmit: ["Transmitting mission data", "DATA UPLINK"],
};
const scenarioLabels = {
  open: "OPEN WATER",
  object: "OBJECT WATCH",
  ice: "ICE WATCH",
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function updateTargetDepth() {
  const nextDepth = parseFloat($("descentDepthInput").value);
  if (Number.isFinite(nextDepth)) {
    state.targetDepth = clamp(nextDepth, 5, 200);
    $("descentDepthInput").value = state.targetDepth.toFixed(0);
  }
}

function setWarning(type, distanceM) {
  state.surfaceHazardType = type;
  state.surfaceHazardDistance = distanceM;
  const label = type === "ice" ? "ICE" : "OBJECT";
  $("warningText").textContent = `${label} detected overhead at ${distanceM.toFixed(2)} m. Abort ascent and re-initiate descent.`;
  $("warningBanner").classList.remove("hidden");
  $("warningBanner").classList.add("critical");
  $("warningBanner").setAttribute("aria-label", `${label} obstruction ${distanceM.toFixed(2)} meters overhead`);
  if (!$("warningBanner").dataset.active || $("warningBanner").dataset.active !== label) {
    addLog(`${label} warning: ${distanceM.toFixed(2)} m overhead.`);
    $("warningBanner").dataset.active = label;
  }
}

function clearWarning() {
  state.surfaceHazardDistance = null;
  state.surfaceHazardType = null;
  $("warningBanner").dataset.active = "";
  $("warningBanner").classList.remove("critical");
  $("warningBanner").removeAttribute("aria-label");
  $("warningBanner").classList.add("hidden");
}

function addLog(message) {
  const stamp = new Date(state.elapsed * 1000).toISOString().slice(14, 19);
  const row = document.createElement("p");
  row.innerHTML = `<time>${stamp}</time><span>${message}</span>`;
  $("eventLog").prepend(row);
  while ($("eventLog").children.length > 5) $("eventLog").lastElementChild.remove();
}

function checkSurfaceHazard() {
  const inApproachWindow = state.phase === "ascend" || state.phase === "scan";
  if (!inApproachWindow || state.depth > 8) {
    clearWarning();
    return null;
  }
  if (state.scenario === "open") {
    clearWarning();
    return null;
  }

  const surfacingWindow = clamp(3 - state.depth, 0, 3);
  const sensorJitter = Math.sin(state.elapsed * 4.2) * 0.025;
  const hazardType = state.scenario === "ice" ? "ice" : "object";
  const baseDistance = hazardType === "ice" ? 0.18 : 0.3;
  const approachScale = hazardType === "ice" ? 0.14 : 0.2;
  const hazardDistance = Number(clamp(baseDistance + surfacingWindow * approachScale + sensorJitter, 0.12, 0.9).toFixed(2));
  const threshold = hazardType === "ice" ? 0.55 : 0.75;
  if (hazardDistance <= threshold) {
    setWarning(hazardType, hazardDistance);
    return hazardDistance;
  }

  clearWarning();
  return null;
}

function setPhase(phase) {
  state.phase = phase;
  document.querySelectorAll(".phase").forEach((node, index) => {
    const validIndex = phases.indexOf(phase);
    node.classList.toggle("active", phases[index] === phase);
    node.classList.toggle("done", validIndex !== -1 && index < validIndex);
  });
  const copy = phaseCopy[phase] || phaseCopy.descend;
  $("phaseTitle").textContent = copy[0];
  $("logStatus").textContent = copy[1];
  $("modePill").textContent = scenarioLabels[state.scenario] || scenarioLabels.open;
}

function updateReadouts() {
  const temp = state.scenario === "ice" && state.depth < 8 ? -1.8 : -1.2 + Math.min(state.depth, 300) * .012;
  const density = state.massKg / state.displacedVolumeM3;
  const displacementShiftMl = Math.round((state.displacedVolumeM3 - state.neutralVolumeM3) * 1000000);
  const densityDisplay = density.toFixed(1);
  const flowLevel = clamp(Math.abs(state.volumeFlowMlPerTick) / 5, 0.05, 1);
  const flow = state.volumeFlowMlPerTick < 0
    ? { intake: flowLevel, outlet: 0.08 }
    : state.volumeFlowMlPerTick > 0
      ? { intake: 0.08, outlet: flowLevel }
      : { intake: 0.08, outlet: 0.08 };

  $("depthValue").textContent = state.depth.toFixed(1);
  $("pressureValue").textContent = (state.depth / 10).toFixed(1);
  $("tempValue").textContent = temp.toFixed(2).replace("-", "−");
  $("salinityValue").textContent = (33.5 + Math.min(state.depth, 300) * .004).toFixed(2);
  $("volumeValue").textContent = displacementShiftMl > 0 ? `+${displacementShiftMl}` : displacementShiftMl < 0 ? `−${Math.abs(displacementShiftMl)}` : "0";
  $("densityValue").textContent = densityDisplay;
  $("inboundFlow").style.setProperty("--flow-level", flow.intake.toFixed(2));
  $("outboundFlow").style.setProperty("--flow-level", flow.outlet.toFixed(2));
  $("inboundFlow").style.opacity = state.phase === "descend" || state.phase === "hold" || state.phase === "profile" ? "1" : "0.25";
  $("outboundFlow").style.opacity = state.phase === "ascend" || state.phase === "hold" || state.phase === "scan" ? "1" : "0.25";
  $("missionClock").textContent = new Date(state.elapsed * 1000).toISOString().slice(11, 19);
  const percent = Math.min(state.depth / 160, 1);
  $("float").style.top = `${Math.max(6, percent * 88)}%`;
  $("transmitProgress").style.width = `${state.transmitProgress}%`;
  $("transmitPercent").textContent = `${Math.round(state.transmitProgress)}%`;
  $("stationLink").className = `uplink-row ${state.transmitProgress >= 50 ? "complete" : "active"}`;
  $("satelliteLink").className = `uplink-row ${state.transmitProgress >= 100 ? "complete" : state.transmitProgress >= 50 ? "active" : ""}`;
  $("stationStatus").textContent = state.transmitProgress >= 50 ? "Packet received · handoff complete" : "Receiving signal…";
  $("satelliteStatus").textContent = state.transmitProgress >= 100 ? "Packet verified · acknowledgement sent" : state.transmitProgress >= 50 ? "Receiving station relay…" : "Waiting for station handoff";
}

function animateOcean() {
  const time = performance.now() / 1000;
  const surfaceFactor = clamp(1 - state.depth / 18, 0, 1);
  const swell = Math.sin(time * 0.72) * 7 + Math.sin(time * 1.31 + 1.6) * 3;
  const chop = Math.sin(time * 2.8 + 0.8) * 1.8;
  const waveX = (swell + chop) * surfaceFactor;
  const waveTilt = (Math.sin(time * 0.72 + 0.8) * 2.2 + Math.sin(time * 1.7) * .7) * surfaceFactor;
  const waveBob = (Math.sin(time * 1.1) * 2.6 + Math.sin(time * 2.6) * .7) * surfaceFactor;
  $("ocean").style.setProperty("--wave-offset", `${swell * 1.8}px`);
  $("float").style.setProperty("--wave-x", `${waveX.toFixed(2)}px`);
  $("float").style.setProperty("--wave-tilt", `${waveTilt.toFixed(2)}deg`);
  $("float").style.setProperty("--wave-bob", `${waveBob.toFixed(2)}px`);
  requestAnimationFrame(animateOcean);
}

function beginTransmission() {
  state.phase = "transmit";
  state.transmitProgress = 0;
  $("scanBeam").classList.remove("active");
  $("sonarPulse").classList.remove("active");
  $("transmissionPanel").classList.add("visible");
  $("ackOverlay").classList.remove("visible");
  $("ackOverlay").setAttribute("aria-hidden", "true");
  $("launchLabel").textContent = "TRANSMITTING DATA";
  setPhase("transmit");
  addLog("Surface breach confirmed. Antenna linked to station.");
  addLog("Uploading temperature, salinity, conductivity, and pressure profile.");
}

function finish(result) {
  clearInterval(state.timer);
  state.running = false;
  clearWarning();
  $("launchButton").disabled = false;
  $("launchLabel").textContent = result === "surface" ? "MISSION COMPLETE" : "HOLDING DEPTH";
  $("statusDot").style.background = result === "surface" ? "var(--cyan)" : "var(--coral)";
  $("statusDot").style.boxShadow = result === "surface" ? "0 0 14px var(--cyan)" : "0 0 14px var(--coral)";
  setPhase(result === "surface" ? "surfaced" : "hold");
  addLog(result === "surface" ? "Station and satellite transmission complete. Mission data secured." : "Safe holding depth reached. Deep sleep engaged.");
  if (result === "surface") {
    $("launchLabel").textContent = "ACKNOWLEDGEMENT COMPLETE";
    $("ackTitle").textContent = "ACKNOWLEDGEMENT COMPLETE";
    $("ackMessage").textContent = "Ground station and satellite received the full mission packet.";
    $("ackNext").textContent = "INITIATING NEXT DIVE RUN";
    $("ackOverlay").classList.add("visible");
    $("ackOverlay").setAttribute("aria-hidden", "false");
    addLog("Acknowledgement completed. Initiating next autonomous dive run.");
    state.autoCycleTimer = setTimeout(() => {
      state.autoCycleTimer = null;
      if (!state.running) {
        $("ackOverlay").classList.remove("visible");
        $("ackOverlay").setAttribute("aria-hidden", "true");
        start();
      }
    }, 3000);
  }
}

function reInitiateDescent(reason = "Surface object or ice detected") {
  if (!state.running) {
    start();
  }
  state.hazardAtSurface = true;
  $("scanBeam").classList.remove("active");
  $("sonarPulse").classList.remove("active");
  state.phase = "descend";
  state.depth = Math.max(2, state.depth);
  $("launchLabel").textContent = "RE-DESCENDING";
  addLog(`${reason}. Re-initiating descent to ${state.targetDepth.toFixed(0)} m.`);
  setPhase("descend");
  if (state.surfaceHazardDistance !== null) {
    setWarning(state.surfaceHazardType || "object", state.surfaceHazardDistance);
  }
}

function holdDepth() {
  state.holdDepth = state.depth > 0 ? state.depth : Math.max(10, state.targetDepth / 2);
  state.phase = "hold";
  state.hazardAtSurface = false;
  $("launchLabel").textContent = "HOLDING DEPTH";
  addLog(`Neutral buoyancy engaged. Holding at ${state.holdDepth.toFixed(1)} m.`);
  setPhase("hold");
  clearWarning();
}

function tick() {
  state.elapsed += .25;

  if (state.phase === "descend") {
    state.depth += 1.15;
    state.volumeFlowMlPerTick = -5;
    state.displacedVolumeM3 = Math.max(0.0999, state.displacedVolumeM3 - 0.000005);
    if (state.depth >= state.targetDepth) {
      state.depth = state.targetDepth;
      state.hazardAtSurface = false;
      setPhase("profile");
      addLog(`Target depth reached. Density balanced at ${state.targetDepth.toFixed(0)} m.`);
    }
  } else if (state.phase === "profile") {
    state.volumeFlowMlPerTick = 0;
    state.displacedVolumeM3 = state.neutralVolumeM3;
    if (state.elapsed > Math.max(18, state.targetDepth / 4)) {
      setPhase("ascend");
      addLog("Profile complete. Piston expanding +100 mL.");
    }
  } else if (state.phase === "ascend") {
    state.depth -= 1.35;
    state.volumeFlowMlPerTick = 5;
    state.displacedVolumeM3 = Math.min(0.1001, state.displacedVolumeM3 + 0.000005);
    if (state.depth <= 3) {
      state.depth = 3;
      setPhase("scan");
      $("scanBeam").classList.add("active");
      $("sonarPulse").classList.add("active");
      addLog("Surface layer reached. Sonar scan initiated.");
    }
    const hazard = checkSurfaceHazard();
    if (hazard !== null) {
      $("iceShelf").classList.add("visible");
      reInitiateDescent(`Surface ${state.surfaceHazardType || "object"} detected at ${state.surfaceHazardDistance?.toFixed(2) || "0.00"} m`);
      return;
    }
  } else if (state.phase === "scan") {
    state.volumeFlowMlPerTick = 0;
    const hazard = checkSurfaceHazard();
    if (hazard !== null) {
      $("iceShelf").classList.add("visible");
      reInitiateDescent(`Surface ${state.surfaceHazardType || "object"} detected at ${state.surfaceHazardDistance?.toFixed(2) || "0.00"} m`);
      return;
    } else if ((state.scenario === "open" && state.elapsed > 1) || (state.scenario === "ice" && state.depth <= 3 && state.elapsed > 30)) {
      $("scanBeam").classList.remove("active");
      $("sonarPulse").classList.remove("active");
      state.depth = 0;
      beginTransmission();
    }
  } else if (state.phase === "transmit") {
    state.transmitProgress = Math.min(100, state.transmitProgress + 12.5);
    if (state.transmitProgress === 50) {
      addLog("Coastal station acknowledgement received.");
    }
    if (state.transmitProgress >= 100) {
      addLog("Satellite relay acknowledgement received. Data packet verified.");
      finish("surface");
    }
  } else if (state.phase === "hold") {
    state.volumeFlowMlPerTick = 0;
    state.transmitProgress = 0;
    const drift = state.holdDepth - state.depth;
    state.depth += drift * 0.12;
    if (Math.abs(drift) < 0.2) {
      state.depth = state.holdDepth;
    }
    $("statusDot").style.background = "var(--cyan)";
    $("statusDot").style.boxShadow = "0 0 14px var(--cyan)";
  }

  updateReadouts();
}

function start() {
  updateTargetDepth();
  if (state.running) return;
  if (state.autoCycleTimer !== null) {
    clearTimeout(state.autoCycleTimer);
    state.autoCycleTimer = null;
  }
  state.running = true;
  state.cycleNumber += 1;
  state.elapsed = 0;
  state.depth = 0;
  state.phase = "descend";
  state.holdDepth = 0;
  state.hazardAtSurface = false;
  state.surfaceHazardDistance = null;
  state.surfaceHazardType = null;
  state.displacedVolumeM3 = state.neutralVolumeM3;
  state.transmitProgress = 0;
  state.volumeFlowMlPerTick = 0;
  clearWarning();
  $("launchButton").disabled = true;
  $("launchLabel").textContent = "SEQUENCE RUNNING";
  $("eventLog").innerHTML = "";
  $("transmissionPanel").classList.remove("visible");
  $("ackOverlay").classList.remove("visible");
  $("ackOverlay").setAttribute("aria-hidden", "true");
  $("iceShelf").classList.remove("visible");
  $("scanBeam").classList.remove("active");
  $("sonarPulse").classList.remove("active");
  $("statusDot").style.background = "var(--cyan)";
  $("statusDot").style.boxShadow = "0 0 14px var(--cyan)";
  setPhase("descend");
  addLog(`Dive cycle ${state.cycleNumber} started. Piston retracting toward ${state.targetDepth.toFixed(0)} m.`);
  state.timer = setInterval(tick, 250);
}

document.querySelectorAll(".scenario").forEach((button) => button.addEventListener("click", () => {
  if (state.running) return;
  document.querySelectorAll(".scenario").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.scenario = button.dataset.scenario;
  $("modePill").textContent = scenarioLabels[state.scenario] || scenarioLabels.open;
  $("iceShelf").classList.toggle("visible", state.scenario === "ice");
}));

$("launchButton").addEventListener("click", start);
$("descentDepthInput").addEventListener("change", updateTargetDepth);
$("holdButton").addEventListener("click", () => {
  if (!state.running) {
    state.running = true;
    state.elapsed = 0;
    state.depth = state.depth || 20;
    state.phase = "hold";
    state.displacedVolumeM3 = state.neutralVolumeM3;
    state.holdDepth = Math.max(10, Math.min(state.depth, 80));
    $("launchButton").disabled = true;
    $("launchLabel").textContent = "HOLDING DEPTH";
    $("eventLog").innerHTML = "";
    setPhase("hold");
    addLog(`Manual hold engaged. Balancing at ${state.holdDepth.toFixed(1)} m.`);
    state.timer = setInterval(tick, 250);
    updateReadouts();
    return;
  }
  holdDepth();
});
$("reDescendButton").addEventListener("click", () => {
  updateTargetDepth();
  if (!state.running) {
    start();
    return;
  }
  const hazardDistance = state.surfaceHazardDistance ?? 0.28;
  const hazardType = state.surfaceHazardType || "object";
  setWarning(hazardType, hazardDistance);
  reInitiateDescent(`Manual override: ${hazardType} detected at ${hazardDistance.toFixed(2)} m`);
});

updateTargetDepth();
updateReadouts();
animateOcean();
