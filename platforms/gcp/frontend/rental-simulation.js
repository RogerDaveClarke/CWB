const DOCK = [47.62795, -122.33645];
const FIRST_NAMES = ["Avery", "Jordan", "Morgan", "Casey", "Riley", "Parker", "Quinn", "Drew", "Taylor", "Cameron"];
const LAST_NAMES = ["Hughes", "Rivera", "Bennett", "Sato", "Dawson", "Nguyen", "Patel", "Monroe", "Kim", "Ellis"];
const BOATS = [
    { id: "martha", name: "Rowboat Martha", startOffset: 0, route: [[47.62795, -122.33645], [47.63010, -122.33500], [47.63235, -122.33725], [47.63045, -122.34010], [47.62795, -122.33645]] },
    { id: "colleen", name: "Rowboat Colleen", startOffset: 11, route: [[47.62795, -122.33645], [47.62695, -122.33280], [47.63005, -122.33070], [47.63320, -122.33370], [47.63135, -122.33755], [47.62795, -122.33645]] },
    { id: "virginia", name: "Rowboat Virginia V", startOffset: 22, route: [[47.62795, -122.33645], [47.62595, -122.33870], [47.62750, -122.34210], [47.63120, -122.34175], [47.63210, -122.33870], [47.62795, -122.33645]] },
    { id: "juanita", name: "Rowboat Juanita", startOffset: 6, route: [[47.62795, -122.33645], [47.62870, -122.33260], [47.63180, -122.33130], [47.63400, -122.33470], [47.63080, -122.33830], [47.62795, -122.33645]] },
    { id: "wawona", name: "Rowboat Wawona", startOffset: 17, route: [[47.62795, -122.33645], [47.62520, -122.33740], [47.62480, -122.34120], [47.62830, -122.34350], [47.63080, -122.34050], [47.62795, -122.33645]] },
    { id: "kalakala", name: "Rowboat Kalakala", startOffset: 28, route: [[47.62795, -122.33645], [47.63060, -122.33920], [47.63340, -122.33680], [47.63290, -122.33260], [47.62960, -122.33150], [47.62795, -122.33645]] }
];
const LATE_MIN_INTERVAL = 14;
const LATE_MAX_INTERVAL = 26;
const CYCLE_SECONDS = 34;
const PHASES = { docked: { start: 0, end: 5, label: "At dock" }, outbound: { start: 5, end: 10, label: "Casting off" }, loop: { start: 10, end: 27, label: "On Lake Union" }, inbound: { start: 27, end: 32, label: "Returning" }, checkin: { start: 32, end: 34, label: "Checking in" } };
const state = { elapsed: 0, lastTick: performance.now(), lastDisplaySecond: -1, running: true, speed: 1, selectedId: BOATS[0].id, boats: new Map(), markers: new Map(), routeLayers: new Map(), activity: [], rentalStarts: new Set(), manualRentals: new Map(), pendingBoatId: null, lateBoats: new Set(), nextLateCheckAt: LATE_MIN_INTERVAL + Math.random() * (LATE_MAX_INTERVAL - LATE_MIN_INTERVAL) };
const elements = { fleetList: document.getElementById("fleetList"), rentalCount: document.getElementById("rentalCount"), activityList: document.getElementById("activityList"), simulationTime: document.getElementById("simulationTime"), selectedBoat: document.getElementById("selectedBoat"), toggle: document.getElementById("toggleSimulation"), reset: document.getElementById("resetSimulation"), speed: document.getElementById("speedControl"), speedValue: document.getElementById("speedValue"), rentalModal: document.getElementById("rentalModal"), rentalBackdrop: document.getElementById("rentalBackdrop"), rentalForm: document.getElementById("rentalForm"), rentalConfirm: document.getElementById("rentalConfirm"), toastContainer: document.getElementById("toastContainer") };
const map = L.map("map", { zoomControl: true, attributionControl: true }).setView([47.6300, -122.3364], 15);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

