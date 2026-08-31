import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { addDoc, collection, deleteDoc, deleteField, doc, getDocs, getFirestore, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyYourActualAPIKeyHere...",
    authDomain: "your-project-id.firebaseapp.com",
    projectId: "your-project-id",
    storageBucket: "your-project-id.appspot.com",
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:abcdef123456"
};

const DOCK = { latitude: 47.62795, longitude: -122.33645 };
const DOCK_GEOFENCE_METERS = 55;
const OPERATING_ZONE_METERS = 1600;
const STALE_AFTER_MINUTES = 30;
const DEFAULT_RENTAL_MINUTES = 60;
const DEMO_RENTAL_HISTORY_KEY = "cwbDemoRentalHistory";
const TABLE_PREFERENCES_KEY = "cwbFleetTablePreferences";
const COLUMN_DEFINITIONS = [
    { id: "action", label: "Dock action", required: true },
    { id: "vessel", label: "Vessel" },
    { id: "availability", label: "Availability" },
    { id: "booked", label: "Booked" },
    { id: "bookedBy", label: "Booked by" },
    { id: "passengers", label: "No. passengers" },
    { id: "timeOut", label: "Time out" },
    { id: "due", label: "Due / ETA" },
    { id: "actualReturn", label: "Actual return" },
    { id: "coordinates", label: "Coordinates" },
    { id: "mooring", label: "Mooring" },
    { id: "battery", label: "Battery" },
    { id: "lastUpdate", label: "Last update" }
];
const DEFAULT_COLUMN_ORDER = COLUMN_DEFINITIONS.map(column => column.id);

function loadTablePreferences() {
    try {
        const saved = JSON.parse(localStorage.getItem(TABLE_PREFERENCES_KEY) || "null");
        const savedOrder = Array.isArray(saved?.order) ? saved.order.filter(id => DEFAULT_COLUMN_ORDER.includes(id)) : [];
        const order = [...savedOrder, ...DEFAULT_COLUMN_ORDER.filter(id => !savedOrder.includes(id))];
        const hidden = new Set(Array.isArray(saved?.hidden) ? saved.hidden.filter(id => id !== "action" && DEFAULT_COLUMN_ORDER.includes(id)) : []);
        const sortColumn = DEFAULT_COLUMN_ORDER.includes(saved?.sort?.column) ? saved.sort.column : "vessel";
        const sortDirection = saved?.sort?.direction === "desc" ? "desc" : "asc";
        return { order, hidden, sort: { column: sortColumn, direction: sortDirection } };
    } catch { return { order: [...DEFAULT_COLUMN_ORDER], hidden: new Set(), sort: { column: "vessel", direction: "asc" } }; }
}

const tablePreferences = loadTablePreferences();
const state = { boats: new Map(), histories: new Map(), markers: new Map(), selectedId: null, routeLayer: null, historyUnsubscribes: new Map(), search: "", status: "all", columnOrder: tablePreferences.order, hiddenColumns: tablePreferences.hidden, sort: tablePreferences.sort, demoMode: false, db: null, auth: null, user: null, isStaff: false, pendingAction: null };
const elements = {
    operationsPane: document.getElementById("operationsPane"), splitter: document.getElementById("splitter"), tableHead: document.getElementById("fleetTableHead"), tableBody: document.getElementById("fleetTableBody"), columnMenuButton: document.getElementById("columnMenuButton"), columnMenu: document.getElementById("columnMenu"), columnMenuList: document.getElementById("columnMenuList"), alertsList: document.getElementById("alertsList"), alertCount: document.getElementById("alertCount"), connection: document.getElementById("connectionStatus"), dataMode: document.getElementById("dataMode"), lastRefresh: document.getElementById("lastRefresh"), mapDetail: document.getElementById("mapDetail"), search: document.getElementById("searchInput"), statusFilter: document.getElementById("statusFilter"),
    signIn: document.getElementById("signInButton"), rentalModal: document.getElementById("rentalModal"), rentalBackdrop: document.getElementById("rentalBackdrop"), rentalBody: document.getElementById("rentalBody"), rentalMessage: document.getElementById("rentalMessage"), rentalConfirm: document.getElementById("rentalConfirm"), rentalForm: document.getElementById("rentalForm"),
    metrics: { total: document.getElementById("metricTotal"), available: document.getElementById("metricAvailable"), underway: document.getElementById("metricUnderway"), alerts: document.getElementById("metricAlerts") }
};

const standardTiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" });
const darkTiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20, attribution: "&copy; OpenStreetMap contributors &copy; CARTO" });
const map = L.map("map", { zoomControl: true, layers: [darkTiles] }).setView([47.6322, -122.3367], 14);
L.control.layers({ "Dark OSM": darkTiles, "Standard OSM": standardTiles }, null, { position: "topright" }).addTo(map);

function toDate(value) { if (!value) return null; if (value instanceof Date) return value; if (typeof value.toDate === "function") return value.toDate(); if (typeof value.seconds === "number") return new Date(value.seconds * 1000); const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed; }
function formatTime(value, includeDate = false) { const date = toDate(value); if (!date) return "—"; return new Intl.DateTimeFormat("en-US", { year: includeDate ? "numeric" : undefined, month: includeDate ? "2-digit" : undefined, day: includeDate ? "2-digit" : undefined, hour: "numeric", minute: "2-digit" }).format(date); }
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function haversineMeters(a, b) { const radius = 6371000; const radians = degrees => degrees * Math.PI / 180; const latDelta = radians(b.latitude - a.latitude); const lonDelta = radians(b.longitude - a.longitude); const lat1 = radians(a.latitude); const lat2 = radians(b.latitude); const value = Math.sin(latDelta / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2; return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)); }
function batteryPercent(millivolts) { return Math.round(Math.max(0, Math.min(100, ((millivolts - 4200) / 1400) * 100))); }

