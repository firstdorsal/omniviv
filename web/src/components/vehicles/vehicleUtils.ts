import type { Vehicle, VehicleStop } from "../../api";
// IMPORTANT: Import directly from feature files, NOT from the barrel (./features).
// The barrel registers collisionAvoidance which imports this file — using the barrel
// here would create a circular dependency.
import { featureManager } from "./features/FeatureManager";
import { shouldStopAtStation, getDwellTimeMs } from "./features/simulatedStops";

export interface VehiclePosition {
    tripId: string;
    lineNumber: string;
    destination: string;
    lon: number;
    lat: number;
    bearing: number;
    status: "at_stop" | "in_transit" | "approaching" | "completed" | "waiting";
    currentStop?: VehicleStop;
    nextStop?: VehicleStop;
    progress: number; // 0-1 progress between stops
    delayMinutes: number | null;
    // Route position info for 3D model placement
    routeSegmentIndex?: number;      // Which segment of the flattened route the vehicle is on
    routeLinearPosition?: number;    // Distance from start of route in meters
    /** Linear position of the next stop on the route (meters from start). */
    nextStopLinearPosition?: number;
    /** Simulated milliseconds remaining until the next stop's arrival time.
     *  Used together with nextStopLinearPosition to compute the required travel
     *  speed so the vehicle arrives on time without exponential-smoothing jumps. */
    msToNextStop?: number;
}

/**
 * Find the linear position of a coordinate on the route geometry
 * Returns the distance from the start of the route to the closest point
 */
function findLinearPositionOnRoute(
    lon: number,
    lat: number,
    routeGeometry: number[][][]
): { linearPosition: number; segmentIndex: number } | null {
    if (!routeGeometry || routeGeometry.length === 0) return null;

    // Flatten route and calculate cumulative distances
    const allCoords: number[][] = [];
    const cumulativeDistances: number[] = [];
    let totalLength = 0;

    for (const segment of routeGeometry) {
        for (const coord of segment) {
            if (allCoords.length > 0) {
                const lastCoord = allCoords[allCoords.length - 1];
                if (lastCoord[0] === coord[0] && lastCoord[1] === coord[1]) continue;
                totalLength += haversineDistance(lastCoord, coord);
            }
            allCoords.push(coord);
            cumulativeDistances.push(totalLength);
        }
    }

    if (allCoords.length < 2) return null;

    // Find the closest point on any segment
    let bestDist = Infinity;
    let bestLinearPos = 0;
    let bestSegIdx = 0;

    for (let i = 0; i < allCoords.length - 1; i++) {
        const p1 = allCoords[i];
        const p2 = allCoords[i + 1];

        // Project point onto segment
        const dx = p2[0] - p1[0];
        const dy = p2[1] - p1[1];
        const lengthSq = dx * dx + dy * dy;

        let t = 0;
        if (lengthSq > 0) {
            t = ((lon - p1[0]) * dx + (lat - p1[1]) * dy) / lengthSq;
            t = Math.max(0, Math.min(1, t));
        }

        const projLon = p1[0] + t * dx;
        const projLat = p1[1] + t * dy;
        const dist = haversineDistance([lon, lat], [projLon, projLat]);

        if (dist < bestDist) {
            bestDist = dist;
            bestSegIdx = i;
            const segLength = cumulativeDistances[i + 1] - cumulativeDistances[i];
            bestLinearPos = cumulativeDistances[i] + t * segLength;
        }
    }

    return { linearPosition: bestLinearPos, segmentIndex: bestSegIdx };
}

/**
 * Calculate the current position of a vehicle based on its stop times and route geometry
 */
