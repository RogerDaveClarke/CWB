import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { collection, doc, getFirestore, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyYourActualAPIKeyHere...",
    authDomain: "your-project-id.firebaseapp.com",
    projectId: "your-project-id",
    storageBucket: "your-project-id.appspot.com",
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:abcdef123456"
};

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_LABELS = { monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday" };
const DEMO_STORAGE_KEY = "cwbAdminBoatConfiguration";
const currentYear = new Date().getFullYear();
const state = { boats: new Map(), editingId: null, search: "", year: currentYear, demoMode: false, auth: null, db: null, user: null, isAdmin: false };

const elements = {
    tableBody: document.getElementById("adminTableBody"),
    fleetCount: document.getElementById("fleetCount"),
    yearFilter: document.getElementById("yearFilter"),
    search: document.getElementById("adminSearch"),
    connection: document.getElementById("adminConnection"),
    signIn: document.getElementById("signInButton"),
    drawer: document.getElementById("boatDrawer"),
    backdrop: document.getElementById("drawerBackdrop"),
    form: document.getElementById("boatForm"),
    formMessage: document.getElementById("formMessage"),
    deviceId: document.getElementById("deviceId"),
    vesselName: document.getElementById("vesselName"),
    availability: document.getElementById("availability"),
    scheduleYear: document.getElementById("scheduleYear"),
    seasonStart: document.getElementById("seasonStart"),
    seasonEnd: document.getElementById("seasonEnd"),
    weeklySchedule: document.getElementById("weeklySchedule"),
    saveButton: document.getElementById("saveButton")
};

function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function defaultSchedule() {
    return Object.fromEntries(DAYS.map(day => [day, { enabled: day !== "monday", start: "12:30", end: "18:30" }]));
}

function fullYearRange(year) {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function normalizeBoat(id, raw = {}) {
    const year = Number(raw.schedule_year || currentYear);
    const range = fullYearRange(year);
    const incomingSchedule = raw.rental_schedule || {};
    const schedule = defaultSchedule();
    DAYS.forEach(day => {
        if (incomingSchedule[day]) schedule[day] = { ...schedule[day], ...incomingSchedule[day] };
    });
    return {
        id,
        vesselName: raw.vessel_name || id,
        availability: raw.availability_status === "under_repair" || raw.availability_status === "maintenance" ? "under_repair" : "available",
        scheduleYear: year,
        seasonStart: raw.rental_season_start || range.start,
        seasonEnd: raw.rental_season_end || range.end,
        schedule
    };
}

function makeDemoBoats() {
    const names = ["Rowboat Martha", "Rowboat Colleen", "Rowboat Virginia V", "Rowboat Blanchard", "Rowboat Wagner", "Rowboat Dearborn", "Rowboat Cascade", "Rowboat Fremont", "Rowboat Gas Works", "Rowboat Aurora"];
    return names.map((name, index) => normalizeBoat(`70b3d57ed${String(index + 1).padStart(7, "0")}`, {
        vessel_name: name,
        availability_status: index === 3 ? "under_repair" : "available",
        schedule_year: currentYear,
        rental_season_start: `${currentYear}-01-01`,
        rental_season_end: `${currentYear}-12-31`,
        rental_schedule: defaultSchedule()
    }));
}

function formatDate(value) {
    if (!value) return "—";
    const date = new Date(`${value}T12:00:00`);
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatTime(value) {
    if (!value) return "—";
    const [hour, minute] = value.split(":").map(Number);
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(2000, 0, 1, hour, minute));
}

function summarizeSchedule(schedule) {
    const groups = [];
    let active = null;
    DAYS.forEach((day, index) => {
        const window = schedule[day];
        const key = window.enabled ? `${window.start}-${window.end}` : "closed";
        if (active && active.key === key) active.end = index;
        else { active = { key, start: index, end: index, window }; groups.push(active); }
    });
    return groups.map(group => {
        const dayRange = group.start === group.end ? DAY_LABELS[DAYS[group.start]].slice(0, 3) : `${DAY_LABELS[DAYS[group.start]].slice(0, 3)}–${DAY_LABELS[DAYS[group.end]].slice(0, 3)}`;
        return group.key === "closed" ? `${dayRange} closed` : `${dayRange} ${formatTime(group.window.start)}–${formatTime(group.window.end)}`;
    }).join(" · ");
}

function setConnection(mode, label) {
    elements.connection.className = `connection-pill ${mode}`;
    elements.connection.innerHTML = `<span class="status-dot"></span><span class="hidden sm:inline">${escapeHtml(label)}</span>`;
}

function renderTable() {
    const boats = [...state.boats.values()].filter(boat => boat.scheduleYear === state.year && `${boat.id} ${boat.vesselName}`.toLowerCase().includes(state.search));
    elements.fleetCount.textContent = `${boats.length} ${boats.length === 1 ? "boat" : "boats"}`;
    if (!boats.length) {
        elements.tableBody.innerHTML = `<tr><td colspan="7" class="empty-cell">No boats match this year and search.</td></tr>`;
        return;
    }
    elements.tableBody.innerHTML = boats.map(boat => `<tr>
        <td><span class="data-value">${escapeHtml(boat.id)}</span></td>
        <td><span class="vessel-name">${escapeHtml(boat.vesselName)}</span></td>
        <td><span class="data-value">${boat.scheduleYear}</span></td>
        <td><span class="data-value">${formatDate(boat.seasonStart)}</span><span class="cell-note">through ${formatDate(boat.seasonEnd)}</span></td>
        <td><span class="schedule-summary">${escapeHtml(summarizeSchedule(boat.schedule))}</span></td>
        <td><span class="availability-value ${boat.availability === "under_repair" ? "repair" : ""}">${boat.availability === "under_repair" ? "Under Repair" : "Yes"}</span></td>
        <td><div class="row-actions"><button class="icon-button edit-boat" type="button" data-boat-id="${escapeHtml(boat.id)}" title="Edit ${escapeHtml(boat.vesselName)}" aria-label="Edit ${escapeHtml(boat.vesselName)}"><i data-lucide="pencil" class="h-4 w-4"></i></button></div></td>
    </tr>`).join("");
    elements.tableBody.querySelectorAll(".edit-boat").forEach(button => button.addEventListener("click", () => openDrawer(state.boats.get(button.dataset.boatId))));
    lucide.createIcons();
}

function buildScheduleEditor(schedule = defaultSchedule()) {
    elements.weeklySchedule.innerHTML = DAYS.map(day => {
        const window = schedule[day];
        return `<div class="schedule-row" data-day="${day}">
            <label class="day-toggle"><input class="day-enabled" type="checkbox" ${window.enabled ? "checked" : ""}><span>${DAY_LABELS[day]}</span></label>
            <input class="schedule-time day-start" type="time" value="${window.start}" aria-label="${DAY_LABELS[day]} start time" ${window.enabled ? "" : "disabled"}>
            <input class="schedule-time day-end" type="time" value="${window.end}" aria-label="${DAY_LABELS[day]} end time" ${window.enabled ? "" : "disabled"}>
        </div>`;
    }).join("");
    elements.weeklySchedule.querySelectorAll(".day-enabled").forEach(toggle => toggle.addEventListener("change", event => {
        event.target.closest(".schedule-row").querySelectorAll(".schedule-time").forEach(input => { input.disabled = !event.target.checked; });
    }));
}

function openDrawer(boat = null) {
    state.editingId = boat?.id || null;
    const year = boat?.scheduleYear || state.year;
    const range = fullYearRange(year);
    document.getElementById("drawerTitle").textContent = boat ? `Edit ${boat.vesselName}` : "Add boat";
    elements.deviceId.value = boat?.id || "";
    elements.deviceId.disabled = Boolean(boat);
    elements.vesselName.value = boat?.vesselName || "";
    elements.availability.value = boat?.availability || "available";
    elements.scheduleYear.value = year;
    elements.seasonStart.value = boat?.seasonStart || range.start;
    elements.seasonEnd.value = boat?.seasonEnd || range.end;
    buildScheduleEditor(boat?.schedule || defaultSchedule());
    hideMessage();
    elements.backdrop.classList.remove("hidden");
    elements.drawer.classList.add("open");
    elements.drawer.setAttribute("aria-hidden", "false");
    setTimeout(() => (boat ? elements.vesselName : elements.deviceId).focus(), 50);
}

function closeDrawer() {
    elements.drawer.classList.remove("open");
    elements.drawer.setAttribute("aria-hidden", "true");
    elements.backdrop.classList.add("hidden");
    state.editingId = null;
}

function readSchedule() {
    const schedule = {};
    elements.weeklySchedule.querySelectorAll(".schedule-row").forEach(row => {
        schedule[row.dataset.day] = { enabled: row.querySelector(".day-enabled").checked, start: row.querySelector(".day-start").value, end: row.querySelector(".day-end").value };
    });
    return schedule;
}

function validateForm(config) {
    if (!/^[0-9a-f]{16}$/.test(config.id)) return "Device ID must contain exactly 16 hexadecimal characters.";
    if (!config.vesselName.trim()) return "Boat name is required.";
    if (!config.seasonStart || !config.seasonEnd || config.seasonStart > config.seasonEnd) return "Rental end date must be on or after the start date.";
    if (!config.seasonStart.startsWith(String(config.scheduleYear)) || !config.seasonEnd.startsWith(String(config.scheduleYear))) return "Rental dates must be within the selected schedule year.";
    const openDays = Object.entries(config.schedule).filter(([, window]) => window.enabled);
    if (!openDays.length) return "At least one day must be open for rentals.";
    const invalidWindow = openDays.find(([, window]) => !window.start || !window.end || window.start >= window.end);
    if (invalidWindow) return `${DAY_LABELS[invalidWindow[0]]} must have an end time after its start time.`;
    return null;
}

function showMessage(message, success = false) {
    elements.formMessage.textContent = message;
    elements.formMessage.className = `form-message ${success ? "success" : ""}`;
}
function hideMessage() { elements.formMessage.className = "form-message hidden"; elements.formMessage.textContent = ""; }

function configFromForm() {
    return {
        id: elements.deviceId.value.trim().toLowerCase(),
        vesselName: elements.vesselName.value.trim(),
        availability: elements.availability.value,
        scheduleYear: Number(elements.scheduleYear.value),
        seasonStart: elements.seasonStart.value,
        seasonEnd: elements.seasonEnd.value,
        schedule: readSchedule()
    };
}

async function saveBoat(config) {
    const payload = {
        device_id: config.id,
        vessel_name: config.vesselName,
        availability_status: config.availability,
        schedule_year: config.scheduleYear,
        rental_season_start: config.seasonStart,
        rental_season_end: config.seasonEnd,
        rental_schedule: config.schedule
    };
    if (state.demoMode) {
        state.boats.set(config.id, normalizeBoat(config.id, payload));
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify([...state.boats.values()]));
        renderTable();
        return;
    }
    if (!state.user || !state.isAdmin) throw new Error("Sign in with a Firebase account that has the admin custom claim.");
    await setDoc(doc(state.db, "boats", config.id), { ...payload, configuration_updated_at: serverTimestamp() }, { merge: true });
}

function restoreDemoBoats() {
    try {
        const saved = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY) || "null");
        if (Array.isArray(saved) && saved.length) return saved.map(boat => normalizeBoat(boat.id, { vessel_name: boat.vesselName, availability_status: boat.availability, schedule_year: boat.scheduleYear, rental_season_start: boat.seasonStart, rental_season_end: boat.seasonEnd, rental_schedule: boat.schedule }));
    } catch (error) { console.warn("Ignoring invalid saved demo configuration", error); }
    return makeDemoBoats();
}