function normalizedBoat(id, raw) {
    const ping = raw.last_ping || {};
    const availability = String(raw.availability_status || raw.availabilityStatus || "").toLowerCase();
    const mooring = ping.mooring_status || "Unknown";
    const mooringValid = ping.mooring_classification_valid ?? ping.inside_dock_geofence ?? ["Tied Up at Dock", "Underway at Dock"].includes(mooring);
    return { id, name: raw.vessel_name || raw.vesselName || raw.name || id, availability: availability === "under_repair" ? "maintenance" : availability, trackingEnabled: raw.tracking_enabled ?? (availability === "rented"), booked: Boolean(raw.booked), bookedBy: raw.booked_by || raw.bookedBy || "", passengerCount: Number(raw.passenger_count ?? raw.passengerCount ?? 0), rentalType: String(raw.rental_type || raw.rentalType || "fixed").toLowerCase(), rentalMinutes: Number(raw.rental_minutes || raw.rentalMinutes || DEFAULT_RENTAL_MINUTES), timeOut: toDate(raw.time_out || raw.timeOut), explicitDue: toDate(raw.time_due_back || raw.timeDueBack), actualReturn: toDate(raw.actual_time_back || raw.actualTimeBack), latitude: Number(ping.latitude), longitude: Number(ping.longitude), batteryMv: Number(ping.battery_mv || 0), lowBattery: Boolean(ping.low_battery), gpsFix: ping.gps_fix !== false, mooring, mooringValid: Boolean(mooringValid), variance: mooringValid && ping.variance_g2 != null ? Number(ping.variance_g2) : null, maxTemperature: ping.max_temperature_c, timestamp: toDate(ping.timestamp), protocolVersion: ping.protocol_version, raw };
}

function fixedDue(boat) { if (boat.explicitDue) return boat.explicitDue; if (boat.rentalType === "fixed" && boat.timeOut) return new Date(boat.timeOut.getTime() + boat.rentalMinutes * 60000); return null; }
function isRentalOverdue(boat) { const due = fixedDue(boat); return Boolean(due && !boat.actualReturn && due < new Date()); }
function recentHistoryPoints(boatId) { return (state.histories.get(boatId) || []).filter(point => point.timestamp && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)).slice(-3); }
function movementBearing(boat) {
    if (!isRentalOverdue(boat)) return null;
    const points = recentHistoryPoints(boat.id);
    if (points.length < 3) return null;
    const radians = degrees => degrees * Math.PI / 180;
    let north = 0;
    let east = 0;
    let distanceTravelled = 0;
    for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        const latitude1 = radians(start.latitude);
        const latitude2 = radians(end.latitude);
        const longitudeDelta = radians(end.longitude - start.longitude);
        const bearing = Math.atan2(Math.sin(longitudeDelta) * Math.cos(latitude2), Math.cos(latitude1) * Math.sin(latitude2) - Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(longitudeDelta));
        const distance = haversineMeters(start, end);
        const weight = distance * index;
        north += Math.cos(bearing) * weight;
        east += Math.sin(bearing) * weight;
        distanceTravelled += distance;
    }
    if (distanceTravelled < 3 || (north === 0 && east === 0)) return null;
    return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}
function vectorEstimate(boat) {
    const points = recentHistoryPoints(boat.id);
    if (points.length < 2) return null;
    let distanceTravelled = 0;
    for (let index = 1; index < points.length; index += 1) distanceTravelled += haversineMeters(points[index - 1], points[index]);
    const elapsedSeconds = (points.at(-1).timestamp - points[0].timestamp) / 1000;
    if (elapsedSeconds <= 0) return null;
    const speedMetersPerSecond = distanceTravelled / elapsedSeconds;
    const earlierDockDistance = haversineMeters(points[0], DOCK);
    const currentDockDistance = haversineMeters(points.at(-1), DOCK);
    if (speedMetersPerSecond < .15 || currentDockDistance >= earlierDockDistance) return null;
    const minutes = Math.min(240, currentDockDistance / speedMetersPerSecond / 60);
    return { due: new Date(Date.now() + minutes * 60000), minutes, speedMetersPerSecond };
}

function isOutsideZone(boat) { return Number.isFinite(boat.latitude) && Number.isFinite(boat.longitude) && haversineMeters(boat, DOCK) > OPERATING_ZONE_METERS; }
function operationalState(boat) { if (boat.availability === "maintenance") return "maintenance"; if (isRentalOverdue(boat) || boat.lowBattery || isOutsideZone(boat)) return "overdue"; if (boat.availability === "available" || (boat.mooring === "Tied Up at Dock" && !boat.timeOut)) return "available"; return "rented"; }
function dueDisplay(boat) { if (boat.actualReturn || ["available", "maintenance"].includes(boat.availability)) return { primary: "—", secondary: "No active rental", warning: false }; const due = fixedDue(boat); if (due) { const deltaMinutes = Math.round((Date.now() - due.getTime()) / 60000); return { primary: formatTime(due, true), secondary: deltaMinutes > 0 && !boat.actualReturn ? `+${deltaMinutes} min late` : `${boat.rentalMinutes} min rental`, warning: deltaMinutes > 0 && !boat.actualReturn }; } const estimate = vectorEstimate(boat); if (estimate) return { primary: formatTime(estimate.due, true), secondary: `Vector ETA · ${estimate.minutes.toFixed(0)} min`, warning: false }; return { primary: "Calculating…", secondary: "Needs return vector", warning: false }; }
function alertsFor(boat) { const alerts = []; const due = fixedDue(boat); if (due && !boat.actualReturn && due < new Date()) alerts.push({ critical: true, message: `${boat.name} is ${Math.max(1, Math.round((Date.now() - due) / 60000))} minutes overdue.` }); if (boat.lowBattery || (boat.batteryMv && boat.batteryMv <= 4200)) alerts.push({ critical: true, message: `${boat.name} battery is low at ${(boat.batteryMv / 1000).toFixed(2)} V.` }); if (isOutsideZone(boat)) alerts.push({ critical: true, message: `${boat.name} is outside the Lake Union operating zone.` }); if (!boat.gpsFix) alerts.push({ critical: false, message: `${boat.name} does not have a valid GPS fix.` }); if (boat.timestamp && Date.now() - boat.timestamp.getTime() > STALE_AFTER_MINUTES * 60000) alerts.push({ critical: false, message: `${boat.name} telemetry is stale (${formatTime(boat.timestamp)}).` }); return alerts; }