export function calculateVehiclePosition(
    vehicle: Vehicle,
    routeGeometry: number[][][],
    currentTime: Date = new Date()
): VehiclePosition | null {
    const { stops } = vehicle;
    // Need at least 2 stops to show a moving vehicle
    if (stops.length < 2) return null;

    const now = currentTime.getTime();

    // Find where the vehicle is based on current time
    let prevStop: VehicleStop | null = null;
    let nextStop: VehicleStop | null = null;

    for (let i = 0; i < stops.length; i++) {
        const stop = stops[i];
        const arrivalTime = getStopTime(stop, "arrival");
        const departureTime = getStopTime(stop, "departure");

        // Check if vehicle is at this stop (between arrival and departure)
        // Use arrival time as departure time fallback for stops with only arrival data
        const effectiveDeparture = departureTime ?? arrivalTime;
        if (arrivalTime && effectiveDeparture && now >= arrivalTime && now <= effectiveDeparture) {
            // Find where this stop is on the route
            const routePos = findLinearPositionOnRoute(stop.lon, stop.lat, routeGeometry);

            // If this is the last stop, mark as completed
            if (i === stops.length - 1) {
                return {
                    tripId: vehicle.trip_id,
                    lineNumber: vehicle.line_number,
                    destination: vehicle.destination,
                    lon: stop.lon,
                    lat: stop.lat,
                    bearing: 0,
                    status: "completed",
                    currentStop: stop,
                    progress: 1,
                    delayMinutes: stop.delay_minutes ?? null,
                    routeSegmentIndex: routePos?.segmentIndex,
                    routeLinearPosition: routePos?.linearPosition,
                };
            }
            return {
                tripId: vehicle.trip_id,
                lineNumber: vehicle.line_number,
                destination: vehicle.destination,
                lon: stop.lon,
                lat: stop.lat,
                bearing: calculateBearing(stop, stops[i + 1]),
                status: "at_stop",
                currentStop: stop,
                nextStop: stops[i + 1],
                progress: 0,
                delayMinutes: stop.delay_minutes ?? null,
                routeSegmentIndex: routePos?.segmentIndex,
                routeLinearPosition: routePos?.linearPosition,
            };
        }

        // Check if vehicle is between this stop and the next
        if (i < stops.length - 1) {
            const nextStopData = stops[i + 1];
            const nextArrival = getStopTime(nextStopData, "arrival");
            // Use departure time, or arrival time as fallback
            const effectiveDep = departureTime ?? arrivalTime;

            if (effectiveDep && nextArrival && now >= effectiveDep && now < nextArrival) {
                // Check if this stop has no explicit dwell time (arrival === departure)
                // and if we should simulate a stop based on time of day (if feature enabled)
                const hasNoDwellTime = arrivalTime === departureTime || departureTime === null;
                const simulatedStopsEnabled = featureManager.isEnabled("simulated-stops");

                if (simulatedStopsEnabled && hasNoDwellTime && stop.stop_ifopt && shouldStopAtStation(vehicle.trip_id, stop.stop_ifopt, currentTime)) {
                    // Calculate simulated dwell with varied duration
                    const dwellTime = getDwellTimeMs(vehicle.trip_id, stop.stop_ifopt);
                    const simulatedDepartureTime = (arrivalTime ?? effectiveDep) + dwellTime;

                    if (now < simulatedDepartureTime) {
                        // Vehicle is at the simulated stop
                        const routePos = findLinearPositionOnRoute(stop.lon, stop.lat, routeGeometry);
                        return {
                            tripId: vehicle.trip_id,
                            lineNumber: vehicle.line_number,
                            destination: vehicle.destination,
                            lon: stop.lon,
                            lat: stop.lat,
                            bearing: calculateBearing(stop, nextStopData),
                            status: "at_stop",
                            currentStop: stop,
                            nextStop: nextStopData,
                            progress: 0,
                            delayMinutes: stop.delay_minutes ?? null,
                            routeSegmentIndex: routePos?.segmentIndex,
                            routeLinearPosition: routePos?.linearPosition,
                        };
                    }
                    // Adjust the effective departure time for transit calculation
                    // The vehicle will be in transit from simulatedDepartureTime to nextArrival
                    if (now >= simulatedDepartureTime && now < nextArrival) {
                        prevStop = stop;
                        nextStop = nextStopData;
                        // Store adjusted times for later calculation
                        (prevStop as VehicleStop & { _adjustedDeparture?: number })._adjustedDeparture = simulatedDepartureTime;
                        break;
                    }
                } else {
                    prevStop = stop;
                    nextStop = nextStopData;
                    break;
                }
            }
        }

        // Check if vehicle hasn't departed yet (before first departure)
        // Show vehicle waiting at first stop
        if (i === 0 && departureTime && now < departureTime) {
            // Find where first stop is on the route
            const routePos = findLinearPositionOnRoute(stop.lon, stop.lat, routeGeometry);

            return {
                tripId: vehicle.trip_id,
                lineNumber: vehicle.line_number,
                destination: vehicle.destination,
                lon: stop.lon,
                lat: stop.lat,
                bearing: calculateBearing(stop, stops[1]),
                status: "waiting",
                currentStop: stop,
                nextStop: stops[1],
                progress: 0,
                delayMinutes: stop.delay_minutes ?? null,
                routeSegmentIndex: routePos?.segmentIndex,
                routeLinearPosition: routePos?.linearPosition,
            };
        }
    }

    // Check if journey is complete (after last arrival)
    const lastStop = stops[stops.length - 1];
    const lastArrival = getStopTime(lastStop, "arrival");
    const lastDeparture = getStopTime(lastStop, "departure");
    const lastTime = lastArrival ?? lastDeparture;

    if (lastTime && now > lastTime) {
        // Journey is complete - return completed status (will be filtered out)
        const routePos = findLinearPositionOnRoute(lastStop.lon, lastStop.lat, routeGeometry);
        return {
            tripId: vehicle.trip_id,
            lineNumber: vehicle.line_number,
            destination: vehicle.destination,
            lon: lastStop.lon,
            lat: lastStop.lat,
            bearing: 0,
            status: "completed",
            currentStop: lastStop,
            progress: 1,
            delayMinutes: lastStop.delay_minutes ?? null,
            routeSegmentIndex: routePos?.segmentIndex,
            routeLinearPosition: routePos?.linearPosition,
        };
    }

    // Vehicle is in transit between stops
    if (prevStop && nextStop) {
        // Use adjusted departure time if available (from simulated stop)
        const adjustedDeparture = (prevStop as VehicleStop & { _adjustedDeparture?: number })._adjustedDeparture;
        const departureTime = adjustedDeparture ?? getStopTime(prevStop, "departure")!;
        const arrivalTime = getStopTime(nextStop, "arrival")!;
        const totalTime = arrivalTime - departureTime;
        const elapsed = now - departureTime;
        const linearProgress = Math.min(1, Math.max(0, elapsed / totalTime));

        // Apply easing for realistic acceleration/deceleration
        const progress = easeInOutProgress(linearProgress);

        // Interpolate position along route geometry
        const position = interpolatePositionAlongRoute(
            prevStop,
            nextStop,
            progress,
            routeGeometry
        );

        const nextStopRoutePos = findLinearPositionOnRoute(nextStop.lon, nextStop.lat, routeGeometry);
        return {
            tripId: vehicle.trip_id,
            lineNumber: vehicle.line_number,
            destination: vehicle.destination,
            lon: position.lon,
            lat: position.lat,
            bearing: position.bearing,
            status: linearProgress > 0.8 ? "approaching" : "in_transit",
            currentStop: prevStop,
            nextStop: nextStop,
            progress: linearProgress, // Use linear progress for external tracking
            delayMinutes: prevStop.delay_minutes ?? nextStop.delay_minutes ?? null,
            routeSegmentIndex: position.segmentIndex,
            routeLinearPosition: position.linearPosition,
            nextStopLinearPosition: nextStopRoutePos?.linearPosition,
            msToNextStop: arrivalTime - now,
        };
    }

    // Check if the first stop departure is in the past - vehicle is likely completed or stale
    const firstStop = stops[0];
    const firstDeparture = getStopTime(firstStop, "departure");
    if (firstDeparture && now > firstDeparture) {
        // First departure is in the past but we couldn't find a valid segment
        // This means all stops are likely in the past - mark as completed
        const routePos = findLinearPositionOnRoute(lastStop.lon, lastStop.lat, routeGeometry);
        return {
            tripId: vehicle.trip_id,
            lineNumber: vehicle.line_number,
            destination: vehicle.destination,
            lon: lastStop.lon,
            lat: lastStop.lat,
            bearing: 0,
            status: "completed",
            currentStop: lastStop,
            progress: 1,
            delayMinutes: lastStop.delay_minutes ?? null,
            routeSegmentIndex: routePos?.segmentIndex,
            routeLinearPosition: routePos?.linearPosition,
        };
    }

    // Vehicle hasn't started yet - show at first stop as waiting
    const routePos = findLinearPositionOnRoute(firstStop.lon, firstStop.lat, routeGeometry);
    return {
        tripId: vehicle.trip_id,
        lineNumber: vehicle.line_number,
        destination: vehicle.destination,
        lon: firstStop.lon,
        lat: firstStop.lat,
        bearing: calculateBearing(firstStop, stops[1]),
        status: "waiting",
        currentStop: firstStop,
        nextStop: stops[1],
        progress: 0,
        delayMinutes: firstStop.delay_minutes ?? null,
        routeSegmentIndex: routePos?.segmentIndex,
        routeLinearPosition: routePos?.linearPosition,
    };
}