function interpolate(points, progress) {
    const scaled = Math.max(0, Math.min(.99999, progress)) * (points.length - 1);
    const index = Math.floor(scaled); const fraction = scaled - index; const start = points[index]; const end = points[index + 1];
    return [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
}
function phaseFor(boat) { const rental = state.manualRentals.get(boat.id); const second = rental ? state.elapsed - rental.startedAt : (state.elapsed + boat.startOffset) % CYCLE_SECONDS; return Object.entries(PHASES).find(([, phase]) => second >= phase.start && second < phase.end)?.[0] || "docked"; }
function phaseProgress(boat, phase) { const rental = state.manualRentals.get(boat.id); const second = rental ? state.elapsed - rental.startedAt : (state.elapsed + boat.startOffset) % CYCLE_SECONDS; const range = PHASES[phase]; return (second - range.start) / (range.end - range.start); }
function guestFor(boat) {
    const cycle = Math.floor((state.elapsed + boat.startOffset) / CYCLE_SECONDS);
    const seed = Math.abs([...boat.id].reduce((total, character) => total * 31 + character.charCodeAt(0), cycle + 17));
    const first = FIRST_NAMES[seed % FIRST_NAMES.length]; const last = LAST_NAMES[Math.floor(seed / 7) % LAST_NAMES.length];
    return { name: `${first} ${last}`, passengers: seed % 5 + 1, phone: `(206) 555-${String(1000 + seed % 9000).slice(-4)}` };
}
function boatLocation(boat, phase) { if (phase === "docked" || phase === "checkin") return DOCK; const progress = phase === "outbound" ? phaseProgress(boat, phase) * .12 : phase === "loop" ? .12 + phaseProgress(boat, phase) * .76 : .88 + phaseProgress(boat, phase) * .12; return interpolate(boat.route, progress); }
function boatIcon(boat) { const underway = boat.phase !== "docked" && boat.phase !== "checkin"; return L.divIcon({ className: "", html: `<div class="boat-marker ${underway ? "underway" : ""}" data-name="${boat.name.replace("Rowboat ", "")}"><i data-lucide="ship-wheel"></i></div>`, iconSize: [34, 34], iconAnchor: [17, 17] }); }
function addActivity(message) { state.activity.unshift({ message, at: state.elapsed }); state.activity = state.activity.slice(0, 8); }
function showToast(title, message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<div><strong>${title}</strong>${message}</div>`;
    elements.toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add("leaving");
        setTimeout(() => toast.remove(), 220);
    }, 5000);
}
function maybeTriggerLateBoat() {
    if (state.elapsed < state.nextLateCheckAt) return;
    state.nextLateCheckAt = state.elapsed + LATE_MIN_INTERVAL + Math.random() * (LATE_MAX_INTERVAL - LATE_MIN_INTERVAL);
    const candidates = [...state.boats.values()].filter(boat => (boat.phase === "loop" || boat.phase === "inbound") && !state.lateBoats.has(boat.id));
    if (!candidates.length) return;
    const boat = candidates[Math.floor(Math.random() * candidates.length)];
    state.lateBoats.add(boat.id);
    addActivity(`${boat.name} is running late returning to the dock.`);
    showToast("Running late", `${boat.name} is behind schedule getting back to the dock.`);
}
function updateBoatStates() {
    BOATS.forEach(boat => {
        const manualRental = state.manualRentals.get(boat.id);
        if (manualRental && state.elapsed - manualRental.startedAt >= CYCLE_SECONDS) { state.manualRentals.delete(boat.id); addActivity(`${boat.name} returned; guest details cleared.`); }
        const phase = phaseFor(boat); const cycle = Math.floor((state.elapsed + boat.startOffset) / CYCLE_SECONDS); const rentalKey = `${boat.id}:${cycle}`;
        const prior = state.boats.get(boat.id); const currentManualRental = state.manualRentals.get(boat.id); const guest = currentManualRental ? currentManualRental.guest : phase === "docked" || phase === "checkin" ? null : guestFor(boat);
        const next = { ...boat, phase, guest, location: boatLocation(boat, phase), late: state.lateBoats.has(boat.id) };
        if (!prior) addActivity(`${boat.name} is ready at the dock.`);
        if (phase === "outbound" && (!prior || prior.phase === "docked") && !state.rentalStarts.has(rentalKey)) { state.rentalStarts.add(rentalKey); addActivity(`${guest.name} checked out ${boat.name} for ${guest.passengers}.`); }
        if (phase === "checkin" && prior && prior.phase !== "checkin") { addActivity(`${boat.name} returned; guest details cleared.`); state.lateBoats.delete(boat.id); }
        if ((phase === "docked" || phase === "checkin") && state.lateBoats.has(boat.id)) state.lateBoats.delete(boat.id);
        state.boats.set(boat.id, next);
    });
    maybeTriggerLateBoat();
}
function renderFleet() {
    const boats = [...state.boats.values()]; const underway = boats.filter(boat => boat.guest).length;
    elements.rentalCount.textContent = `${underway} underway`;
    elements.fleetList.innerHTML = boats.map(boat => {
        const manualRental = state.manualRentals.has(boat.id);
        const action = manualRental ? "check-in" : "check-out";
        const label = manualRental ? "Check in" : boat.guest ? "On lake" : "Check out";
        return `<tr class="${boat.id === state.selectedId ? "selected" : ""}" data-boat-id="${boat.id}"><td><button class="dock-action ${action === "check-in" ? "check-in" : ""}" data-action="${action}" data-boat-id="${boat.id}" type="button" ${boat.guest && !manualRental ? "disabled" : ""}>${label}</button></td><td><span class="boat-name">${boat.name.replace("Rowboat ", "")}</span><span class="boat-phase ${boat.late ? "late" : ""}">${boat.late ? "Running late" : PHASES[boat.phase].label}</span></td><td><i class="boat-status ${boat.guest ? "underway" : ""}"></i></td><td>${boat.guest ? boat.guest.name : "-"}</td><td>${boat.guest ? boat.guest.passengers : "-"}</td></tr>`;
    }).join("");
    elements.fleetList.querySelectorAll("tr").forEach(row => row.addEventListener("click", () => { state.selectedId = row.dataset.boatId; render(); map.flyTo(state.boats.get(state.selectedId).location, 15, { duration: .5 }); }));
    elements.fleetList.querySelectorAll(".dock-action").forEach(button => button.addEventListener("click", event => { event.stopPropagation(); if (button.dataset.action === "check-in") checkInBoat(button.dataset.boatId); else openRentalModal(button.dataset.boatId); }));
}
function renderMap() {
    state.boats.forEach(boat => {
        let marker = state.markers.get(boat.id);
        if (!marker) { marker = L.marker(boat.location, { icon: boatIcon(boat), riseOnHover: true }).addTo(map); marker.on("click", () => { state.selectedId = boat.id; render(); }); state.markers.set(boat.id, marker); }
        else marker.setLatLng(boat.location).setIcon(boatIcon(boat));
        const active = Boolean(boat.guest); let route = state.routeLayers.get(boat.id);
        if (active && !route) { route = L.polyline(boat.route, { color: "#4ee0b7", weight: 2, opacity: .7, className: "route-line" }).addTo(map); state.routeLayers.set(boat.id, route); }
        if (!active && route) { route.remove(); state.routeLayers.delete(boat.id); }
    });
    lucide.createIcons();
}
function renderDetails() {
    const boat = state.boats.get(state.selectedId); if (!boat) return;
    const guest = boat.guest;
    elements.selectedBoat.innerHTML = `<p class="eyebrow">${PHASES[boat.phase].label}</p><h3>${boat.name}</h3><p>${guest ? `${guest.name} · ${guest.passengers} passengers · ${guest.phone}` : "Docked and ready for the next rental."}</p><strong>${guest ? "TRACKING ACTIVE" : "TRACKING OFF"}</strong>`;
}
function renderActivity() { elements.activityList.innerHTML = state.activity.map(entry => `<li><span>${entry.message}</span><time>${formatClock(entry.at)}</time></li>`).join(""); elements.simulationTime.textContent = formatClock(state.elapsed); }
function formatClock(seconds) { const total = Math.floor(seconds * 2.5); return `${String(12 + Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function render() { renderFleet(); renderMap(); renderDetails(); renderActivity(); }
function checkoutDetailsAreComplete() {
    const renterName = document.getElementById("renterName").value.trim();
    const passengerCount = Number(document.getElementById("renterPassengers").value);
    return Boolean(renterName) && Number.isInteger(passengerCount) && passengerCount >= 1 && passengerCount <= 6 && document.getElementById("renterNdaSigned").checked;
}
function updateCheckoutEligibility() { elements.rentalConfirm.disabled = !checkoutDetailsAreComplete(); }
function closeRentalModal() { state.pendingBoatId = null; elements.rentalBackdrop.classList.add("hidden"); elements.rentalModal.classList.add("hidden"); }
function openRentalModal(boatId) {
    const boat = state.boats.get(boatId);
    if (!boat || boat.guest) return;
    state.pendingBoatId = boatId;
    document.getElementById("rentalTitle").textContent = `Check out ${boat.name}`;
    elements.rentalForm.reset();
    updateCheckoutEligibility();
    elements.rentalBackdrop.classList.remove("hidden");
    elements.rentalModal.classList.remove("hidden");
    document.getElementById("renterName").focus();
}
function checkInBoat(boatId) {
    const boat = state.boats.get(boatId); const rental = state.manualRentals.get(boatId);
    if (!boat || !rental) return;
    state.manualRentals.delete(boatId);
    addActivity(`${boat.name} checked in; ${rental.guest.name}'s details cleared.`);
    updateBoatStates();
    render();
}
function submitRental(event) {
    event.preventDefault();
    const boat = state.boats.get(state.pendingBoatId);
    if (!boat || !checkoutDetailsAreComplete()) return;
    const guest = { name: document.getElementById("renterName").value.trim(), passengers: Number(document.getElementById("renterPassengers").value), phone: document.getElementById("renterPhone").value.trim() || "No phone provided" };
    state.manualRentals.set(boat.id, { startedAt: state.elapsed, guest });
    state.selectedId = boat.id;
    addActivity(`${guest.name} checked out ${boat.name} for ${guest.passengers}.`);
    closeRentalModal();
    updateBoatStates();
    render();
    map.flyTo(state.boats.get(boat.id).location, 15, { duration: .5 });
}
function resetSimulation() { state.elapsed = 0; state.activity = []; state.rentalStarts.clear(); state.manualRentals.clear(); state.lateBoats.clear(); state.nextLateCheckAt = LATE_MIN_INTERVAL + Math.random() * (LATE_MAX_INTERVAL - LATE_MIN_INTERVAL); state.boats.clear(); updateBoatStates(); render(); }
function tick(now) {
    const elapsed = (now - state.lastTick) / 1000;
    state.lastTick = now;
    if (state.running) {
        state.elapsed += elapsed * state.speed;
        updateBoatStates();
        renderMap();
        if (Math.floor(state.elapsed) !== state.lastDisplaySecond) {
            state.lastDisplaySecond = Math.floor(state.elapsed);
            renderFleet();
            renderDetails();
            renderActivity();
        }
    }
    requestAnimationFrame(tick);
}

elements.toggle.addEventListener("click", () => { state.running = !state.running; elements.toggle.setAttribute("aria-label", state.running ? "Pause simulation" : "Resume simulation"); elements.toggle.title = state.running ? "Pause simulation" : "Resume simulation"; elements.toggle.innerHTML = `<i data-lucide="${state.running ? "pause" : "play"}"></i>`; lucide.createIcons(); });
elements.reset.addEventListener("click", resetSimulation);
elements.speed.addEventListener("input", event => { state.speed = Number(event.target.value); elements.speedValue.value = `${state.speed}x`; });
elements.rentalForm.addEventListener("submit", submitRental);
document.querySelectorAll("#renterName, #renterPassengers, #renterNdaSigned").forEach(input => input.addEventListener("input", updateCheckoutEligibility));
document.getElementById("renterNdaSigned").addEventListener("change", updateCheckoutEligibility);
document.getElementById("rentalClose").addEventListener("click", closeRentalModal);
document.getElementById("rentalCancel").addEventListener("click", closeRentalModal);
elements.rentalBackdrop.addEventListener("click", closeRentalModal);
updateBoatStates(); render(); lucide.createIcons(); requestAnimationFrame(tick);