function formatVariance(boat) { return boat.mooringValid && boat.variance != null ? `σ² ${boat.variance.toFixed(5)}` : "Not evaluated"; }
function markerIcon(boat) { const status = operationalState(boat); const critical = alertsFor(boat).some(alert => alert.critical); const markerStatus = critical ? "warning" : status; const bearing = movementBearing(boat); const directionArrow = bearing == null ? "" : `<span class="boat-direction" style="--boat-bearing:${bearing.toFixed(1)}deg" title="Direction of travel"><i data-lucide="navigation-2"></i></span>`; return L.divIcon({ className: "", html: `<div class="boat-marker ${markerStatus}">${directionArrow}<i data-lucide="ship-wheel"></i><span class="boat-label">${escapeHtml(boat.name)}</span></div>`, iconSize: [38, 38], iconAnchor: [19, 19] }); }
function updateMarkers() {
    const currentIds = new Set(state.boats.keys());
    state.markers.forEach((marker, id) => { if (!currentIds.has(id)) { marker.remove(); state.markers.delete(id); } });
    state.boats.forEach(boat => {
        if (!boat.gpsFix || !Number.isFinite(boat.latitude) || !Number.isFinite(boat.longitude)) return;
        const location = [boat.latitude, boat.longitude]; let marker = state.markers.get(boat.id);
        if (!marker) { marker = L.marker(location, { icon: markerIcon(boat), riseOnHover: true }).addTo(map); marker.on("click", () => selectBoat(boat.id, false)); state.markers.set(boat.id, marker); } else marker.setLatLng(location).setIcon(markerIcon(boat));
        marker.bindPopup(`<strong>${escapeHtml(boat.name)}</strong><br>${escapeHtml(boat.mooring)}<br>${(boat.batteryMv / 1000).toFixed(2)} V · ${formatVariance(boat)}`);
    });
    lucide.createIcons();
}