/**
 * Get the effective time for a stop (estimated if available, otherwise planned)
 */
function getStopTime(stop: VehicleStop, type: "arrival" | "departure"): number | null {
    const estimated = type === "arrival" ? stop.arrival_time_estimated : stop.departure_time_estimated;
    const planned = type === "arrival" ? stop.arrival_time : stop.departure_time;

    const timeStr = estimated || planned;
    if (!timeStr) return null;

    return new Date(timeStr).getTime();
}

/**
 * Calculate bearing from one stop to another
 */
function calculateBearing(from: VehicleStop | undefined, to: VehicleStop | undefined): number {
    if (!from || !to) return 0;

    const lon1 = (from.lon * Math.PI) / 180;
    const lat1 = (from.lat * Math.PI) / 180;
    const lon2 = (to.lon * Math.PI) / 180;
    const lat2 = (to.lat * Math.PI) / 180;

    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

    let bearing = (Math.atan2(y, x) * 180) / Math.PI;
    bearing = (bearing + 360) % 360;

    return bearing;
}

/**
 * Interpolate position along route geometry between two stops
 * Returns position, bearing, and route tracking info (segment index and linear position)
 */
function interpolatePositionAlongRoute(
    fromStop: VehicleStop,
    toStop: VehicleStop,
    progress: number,
    routeGeometry: number[][][]
): { lon: number; lat: number; bearing: number; segmentIndex?: number; linearPosition?: number } {
    // Find the route segment(s) between the two stops
    const fromCoord = [fromStop.lon, fromStop.lat];
    const toCoord = [toStop.lon, toStop.lat];

    // Flatten all segments into a single path and calculate cumulative distances
    const allCoords: number[][] = [];
    const cumulativeDistances: number[] = [];
    let totalRouteLength = 0;

    for (const segment of routeGeometry) {
        for (const coord of segment) {
            if (allCoords.length > 0) {
                const lastCoord = allCoords[allCoords.length - 1];
                // Skip duplicates
                if (lastCoord[0] === coord[0] && lastCoord[1] === coord[1]) continue;
                totalRouteLength += haversineDistance(lastCoord, coord);
            }
            allCoords.push(coord);
            cumulativeDistances.push(totalRouteLength);
        }
    }

    if (allCoords.length < 2) {
        // Fallback to linear interpolation
        return linearInterpolate(fromCoord, toCoord, progress);
    }

    // Find closest points on the route to from and to stops
    const fromIdx = findClosestPointIndex(allCoords, fromCoord);
    const toIdx = findClosestPointIndex(allCoords, toCoord);

    if (fromIdx === toIdx || fromIdx === -1 || toIdx === -1) {
        return linearInterpolate(fromCoord, toCoord, progress);
    }

    // Determine direction: are we going forward or backward along the geometry?
    const goingForward = fromIdx < toIdx;
    const startIdx = Math.min(fromIdx, toIdx);
    const endIdx = Math.max(fromIdx, toIdx);

    // Calculate the linear position at fromIdx and toIdx
    const fromLinearPos = cumulativeDistances[fromIdx];
    const toLinearPos = cumulativeDistances[toIdx];

    // Extract the path between the two indices
    let pathSegment = allCoords.slice(startIdx, endIdx + 1);

    // If traveling opposite to geometry direction, reverse the path
    if (!goingForward) {
        pathSegment = pathSegment.slice().reverse();
    }

    if (pathSegment.length < 2) {
        return linearInterpolate(fromCoord, toCoord, progress);
    }

    // Calculate total length of path segment
    let totalLength = 0;
    const lengths: number[] = [0];
    for (let i = 1; i < pathSegment.length; i++) {
        const dist = haversineDistance(pathSegment[i - 1], pathSegment[i]);
        totalLength += dist;
        lengths.push(totalLength);
    }

    // Find position at progress along the path
    const targetLength = totalLength * progress;

    for (let i = 1; i < pathSegment.length; i++) {
        if (lengths[i] >= targetLength) {
            const segmentStart = lengths[i - 1];
            const segmentEnd = lengths[i];
            const segmentProgress = segmentEnd > segmentStart
                ? (targetLength - segmentStart) / (segmentEnd - segmentStart)
                : 0;

            const lon = pathSegment[i - 1][0] + (pathSegment[i][0] - pathSegment[i - 1][0]) * segmentProgress;
            const lat = pathSegment[i - 1][1] + (pathSegment[i][1] - pathSegment[i - 1][1]) * segmentProgress;
            const bearing = calculateBearingCoords(pathSegment[i - 1], pathSegment[i]);

            // Calculate the actual segment index in the original flattened array
            // i-1 is the index within pathSegment, need to map back to allCoords
            const segmentIndexInPath = i - 1;
            const actualSegmentIndex = goingForward
                ? startIdx + segmentIndexInPath
                : endIdx - segmentIndexInPath;

            // Calculate linear position along the full route
            const linearPosition = goingForward
                ? fromLinearPos + targetLength
                : fromLinearPos - targetLength;

            return { lon, lat, bearing, segmentIndex: actualSegmentIndex, linearPosition };
        }
    }

    // Fallback to end of path
    const lastCoord = pathSegment[pathSegment.length - 1];
    const prevCoord = pathSegment[pathSegment.length - 2];
    const finalSegmentIndex = goingForward ? endIdx - 1 : startIdx;
    const finalLinearPosition = goingForward ? toLinearPos : fromLinearPos - totalLength;

    return {
        lon: lastCoord[0],
        lat: lastCoord[1],
        bearing: calculateBearingCoords(prevCoord, lastCoord),
        segmentIndex: finalSegmentIndex,
        linearPosition: finalLinearPosition,
    };
}