function startDemo() {
    state.demoMode = true;
    state.isAdmin = true;
    state.boats = new Map(restoreDemoBoats().map(boat => [boat.id, boat]));
    elements.signIn.disabled = true;
    elements.signIn.innerHTML = `<i data-lucide="database" class="h-4 w-4"></i><span>Demo mode</span>`;
    setConnection("live", "Local demo");
    renderTable();
    lucide.createIcons();
}

function updateAuth(user, isAdmin) {
    state.user = user;
    state.isAdmin = isAdmin;
    if (user) {
        elements.signIn.innerHTML = `<i data-lucide="log-out" class="h-4 w-4"></i><span>${escapeHtml(user.displayName || user.email || "Sign out")}</span>`;
        setConnection(isAdmin ? "live" : "error", isAdmin ? "Admin access" : "Read only");
    } else {
        elements.signIn.innerHTML = `<i data-lucide="log-in" class="h-4 w-4"></i><span>Sign in</span>`;
        setConnection("", "Read only");
    }
    lucide.createIcons();
}

function startFirebase() {
    if (!firebaseConfig.projectId || firebaseConfig.projectId.startsWith("your-")) { startDemo(); return; }
    const app = initializeApp(firebaseConfig);
    state.db = getFirestore(app);
    state.auth = getAuth(app);
    onAuthStateChanged(state.auth, async user => {
        const token = user ? await user.getIdTokenResult(true) : null;
        updateAuth(user, Boolean(token?.claims?.admin));
    });
    onSnapshot(collection(state.db, "boats"), snapshot => {
        state.boats = new Map(snapshot.docs.map(document => [document.id, normalizeBoat(document.id, document.data())]));
        setConnection(state.isAdmin ? "live" : "", state.isAdmin ? "Admin access" : "Read only");
        renderTable();
    }, error => {
        console.error("Unable to load boat configuration", error);
        setConnection("error", "Load failed");
        elements.tableBody.innerHTML = `<tr><td colspan="7" class="empty-cell">Unable to load boat configuration.</td></tr>`;
    });
}