function badge(status, label) { return `<span class="badge ${status}"><i class="badge-dot"></i>${escapeHtml(label)}</span>`; }
function dockActionContent(boat, status) {
    if (status === "maintenance") return `<button class="dock-action" type="button" disabled>Unavailable</button>`;
    const isOut = status === "rented" || status === "overdue";
    return `<button class="dock-action ${isOut ? "check-in" : "check-out"}" type="button" data-action="${isOut ? "check-in" : "check-out"}" data-boat-id="${escapeHtml(boat.id)}"><i data-lucide="${isOut ? "log-in" : "log-out"}" class="h-3 w-3"></i>${isOut ? "Check in" : "Check out"}</button>`;
}
function visibleColumns() { return state.columnOrder.filter(id => !state.hiddenColumns.has(id)).map(id => COLUMN_DEFINITIONS.find(column => column.id === id)); }
function saveTablePreferences() { localStorage.setItem(TABLE_PREFERENCES_KEY, JSON.stringify({ order: state.columnOrder, hidden: [...state.hiddenColumns], sort: state.sort })); }
function sortValue(boat, columnId) {
    const status = operationalState(boat);
    const due = fixedDue(boat) || vectorEstimate(boat)?.due;
    const values = {
        action: status,
        vessel: `${boat.name} ${boat.id}`.toLowerCase(),
        availability: status,
        booked: boat.booked ? 1 : 0,
        bookedBy: boat.bookedBy.toLowerCase(),
        passengers: boat.passengerCount,
        timeOut: boat.timeOut?.getTime() ?? 0,
        due: due?.getTime() ?? 0,
        actualReturn: boat.actualReturn?.getTime() ?? 0,
        coordinates: Number.isFinite(boat.latitude) ? boat.latitude : Number.NEGATIVE_INFINITY,
        mooring: boat.mooring.toLowerCase(),
        battery: boat.batteryMv,
        lastUpdate: boat.timestamp?.getTime() ?? 0
    };
    return values[columnId];
}
function compareBoats(left, right) {
    const leftValue = sortValue(left, state.sort.column);
    const rightValue = sortValue(right, state.sort.column);
    const result = typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: "base" });
    return (state.sort.direction === "asc" ? result : -result) || left.name.localeCompare(right.name);
}
function cellContent(columnId, boat, status, due, battery, availabilityLabel) {
    const cells = {
        action: () => dockActionContent(boat, status),
        vessel: () => `<span class="vessel-name">${escapeHtml(boat.name)}</span><span class="vessel-id">${escapeHtml(boat.id)}</span>`,
        availability: () => badge(status, availabilityLabel),
        booked: () => `<span class="data-value">${boat.booked ? "YES" : "NO"}</span>`,
        bookedBy: () => `<span class="data-value">${boat.bookedBy ? escapeHtml(boat.bookedBy) : "—"}</span>`,
        passengers: () => `<span class="data-value">${boat.passengerCount || "—"}</span>`,
        timeOut: () => `<span class="data-value">${formatTime(boat.timeOut, true)}</span><span class="cell-note">${boat.timeOut ? boat.rentalType : "No active checkout"}</span>`,
        due: () => `<span class="data-value ${due.warning ? "text-red-400" : ""}">${due.primary}</span><span class="cell-note ${due.warning ? "text-red-400" : ""}">${due.secondary}</span>`,
        actualReturn: () => `<span class="data-value">${formatTime(boat.actualReturn, true)}</span>`,
        coordinates: () => `<span class="data-value">${Number.isFinite(boat.latitude) ? boat.latitude.toFixed(5) : "—"}</span><span class="cell-note font-mono">${Number.isFinite(boat.longitude) ? boat.longitude.toFixed(5) : "—"}</span>`,
        mooring: () => `<span class="data-value">${escapeHtml(boat.mooring.replace("Underway / Moving", "Underway").replace(" at Dock", ""))}</span>`,
        battery: () => `<span class="data-value ${boat.lowBattery ? "text-red-400" : ""}">${(boat.batteryMv / 1000).toFixed(2)} V</span><div class="battery-track"><div class="battery-fill ${boat.lowBattery ? "low" : ""}" style="width:${battery}%"></div></div>`,
        lastUpdate: () => `<span class="data-value">${formatTime(boat.timestamp)}</span><span class="cell-note">Protocol v${boat.protocolVersion ?? "—"}</span>`
    };
    return cells[columnId]();
}
function renderTableHead(columns) {
    elements.tableHead.innerHTML = columns.map(column => {
        const active = state.sort.column === column.id;
        const direction = active ? state.sort.direction : "none";
        const icon = active ? (direction === "asc" ? "arrow-up" : "arrow-down") : "chevrons-up-down";
        return `<th aria-sort="${active ? (direction === "asc" ? "ascending" : "descending") : "none"}"><button class="column-sort" type="button" data-column-id="${column.id}"><span>${escapeHtml(column.label)}</span><i data-lucide="${icon}"></i></button></th>`;
    }).join("");
    elements.tableHead.querySelectorAll(".column-sort").forEach(button => button.addEventListener("click", () => {
        const column = button.dataset.columnId;
        state.sort = { column, direction: state.sort.column === column && state.sort.direction === "asc" ? "desc" : "asc" };
        saveTablePreferences();
        renderTable();
    }));
}
function renderColumnMenu() {
    elements.columnMenuList.innerHTML = state.columnOrder.map((id, index) => {
        const column = COLUMN_DEFINITIONS.find(item => item.id === id);
        const checked = !state.hiddenColumns.has(id);
        return `<div class="column-menu-row" data-column-id="${id}">
            <label class="column-toggle"><input type="checkbox" ${checked ? "checked" : ""} ${column.required ? "disabled" : ""}><span>${escapeHtml(column.label)}</span></label>
            <button class="column-move" type="button" data-direction="up" title="Move ${escapeHtml(column.label)} left" aria-label="Move ${escapeHtml(column.label)} left" ${index === 0 ? "disabled" : ""}><i data-lucide="arrow-up"></i></button>
            <button class="column-move" type="button" data-direction="down" title="Move ${escapeHtml(column.label)} right" aria-label="Move ${escapeHtml(column.label)} right" ${index === state.columnOrder.length - 1 ? "disabled" : ""}><i data-lucide="arrow-down"></i></button>
        </div>`;
    }).join("");
    elements.columnMenuList.querySelectorAll(".column-toggle input").forEach(input => input.addEventListener("change", event => {
        const id = event.target.closest(".column-menu-row").dataset.columnId;
        if (event.target.checked) state.hiddenColumns.delete(id); else state.hiddenColumns.add(id);
        saveTablePreferences();
        renderTable();
    }));
    elements.columnMenuList.querySelectorAll(".column-move").forEach(button => button.addEventListener("click", () => {
        const id = button.closest(".column-menu-row").dataset.columnId;
        const index = state.columnOrder.indexOf(id);
        const targetIndex = index + (button.dataset.direction === "up" ? -1 : 1);
        if (targetIndex < 0 || targetIndex >= state.columnOrder.length) return;
        [state.columnOrder[index], state.columnOrder[targetIndex]] = [state.columnOrder[targetIndex], state.columnOrder[index]];
        saveTablePreferences();
        renderColumnMenu();
        renderTable();
    }));
    lucide.createIcons();
}
function setColumnMenuOpen(open) {
    elements.columnMenu.classList.toggle("hidden", !open);
    elements.columnMenuButton.setAttribute("aria-expanded", String(open));
    if (open) renderColumnMenu();
}
function renderTable() {
    const columns = visibleColumns();
    renderTableHead(columns);
    const boats = [...state.boats.values()].filter(boat => `${boat.id} ${boat.name}`.toLowerCase().includes(state.search) && (state.status === "all" || operationalState(boat) === state.status)).sort(compareBoats);
    if (!boats.length) { elements.tableBody.innerHTML = `<tr><td colspan="${columns.length}" class="empty-cell">No vessels match the current filters.</td></tr>`; lucide.createIcons(); return; }
    elements.tableBody.innerHTML = boats.map(boat => {
        const status = operationalState(boat); const due = dueDisplay(boat); const battery = batteryPercent(boat.batteryMv); const hasAlerts = alertsFor(boat).length > 0; const availabilityLabel = status === "overdue" ? "Overdue" : status[0].toUpperCase() + status.slice(1);
        return `<tr data-boat-id="${escapeHtml(boat.id)}" class="${hasAlerts ? "alert-row" : ""} ${state.selectedId === boat.id ? "selected" : ""}">${columns.map(column => `<td>${cellContent(column.id, boat, status, due, battery, availabilityLabel)}</td>`).join("")}</tr>`;
    }).join("");
    elements.tableBody.querySelectorAll("tr[data-boat-id]").forEach(row => row.addEventListener("click", () => selectBoat(row.dataset.boatId, true)));
    elements.tableBody.querySelectorAll(".dock-action[data-action]").forEach(button => button.addEventListener("click", event => {
        event.stopPropagation();
        if (button.dataset.action === "check-in") checkInFromTable(button.dataset.boatId, button);
        else openRentalModal(button.dataset.boatId);
    }));
    lucide.createIcons();
}