function linearInterpolate(
    from: number[],
    to: number[],
    progress: number
): { lon: number; lat: number; bearing: number } {
    const lon = from[0] + (to[0] - from[0]) * progress;
    const lat = from[1] + (to[1] - from[1]) * progress;
    const bearing = calculateBearingCoords(from, to);
    return { lon, lat, bearing };
}

function findClosestPointIndex(coords: number[][], target: number[]): number {
    let minDist = Infinity;
    let minIdx = -1;

    for (let i = 0; i < coords.length; i++) {
        const dist = Math.pow(coords[i][0] - target[0], 2) + Math.pow(coords[i][1] - target[1], 2);
        if (dist < minDist) {
            minDist = dist;
            minIdx = i;
        }
    }

    return minIdx;
}

function haversineDistance(coord1: number[], coord2: number[]): number {
    const R = 6371000; // Earth's radius in meters
    const lat1 = (coord1[1] * Math.PI) / 180;
    const lat2 = (coord2[1] * Math.PI) / 180;
    const dLat = ((coord2[1] - coord1[1]) * Math.PI) / 180;
    const dLon = ((coord2[0] - coord1[0]) * Math.PI) / 180;

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

function calculateBearingCoords(from: number[], to: number[]): number {
    const lon1 = (from[0] * Math.PI) / 180;
    const lat1 = (from[1] * Math.PI) / 180;
    const lon2 = (to[0] * Math.PI) / 180;
    const lat2 = (to[1] * Math.PI) / 180;

    const dLon = lon2 - lon1;
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);

    let bearing = (Math.atan2(y, x) * 180) / Math.PI;
    bearing = (bearing + 360) % 360;

    return bearing;
}

