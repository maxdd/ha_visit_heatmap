export function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function decayOpacity(now, lastSeen, rate) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const lastMs = typeof lastSeen === "number" ? lastSeen : Date.parse(lastSeen);
  const ageDays = (nowMs - lastMs) / 86400e3;
  return Math.max(0, Math.min(1, Math.pow(1 - rate, ageDays)));
}

export function withinHorizon(now, lastSeen, horizon) {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const lastMs = typeof lastSeen === "number" ? lastSeen : Date.parse(lastSeen);
  return (nowMs - lastMs) / 86400e3 <= horizon;
}

export function parseEntities(config, states, entityRegistry) {
  if (config.show_all) {
    const entities = [];
    for (const entity of Object.values(states || {})) {
      if (
        entity.attributes.latitude != null &&
        entity.attributes.longitude != null &&
        entity.entity_id.startsWith("device_tracker.") &&
        !(entityRegistry || {})[entity.entity_id]?.hidden
      ) {
        entities.push({ entity: entity.entity_id });
      }
    }
    return entities;
  }
  return (config.entities || []).map((entry) =>
    typeof entry === "string" ? { entity: entry } : { ...entry }
  );
}

export function journeySegments(
  points,
  { maxGapMs, maxDistM, hasStationaryBetween, atLeastOneMoving },
) {
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const gapMs = Date.parse(b.last_seen) - Date.parse(a.last_seen);
    const connectedByTime = gapMs <= maxGapMs;
    const connectedByDistance =
      maxDistM != null &&
      haversineM(a.lat, a.lon, b.lat, b.lon) <= maxDistM;
    if (!connectedByTime && !connectedByDistance) continue;
    if (atLeastOneMoving && !a.moving && !b.moving) continue;
    if (hasStationaryBetween && hasStationaryBetween(a, b)) continue;
    segments.push({ a, b });
  }
  return segments;
}