function renderAlerts() { const alerts = [...state.boats.values()].flatMap(boat => alertsFor(boat).map(alert => ({ ...alert, boatId: boat.id }))); elements.alertCount.textContent = alerts.length; elements.metrics.alerts.textContent = alerts.length; elements.alertsList.innerHTML = alerts.length ? alerts.map(alert => `<button class="alert-item ${alert.critical ? "critical" : ""}" data-boat-id="${escapeHtml(alert.boatId)}" type="button"><span class="alert-severity"></span><span>${escapeHtml(alert.message)}</span></button>`).join("") : `<p class="no-alerts">No active fleet alerts.</p>`; elements.alertsList.querySelectorAll("button").forEach(button => button.addEventListener("click", () => selectBoat(button.dataset.boatId, true))); }
function renderMetrics() { const boats = [...state.boats.values()]; elements.metrics.total.textContent = boats.length; elements.metrics.available.textContent = boats.filter(boat => operationalState(boat) === "available").length; elements.metrics.underway.textContent = boats.filter(boat => boat.mooring !== "Tied Up at Dock").length; }
function renderMapDetail() { const boat = state.boats.get(state.selectedId); if (!boat) { elements.mapDetail.classList.add("hidden"); return; } const due = dueDisplay(boat); elements.mapDetail.innerHTML = `<div class="flex items-start justify-between gap-3"><div><p class="eyebrow">Selected vessel</p><h3 class="mt-1 font-semibold">${escapeHtml(boat.name)}</h3><p class="mt-1 font-mono text-[10px] text-zinc-500">${escapeHtml(boat.id)}</p></div>${badge(operationalState(boat), operationalState(boat).toUpperCase())}</div><div class="map-detail-grid"><div><span>Due / ETA</span><strong>${due.primary}</strong></div><div><span>Battery</span><strong>${(boat.batteryMv / 1000).toFixed(2)} V</strong></div><div><span>Last ping</span><strong>${formatTime(boat.timestamp)}</strong></div></div>`; elements.mapDetail.classList.remove("hidden"); }
function drawRoute(id) { if (state.routeLayer) { state.routeLayer.remove(); state.routeLayer = null; } const boat = state.boats.get(id); if (!boat || !isRentalOverdue(boat)) return; const points = recentHistoryPoints(id); if (points.length < 2) return; state.routeLayer = L.polyline(points.map(point => [point.latitude, point.longitude]), { color: "#ef4444", weight: 3, opacity: .75, dashArray: "4 7" }).addTo(map); }
function selectBoat(id, pan) { state.selectedId = id; const boat = state.boats.get(id); if (!boat) return; renderTable(); renderMapDetail(); drawRoute(id); if (pan && boat.gpsFix) map.flyTo([boat.latitude, boat.longitude], Math.max(map.getZoom(), 15), { duration: .7 }); }
function syncHistorySubscriptions() {
    if (!state.db) return;
    const overdueIds = new Set([...state.boats.values()].filter(boat => boat.trackingEnabled && isRentalOverdue(boat)).map(boat => boat.id));
    state.historyUnsubscribes.forEach((unsubscribe, id) => {
        if (overdueIds.has(id)) return;
        unsubscribe();
        state.historyUnsubscribes.delete(id);
        state.histories.delete(id);
    });
    overdueIds.forEach(id => {
        if (state.historyUnsubscribes.has(id)) return;
        const historyQuery = query(collection(state.db, "boats", id, "history"), orderBy("timestamp", "desc"), limit(3));
        const unsubscribe = onSnapshot(historyQuery, snapshot => {
            state.histories.set(id, snapshot.docs.map(document => { const data = document.data(); return { latitude: Number(data.latitude), longitude: Number(data.longitude), timestamp: toDate(data.timestamp) }; }).reverse());
            updateMarkers();
            if (state.selectedId === id) drawRoute(id);
        }, error => console.warn(`Unable to load route history for ${id}`, error));
        state.historyUnsubscribes.set(id, unsubscribe);
    });
}
function render() { renderMetrics(); renderTable(); renderAlerts(); updateMarkers(); renderMapDetail(); elements.lastRefresh.textContent = `Updated ${formatTime(new Date())}`; }
function addLivePoint(boat) { if (!boat.trackingEnabled || !boat.timestamp || !boat.gpsFix) return; const history = state.histories.get(boat.id) || []; const last = history.at(-1); if (!last || last.timestamp?.getTime() !== boat.timestamp.getTime()) { history.push({ latitude: boat.latitude, longitude: boat.longitude, timestamp: boat.timestamp }); state.histories.set(boat.id, history.slice(-3)); } }
function setConnection(mode, label) { elements.connection.className = `connection-pill ${mode}`; elements.connection.innerHTML = `<span class="status-dot"></span><span class="hidden sm:inline">${escapeHtml(label)}</span>`; }

function readDemoRentalHistory() { try { return JSON.parse(localStorage.getItem(DEMO_RENTAL_HISTORY_KEY) || "[]"); } catch { return []; } }
function appendDemoRentalHistory(record) { localStorage.setItem(DEMO_RENTAL_HISTORY_KEY, JSON.stringify([...readDemoRentalHistory(), record].slice(-500))); }

function rentalRecord(boat, checkedOutAt, checkedInAt) {
    return {
        device_id: boat.id,
        vessel_name: boat.name,
        checked_out_at: checkedOutAt,
        checked_in_at: checkedInAt,
        duration_minutes: checkedOutAt ? Math.max(0, Math.round((checkedInAt - checkedOutAt) / 60000)) : 0,
        passenger_count: boat.passengerCount || 0
    };
}

async function checkOutBoat(boat, renterName, passengerCount) {
    if (state.demoMode) {
        state.boats.set(boat.id, { ...boat, availability: "rented", trackingEnabled: true, booked: true, bookedBy: renterName, passengerCount, timeOut: new Date(), actualReturn: null });
        state.histories.set(boat.id, []);
        return;
    }
    await updateDoc(doc(state.db, "boats", boat.id), {
        availability_status: "rented",
        tracking_enabled: true,
        booked: true,
        booked_by: renterName,
        passenger_count: passengerCount,
        time_out: new Date(),
        actual_time_back: deleteField(),
        rental_updated_at: serverTimestamp()
    });
}

// Check-in is the privacy boundary: the journey trail and renter identity are destroyed here.
async function checkInBoat(boat) {
    const checkedInAt = new Date();
    const record = rentalRecord(boat, boat.timeOut, checkedInAt);
    state.histories.delete(boat.id);
    if (state.routeLayer && state.selectedId === boat.id) { state.routeLayer.remove(); state.routeLayer = null; }

    if (state.demoMode) {
        appendDemoRentalHistory({ ...record, checked_out_at: boat.timeOut?.toISOString() || null, checked_in_at: checkedInAt.toISOString() });
        state.boats.set(boat.id, { ...boat, availability: "available", trackingEnabled: false, booked: false, bookedBy: "", passengerCount: 0, timeOut: null, actualReturn: null });
        return;
    }

    await addDoc(collection(state.db, "rental_history"), record);

    const historyUnsubscribe = state.historyUnsubscribes.get(boat.id);
    if (historyUnsubscribe) { historyUnsubscribe(); state.historyUnsubscribes.delete(boat.id); }
    const trail = await getDocs(collection(state.db, "boats", boat.id, "history"));
    await Promise.all(trail.docs.map(entry => deleteDoc(entry.ref)));

    await updateDoc(doc(state.db, "boats", boat.id), {
        availability_status: "available",
        tracking_enabled: false,
        booked: false,
        booked_by: deleteField(),
        passenger_count: deleteField(),
        time_out: deleteField(),
        actual_time_back: deleteField(),
        rental_updated_at: serverTimestamp()
    });
}