/**
 * Linearized route with cumulative distances for efficient position lookups
 */
export interface LinearizedRoute {
    coords: number[][];      // All coordinates in order
    distances: number[];     // Cumulative distance at each coordinate
    totalLength: number;     // Total route length in meters
}

/**
 * Linearize route geometry into a single path with cumulative distances
 */
export function linearizeRoute(routeGeometry: number[][][]): LinearizedRoute | null {
    if (!routeGeometry || routeGeometry.length === 0) return null;

    const coords: number[][] = [];
    const distances: number[] = [];
    let totalLength = 0;

    for (const segment of routeGeometry) {
        for (const coord of segment) {
            if (coords.length > 0) {
                const lastCoord = coords[coords.length - 1];
                // Skip duplicate coordinates
                if (lastCoord[0] === coord[0] && lastCoord[1] === coord[1]) continue;
                totalLength += haversineDistance(lastCoord, coord);
            }
            coords.push(coord);
            distances.push(totalLength);
        }
    }

    if (coords.length < 2) return null;
    return { coords, distances, totalLength };
}

/**
 * Find where a point is located on a linearized route
 * Returns the linear position (distance from start) and segment info
 */
export function findPositionOnRoute(
    route: LinearizedRoute,
    lon: number,
    lat: number
): { linearPosition: number; segmentIndex: number; t: number; distance: number } {
    let bestDist = Infinity;
    let bestLinearPos = 0;
    let bestSegIdx = 0;
    let bestT = 0;

    for (let i = 0; i < route.coords.length - 1; i++) {
        const p1 = route.coords[i];
        const p2 = route.coords[i + 1];

        // Project point onto segment
        const projection = projectPointOnSegment(lon, lat, p1[0], p1[1], p2[0], p2[1]);

        if (projection.distance < bestDist) {
            bestDist = projection.distance;
            bestSegIdx = i;
            bestT = projection.t;
            // Linear position = distance to segment start + t * segment length
            const segLength = route.distances[i + 1] - route.distances[i];
            bestLinearPos = route.distances[i] + projection.t * segLength;
        }
    }

    return { linearPosition: bestLinearPos, segmentIndex: bestSegIdx, t: bestT, distance: bestDist };
}

/**
 * Get the position at a specific linear distance along the route
 */
