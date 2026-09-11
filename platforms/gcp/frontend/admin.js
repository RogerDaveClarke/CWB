import { firebaseConfig } from "./firebase-config.js";
import { initAuthGuard, signOut, showAuthModal, isConfigValid, getFirebase } from "./auth-guard.js";
import { collection, deleteDoc, doc, getDocs, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_LABELS = { monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday" };
const MONTH_LABELS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DEMO_STORAGE_KEY = "cwbAdminBoatConfiguration";
const DEMO_BOAT_TYPES_KEY = "cwbAdminBoatTypes";
const DEMO_CLOSURE_KEY = "cwbAdminLiveryClosure";
const DEFAULT_BOAT_TYPES = ["Row", "Capri 22", "Capri 14"];
// Livery closes for the winter off-season; recurring annually (month-day).
const DEFAULT_CLOSURE = { enabled: true, start: "10-15", end: "03-15" };
const currentYear = new Date().getFullYear();
const state = { boats: new Map(), boatTypes: [], closure: { ...DEFAULT_CLOSURE }, editingId: null, search: "", year: currentYear, demoMode: false, auth: null, db: null, user: null, isAdmin: false };

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
    boatType: document.getElementById("boatType"),
    availability: document.getElementById("availability"),
    reportIntervalMinutes: document.getElementById("reportIntervalMinutes"),
    scheduleYear: document.getElementById("scheduleYear"),
    seasonStart: document.getElementById("seasonStart"),
    seasonEnd: document.getElementById("seasonEnd"),
    weeklySchedule: document.getElementById("weeklySchedule"),
    deleteButton: document.getElementById("deleteBoatButton"),
    saveButton: document.getElementById("saveButton"),
    updateTrackerButton: document.getElementById("updateTrackerButton"),
    closureEnabled: document.getElementById("closureEnabled"),
    closureStartMonth: document.getElementById("closureStartMonth"),
    closureStartDay: document.getElementById("closureStartDay"),
    closureEndMonth: document.getElementById("closureEndMonth"),
    closureEndDay: document.getElementById("closureEndDay"),
    saveClosureButton: document.getElementById("saveClosureButton")
};

function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function defaultSchedule() {
    return Object.fromEntries(DAYS.map(day => [day, { enabled: day !== "monday", start: "12:30", end: "18:30" }]));
}

function defaultBoatTypes() {
    return DEFAULT_BOAT_TYPES.map(name => ({ id: name.toLowerCase().replaceAll(" ", "-"), name }));
}

function restoreDemoBoatTypes() {
    try {
        const saved = JSON.parse(localStorage.getItem(DEMO_BOAT_TYPES_KEY) || "null");
        if (Array.isArray(saved) && saved.every(type => type && typeof type.id === "string" && typeof type.name === "string")) return saved;
    } catch (error) { console.warn("Ignoring invalid saved boat types", error); }
    return defaultBoatTypes();
}

function saveDemoBoatTypes() {
    localStorage.setItem(DEMO_BOAT_TYPES_KEY, JSON.stringify(state.boatTypes));
}

function renderBoatTypeOptions(selectedType) {
    const selected = selectedType || elements.boatType.value || state.boatTypes[0]?.name || "";
    const types = state.boatTypes.some(type => type.name === selected) ? state.boatTypes : [...state.boatTypes, { id: "current", name: selected }];
    elements.boatType.replaceChildren(...types.map(type => {
        const option = document.createElement("option");
        option.value = type.name;
        option.textContent = type.name;
        option.selected = type.name === selected;
        return option;
    }));
}

function selectedBoatType() {
    return state.boatTypes.find(type => type.name === elements.boatType.value) || null;
}

function validateBoatTypeName(name, exceptId = "") {
    const normalized = name.trim();
    if (!normalized) return "Boat type is required.";
    if (state.boatTypes.some(type => type.id !== exceptId && type.name.toLowerCase() === normalized.toLowerCase())) return "Boat type names must be unique.";
    return null;
}

async function addBoatType() {
    const name = window.prompt("New boat type name:");
    if (name == null) return;
    const validationError = validateBoatTypeName(name);
    if (validationError) { showMessage(validationError); return; }
    const type = { id: crypto.randomUUID(), name: name.trim() };
    try {
        if (!state.demoMode) await setDoc(doc(state.db, "boat_types", type.id), { name: type.name });
        state.boatTypes.push(type);
        if (state.demoMode) saveDemoBoatTypes();
        renderBoatTypeOptions(type.name);
        hideMessage();
    } catch (error) {
        console.error("Unable to add boat type", error);
        showMessage(error.message || "Unable to add boat type.");
    }
}

async function renameBoatType() {
    const type = selectedBoatType();
    if (!type) { showMessage("Select a boat type to rename."); return; }
    const name = window.prompt(`Rename boat type "${type.name}" to:`, type.name);
    if (name == null || name.trim() === type.name) return;
    const validationError = validateBoatTypeName(name, type.id);
    if (validationError) { showMessage(validationError); return; }
    const oldName = type.name;
    const newName = name.trim();
    try {
        type.name = newName;
        state.boats.forEach(boat => { if (boat.boatType === oldName) boat.boatType = newName; });
        if (state.demoMode) {
            localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify([...state.boats.values()]));
            saveDemoBoatTypes();
        } else {
            await setDoc(doc(state.db, "boat_types", type.id), { name: newName });
            await Promise.all([...state.boats.values()].filter(boat => boat.boatType === newName).map(boat => setDoc(doc(state.db, "boats", boat.id), { boat_type: newName, configuration_updated_at: serverTimestamp() }, { merge: true })));
        }
        renderTable();
        renderBoatTypeOptions(newName);
        hideMessage();
    } catch (error) {
        console.error("Unable to rename boat type", error);
        showMessage(error.message || "Unable to rename boat type.");
    }
}