async function checkInFromTable(boatId, button) {
    const boat = state.boats.get(boatId);
    if (!boat) return;
    if (!state.demoMode && !state.isStaff) { setConnection("error", "Sign in required"); return; }

    button.disabled = true;
    button.textContent = "Checking in…";
    try {
        await checkInBoat(boat);
        render();
        if (!state.demoMode) setConnection("live", "Boat checked in");
    } catch (error) {
        console.error("Check-in failed", error);
        setConnection("error", "Check-in failed");
        if (button.isConnected) { button.disabled = false; button.textContent = "Check in"; }
    }
}

function showRentalMessage(message, success = false) { elements.rentalMessage.textContent = message; elements.rentalMessage.className = `form-message ${success ? "success" : ""}`; }
function hideRentalMessage() { elements.rentalMessage.className = "form-message hidden"; elements.rentalMessage.textContent = ""; }

function checkoutDetailsAreComplete() {
    const renterName = document.getElementById("renterName")?.value.trim();
    const passengerCount = Number(document.getElementById("renterPassengers")?.value);
    const ndaSigned = document.getElementById("renterNdaSigned")?.checked;
    return Boolean(renterName) && Number.isInteger(passengerCount) && passengerCount >= 1 && passengerCount <= 6 && ndaSigned;
}

function updateCheckoutEligibility() {
    elements.rentalConfirm.disabled = !checkoutDetailsAreComplete();
}

function openRentalModal(boatId) {
    const boat = state.boats.get(boatId);
    if (!boat) return;
     state.pendingAction = { boatId };
    hideRentalMessage();
     document.getElementById("rentalTitle").textContent = `Check out ${boat.name}`;
     document.getElementById("rentalEyebrow").textContent = "Start rental";
     elements.rentalConfirm.querySelector("span").textContent = "Check out";
     elements.rentalBody.innerHTML = `<label><span>Renter name</span><input id="renterName" type="text" maxlength="60" placeholder="Full name" autocomplete="off" required></label>
         <label><span>Phone number</span><input id="renterPhone" type="tel" maxlength="30" placeholder="(206) 555-0123" autocomplete="tel" inputmode="tel"></label>
        <label><span>Number of passengers</span><input id="renterPassengers" type="number" min="1" max="6" required></label>
        <label class="nda-confirmation"><input id="renterNdaSigned" type="checkbox" required><span>I confirm the renter has signed the NDA.</span></label>
         <div class="privacy-note"><i data-lucide="shield" class="h-4 w-4 shrink-0"></i><span>Location tracking starts now and runs only until check-in. The renter name and route are erased automatically when the boat returns.</span></div>`;
    elements.rentalBody.querySelectorAll("input").forEach(input => input.addEventListener("input", updateCheckoutEligibility));
    document.getElementById("renterNdaSigned").addEventListener("change", updateCheckoutEligibility);
    updateCheckoutEligibility();
    elements.rentalBackdrop.classList.remove("hidden");
    elements.rentalModal.classList.remove("hidden");
    lucide.createIcons();
    setTimeout(() => document.getElementById("renterName")?.focus(), 50);
}

function closeRentalModal() { state.pendingAction = null; elements.rentalBackdrop.classList.add("hidden"); elements.rentalModal.classList.add("hidden"); }

async function submitRentalAction(event) {
    event.preventDefault();
    if (!state.pendingAction) return;
    const { boatId } = state.pendingAction;
    const boat = state.boats.get(boatId);
    if (!boat) { closeRentalModal(); return; }
    if (!state.demoMode && !state.isStaff) { showRentalMessage("Sign in with a dock staff account to record rentals."); return; }

    const renterName = document.getElementById("renterName").value.trim();
    const passengerCount = Number(document.getElementById("renterPassengers").value);
    const ndaSigned = document.getElementById("renterNdaSigned").checked;
    if (!renterName) { showRentalMessage("Renter name is required."); return; }
    if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 6) { showRentalMessage("Passengers must be between 1 and 6."); return; }
    if (!ndaSigned) { showRentalMessage("Confirm that the renter has signed the NDA before checkout."); return; }

    elements.rentalConfirm.disabled = true;
    try {
        await checkOutBoat(boat, renterName, passengerCount);
        render();
        if (state.demoMode) closeRentalModal();
        else { showRentalMessage("Boat checked out.", true); setTimeout(closeRentalModal, 600); }
    } catch (error) {
        console.error("Rental action failed", error);
        showRentalMessage(error.message || "Unable to complete the dock operation.");
    } finally {
        updateCheckoutEligibility();
    }
}

function startFirebase() {
    if (!firebaseConfig.projectId || firebaseConfig.projectId.startsWith("your-")) { startDemo(); return; }
    try {
        const app = initializeApp(firebaseConfig); window.__firebaseApp = app; const db = getFirestore(app);
        state.db = db;
        state.auth = getAuth(app);
        onAuthStateChanged(state.auth, async user => {
            const token = user ? await user.getIdTokenResult(true) : null;
            state.user = user;
            state.isStaff = Boolean(token?.claims?.admin);
            elements.signIn.innerHTML = `<i data-lucide="${user ? "log-out" : "log-in"}" class="h-4 w-4"></i>`;
            elements.signIn.title = user ? `Sign out ${user.displayName || user.email || ""}`.trim() : "Sign in for dock operations";
            lucide.createIcons();
        });
        onSnapshot(collection(db, "boats"), snapshot => { const next = new Map(); snapshot.forEach(document => { const boat = normalizedBoat(document.id, document.data()); if (boat.availability === "maintenance") return; next.set(boat.id, boat); addLivePoint(boat); }); state.boats = next; if (!next.has(state.selectedId)) state.selectedId = next.size ? next.keys().next().value : null; syncHistorySubscriptions(); setConnection("live", "Firebase live"); render(); }, error => { console.error("Firestore listener failed", error); setConnection("error", "Connection error"); elements.tableBody.innerHTML = `<tr><td colspan="${visibleColumns().length}" class="empty-cell">Unable to load Firebase telemetry. Check the console and Firestore configuration.</td></tr>`; });
    } catch (error) { console.error("Firebase initialization failed", error); setConnection("error", "Configuration error"); }
}