export function getPositionAtDistance(
    route: LinearizedRoute,
    linearPosition: number
): { lon: number; lat: number; bearing: number; segmentIndex: number } {
    // Clamp to route bounds
    if (linearPosition <= 0) {
        return {
            lon: route.coords[0][0],
            lat: route.coords[0][1],
            bearing: calculateBearingCoords(route.coords[0], route.coords[1]),
            segmentIndex: 0,
        };
    }
    if (linearPosition >= route.totalLength) {
        const n = route.coords.length;
        return {
            lon: route.coords[n - 1][0],
            lat: route.coords[n - 1][1],
            bearing: calculateBearingCoords(route.coords[n - 2], route.coords[n - 1]),
            segmentIndex: n - 2,
        };
    }

    // Find the segment containing this position
    for (let i = 0; i < route.coords.length - 1; i++) {
        if (linearPosition <= route.distances[i + 1]) {
            const segStart = route.distances[i];
            const segLength = route.distances[i + 1] - segStart;
            const t = segLength > 0 ? (linearPosition - segStart) / segLength : 0;

            const p1 = route.coords[i];
            const p2 = route.coords[i + 1];

            return {
                lon: p1[0] + (p2[0] - p1[0]) * t,
                lat: p1[1] + (p2[1] - p1[1]) * t,
                bearing: calculateBearingCoords(p1, p2),
                segmentIndex: i,
            };
        }
    }

    // Fallback (shouldn't reach here)
    const n = route.coords.length;
    return {
        lon: route.coords[n - 1][0],
        lat: route.coords[n - 1][1],
        bearing: 0,
        segmentIndex: n - 2,
    };
}

/**
 * Get positions along the route at specific distances behind a reference position
 */
export function getPositionsBehindOnRoute(
    route: LinearizedRoute,
    vehicleLinearPos: number,
    distancesBehind: number[]
): Array<{ lon: number; lat: number; bearing: number }> {
    return distancesBehind.map(dist => {
        const pos = getPositionAtDistance(route, vehicleLinearPos - dist);
        return { lon: pos.lon, lat: pos.lat, bearing: pos.bearing };
    });
}

/**
 * Get debug segment features for visualization
 * Returns GeoJSON features for segments ahead (green) and behind (red)
 */
export function getDebugSegmentFeatures(
    route: LinearizedRoute,
    segmentIndex: number,
    segmentsAhead: number,
    segmentsBehind: number
): GeoJSON.Feature[] {
    const features: GeoJSON.Feature[] = [];

    // Segments ahead (green)
    for (let i = segmentIndex; i < Math.min(segmentIndex + segmentsAhead, route.coords.length - 1); i++) {
        features.push({
            type: "Feature",
            properties: { color: "#00ff00", type: "ahead", index: i },
            geometry: {
                type: "LineString",
                coordinates: [route.coords[i], route.coords[i + 1]],
            },
        });
    }

    // Segments behind (red)
    for (let i = segmentIndex - 1; i >= Math.max(0, segmentIndex - segmentsBehind); i--) {
        features.push({
            type: "Feature",
            properties: { color: "#ff0000", type: "behind", index: i },
            geometry: {
                type: "LineString",
                coordinates: [route.coords[i], route.coords[i + 1]],
            },
        });
    }

    return features;
}

/**
 * Project a point onto a line segment
 */
function projectPointOnSegment(
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
): { t: number; distance: number; projLon: number; projLat: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
        return { t: 0, distance: haversineDistance([px, py], [x1, y1]), projLon: x1, projLat: y1 };
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const projLon = x1 + t * dx;
    const projLat = y1 + t * dy;
    const distance = haversineDistance([px, py], [projLon, projLat]);

    return { t, distance, projLon, projLat };
}

/**
 * Apply easing for smooth acceleration/deceleration near stops
 * Uses a cubic ease-in-out curve for realistic train/tram movement
 *
 * The curve has three phases:
 * 1. Acceleration (0-5% of journey): Gradual speed increase from standstill
 * 2. Cruising (5-95% of journey): Constant speed
 * 3. Deceleration (95-100% of journey): Gradual speed decrease to stop
 */
export function easeInOutProgress(progress: number): number {
    const accelEnd = 0.05;    // End of acceleration phase
    const decelStart = 0.95;  // Start of deceleration phase

    if (progress <= 0) return 0;
    if (progress >= 1) return 1;

    if (progress < accelEnd) {
        // Acceleration phase: cubic ease-in
        const t = progress / accelEnd;
        return accelEnd * (t * t * (3 - 2 * t));
    } else if (progress > decelStart) {
        // Deceleration phase: cubic ease-out
        const t = (progress - decelStart) / (1 - decelStart);
        const eased = t * t * (3 - 2 * t);
        return decelStart + (1 - decelStart) * eased;
    } else {
        // Cruising phase: linear
        return progress;
    }
}

