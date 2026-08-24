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
const state = { boats: new Map(), histories: new Map(), markers: new Map(), selectedId: null, routeLayer: null, historyUnsubscribe: null, search: "", status: "all", demoMode: false, db: null, auth: null, user: null, isStaff: false, pendingAction: null };
const elements = {
    operationsPane: document.getElementById("operationsPane"), splitter: document.getElementById("splitter"), tableBody: document.getElementById("fleetTableBody"), alertsList: document.getElementById("alertsList"), alertCount: document.getElementById("alertCount"), connection: document.getElementById("connectionStatus"), dataMode: document.getElementById("dataMode"), lastRefresh: document.getElementById("lastRefresh"), mapDetail: document.getElementById("mapDetail"), search: document.getElementById("searchInput"), statusFilter: document.getElementById("statusFilter"),
    signIn: document.getElementById("signInButton"), rentalModal: document.getElementById("rentalModal"), rentalBackdrop: document.getElementById("rentalBackdrop"), rentalBody: document.getElementById("rentalBody"), rentalMessage: document.getElementById("rentalMessage"), rentalConfirm: document.getElementById("rentalConfirm"), rentalForm: document.getElementById("rentalForm"),
    metrics: { total: document.getElementById("metricTotal"), available: document.getElementById("metricAvailable"), underway: document.getElementById("metricUnderway"), alerts: document.getElementById("metricAlerts") }
};

const standardTiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" });
const darkTiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 20, attribution: "&copy; OpenStreetMap contributors &copy; CARTO" });
const map = L.map("map", { zoomControl: true, layers: [darkTiles] }).setView([47.6322, -122.3367], 14);
L.control.layers({ "Dark OSM": darkTiles, "Standard OSM": standardTiles }, null, { position: "topright" }).addTo(map);
L.circle([DOCK.latitude, DOCK.longitude], { radius: DOCK_GEOFENCE_METERS, color: "#38bdf8", weight: 2, fillColor: "#38bdf8", fillOpacity: .12 }).bindTooltip("CWB dock geofence").addTo(map);
L.circle([DOCK.latitude, DOCK.longitude], { radius: OPERATING_ZONE_METERS, color: "#f59e0b", weight: 1, dashArray: "7 8", fillOpacity: .015 }).bindTooltip("Lake Union operating zone").addTo(map);