function setupControls() {
    for (let year = currentYear - 1; year <= currentYear + 5; year += 1) elements.yearFilter.add(new Option(String(year), String(year), year === currentYear, year === currentYear));
    elements.yearFilter.addEventListener("change", event => { state.year = Number(event.target.value); renderTable(); });
    elements.search.addEventListener("input", event => { state.search = event.target.value.trim().toLowerCase(); renderTable(); });
    document.getElementById("addBoatButton").addEventListener("click", () => openDrawer());
    document.getElementById("closeDrawerButton").addEventListener("click", closeDrawer);
    document.getElementById("cancelButton").addEventListener("click", closeDrawer);
    elements.backdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", event => { if (event.key === "Escape" && elements.drawer.classList.contains("open")) closeDrawer(); });
    document.getElementById("themeToggle").addEventListener("click", () => document.documentElement.classList.toggle("dark"));
    document.getElementById("applyToOpenDays").addEventListener("click", () => {
        const tuesday = elements.weeklySchedule.querySelector('[data-day="tuesday"]');
        const start = tuesday.querySelector(".day-start").value;
        const end = tuesday.querySelector(".day-end").value;
        elements.weeklySchedule.querySelectorAll(".schedule-row").forEach(row => { if (row.querySelector(".day-enabled").checked) { row.querySelector(".day-start").value = start; row.querySelector(".day-end").value = end; } });
    });
    elements.scheduleYear.addEventListener("change", () => { const range = fullYearRange(Number(elements.scheduleYear.value)); elements.seasonStart.value = range.start; elements.seasonEnd.value = range.end; });
    elements.signIn.addEventListener("click", async () => {
        if (state.demoMode) return;
        try { if (state.user) await signOut(state.auth); else await signInWithPopup(state.auth, new GoogleAuthProvider()); }
        catch (error) { console.error("Authentication failed", error); setConnection("error", "Sign-in failed"); }
    });
    elements.form.addEventListener("submit", async event => {
        event.preventDefault();
        const config = configFromForm();
        const validationError = validateForm(config);
        if (validationError) { showMessage(validationError); return; }
        elements.saveButton.disabled = true;
        elements.saveButton.querySelector("span").textContent = "Saving…";
        try { await saveBoat(config); showMessage("Boat configuration saved.", true); setTimeout(closeDrawer, 450); }
        catch (error) { console.error("Unable to save boat", error); showMessage(error.message || "Unable to save boat configuration."); }
        finally { elements.saveButton.disabled = false; elements.saveButton.querySelector("span").textContent = "Save boat"; }
    });
}

setupControls();
buildScheduleEditor();
lucide.createIcons();
startFirebase();