/**
 * Smoothed vehicle position that tracks rendered vs target positions
 */
export interface SmoothedVehiclePosition extends VehiclePosition {
    renderedLon: number;
    renderedLat: number;
    renderedBearing: number;
    lastUpdateTime: number;
    renderedLinearPosition?: number;
    /** Track which segment we're on to detect backward teleporting from GTFS-RT updates */
    prevStopIfopt?: string;
    nextStopIfopt?: string;
    /** Smoothed required speed (m/s) — prevents spikes after GTFS-RT updates */
    smoothedSpeed?: number;
}

// Thresholds for position smoothing
const SNAP_DISTANCE_METERS = 1000; // Distance above which we snap instead of smooth (route change/restart)
// Bearing smoothing: exponential decay half-life in ms
const BEARING_HALF_LIFE_MS = 200;
/** Speed smoothing half-life in ms. Prevents abrupt speed spikes when GTFS-RT
 * updates change estimated arrival times. At 500ms half-life, a 2x speed jump
 * takes ~1.5 seconds to fully catch up — visually imperceptible. */
const SPEED_HALF_LIFE_MS = 500;
/** Maximum rendered vehicle speed in m/s (70 km/h).
 * Clamps the per-frame linear position delta so that even large target jumps
 * (from GTFS-RT time corrections) don't cause the vehicle to visually "speed"
 * at hundreds of km/h. Augsburg trams max out at ~70 km/h in service. */
const MAX_RENDERED_SPEED_MS = 70 / 3.6;

/**
 * Calculate haversine distance between two coordinates in meters
 */