function toDate(value) { if (!value) return null; if (value instanceof Date) return value; if (typeof value.toDate === "function") return value.toDate(); if (typeof value.seconds === "number") return new Date(value.seconds * 1000); const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed; }
function formatTime(value, includeDate = false) { const date = toDate(value); if (!date) return "—"; return new Intl.DateTimeFormat("en-US", { weekday: includeDate ? "short" : undefined, month: includeDate ? "short" : undefined, day: includeDate ? "numeric" : undefined, hour: "numeric", minute: "2-digit" }).format(date); }
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
function vectorEstimate(boat) {
    const points = (state.histories.get(boat.id) || []).filter(point => point.timestamp && Number.isFinite(point.latitude) && Number.isFinite(point.longitude)).slice(-3);
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
function operationalState(boat) { const due = fixedDue(boat); const overdue = Boolean(due && !boat.actualReturn && due < new Date()); if (boat.availability === "maintenance") return "maintenance"; if (overdue || boat.lowBattery || isOutsideZone(boat)) return "overdue"; if (boat.availability === "available" || (boat.mooring === "Tied Up at Dock" && !boat.timeOut)) return "available"; return "rented"; }
function dueDisplay(boat) { if (boat.actualReturn || ["available", "maintenance"].includes(boat.availability)) return { primary: "—", secondary: "No active rental", warning: false }; const due = fixedDue(boat); if (due) { const deltaMinutes = Math.round((Date.now() - due.getTime()) / 60000); return { primary: formatTime(due, true), secondary: deltaMinutes > 0 && !boat.actualReturn ? `+${deltaMinutes} min late` : `${boat.rentalMinutes} min rental`, warning: deltaMinutes > 0 && !boat.actualReturn }; } const estimate = vectorEstimate(boat); if (estimate) return { primary: formatTime(estimate.due, true), secondary: `Vector ETA · ${estimate.minutes.toFixed(0)} min`, warning: false }; return { primary: "Calculating…", secondary: "Needs return vector", warning: false }; }
function alertsFor(boat) { const alerts = []; const due = fixedDue(boat); if (due && !boat.actualReturn && due < new Date()) alerts.push({ critical: true, message: `${boat.name} is ${Math.max(1, Math.round((Date.now() - due) / 60000))} minutes overdue.` }); if (boat.lowBattery || (boat.batteryMv && boat.batteryMv <= 4200)) alerts.push({ critical: true, message: `${boat.name} battery is low at ${(boat.batteryMv / 1000).toFixed(2)} V.` }); if (isOutsideZone(boat)) alerts.push({ critical: true, message: `${boat.name} is outside the Lake Union operating zone.` }); if (!boat.gpsFix) alerts.push({ critical: false, message: `${boat.name} does not have a valid GPS fix.` }); if (boat.timestamp && Date.now() - boat.timestamp.getTime() > STALE_AFTER_MINUTES * 60000) alerts.push({ critical: false, message: `${boat.name} telemetry is stale (${formatTime(boat.timestamp)}).` }); return alerts; }

function formatVariance(boat) { return boat.mooringValid && boat.variance != null ? `σ² ${boat.variance.toFixed(5)}` : "Not evaluated"; }
function markerIcon(boat) { const status = operationalState(boat); const critical = alertsFor(boat).some(alert => alert.critical); const markerStatus = critical ? "warning" : status; return L.divIcon({ className: "", html: `<div class="boat-marker ${markerStatus}"><i data-lucide="ship-wheel"></i><span class="boat-label">${escapeHtml(boat.name)}</span></div>`, iconSize: [38, 38], iconAnchor: [19, 19] }); }
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
function dockActionCell(boat, status) {
    if (status === "maintenance") return `<td><button class="dock-action" type="button" disabled>Unavailable</button></td>`;
    const isOut = status === "rented" || status === "overdue";
    return `<td><button class="dock-action ${isOut ? "check-in" : "check-out"}" type="button" data-action="${isOut ? "check-in" : "check-out"}" data-boat-id="${escapeHtml(boat.id)}"><i data-lucide="${isOut ? "log-in" : "log-out"}" class="h-3 w-3"></i>${isOut ? "Check in" : "Check out"}</button></td>`;
}
function renderTable() {
    const boats = [...state.boats.values()].filter(boat => `${boat.id} ${boat.name}`.toLowerCase().includes(state.search) && (state.status === "all" || operationalState(boat) === state.status));
    if (!boats.length) { elements.tableBody.innerHTML = `<tr><td colspan="13" class="empty-cell">No vessels match the current filters.</td></tr>`; return; }
    elements.tableBody.innerHTML = boats.map(boat => {
        const status = operationalState(boat); const due = dueDisplay(boat); const battery = batteryPercent(boat.batteryMv); const hasAlerts = alertsFor(boat).length > 0; const availabilityLabel = status === "overdue" ? "Overdue" : status[0].toUpperCase() + status.slice(1);
        return `<tr data-boat-id="${escapeHtml(boat.id)}" class="${hasAlerts ? "alert-row" : ""} ${state.selectedId === boat.id ? "selected" : ""}">${dockActionCell(boat, status)}<td><span class="vessel-name">${escapeHtml(boat.name)}</span><span class="vessel-id">${escapeHtml(boat.id)}</span></td><td>${badge(status, availabilityLabel)}</td><td><span class="data-value">${boat.booked ? "YES" : "NO"}</span></td><td><span class="data-value">${boat.bookedBy ? escapeHtml(boat.bookedBy) : "—"}</span></td><td><span class="data-value">${boat.passengerCount || "—"}</span></td><td><span class="data-value">${formatTime(boat.timeOut, true)}</span><span class="cell-note">${boat.timeOut ? boat.rentalType : "No active checkout"}</span></td><td><span class="data-value ${due.warning ? "text-red-400" : ""}">${due.primary}</span><span class="cell-note ${due.warning ? "text-red-400" : ""}">${due.secondary}</span></td><td><span class="data-value">${formatTime(boat.actualReturn, true)}</span></td><td><span class="data-value">${Number.isFinite(boat.latitude) ? boat.latitude.toFixed(5) : "—"}</span><span class="cell-note font-mono">${Number.isFinite(boat.longitude) ? boat.longitude.toFixed(5) : "—"}</span></td><td><span class="data-value">${escapeHtml(boat.mooring.replace(" at Dock", ""))}</span><span class="cell-note">${formatVariance(boat)}</span></td><td><span class="data-value ${boat.lowBattery ? "text-red-400" : ""}">${(boat.batteryMv / 1000).toFixed(2)} V</span><div class="battery-track"><div class="battery-fill ${boat.lowBattery ? "low" : ""}" style="width:${battery}%"></div></div></td><td><span class="data-value">${formatTime(boat.timestamp)}</span><span class="cell-note">Protocol v${boat.protocolVersion ?? "—"}</span></td></tr>`;
    }).join("");
    elements.tableBody.querySelectorAll("tr[data-boat-id]").forEach(row => row.addEventListener("click", () => selectBoat(row.dataset.boatId, true)));
    elements.tableBody.querySelectorAll(".dock-action[data-action]").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); openRentalModal(button.dataset.boatId, button.dataset.action); }));
    lucide.createIcons();
}