function demoHistory(origin, destination, count, startedAt) { return Array.from({ length: count }, (_, index) => { const progress = index / (count - 1); const wave = Math.sin(index * 1.7) * .00035; return { latitude: origin.latitude + (destination.latitude - origin.latitude) * progress + wave, longitude: origin.longitude + (destination.longitude - origin.longitude) * progress + wave * .7, timestamp: new Date(startedAt.getTime() + index * 3 * 60000) }; }); }
function demoOperatingDate(tuesday, dayOffset, hour, minute) { const date = new Date(tuesday); date.setDate(tuesday.getDate() + dayOffset); date.setHours(hour, minute, 0, 0); return date; }
function randomPassengerCount() { return Math.floor(Math.random() * 6) + 1; }
function startDemo() {
    state.demoMode = true; const now = new Date(); const tuesday = new Date(now); tuesday.setDate(now.getDate() - ((now.getDay() - 2 + 7) % 7)); tuesday.setHours(0, 0, 0, 0);
    const boats = [
        normalizedBoat("70b3d57ed0000001", { vessel_name: "Rowboat Martha", availability_status: "available", booked: true, booked_by: "Jamie Chen", passenger_count: randomPassengerCount(), rental_type: "fixed", rental_minutes: 60, time_out: demoOperatingDate(tuesday, 0, 12, 30), actual_time_back: demoOperatingDate(tuesday, 0, 13, 27), last_ping: { protocol_version: 1, latitude: 47.62805, longitude: -122.33638, battery_mv: 5160, low_battery: false, gps_fix: true, mooring_status: "Tied Up at Dock", variance_g2: .0004, max_temperature_c: 17.9, timestamp: new Date(now.getTime() - 18000) } }),
        normalizedBoat("70b3d57ed0000002", { vessel_name: "Rowboat Colleen", availability_status: "available", booked: true, booked_by: "Priya Shah", passenger_count: randomPassengerCount(), rental_type: "fixed", rental_minutes: 60, time_out: demoOperatingDate(tuesday, 0, 15, 0), actual_time_back: demoOperatingDate(tuesday, 0, 16, 2), last_ping: { protocol_version: 1, latitude: 47.62812, longitude: -122.33628, battery_mv: 5010, low_battery: false, gps_fix: true, mooring_status: "Tied Up at Dock", variance_g2: .0005, max_temperature_c: 18.1, timestamp: new Date(now.getTime() - 9000) } }),
        normalizedBoat("70b3d57ed0000003", { vessel_name: "Rowboat Virginia V", availability_status: "available", booked: true, booked_by: "Elena Garcia", passenger_count: randomPassengerCount(), rental_type: "fixed", rental_minutes: 60, time_out: demoOperatingDate(tuesday, 1, 12, 45), actual_time_back: demoOperatingDate(tuesday, 1, 13, 41), last_ping: { protocol_version: 1, latitude: 47.62792, longitude: -122.33651, battery_mv: 4930, low_battery: false, gps_fix: true, mooring_status: "Tied Up at Dock", variance_g2: .0004, max_temperature_c: 18.4, timestamp: new Date(now.getTime() - 32000) } }),
        normalizedBoat("70b3d57ed0000004", { vessel_name: "Rowboat Blanchard", availability_status: "maintenance", booked: false, booked_by: "", passenger_count: randomPassengerCount(), last_ping: { protocol_version: 1, latitude: 47.62786, longitude: -122.33662, battery_mv: 4090, low_battery: true, gps_fix: true, mooring_status: "Tied Up at Dock", variance_g2: .0003, max_temperature_c: null, timestamp: new Date(now.getTime() - 46 * 60000) } }),
        normalizedBoat("70b3d57ed0000005", { vessel_name: "Rowboat Wagner", availability_status: "available", booked: true, booked_by: "Noah Williams", passenger_count: randomPassengerCount(), rental_type: "fixed", rental_minutes: 60, time_out: demoOperatingDate(tuesday, 2, 13, 15), actual_time_back: demoOperatingDate(tuesday, 2, 14, 11), last_ping: { protocol_version: 1, latitude: 47.6282, longitude: -122.33643, battery_mv: 4870, low_battery: false, gps_fix: true, mooring_status: "Tied Up at Dock", variance_g2: .0006, max_temperature_c: 18.2, timestamp: new Date(now.getTime() - 22000) } }),
        normalizedBoat("70b3d57ed0000006", { vessel_name: "Rowboat Dearborn", availability_status: "available", booked: true, booked_by: "Amina Yusuf", passenger_count: randomPassengerCount(), rental_type: "fixed", rental_minutes: 60, time_out: demoOperatingDate(tuesday, 3, 14, 30), actual_time_back: demoOperatingDate(tuesday, 3, 15, 35), last_ping: { protocol_version: 1, latitude: 47.62808, longitude: -122.3367, battery_mv: 4750, low_battery: false, gps_fix: true, mooring_status: "Tied Up at Dock", variance_g2: .0005, max_temperature_c: 18.7, timestamp: new Date(now.getTime() - 27000) } }),
        normalizedBoat("70b3d57ed0000007", { vessel_name: "Rowboat Cascade", availability_status: "available", booked: true, booked_by: "Lucas Martin", passenger_count: randomPassengerCount(), rental_type: "fixed", rental_minutes: 60, time_out: demoOperatingDate(tuesday, 4, 12, 30), actual_time_back: demoOperatingDate(tuesday, 4, 13, 25), last_ping: { protocol_version: 1, latitude: 47.62778, longitude: -122.33632, battery_mv: 5090, low_battery: false, gps_fix: true, mooring_status: "Tied Up at Dock", variance_g2: .0004, max_temperature_c: 19.0, timestamp: new Date(now.getTime() - 16000) } }),
        normalizedBoat("70b3d57ed0000008", { vessel_name: "Rowboat Fremont", availability_status: "available", booked: true, booked_by: "Sofia Kim", passenger_count: randomPassengerCount(), rental_type: "fixed", rental_minutes: 60, time_out: demoOperatingDate(tuesday, 4, 17, 30), actual_time_back: demoOperatingDate(tuesday, 4, 18, 24), last_ping: { protocol_version: 1, latitude: 47.62826, longitude: -122.33612, battery_mv: 4960, low_battery: false, gps_fix: true, mooring_status: "Tied Up at Dock", variance_g2: .0005, max_temperature_c: 19.3, timestamp: new Date(now.getTime() - 12000) } }),
        normalizedBoat("70b3d57ed0000009", { vessel_name: "Rowboat Gas Works", availability_status: "rented", booked: true, booked_by: "Marcus Lee", passenger_count: randomPassengerCount(), rental_type: "open", time_out: demoOperatingDate(tuesday, 5, 13, 0), last_ping: { protocol_version: 1, latitude: 47.6346, longitude: -122.3328, battery_mv: 4680, low_battery: false, gps_fix: true, mooring_status: "Underway / Moving", variance_g2: .0017, max_temperature_c: 19.4, timestamp: new Date(now.getTime() - 8000) } }),
        normalizedBoat("70b3d57ed0000010", { vessel_name: "Rowboat Aurora", availability_status: "rented", booked: true, booked_by: "Taylor Brooks", passenger_count: randomPassengerCount(), rental_type: "fixed", rental_minutes: 60, time_out: demoOperatingDate(tuesday, 5, 17, 30), last_ping: { protocol_version: 1, latitude: 47.6402, longitude: -122.3344, battery_mv: 4520, low_battery: false, gps_fix: true, mooring_status: "Underway / Moving", variance_g2: .0028, max_temperature_c: 19.2, timestamp: new Date(now.getTime() - 11000) } })
    ];
    state.boats = new Map(boats.filter(boat => boat.availability !== "maintenance").map(boat => [boat.id, boat])); state.histories.set(boats[8].id, demoHistory({ latitude: 47.6405, longitude: -122.3340 }, boats[8], 18, demoOperatingDate(tuesday, 5, 13, 0))); state.histories.set(boats[9].id, demoHistory(DOCK, boats[9], 24, demoOperatingDate(tuesday, 5, 17, 30))); state.selectedId = boats[8].id; elements.dataMode.textContent = "Demo mode · Tue–Sun, 12:30–18:30"; elements.signIn.classList.add("hidden"); setConnection("live", "Demo data"); render(); selectBoat(boats[8].id, false);
}

