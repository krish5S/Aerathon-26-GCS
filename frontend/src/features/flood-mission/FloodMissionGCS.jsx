"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Head from "next/head";
import {
  ChevronUp,
  ChevronDown,
  Globe2,
  LocateFixed,
  Maximize2,
  Minimize2,
  Plus,
  Minus,
  MapPin,
  Upload,
} from "lucide-react";
import CesiumGlobe from "./components/CesiumGlobe";
import { useCesium } from "@/context/CesiumContext";

const API = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";
const DEFAULT_KML_URL = "/mock_arena_geofence.kml";
const EARTH_RADIUS_M = 6_371_000;
const LAUNCH_OFFSET_SOUTH_M = 13 * (40 / 30);
const MISSION_ALTITUDE_M = 5;
const MISSION_SPEED_MPS = 3;
const PHASE_LABELS = {
  INITIALIZING: "INITIALIZING",
  TAKEOFF: "TAKEOFF",
  SURVEY: "SEARCHING FLOOD ZONE",
  RETURN: "RETURNING TO LAUNCH",
  LAND: "LANDING",
  COMPLETE: "MISSION COMPLETE",
  STOPPED: "MISSION STOPPED",
  ERROR: "SIMULATION ERROR",
};

function prettyTime(seconds = 0) {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function focusMissionArea(viewer, positions, duration = 1.2) {
  if (!viewer || viewer.isDestroyed() || !window.Cesium || !positions?.length) return;
  const Cesium = window.Cesium;
  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  viewer.camera.flyToBoundingSphere(sphere, {
    duration,
    offset: new Cesium.HeadingPitchRange(
      0,
      -1.3,
      Math.max(sphere.radius * 8, 650),
    ),
  });
}

function GeoEntities({ mission, selectedFile, focusOnLoad, onKmlReady, onKmlError }) {
  const { viewer } = useCesium();
  const kmlEntities = useRef([]);
  const kmlPositions = useRef([]);
  const kmlSiteEntity = useRef(null);
  const missionEntities = useRef({});
  const [kmlVersion, setKmlVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const loadKml = async () => {
      if (!viewer || viewer.isDestroyed() || !window.Cesium) return;
      const Cesium = window.Cesium;
      kmlEntities.current.forEach((entity) => viewer.entities.remove(entity));
      kmlEntities.current = [];
      kmlPositions.current = [];
      kmlSiteEntity.current = null;
      if (!selectedFile) {
        onKmlReady(null, []);
        return;
      }
      const xml = new DOMParser().parseFromString(await selectedFile.text(), "application/xml");
      if (cancelled) return;
      if (xml.querySelector("parsererror")) {
        onKmlReady(null, []);
        onKmlError("This KML file could not be parsed.");
        return;
      }
      const coordinateNodes = [...xml.getElementsByTagNameNS("*", "coordinates")];
      const all = [];
      const allCoordinates = [];
      const coordinateGroups = [];
      let pointHome = null;
      for (const node of coordinateNodes) {
        const coordinates = node.textContent.trim().split(/\s+/).map((token) => {
          const [longitude, latitude, altitude = "0"] = token.split(",").map(Number);
          return Number.isFinite(longitude) && Number.isFinite(latitude)
            ? { longitude, latitude, altitude: Number.isFinite(altitude) ? altitude : 0 }
            : null;
        }).filter(Boolean);
        const parsed = coordinates.map(({ longitude, latitude, altitude }) =>
          Cesium.Cartesian3.fromDegrees(longitude, latitude, altitude));
        if (!parsed.length) continue;
        all.push(...parsed);
        allCoordinates.push(...coordinates);
        coordinateGroups.push(coordinates);
        let parent = node.parentElement;
        while (parent && parent.localName !== "Point" && parent.localName !== "LineString" && parent.localName !== "LinearRing") {
          parent = parent.parentElement;
        }
        const isPoint = parent?.localName === "Point";
        if (isPoint && !pointHome) pointHome = coordinates[0];
        const entity = viewer.entities.add(isPoint
          ? {
              position: parsed[0],
              point: { pixelSize: 13, color: Cesium.Color.fromCssColorString("#ff9a43"), outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
              label: { text: "KML SITE", font: "11px sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, pixelOffset: new Cesium.Cartesian2(0, -20) },
            }
          : {
              polyline: { positions: parsed, width: 2, material: Cesium.Color.fromCssColorString("#ff9a43").withAlpha(0.8) },
            });
        kmlEntities.current.push(entity);
        if (isPoint && !kmlSiteEntity.current) kmlSiteEntity.current = entity;
      }
      if (!allCoordinates.length) {
        onKmlReady(null, []);
        onKmlError("No usable coordinates were found in this KML file.");
        return;
      }
      kmlPositions.current = all;
      setKmlVersion((version) => version + 1);
      const outerBoundary = coordinateGroups.reduce((largest, group) => {
        const longitudes = group.map((item) => item.longitude);
        const latitudes = group.map((item) => item.latitude);
        const area = (Math.max(...longitudes) - Math.min(...longitudes)) * (Math.max(...latitudes) - Math.min(...latitudes));
        return !largest || area > largest.area ? { group, area } : largest;
      }, null)?.group || allCoordinates;
      const center = {
        longitude: (Math.min(...outerBoundary.map((item) => item.longitude)) + Math.max(...outerBoundary.map((item) => item.longitude))) / 2,
        latitude: (Math.min(...outerBoundary.map((item) => item.latitude)) + Math.max(...outerBoundary.map((item) => item.latitude))) / 2,
        altitude: 0,
      };
      const site = pointHome || {
        ...center,
        latitude: center.latitude - Cesium.Math.toDegrees(LAUNCH_OFFSET_SOUTH_M / EARTH_RADIUS_M),
      };
      if (!kmlSiteEntity.current) {
        kmlSiteEntity.current = viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(site.longitude, site.latitude, site.altitude),
          point: { pixelSize: 15, color: Cesium.Color.fromCssColorString("#ff9a43"), outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
          label: { text: "LAUNCH SITE", font: "bold 10px sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, pixelOffset: new Cesium.Cartesian2(0, -22) },
        });
        kmlEntities.current.push(kmlSiteEntity.current);
      }
      if (focusOnLoad && all.length && !cancelled) {
        await new Promise((resolve) => {
          const sphere = Cesium.BoundingSphere.fromPoints(all);
          viewer.camera.flyToBoundingSphere(sphere, {
            duration: 1.8,
            offset: new Cesium.HeadingPitchRange(0, -1.3, Math.max(sphere.radius * 8, 650)),
            complete: resolve,
            cancel: resolve,
          });
        });
      }
      if (!cancelled) onKmlReady(site, all);
    };
    loadKml();
    return () => { cancelled = true; };
  }, [viewer, selectedFile, focusOnLoad, onKmlReady, onKmlError]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !window.Cesium) return;
    const Cesium = window.Cesium;
    const entities = missionEntities.current;
    const remove = (key) => {
      if (Array.isArray(entities[key])) entities[key].forEach((entity) => viewer.entities.remove(entity));
      else if (entities[key]) viewer.entities.remove(entities[key]);
      delete entities[key];
    };

    if (!mission?.home) {
      if (entities.cameraTimer) window.clearTimeout(entities.cameraTimer);
      entities.cameraTimer = null;
      ["planned", "trail", "home", "drone", "people"].forEach(remove);
      entities.plannedKey = null;
      entities.trailKey = null;
      entities.peopleKey = null;
      entities.cameraKey = null;
      return;
    }
    if (kmlSiteEntity.current) {
      viewer.entities.remove(kmlSiteEntity.current);
      kmlSiteEntity.current = null;
    }
    const point = (location, altitude = 0) => Cesium.Cartesian3.fromDegrees(
      location.longitude,
      location.latitude,
      Math.max(altitude, 0),
    );
    const pathPositions = (locations) => locations.map((location) => point(location, location.altitude || 5));

    const plannedKey = (mission.planned_route || []).map((location) => `${location.latitude},${location.longitude}`).join("|");
    if (entities.plannedKey !== plannedKey) {
      remove("planned");
      if (mission.planned_route?.length > 1) {
        entities.planned = viewer.entities.add({
          polyline: {
            positions: pathPositions(mission.planned_route),
            width: 3,
            material: Cesium.Color.fromCssColorString("#ff741f").withAlpha(0.9),
            arcType: Cesium.ArcType.GEODESIC,
          },
        });
      }
      entities.plannedKey = plannedKey;
    }

    if (!entities.home) {
      entities.home = viewer.entities.add({
        position: point(mission.home),
        point: { pixelSize: 15, color: Cesium.Color.fromCssColorString("#ff9a43"), outlineColor: Cesium.Color.BLACK, outlineWidth: 2 },
        label: { text: "LAUNCH SITE", font: "bold 11px sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, pixelOffset: new Cesium.Cartesian2(0, -35) },
      });
    }

    const cameraKey = `${mission.home.latitude},${mission.home.longitude}:${plannedKey}:${kmlVersion}`;
    if (entities.cameraKey !== cameraKey) {
      const routePoints = pathPositions(mission.planned_route || []);
      const focusPoints = [...kmlPositions.current, ...routePoints];
      if (entities.cameraTimer) window.clearTimeout(entities.cameraTimer);
      entities.cameraTimer = window.setTimeout(() => {
        focusMissionArea(viewer, focusPoints.length ? focusPoints : [point(mission.home)]);
        entities.cameraTimer = null;
      }, 1800);
      entities.cameraKey = cameraKey;
    }

    const trail = mission.state?.trail || [];
    const trailKey = `${trail.length}:${trail.at(-1)?.latitude || 0}:${trail.at(-1)?.longitude || 0}`;
    if (entities.trailKey !== trailKey) {
      remove("trail");
      if (trail.length > 1) {
        entities.trail = viewer.entities.add({
          polyline: {
            positions: pathPositions(trail),
            width: 3,
            material: Cesium.Color.fromCssColorString("#ffd2a8"),
            arcType: Cesium.ArcType.GEODESIC,
          },
        });
      }
      entities.trailKey = trailKey;
    }

    const drone = mission.state?.drone;
    if (drone) {
      if (!entities.drone) {
        entities.drone = viewer.entities.add({
          position: point(drone, drone.altitude),
          point: { pixelSize: 17, color: Cesium.Color.fromCssColorString("#ff741f"), outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
          label: { text: "RESCUE-01", font: "bold 12px sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, pixelOffset: new Cesium.Cartesian2(0, -48) },
        });
      } else {
        entities.drone.position = point(drone, drone.altitude);
      }
    }

    const people = mission.state?.people || [];
    const peopleKey = people.map((person) => `${person.id}:${person.latitude}:${person.longitude}`).join("|");
    if (entities.peopleKey !== peopleKey) {
      remove("people");
      if (people.length) entities.people = people.map((person) => viewer.entities.add({
          position: point(person),
          point: { pixelSize: 12, color: Cesium.Color.fromCssColorString("#ff5a66"), outlineColor: Cesium.Color.WHITE, outlineWidth: 2 },
          label: { text: `P${String(person.id).padStart(2, "0")}`, font: "bold 10px sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, pixelOffset: new Cesium.Cartesian2(12, -13 - ((person.id - 1) % 4) * 11) },
        }));
      entities.peopleKey = peopleKey;
    }
  }, [viewer, mission, kmlVersion]);

  useEffect(() => () => {
    if (!viewer || viewer.isDestroyed()) return;
    if (missionEntities.current.cameraTimer) window.clearTimeout(missionEntities.current.cameraTimer);
    if (viewer.isDestroyed()) return;
    kmlEntities.current.forEach((entity) => viewer.entities.remove(entity));
    ["planned", "trail", "home", "drone", "people"].forEach((key) => {
      const entity = missionEntities.current[key];
      if (Array.isArray(entity)) entity.forEach((item) => viewer.entities.remove(item));
      else if (entity) viewer.entities.remove(entity);
    });
  }, [viewer]);

  return null;
}

function CameraPanel({ title, camera, stamp, sessionId, active, detail, expanded, onToggle }) {
  const src = sessionId ? `${API}/simulation/flood/${sessionId}/camera/${camera}?frame=${stamp}` : null;
  const feedText = active ? "SIM FEED" : sessionId ? "LAST FRAME" : "STANDBY";
  return (
    <section className={`camera-card ${expanded ? "camera-expanded" : ""}`} aria-label={`${title} panel`}>
      <div className="camera-head">
        <div className="camera-title"><span className={`camera-indicator camera-${camera}`} /><span>{title}</span></div>
        <div className="camera-head-actions">
          <span className={`feed-state ${active ? "feed-live" : sessionId ? "feed-last" : "feed-idle"}`}><i />{feedText}</span>
          <button className="camera-expand" type="button" onClick={onToggle} aria-label={expanded ? `Restore ${title.toLowerCase()}` : `Expand ${title.toLowerCase()}`} title={expanded ? "Restore camera size" : "Expand camera"}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </div>
      <div className="camera-image">
        {src ? <img src={src} alt={`${title} simulation feed`} /> : (
          <div className="camera-empty">
            <span className="empty-feed-mark" />
            <span>AWAITING SIMULATION FEED</span>
          </div>
        )}
        {active && <div className="camera-hud"><span>SIMULATION</span><span>{detail}</span></div>}
      </div>
    </section>
  );
}

function MapControls({ viewer, is2d, onToggleMode, onHome }) {
  const zoom = (direction) => {
    if (!viewer) return;
    const height = viewer.camera.positionCartographic?.height || 10000;
    const distance = Math.max(150, Math.min(height * 0.22, 3000000));
    if (direction < 0) viewer.camera.zoomIn(distance);
    else viewer.camera.zoomOut(distance);
  };

  return (
    <div className="map-controls" aria-label="Map controls">
      <button type="button" onClick={() => zoom(-1)} disabled={!viewer} title="Zoom in" aria-label="Zoom in"><Plus size={17} /></button>
      <button type="button" onClick={() => zoom(1)} disabled={!viewer} title="Zoom out" aria-label="Zoom out"><Minus size={17} /></button>
      <span className="map-control-divider" />
      <button type="button" onClick={onToggleMode} disabled={!viewer} title={is2d ? "Switch to 3D globe" : "Switch to 2D map"} aria-label={is2d ? "Switch to 3D globe" : "Switch to 2D map"}><Globe2 size={16} /><small>{is2d ? "2D" : "3D"}</small></button>
      <button type="button" onClick={onHome} disabled={!viewer} title="Return to mission area" aria-label="Return to mission area"><LocateFixed size={16} /></button>
    </div>
  );
}

export default function FloodMissionGCS() {
  const { viewer } = useCesium();
  const fileInput = useRef(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [kmlSite, setKmlSite] = useState(null);
  const [kmlFramePoints, setKmlFramePoints] = useState([]);
  const [focusKmlOnLoad, setFocusKmlOnLoad] = useState(false);
  const [mission, setMission] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cameraStamp, setCameraStamp] = useState(Date.now());
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [expandedCamera, setExpandedCamera] = useState(null);
  const [is2d, setIs2d] = useState(false);
  const [groundSpeed, setGroundSpeed] = useState(null);
  const speedSample = useRef(null);
  const userUploadedKml = useRef(false);
  const handleKmlReady = useCallback((site, positions = []) => {
    setKmlSite(site);
    setKmlFramePoints(positions);
  }, []);
  const active = mission && ["starting", "running", "returning"].includes(mission.status);
  const phase = mission?.state?.phase || (mission?.status === "starting" ? "INITIALIZING" : "STANDBY");
  const survivorCount = mission?.state?.people?.length || 0;
  const phaseLabel = PHASE_LABELS[phase] || phase;
  const pose = mission?.state?.pose;
  const headingDegrees = Number.isFinite(pose?.yaw)
    ? ((Math.round((90 - (pose.yaw * 180) / Math.PI) % 360) + 360) % 360)
    : null;
  const heading = headingDegrees === null ? "—" : `${String(headingDegrees).padStart(3, "0")}°`;
  const battery = Number.isFinite(mission?.state?.battery_percent)
    ? `${Math.round(mission.state.battery_percent)}%`
    : "N/A";
  const launchSite = mission?.home || kmlSite;
  const gpsPosition = mission?.state?.drone
    ? `${mission.state.drone.latitude.toFixed(5)}, ${mission.state.drone.longitude.toFixed(5)}`
    : kmlSite ? `${kmlSite.latitude.toFixed(5)}, ${kmlSite.longitude.toFixed(5)}` : "—";
  const homeText = launchSite
    ? `${Math.abs(launchSite.latitude).toFixed(5)}° ${launchSite.latitude >= 0 ? "N" : "S"}  ${Math.abs(launchSite.longitude).toFixed(5)}° ${launchSite.longitude >= 0 ? "E" : "W"}`
    : selectedFile ? "Mapping mission area…" : "Loading mission KML…";

  useEffect(() => {
    let cancelled = false;
    fetch(DEFAULT_KML_URL)
      .then((response) => {
        if (!response.ok) throw new Error("The mission KML could not be loaded.");
        return response.blob();
      })
      .then((blob) => {
        if (!cancelled && !userUploadedKml.current) {
          setSelectedFile(new File([blob], "mock_arena_geofence.kml", {
            type: "application/vnd.google-earth.kml+xml",
          }));
        }
      })
      .catch((loadError) => {
        if (!cancelled && !userUploadedKml.current) setError(loadError.message || "The mission KML could not be loaded.");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/simulation/flood/active`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((data) => {
        if (cancelled || !data?.session_id) return;
        speedSample.current = null;
        setGroundSpeed(null);
        setMission((current) => current?.session_id ? current : data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const startMission = async () => {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      if (selectedFile) form.append("kml_file", selectedFile);
      form.append("altitude", String(MISSION_ALTITUDE_M));
      form.append("speed", String(MISSION_SPEED_MPS));
      form.append("realtime", "true");
      const response = await fetch(`${API}/simulation/flood/start`, { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not start the flood simulation");
      setGroundSpeed(null);
      speedSample.current = null;
      setMission({ ...data, state: { phase: "INITIALIZING", trail: [], people: [] } });
    } catch (e) {
      const message = e.message || "Could not connect to the simulation backend";
      if (/already active/i.test(message)) {
        try {
          const response = await fetch(`${API}/simulation/flood/active`, { cache: "no-store" });
          const activeMission = response.ok ? await response.json() : null;
          if (activeMission?.session_id) {
            speedSample.current = null;
            setGroundSpeed(null);
            setMission(activeMission);
            setError("");
            return;
          }
        } catch {
          // Keep the original start error if the active session cannot be recovered.
        }
      }
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const uploadKml = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".kml")) {
      setError("Choose a .kml file. KMZ archives are not supported in this demo.");
      return;
    }
    userUploadedKml.current = true;
    setError("");
    setKmlSite(null);
    setKmlFramePoints([]);
    setMission(null);
    setGroundSpeed(null);
    speedSample.current = null;
    setSelectedFile(file);
    setFocusKmlOnLoad(true);
  };

  const returnToLaunch = async () => {
    if (!mission?.session_id) return;
    try {
      const response = await fetch(`${API}/simulation/flood/${mission.session_id}/stop`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Could not request return to launch");
      setMission((current) => ({ ...current, status: data.status, state: { ...current.state, phase: "RETURN" } }));
    } catch (e) {
      setError(e.message || "Could not request return to launch");
    }
  };

  useEffect(() => {
    if (!mission?.session_id) return undefined;
    if (!["starting", "running", "returning"].includes(mission.status)) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${API}/simulation/flood/${mission.session_id}/state`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Lost simulation connection");
        if (!cancelled) {
          if (data.status === "failed" && data.error) setError(data.error);
          const state = data.state;
          const pose = state?.pose;
          if (pose && Number.isFinite(state?.sim_time) && Number.isFinite(pose.x) && Number.isFinite(pose.y)) {
            const previous = speedSample.current;
            if (previous?.sessionId === data.session_id && state.sim_time > previous.simTime) {
              const deltaTime = state.sim_time - previous.simTime;
              if (deltaTime >= 0.05) {
                setGroundSpeed(Math.hypot(pose.x - previous.x, pose.y - previous.y) / deltaTime);
              }
            } else {
              setGroundSpeed(null);
            }
            speedSample.current = { sessionId: data.session_id, simTime: state.sim_time, x: pose.x, y: pose.y };
          }
          setMission((current) => ({ ...current, ...data }));
        }
      } catch (e) {
        if (!cancelled && /session not found/i.test(e.message || "")) {
          try {
            const response = await fetch(`${API}/simulation/flood/active`, { cache: "no-store" });
            const activeMission = response.ok ? await response.json() : null;
            if (cancelled) return;
            if (activeMission?.session_id) {
              speedSample.current = null;
              setGroundSpeed(null);
              setMission((current) => current?.session_id === mission.session_id ? activeMission : current);
              setError("");
            } else {
              setMission((current) => current?.session_id === mission.session_id ? null : current);
              setGroundSpeed(null);
              speedSample.current = null;
              setError("The previous simulation session was cleared. Start the flood mission again.");
            }
          } catch {
            if (!cancelled) setError("Lost simulation connection. Check that the backend is running, then retry.");
          }
        } else if (!cancelled) {
          setError(e.message || "Lost simulation connection");
        }
      }
      if (!cancelled) setCameraStamp(Date.now());
    };
    poll();
    const timer = window.setInterval(poll, 450);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [mission?.session_id, mission?.status]);

  useEffect(() => {
    if (!expandedCamera) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setExpandedCamera(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expandedCamera]);

  useEffect(() => {
    if (window.innerWidth <= 760) setConfigCollapsed(true);
  }, []);

  const toggleMapMode = () => {
    if (!viewer) return;
    if (is2d) viewer.scene.morphTo3D(0.6);
    else viewer.scene.morphTo2D(0.6);
    setIs2d((current) => !current);
  };

  const returnMapToMission = () => {
    if (!viewer || viewer.isDestroyed()) return;
    if (!launchSite || !window.Cesium) {
      viewer.camera.flyHome(0.8);
      return;
    }
    const Cesium = window.Cesium;
    const route = mission?.planned_route || [];
    const positions = [
      ...kmlFramePoints,
      ...route.map((location) => Cesium.Cartesian3.fromDegrees(location.longitude, location.latitude, Math.max(location.altitude || 0, MISSION_ALTITUDE_M))),
    ];
    if (positions.length) focusMissionArea(viewer, positions, 0.9);
    else viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(launchSite.longitude, launchSite.latitude, 1_000), duration: 0.9 });
  };

  return (
    <main className="flood-gcs">
      <Head><title>PHOENIX GCS · Flood Mission Control</title><meta name="description" content="Phoenix GCS flood response simulation mission control." /></Head>
      <GeoEntities mission={mission} selectedFile={selectedFile} focusOnLoad={focusKmlOnLoad} onKmlReady={handleKmlReady} onKmlError={setError} />
      <div className="gcs-map-layer">
        <CesiumGlobe />
        <div className="map-vignette" />
        {!viewer && <div className="map-loading"><span className="map-loading-orbit"><LocateFixed size={20} /></span><span>CONNECTING GEOSPATIAL VIEW</span></div>}
        <div className="map-legend"><span><i className="legend-kml" />KML SITE</span><span><i className="legend-plan" />PLANNED ROUTE</span><span><i className="legend-flown" />FLOWN TRACK</span><span><i className="legend-drone" />AIRCRAFT</span><span><i className="legend-detection" />SURVIVOR</span></div>
      </div>

      <div className="gcs-overlay-layer">
        <header className="gcs-header">
          <div className="phoenix-brand">
            <img className="phoenix-mark" src="/phoenix-bird.png" alt="Phoenix bird emblem" />
            <div className="phoenix-wordmark"><strong>PHOENIX <span>GCS</span></strong><small>GROUND CONTROL STATION</small></div>
          </div>
          <img className="dhruva-logo" src="/dhruva-logo.png" alt="DHRUVA · Disaster Handling, Rescue & Unmanned Vigilance Aircraft" />
        </header>

        <aside className={`config-panel ${configCollapsed ? "config-collapsed" : ""}`} aria-label="System configuration">
          <div className="config-heading">
            <div className="config-heading-copy"><span>MISSION CONTROLS</span><h1>SYSTEM CONFIGURATION</h1></div>
            <button className="config-collapse" type="button" onClick={() => setConfigCollapsed((current) => !current)} aria-expanded={!configCollapsed} aria-label={configCollapsed ? "Expand system configuration" : "Collapse system configuration"} title={configCollapsed ? "Expand panel" : "Collapse panel"}>
              {configCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
          {configCollapsed ? (
            <div className="collapsed-config">
              <span className={`panel-status-dot ${active ? "panel-status-active" : ""}`} />
              <span>{active ? phaseLabel : "FLOOD MISSION READY"}</span>
              {active && <button className="collapsed-return" onClick={returnToLaunch} disabled={phase === "RETURN" || phase === "LAND"}>RETURN TO LAUNCH</button>}
            </div>
          ) : (
            <div className="config-body">
              <div className={`config-status ${active ? "config-status-active" : mission?.status === "failed" ? "config-status-error" : ""}`}>
                <span className="panel-status-dot" />
                <span>{active ? phaseLabel : mission?.status === "complete" ? "MISSION COMPLETE" : "SYSTEM READY"}</span>
                <strong>{prettyTime(mission?.state?.sim_time)}</strong>
              </div>

              <div className="control-label"><span className="field-kicker">SIMULATION BACKEND</span>
                <div className="static-setting"><span>PYBULLET FLOOD WORLD</span></div>
              </div>

              <div className="control-label"><span className="field-kicker">MISSION AREA · KML</span>
                <div className="kml-dropzone kml-ready">
                  <MapPin className="kml-drop-icon" size={20} strokeWidth={1.7} />
                  <span className="kml-file-copy"><strong>{selectedFile?.name || "mock_arena_geofence.kml"}</strong><small>{kmlSite ? homeText : selectedFile ? "Reading coordinates…" : "Loading mission KML…"}</small></span>
                  <button className="kml-upload-button" type="button" onClick={() => fileInput.current?.click()} disabled={active} title="Upload a mission KML">
                    <Upload size={14} strokeWidth={2} /><span>UPLOAD</span>
                  </button>
                </div>
                <input ref={fileInput} type="file" accept=".kml,application/vnd.google-earth.kml+xml" hidden onChange={uploadKml} />
              </div>

              <div className="config-field-grid">
                <label className="control-label"><span className="field-kicker">ALTITUDE</span><span className="number-input-wrap"><input type="number" value={MISSION_ALTITUDE_M} readOnly /><small>m AGL</small></span></label>
                <label className="control-label"><span className="field-kicker">SURVEY SPEED</span><span className="number-input-wrap"><input type="number" value={MISSION_SPEED_MPS} readOnly /><small>m/s</small></span></label>
              </div>

              {active ? (
                <button className="return-button" onClick={returnToLaunch} disabled={phase === "RETURN" || phase === "LAND"}>{phase === "RETURN" || phase === "LAND" ? "RETURNING TO LAUNCH" : "RETURN TO LAUNCH"}</button>
              ) : (
                <button className="start-button" onClick={startMission} disabled={busy}>
                  {busy ? <span className="spinner" /> : null}{busy ? "STARTING SIMULATION" : "START FLOOD MISSION"}
                </button>
              )}

              <div className="config-note"><span className="config-note-mark" /><span>Return to launch stays available during flight. Simulation only; not for flight operations.</span></div>
              <div className="backend-note"><span>ACTIVE SIMULATOR</span><strong>PYBULLET FLOOD WORLD</strong></div>
            </div>
          )}
        </aside>

        {error && <div className="error-banner" role="alert"><span className="error-mark" /><span>{error}</span><button onClick={() => setError("")}>DISMISS</button></div>}

        <MapControls viewer={viewer} is2d={is2d} onToggleMode={toggleMapMode} onHome={returnMapToMission} />

        {expandedCamera && <button className="camera-expanded-backdrop" type="button" aria-label="Close expanded camera" onClick={() => setExpandedCamera(null)} />}
        <section className="camera-stack" aria-label="Simulation cameras">
          <CameraPanel title="FRONT CAMERA" camera="front" stamp={cameraStamp} sessionId={mission?.session_id} active={active} detail={phase === "SURVEY" ? "SURVIVOR SEARCH" : "FLIGHT VIEW"} expanded={expandedCamera === "front"} onToggle={() => setExpandedCamera((current) => current === "front" ? null : "front")} />
          <CameraPanel title="DOWN CAMERA" camera="down" stamp={cameraStamp} sessionId={mission?.session_id} active={active} detail="GROUND SCAN" expanded={expandedCamera === "down"} onToggle={() => setExpandedCamera((current) => current === "down" ? null : "down")} />
        </section>

        <section className="telemetry-strip" aria-label="Live telemetry">
          <div className="telemetry-cell aircraft-cell"><span><small>AIRCRAFT</small><strong>DHRUVA · RESCUE-01</strong></span></div>
          <div className="telemetry-cell phase-cell"><span><small>FLIGHT PHASE</small><strong>{phaseLabel}</strong></span></div>
          <div className="telemetry-cell"><span><small>MISSION TIME</small><strong className="mono">{prettyTime(mission?.state?.sim_time)}</strong></span></div>
          <div className="telemetry-cell"><span><small>ALTITUDE</small><strong className="mono">{mission?.state?.drone ? `${mission.state.drone.altitude.toFixed(1)} m` : "—"}</strong></span></div>
          <div className="telemetry-cell"><span><small>GROUND SPEED</small><strong className="mono">{active && Number.isFinite(groundSpeed) ? `${groundSpeed.toFixed(1)} m/s` : "—"}</strong></span></div>
          <div className="telemetry-cell"><span><small>HEADING</small><strong className="mono">{heading}</strong></span></div>
          <div className="telemetry-cell position-cell"><span><small>GPS POSITION</small><strong className="mono">{gpsPosition}</strong></span></div>
          <div className="telemetry-cell"><span><small>BATTERY</small><strong className="mono muted-value">{battery}</strong></span></div>
          <div className="telemetry-cell people-cell"><span><small>SURVIVORS</small><strong>{String(survivorCount).padStart(2, "0")} confirmed</strong></span></div>
          <div className="telemetry-cell link-cell"><span className={`link-indicator ${active ? "link-active" : ""}`} /><span><small>SIM LINK</small><strong>{active ? "STREAMING" : mission?.status === "failed" ? "ERROR" : "STANDBY"}</strong></span></div>
        </section>
      </div>
    </main>
  );
}