function renderAlerts() { const alerts = [...state.boats.values()].flatMap(boat => alertsFor(boat).map(alert => ({ ...alert, boatId: boat.id }))); elements.alertCount.textContent = alerts.length; elements.metrics.alerts.textContent = alerts.length; elements.alertsList.innerHTML = alerts.length ? alerts.map(alert => `<button class="alert-item ${alert.critical ? "critical" : ""}" data-boat-id="${escapeHtml(alert.boatId)}" type="button"><span class="alert-severity"></span><span>${escapeHtml(alert.message)}</span></button>`).join("") : `<p class="no-alerts">No active fleet alerts.</p>`; elements.alertsList.querySelectorAll("button").forEach(button => button.addEventListener("click", () => selectBoat(button.dataset.boatId, true))); }
function renderMetrics() { const boats = [...state.boats.values()]; elements.metrics.total.textContent = boats.length; elements.metrics.available.textContent = boats.filter(boat => operationalState(boat) === "available").length; elements.metrics.underway.textContent = boats.filter(boat => boat.mooring !== "Tied Up at Dock").length; }
function renderMapDetail() { const boat = state.boats.get(state.selectedId); if (!boat) { elements.mapDetail.classList.add("hidden"); return; } const due = dueDisplay(boat); elements.mapDetail.innerHTML = `<div class="flex items-start justify-between gap-3"><div><p class="eyebrow">Selected vessel</p><h3 class="mt-1 font-semibold">${escapeHtml(boat.name)}</h3><p class="mt-1 font-mono text-[10px] text-zinc-500">${escapeHtml(boat.id)}</p></div>${badge(operationalState(boat), operationalState(boat).toUpperCase())}</div><div class="map-detail-grid"><div><span>Due / ETA</span><strong>${due.primary}</strong></div><div><span>Battery</span><strong>${(boat.batteryMv / 1000).toFixed(2)} V</strong></div><div><span>Last ping</span><strong>${formatTime(boat.timestamp)}</strong></div></div>`; elements.mapDetail.classList.remove("hidden"); }
function drawRoute(id) { if (state.routeLayer) state.routeLayer.remove(); const points = (state.histories.get(id) || []).filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)); if (points.length < 2) return; state.routeLayer = L.polyline(points.map(point => [point.latitude, point.longitude]), { color: operationalState(state.boats.get(id)) === "overdue" ? "#ef4444" : "#38bdf8", weight: 3, opacity: .75, dashArray: "4 7" }).addTo(map); }
function selectBoat(id, pan) { state.selectedId = id; const boat = state.boats.get(id); if (!boat) return; renderTable(); renderMapDetail(); drawRoute(id); if (pan && boat.gpsFix) map.flyTo([boat.latitude, boat.longitude], Math.max(map.getZoom(), 15), { duration: .7 }); if (!state.demoMode) subscribeToHistory(id); }
function subscribeToHistory(id) { if (state.historyUnsubscribe) { state.historyUnsubscribe(); state.historyUnsubscribe = null; } const boat = state.boats.get(id); if (!state.db || !boat?.trackingEnabled) return; const historyQuery = query(collection(state.db, "boats", id, "history"), orderBy("timestamp", "desc"), limit(120)); state.historyUnsubscribe = onSnapshot(historyQuery, snapshot => { state.histories.set(id, snapshot.docs.map(document => { const data = document.data(); return { latitude: Number(data.latitude), longitude: Number(data.longitude), timestamp: toDate(data.timestamp) }; }).reverse()); drawRoute(id); renderTable(); renderMapDetail(); }, error => console.warn("Unable to load route history", error)); }
function render() { renderMetrics(); renderTable(); renderAlerts(); updateMarkers(); renderMapDetail(); elements.lastRefresh.textContent = `Updated ${formatTime(new Date())}`; }
function addLivePoint(boat) { if (!boat.trackingEnabled || !boat.timestamp || !boat.gpsFix) return; const history = state.histories.get(boat.id) || []; const last = history.at(-1); if (!last || last.timestamp?.getTime() !== boat.timestamp.getTime()) { history.push({ latitude: boat.latitude, longitude: boat.longitude, timestamp: boat.timestamp }); state.histories.set(boat.id, history.slice(-120)); } }
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

    if (state.historyUnsubscribe) { state.historyUnsubscribe(); state.historyUnsubscribe = null; }
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