function haversineDistanceCoords(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number
): number {
    const R = 6371000; // Earth's radius in meters
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dPhi = ((lat2 - lat1) * Math.PI) / 180;
    const dLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a =
        Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Create initial smoothed position from a target position
 */
export function createSmoothedPosition(target: VehiclePosition): SmoothedVehiclePosition {
    return {
        ...target,
        renderedLon: target.lon,
        renderedLat: target.lat,
        renderedBearing: target.bearing,
        lastUpdateTime: Date.now(),
        renderedLinearPosition: target.routeLinearPosition,
        prevStopIfopt: target.currentStop?.stop_ifopt,
        nextStopIfopt: target.nextStop?.stop_ifopt,
    };
}

/**
 * Update smoothed position to move toward target position.
 *
 * Uses route-based smoothing when a linearized route is available:
 * - Smooths the `routeLinearPosition` with forward-only clamping
 * - Derives lat/lon from the smoothed linear position on the route
 * - Prevents backward teleporting caused by GTFS-RT time estimate changes
 *
 * Falls back to direct lat/lon smoothing when no route is available.
 */
export function updateSmoothedPosition(
    current: SmoothedVehiclePosition,
    target: VehiclePosition,
    deltaMs: number,
    linearizedRoute?: LinearizedRoute | null,
    timeSpeed = 1.0,
): SmoothedVehiclePosition {
    const distance = haversineDistanceCoords(
        current.renderedLon,
        current.renderedLat,
        target.lon,
        target.lat
    );

    // Detect if the vehicle changed segments (different prev/next stops)
    const sameSegment =
        current.prevStopIfopt === target.currentStop?.stop_ifopt &&
        current.nextStopIfopt === target.nextStop?.stop_ifopt;

    // If distance is too large, snap to target (vehicle likely jumped routes or restarted)
    if (distance > SNAP_DISTANCE_METERS) {
        return {
            ...target,
            renderedLon: target.lon,
            renderedLat: target.lat,
            renderedBearing: target.bearing,
            lastUpdateTime: Date.now(),
            renderedLinearPosition: target.routeLinearPosition,
            prevStopIfopt: target.currentStop?.stop_ifopt,
            nextStopIfopt: target.nextStop?.stop_ifopt,
        };
    }

    // Smoothly interpolate bearing (frame-rate independent)
    let bearingDiff = target.bearing - current.renderedBearing;
    if (bearingDiff > 180) bearingDiff -= 360;
    if (bearingDiff < -180) bearingDiff += 360;
    const bearingDecay = 1 - Math.pow(0.5, deltaMs / BEARING_HALF_LIFE_MS);
    const newBearing = (current.renderedBearing + bearingDiff * bearingDecay + 360) % 360;

    // Route-based smoothing: smooth the linear position and derive lat/lon from route
    if (linearizedRoute &&
        current.renderedLinearPosition !== undefined &&
        target.routeLinearPosition !== undefined) {

        // Forward-only clamping: when on the same segment (between the same stops),
        // never let the target linear position go backward.
        // This prevents backward teleporting when GTFS-RT updates change estimated times.
        const isInTransit = target.status === "in_transit" || target.status === "approaching";
        let effectiveTargetLinear = target.routeLinearPosition;
        if (isInTransit && sameSegment && effectiveTargetLinear < current.renderedLinearPosition) {
            effectiveTargetLinear = current.renderedLinearPosition;
        }

        // Arrival-time-based speed: advance at the speed needed to reach the next
        // stop by its scheduled arrival time.  When GTFS-RT updates change times,
        // only the *speed* changes — the rendered position never jumps.
        // Speed itself is exponentially smoothed to prevent visual spikes.
        let smoothedLinear: number;
        let newSmoothedSpeed = current.smoothedSpeed;
        const simDeltaMs = deltaMs * timeSpeed;
        if (isInTransit &&
            target.nextStopLinearPosition !== undefined &&
            target.msToNextStop !== undefined &&
            target.msToNextStop > 0) {
            const distToStop = target.nextStopLinearPosition - current.renderedLinearPosition;
            const timeToStopSec = target.msToNextStop / 1000;
            const requiredSpeed = Math.max(0, distToStop / timeToStopSec);
            const clampedSpeed = Math.min(requiredSpeed, MAX_RENDERED_SPEED_MS);
            // Smooth the speed change to prevent visual spikes after GTFS-RT updates
            const prevSpeed = current.smoothedSpeed ?? clampedSpeed;
            const speedDecay = 1 - Math.pow(0.5, deltaMs / SPEED_HALF_LIFE_MS);
            const effectiveSpeed = prevSpeed + (clampedSpeed - prevSpeed) * speedDecay;
            newSmoothedSpeed = effectiveSpeed;
            smoothedLinear = current.renderedLinearPosition + effectiveSpeed * (simDeltaMs / 1000);
        } else {
            // At stop, waiting, or missing schedule info: advance toward target
            // at max speed instead of snapping, to prevent forward teleportation
            // when collision avoidance held the vehicle back.
            const maxAdvance = MAX_RENDERED_SPEED_MS * (simDeltaMs / 1000);
            if (effectiveTargetLinear > current.renderedLinearPosition + maxAdvance) {
                smoothedLinear = current.renderedLinearPosition + maxAdvance;
            } else {
                smoothedLinear = effectiveTargetLinear;
            }
        }

        // Derive lat/lon from the route at the smoothed linear position
        const routePos = getPositionAtDistance(linearizedRoute, smoothedLinear);

        // When the target jumps to a new stop segment (time-based) but the rendered
        // position hasn't visually reached the boundary stop yet, keep showing the
        // OLD stop names so the UI matches what the user sees on the map.
        // Without this, smoothing/speed-clamping lag causes "next stop: Rosenaustraße"
        // while the vehicle is still visually approaching Hauptbahnhof.
        if (!sameSegment && target.currentStop) {
            const boundary = findPositionOnRoute(
                linearizedRoute, target.currentStop.lon, target.currentStop.lat
            );
            if (smoothedLinear < boundary.linearPosition - 5) {
                return {
                    ...target,
                    currentStop: current.currentStop,
                    nextStop: current.nextStop,
                    status: current.status,
                    delayMinutes: current.delayMinutes,
                    renderedLon: routePos.lon,
                    renderedLat: routePos.lat,
                    renderedBearing: newBearing,
                    lastUpdateTime: Date.now(),
                    renderedLinearPosition: smoothedLinear,
                    smoothedSpeed: newSmoothedSpeed,
                    prevStopIfopt: current.prevStopIfopt,
                    nextStopIfopt: current.nextStopIfopt,
                };
            }
        }

        return {
            ...target,
            renderedLon: routePos.lon,
            renderedLat: routePos.lat,
            renderedBearing: newBearing,
            lastUpdateTime: Date.now(),
            renderedLinearPosition: smoothedLinear,
            smoothedSpeed: newSmoothedSpeed,
            prevStopIfopt: target.currentStop?.stop_ifopt,
            nextStopIfopt: target.nextStop?.stop_ifopt,
        };
    }

    // Fallback: direct lat/lon assignment (no route geometry available)
    return {
        ...target,
        renderedLon: target.lon,
        renderedLat: target.lat,
        renderedBearing: newBearing,
        lastUpdateTime: Date.now(),
        renderedLinearPosition: target.routeLinearPosition,
        prevStopIfopt: target.currentStop?.stop_ifopt,
        nextStopIfopt: target.nextStop?.stop_ifopt,
    };
}