function setupInteractions() {
    elements.rentalForm.addEventListener("submit", submitRentalAction);
    document.getElementById("rentalClose").addEventListener("click", closeRentalModal);
    document.getElementById("rentalCancel").addEventListener("click", closeRentalModal);
    elements.rentalBackdrop.addEventListener("click", closeRentalModal);
    document.addEventListener("keydown", event => { if (event.key !== "Escape") return; if (!elements.rentalModal.classList.contains("hidden")) closeRentalModal(); setColumnMenuOpen(false); });
    document.addEventListener("click", event => { if (!event.target.closest(".column-menu-wrap")) setColumnMenuOpen(false); });
    elements.columnMenuButton.addEventListener("click", event => { event.stopPropagation(); setColumnMenuOpen(elements.columnMenu.classList.contains("hidden")); });
    document.getElementById("resetColumnsButton").addEventListener("click", () => { state.columnOrder = [...DEFAULT_COLUMN_ORDER]; state.hiddenColumns.clear(); state.sort = { column: "vessel", direction: "asc" }; saveTablePreferences(); renderColumnMenu(); renderTable(); });
    elements.signIn.addEventListener("click", async () => {
        if (state.demoMode || !state.auth) return;
        try { if (state.user) await signOut(state.auth); else await signInWithPopup(state.auth, new GoogleAuthProvider()); }
        catch (error) { console.error("Authentication failed", error); setConnection("error", "Sign-in failed"); }
    });
    elements.search.addEventListener("input", event => { state.search = event.target.value.trim().toLowerCase(); renderTable(); });
    elements.statusFilter.addEventListener("change", event => { state.status = event.target.value; renderTable(); });
    document.getElementById("collapseAlerts").addEventListener("click", () => document.querySelector(".alerts-panel").classList.toggle("collapsed"));
    document.getElementById("themeToggle").addEventListener("click", () => { document.documentElement.classList.toggle("dark"); if (document.documentElement.classList.contains("dark")) { if (map.hasLayer(standardTiles)) map.removeLayer(standardTiles); darkTiles.addTo(map); } else { if (map.hasLayer(darkTiles)) map.removeLayer(darkTiles); standardTiles.addTo(map); } });
    document.getElementById("fullscreenToggle").addEventListener("click", () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); });
    let dragging = false;
    elements.splitter.addEventListener("pointerdown", event => { dragging = true; elements.splitter.classList.add("dragging"); elements.splitter.setPointerCapture(event.pointerId); });
    elements.splitter.addEventListener("pointermove", event => { if (!dragging) return; const workspace = document.getElementById("workspace").getBoundingClientRect(); if (window.innerWidth <= 900) { const height = Math.max(190, Math.min(workspace.height - 150, event.clientY - workspace.top)); elements.operationsPane.style.height = `${height}px`; } else { const width = Math.max(390, Math.min(workspace.width - 390, event.clientX - workspace.left)); document.documentElement.style.setProperty("--operations-size", `${width}px`); localStorage.setItem("cwbOperationsWidth", String(width)); } map.invalidateSize({ animate: false }); });
    elements.splitter.addEventListener("pointerup", event => { dragging = false; elements.splitter.classList.remove("dragging"); elements.splitter.releasePointerCapture(event.pointerId); map.invalidateSize(); });
    elements.splitter.addEventListener("keydown", event => { if (!["ArrowLeft", "ArrowRight"].includes(event.key) || window.innerWidth <= 900) return; const next = elements.operationsPane.getBoundingClientRect().width + (event.key === "ArrowRight" ? 24 : -24); document.documentElement.style.setProperty("--operations-size", `${Math.max(390, next)}px`); map.invalidateSize(); });
    const savedWidth = Number(localStorage.getItem("cwbOperationsWidth")); if (savedWidth && window.innerWidth > 900) document.documentElement.style.setProperty("--operations-size", `${savedWidth}px`); window.addEventListener("resize", () => map.invalidateSize());
}

setInterval(() => { document.getElementById("headerClock").textContent = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date()); }, 1000);
lucide.createIcons();
setupInteractions();
startFirebase();