function showRentalMessage(message, success = false) { elements.rentalMessage.textContent = message; elements.rentalMessage.className = `form-message ${success ? "success" : ""}`; }
function hideRentalMessage() { elements.rentalMessage.className = "form-message hidden"; elements.rentalMessage.textContent = ""; }

function openRentalModal(boatId, action) {
    const boat = state.boats.get(boatId);
    if (!boat) return;
    state.pendingAction = { boatId, action };
    hideRentalMessage();
    document.getElementById("rentalTitle").textContent = action === "check-out" ? `Check out ${boat.name}` : `Check in ${boat.name}`;
    document.getElementById("rentalEyebrow").textContent = action === "check-out" ? "Start rental" : "End rental";
    elements.rentalConfirm.querySelector("span").textContent = action === "check-out" ? "Check out" : "Check in and erase data";
    elements.rentalBody.innerHTML = action === "check-out"
        ? `<label><span>Renter name</span><input id="renterName" type="text" maxlength="60" placeholder="Full name" autocomplete="off" required></label>
           <label><span>Number of passengers</span><input id="renterPassengers" type="number" min="1" max="6" value="2" required></label>
           <div class="privacy-note"><i data-lucide="shield" class="h-4 w-4 shrink-0"></i><span>Location tracking starts now and runs only until check-in. The renter name and route are erased when the boat returns.</span></div>`
        : `<p class="rental-summary">Out since <strong>${formatTime(boat.timeOut, true)}</strong>${boat.bookedBy ? ` · <strong>${escapeHtml(boat.bookedBy)}</strong>` : ""}</p>
           <div class="privacy-note"><i data-lucide="shield-check" class="h-4 w-4 shrink-0"></i><span>Checking in permanently deletes:<ul><li>every GPS coordinate from this trip</li><li>the renter name and passenger count</li></ul>Only the boat name and rental times are kept.</span></div>`;
    elements.rentalBackdrop.classList.remove("hidden");
    elements.rentalModal.classList.remove("hidden");
    lucide.createIcons();
    setTimeout(() => document.getElementById("renterName")?.focus(), 50);
}