async function removeBoatType() {
    const type = selectedBoatType();
    if (!type) { showMessage("Select a boat type to delete."); return; }
    if ([...state.boats.values()].some(boat => boat.boatType === type.name)) { showMessage(`Assign boats using ${type.name} to another type before removing it.`); return; }
    if (!window.confirm(`Delete boat type "${type.name}"?`)) return;
    try {
        if (!state.demoMode) await deleteDoc(doc(state.db, "boat_types", type.id));
        state.boatTypes = state.boatTypes.filter(item => item.id !== type.id);
        if (state.demoMode) saveDemoBoatTypes();
        renderBoatTypeOptions(state.boatTypes[0]?.name || "");
        hideMessage();
    } catch (error) {
        console.error("Unable to delete boat type", error);
        showMessage(error.message || "Unable to delete boat type.");
    }
}

function fullYearRange(year) {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
}

// Device IDs are generated by the system, never typed by hand. 8 random bytes
// rendered as 16 lowercase hex characters, matching the DevEUI format the
// telemetry ingest keys on.
function randomDeviceId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// ---- Livery closure (annual off-season, e.g. Oct 15 – Mar 15) ----

function parseMonthDay(value, fallback) {
    const match = /^(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return fallback;
    const month = Number(match[1]), day = Number(match[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return fallback;
    return { month, day };
}

function normalizeClosure(raw = {}) {
    const start = parseMonthDay(raw.closure_start ?? raw.start, parseMonthDay(DEFAULT_CLOSURE.start));
    const end = parseMonthDay(raw.closure_end ?? raw.end, parseMonthDay(DEFAULT_CLOSURE.end));
    return {
        enabled: (raw.closure_enabled ?? raw.enabled) !== false,
        start: `${String(start.month).padStart(2, "0")}-${String(start.day).padStart(2, "0")}`,
        end: `${String(end.month).padStart(2, "0")}-${String(end.day).padStart(2, "0")}`
    };
}

function renderClosure() {
    const start = parseMonthDay(state.closure.start, parseMonthDay(DEFAULT_CLOSURE.start));
    const end = parseMonthDay(state.closure.end, parseMonthDay(DEFAULT_CLOSURE.end));
    elements.closureEnabled.checked = state.closure.enabled;
    elements.closureStartMonth.value = String(start.month);
    elements.closureStartDay.value = String(start.day);
    elements.closureEndMonth.value = String(end.month);
    elements.closureEndDay.value = String(end.day);
}

function closureFromControls() {
    const startMonth = Number(elements.closureStartMonth.value);
    const startDay = Number(elements.closureStartDay.value);
    const endMonth = Number(elements.closureEndMonth.value);
    const endDay = Number(elements.closureEndDay.value);
    const daysIn = month => [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    if (!Number.isInteger(startDay) || startDay < 1 || startDay > daysIn(startMonth)) return { error: `Closure start day must be 1–${daysIn(startMonth)} for ${MONTH_LABELS[startMonth - 1]}.` };
    if (!Number.isInteger(endDay) || endDay < 1 || endDay > daysIn(endMonth)) return { error: `Closure end day must be 1–${daysIn(endMonth)} for ${MONTH_LABELS[endMonth - 1]}.` };
    return {
        closure: {
            enabled: elements.closureEnabled.checked,
            start: `${String(startMonth).padStart(2, "0")}-${String(startDay).padStart(2, "0")}`,
            end: `${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`
        }
    };
}

async function saveClosure() {
    const { closure, error } = closureFromControls();
    if (error) { window.alert(error); return; }
    elements.saveClosureButton.disabled = true;
    try {
        state.closure = closure;
        if (state.demoMode) {
            localStorage.setItem(DEMO_CLOSURE_KEY, JSON.stringify(closure));
        } else {
            if (!state.user || !state.isAdmin) throw new Error("Sign in with an Administrator account to save the livery closure.");
            await setDoc(doc(state.db, "fleet_config", "livery"), {
                closure_enabled: closure.enabled,
                closure_start: closure.start,
                closure_end: closure.end,
                updated_at: serverTimestamp()
            });
        }
        renderClosure();
    } catch (error) {
        console.error("Unable to save livery closure", error);
        window.alert(error.message || "Unable to save livery closure.");
    } finally {
        elements.saveClosureButton.disabled = false;
    }
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
        boatType: String(raw.boat_type || "Row"),
        availability: raw.availability_status === "under_repair" || raw.availability_status === "maintenance" ? "under_repair" : "available",
        activeRental: raw.tracking_enabled === true || raw.availability_status === "rented",
        reportIntervalMinutes: Number(raw.report_interval_minutes ?? 3),
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
        boat_type: "Row",
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
        elements.tableBody.innerHTML = `<tr><td colspan="9" class="empty-cell">No boats match this year and search.</td></tr>`;
        return;
    }
    const textCell = (value, className = "data-value") => {
        const cell = document.createElement("td");
        const span = document.createElement("span");
        span.className = className;
        span.textContent = String(value ?? "");
        cell.appendChild(span);
        return cell;
    };
    elements.tableBody.replaceChildren(...boats.map(boat => {
        const row = document.createElement("tr");
        row.append(
            textCell(boat.id),
            textCell(boat.vesselName, "vessel-name"),
            textCell(boat.boatType),
            textCell(`${boat.reportIntervalMinutes} min`),
            textCell(boat.scheduleYear)
        );

        const seasonCell = document.createElement("td");
        const seasonStart = document.createElement("span");
        seasonStart.className = "data-value";
        seasonStart.textContent = formatDate(boat.seasonStart);
        const seasonEnd = document.createElement("span");
        seasonEnd.className = "cell-note";
        seasonEnd.textContent = `through ${formatDate(boat.seasonEnd)}`;
        seasonCell.append(seasonStart, seasonEnd);
        row.appendChild(seasonCell);
        row.appendChild(textCell(summarizeSchedule(boat.schedule), "schedule-summary"));

        const availabilityCell = textCell(boat.availability === "under_repair" ? "Under Repair" : "Yes", `availability-value ${boat.availability === "under_repair" ? "repair" : ""}`.trim());
        row.appendChild(availabilityCell);

        const actionCell = document.createElement("td");
        const actions = document.createElement("div");
        actions.className = "row-actions";
        const button = document.createElement("button");
        button.className = "icon-button edit-boat";
        button.type = "button";
        button.dataset.boatId = boat.id;
        button.title = `Edit ${boat.vesselName}`;
        button.setAttribute("aria-label", `Edit ${boat.vesselName}`);
        const icon = document.createElement("i");
        icon.dataset.lucide = "pencil";
        icon.className = "h-4 w-4";
        button.appendChild(icon);
        actions.appendChild(button);
        actionCell.appendChild(actions);
        row.appendChild(actionCell);
        return row;
    }));
    elements.tableBody.querySelectorAll(".edit-boat").forEach(button => button.addEventListener("click", () => openDrawer(state.boats.get(button.dataset.boatId))));
    lucide.createIcons();
}

function buildScheduleEditor(schedule = defaultSchedule()) {
    elements.weeklySchedule.replaceChildren(...DAYS.map(day => {
        const window = schedule[day];
        const row = document.createElement("div");
        row.className = "schedule-row";
        row.dataset.day = day;
        const label = document.createElement("label");
        label.className = "day-toggle";
        const enabled = document.createElement("input");
        enabled.className = "day-enabled";
        enabled.type = "checkbox";
        enabled.checked = Boolean(window.enabled);
        const dayLabel = document.createElement("span");
        dayLabel.textContent = DAY_LABELS[day];
        label.append(enabled, dayLabel);

        const timeInput = (className, value, suffix) => {
            const input = document.createElement("input");
            input.className = `schedule-time ${className}`;
            input.type = "time";
            input.value = String(value || "");
            input.setAttribute("aria-label", `${DAY_LABELS[day]} ${suffix} time`);
            input.disabled = !window.enabled;
            return input;
        };
        row.append(label, timeInput("day-start", window.start, "start"), timeInput("day-end", window.end, "end"));
        return row;
    }));
    elements.weeklySchedule.querySelectorAll(".day-enabled").forEach(toggle => toggle.addEventListener("change", event => {
        event.target.closest(".schedule-row").querySelectorAll(".schedule-time").forEach(input => { input.disabled = !event.target.checked; });
    }));
}

function openDrawer(boat = null) {
    state.editingId = boat?.id || null;
    const year = boat?.scheduleYear || state.year;
    const range = fullYearRange(year);
    document.getElementById("drawerTitle").textContent = boat ? `Edit ${boat.vesselName}` : "Add boat";
    elements.deviceId.value = boat?.id || randomDeviceId();
    elements.vesselName.value = boat?.vesselName || "";
    renderBoatTypeOptions(boat?.boatType);
    elements.availability.value = boat?.availability || "available";
    elements.reportIntervalMinutes.value = boat?.reportIntervalMinutes || 3;
    elements.scheduleYear.value = year;
    elements.seasonStart.value = boat?.seasonStart || range.start;
    elements.seasonEnd.value = boat?.seasonEnd || range.end;
    elements.deleteButton.classList.toggle("hidden", !boat);
    buildScheduleEditor(boat?.schedule || defaultSchedule());
    hideMessage();
    elements.backdrop.classList.remove("hidden");
    elements.drawer.classList.add("open");
    elements.drawer.setAttribute("aria-hidden", "false");
    setTimeout(() => elements.vesselName.focus(), 50);
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
    if (!Number.isInteger(config.reportIntervalMinutes) || config.reportIntervalMinutes < 1 || config.reportIntervalMinutes > 60) return "Reporting interval must be a whole number from 1 to 60 minutes.";
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
        boatType: elements.boatType.value,
        availability: elements.availability.value,
        reportIntervalMinutes: Number(elements.reportIntervalMinutes.value),
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
        boat_type: config.boatType,
        availability_status: config.availability,
        report_interval_minutes: config.reportIntervalMinutes,
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

// Queue a configuration downlink to the boat's tracker through the LoRaWAN
// gateway (ChirpStack). The device applies Device ID, name, type, availability,
// reporting interval, rental range, and weekly rental hours on receipt.
async function pushTrackerConfig() {
    const config = configFromForm();
    const validationError = validateForm(config);
    if (validationError) { showMessage(validationError); return; }
    if (state.demoMode) { showMessage("Demo mode: no LoRaWAN gateway is connected."); return; }
    if (!state.user || !state.isAdmin) { showMessage("Sign in with an Administrator account to update trackers."); return; }

    elements.updateTrackerButton.disabled = true;
    elements.updateTrackerButton.querySelector("span").textContent = "Sending…";
    try {
        const { functions, functionsModule } = await getFirebase();
        const result = await functionsModule.httpsCallable(functions, "pushBoatConfig")(config);
        showMessage(`Tracker update queued for ${config.id} (${result.data?.bytes ?? "?"} bytes). The device applies it at its next downlink window.`, true);
    } catch (error) {
        console.error("pushBoatConfig failed", error);
        showMessage(error.message || "Unable to send tracker update.");
    } finally {
        elements.updateTrackerButton.disabled = false;
        elements.updateTrackerButton.querySelector("span").textContent = "Update Boat Tracker";
    }
}

async function deleteBoat() {
    const boat = state.boats.get(state.editingId);
    if (!boat) return;
    if (boat.activeRental) { showMessage("Check in this boat before deleting it."); return; }
    if (!window.confirm(`Delete ${boat.vesselName}? This permanently deletes its configuration, latest telemetry, and any GPS history. Completed rental history is retained.`)) return;

    elements.deleteButton.disabled = true;
    elements.saveButton.disabled = true;
    elements.deleteButton.querySelector("span").textContent = "Deleting…";
    try {
        if (state.demoMode) {
            state.boats.delete(boat.id);
            localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify([...state.boats.values()]));
            renderTable();
        } else {
            if (!state.user || !state.isAdmin) throw new Error("Sign in with a Firebase account that has the admin custom claim.");
            const history = await getDocs(collection(state.db, "boats", boat.id, "history"));
            await Promise.all(history.docs.map(entry => deleteDoc(entry.ref)));
            await deleteDoc(doc(state.db, "boats", boat.id));
        }
        closeDrawer();
    } catch (error) {
        console.error("Unable to delete boat", error);
        showMessage(error.message || "Unable to delete boat.");
    } finally {
        elements.deleteButton.disabled = false;
        elements.saveButton.disabled = false;
        elements.deleteButton.querySelector("span").textContent = "Delete boat";
    }
}

function restoreDemoBoats() {
    try {
        const saved = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY) || "null");
        if (Array.isArray(saved)) return saved.map(boat => normalizeBoat(boat.id, { vessel_name: boat.vesselName, boat_type: boat.boatType, availability_status: boat.availability, report_interval_minutes: boat.reportIntervalMinutes, schedule_year: boat.scheduleYear, rental_season_start: boat.seasonStart, rental_season_end: boat.seasonEnd, rental_schedule: boat.schedule }));
    } catch (error) { console.warn("Ignoring invalid saved demo configuration", error); }
    return makeDemoBoats();
}

function startDemo() {
    state.demoMode = true;
    state.isAdmin = true;
    state.boatTypes = restoreDemoBoatTypes();
    state.boats = new Map(restoreDemoBoats().map(boat => [boat.id, boat]));
    try {
        const savedClosure = JSON.parse(localStorage.getItem(DEMO_CLOSURE_KEY) || "null");
        if (savedClosure) state.closure = normalizeClosure(savedClosure);
    } catch (error) { console.warn("Ignoring invalid saved livery closure", error); }
    renderClosure();
    elements.signIn.disabled = true;
    elements.signIn.innerHTML = `<i data-lucide="database" class="h-4 w-4"></i><span>Demo mode</span>`;
    setConnection("live", "Local demo");
    renderTable();
    renderBoatTypeOptions();
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

async function startFirebase() {
    if (!isConfigValid()) {
        setConnection("error", "Not configured");
        showAuthModal("error", { message: "Firebase configuration missing. Please contact administrator." });
        return;
    }
    try {
        await initAuthGuard({ requireAdmin: true }, {
            onReady: ({ user, claims, db }) => {
                state.db = db;
                state.user = user;
                state.isAdmin = claims.isAdmin;
                updateAuth(user, true);

                onSnapshot(collection(state.db, "boats"), snapshot => {
                    if (snapshot.empty) {
                        state.boats.clear();
                        renderTable();
                        return;
                    }
                    state.boats = new Map(snapshot.docs.map(document => [document.id, normalizeBoat(document.id, document.data())]));
                    setConnection(state.isAdmin ? "live" : "", state.isAdmin ? "Admin access" : "Read only");
                    renderTable();
                }, error => {
                    console.error("Unable to load boat configuration", error);
                    setConnection("error", "Access denied");
                    elements.tableBody.innerHTML = `<tr><td colspan="9" class="empty-cell">Unable to load boat configuration. Sign in with an Administrator account.</td></tr>`;
                });

                onSnapshot(collection(state.db, "boat_types"), snapshot => {
                    const types = snapshot.docs.map(document => ({ id: document.id, name: String(document.data().name || "").trim() })).filter(type => type.name);
                    if (types.length) state.boatTypes = types;
                    renderBoatTypeOptions();
                });

                onSnapshot(doc(state.db, "fleet_config", "livery"), snapshot => {
                    if (snapshot.exists()) {
                        state.closure = normalizeClosure(snapshot.data());
                        renderClosure();
                    }
                }, error => console.warn("Unable to load livery closure configuration", error));
            },
            onDenied: () => {
                updateAuth(null, false);
                elements.tableBody.innerHTML = `<tr><td colspan="9" class="empty-cell">Sign in with an Administrator account required.</td></tr>`;
            },
            onSignedOut: () => {
                updateAuth(null, false);
                elements.tableBody.innerHTML = `<tr><td colspan="9" class="empty-cell">Sign in with an Administrator account required.</td></tr>`;
            }
        });
    } catch (error) {
        console.error("Firebase initialization failed", error);
        setConnection("error", "Configuration error");
    }
}

function setupControls() {
    for (let year = currentYear - 1; year <= currentYear + 5; year += 1) elements.yearFilter.add(new Option(String(year), String(year), year === currentYear, year === currentYear));
    MONTH_LABELS.forEach((label, index) => {
        elements.closureStartMonth.add(new Option(label, String(index + 1)));
        elements.closureEndMonth.add(new Option(label, String(index + 1)));
    });
    elements.saveClosureButton.addEventListener("click", saveClosure);
    renderClosure();
    elements.yearFilter.addEventListener("change", event => { state.year = Number(event.target.value); renderTable(); });
    elements.search.addEventListener("input", event => { state.search = event.target.value.trim().toLowerCase(); renderTable(); });
    document.getElementById("addBoatButton").addEventListener("click", () => openDrawer());
    document.getElementById("addBoatTypeButton").addEventListener("click", addBoatType);
    document.getElementById("renameBoatTypeButton").addEventListener("click", renameBoatType);
    document.getElementById("removeBoatTypeButton").addEventListener("click", removeBoatType);
    elements.updateTrackerButton.addEventListener("click", pushTrackerConfig);
    elements.deleteButton.addEventListener("click", deleteBoat);
    document.getElementById("closeDrawerButton").addEventListener("click", closeDrawer);
    document.getElementById("cancelButton").addEventListener("click", closeDrawer);
    elements.backdrop.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", event => { if (event.key === "Escape" && elements.drawer.classList.contains("open")) closeDrawer(); });
    document.getElementById("applyToOpenDays").addEventListener("click", () => {
        const tuesday = elements.weeklySchedule.querySelector('[data-day="tuesday"]');
        const start = tuesday.querySelector(".day-start").value;
        const end = tuesday.querySelector(".day-end").value;
        elements.weeklySchedule.querySelectorAll(".schedule-row").forEach(row => { if (row.querySelector(".day-enabled").checked) { row.querySelector(".day-start").value = start; row.querySelector(".day-end").value = end; } });
    });
    elements.scheduleYear.addEventListener("change", () => { const range = fullYearRange(Number(elements.scheduleYear.value)); elements.seasonStart.value = range.start; elements.seasonEnd.value = range.end; });
    elements.signIn.addEventListener("click", async () => {
        if (state.user) await signOut(); else showAuthModal("signIn");
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
state.boatTypes = defaultBoatTypes();
renderBoatTypeOptions();
lucide.createIcons();
startFirebase();