function closeRentalModal() { state.pendingAction = null; elements.rentalBackdrop.classList.add("hidden"); elements.rentalModal.classList.add("hidden"); }

async function submitRentalAction(event) {
    event.preventDefault();
    if (!state.pendingAction) return;
    const { boatId, action } = state.pendingAction;
    const boat = state.boats.get(boatId);
    if (!boat) { closeRentalModal(); return; }
    if (!state.demoMode && !state.isStaff) { showRentalMessage("Sign in with a dock staff account to record rentals."); return; }

    let renterName = "";
    let passengerCount = 0;
    if (action === "check-out") {
        renterName = document.getElementById("renterName").value.trim();
        passengerCount = Number(document.getElementById("renterPassengers").value);
        if (!renterName) { showRentalMessage("Renter name is required."); return; }
        if (!Number.isInteger(passengerCount) || passengerCount < 1 || passengerCount > 6) { showRentalMessage("Passengers must be between 1 and 6."); return; }
    }

    elements.rentalConfirm.disabled = true;
    try {
        if (action === "check-out") await checkOutBoat(boat, renterName, passengerCount);
        else await checkInBoat(boat);
        render();
        if (state.demoMode) closeRentalModal();
        else { showRentalMessage(action === "check-out" ? "Boat checked out." : "Boat checked in and rental data erased.", true); setTimeout(closeRentalModal, 600); }
    } catch (error) {
        console.error("Rental action failed", error);
        showRentalMessage(error.message || "Unable to complete the dock operation.");
    } finally {
        elements.rentalConfirm.disabled = false;
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
        onSnapshot(collection(db, "boats"), snapshot => { const next = new Map(); snapshot.forEach(document => { const boat = normalizedBoat(document.id, document.data()); next.set(boat.id, boat); addLivePoint(boat); }); state.boats = next; if (!state.selectedId && next.size) state.selectedId = next.keys().next().value; setConnection("live", "Firebase live"); render(); }, error => { console.error("Firestore listener failed", error); setConnection("error", "Connection error"); elements.tableBody.innerHTML = `<tr><td colspan="13" class="empty-cell">Unable to load Firebase telemetry. Check the console and Firestore configuration.</td></tr>`; });
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
    state.boats = new Map(boats.map(boat => [boat.id, boat])); state.histories.set(boats[8].id, demoHistory({ latitude: 47.6405, longitude: -122.3340 }, boats[8], 18, demoOperatingDate(tuesday, 5, 13, 0))); state.histories.set(boats[9].id, demoHistory(DOCK, boats[9], 24, demoOperatingDate(tuesday, 5, 17, 30))); state.selectedId = boats[8].id; elements.dataMode.textContent = "Demo mode · Tue–Sun, 12:30–18:30"; elements.signIn.disabled = true; elements.signIn.title = "Demo mode"; setConnection("live", "Demo data"); render(); selectBoat(boats[8].id, false);
}

function setupInteractions() {
    elements.rentalForm.addEventListener("submit", submitRentalAction);
    document.getElementById("rentalClose").addEventListener("click", closeRentalModal);
    document.getElementById("rentalCancel").addEventListener("click", closeRentalModal);
    elements.rentalBackdrop.addEventListener("click", closeRentalModal);
    document.addEventListener("keydown", event => { if (event.key === "Escape" && !elements.rentalModal.classList.contains("hidden")) closeRentalModal(); });
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