import { initHeaderControls } from "./header-nav.js";

const BOATS = [
    { id: "martha", name: "Rowboat Martha", type: "Row", capacity: 6 },
    { id: "colleen", name: "Rowboat Colleen", type: "Row", capacity: 6 },
    { id: "virginia", name: "Rowboat Virginia V", type: "Row", capacity: 6 },
    { id: "wagner", name: "Rowboat Wagner", type: "Row", capacity: 6 },
    { id: "dearborn", name: "Rowboat Dearborn", type: "Row", capacity: 6 },
    { id: "cascade", name: "Rowboat Cascade", type: "Row", capacity: 6 },
    { id: "fremont", name: "Rowboat Fremont", type: "Row", capacity: 6 },
    { id: "aurora", name: "Rowboat Aurora", type: "Row", capacity: 6 }
];

function minutesFromNow(minutes) { return new Date(Date.now() + minutes * 60000); }
function initialEvents() {
    return [
        {
            id: "spring-fling", name: "Spring Fling Regatta", type: "Regatta", status: "active", startsAt: minutesFromNow(-75), defaultDuration: 60,
            boats: {
                martha: { status: "out", responsibleName: "Jamie Chen", participation: "Event participant", passengers: 3, departedAt: minutesFromNow(-35), dueAt: minutesFromNow(25) },
                colleen: { status: "overdue", responsibleName: "Alex Rivera", participation: "Event participant", passengers: 2, departedAt: minutesFromNow(-70), dueAt: minutesFromNow(-10) },
                virginia: { status: "at_dock" },
                wagner: { status: "returned", passengers: 4, departedAt: minutesFromNow(-65), returnedAt: minutesFromNow(-8) },
                dearborn: { status: "at_dock" }
            },
            activity: [
                { at: minutesFromNow(-8), message: "Rowboat Wagner returned; responsible-person details cleared." },
                { at: minutesFromNow(-35), message: "Rowboat Martha departed with 3 people aboard." },
                { at: minutesFromNow(-70), message: "Rowboat Colleen departed with 2 people aboard." }
            ]
        },
        { id: "public-sail", name: "Sunday Public Sail", type: "Sunday Public Sail", status: "planned", startsAt: minutesFromNow(24 * 60), defaultDuration: 45, boats: { martha: { status: "at_dock" }, colleen: { status: "at_dock" }, cascade: { status: "at_dock" }, fremont: { status: "at_dock" } }, activity: [] },
        { id: "wood-regatta", name: "Norm Blanchard WOOD Regatta", type: "Regatta", status: "planned", startsAt: minutesFromNow(12 * 24 * 60), defaultDuration: 90, boats: { virginia: { status: "at_dock" }, wagner: { status: "at_dock" }, dearborn: { status: "at_dock" }, aurora: { status: "at_dock" } }, activity: [] },
        { id: "charter", name: "Lake Union Sunset Charter", type: "Charter Cruise", status: "completed", startsAt: minutesFromNow(-24 * 60), defaultDuration: 120, boats: { aurora: { status: "returned", passengers: 5, departedAt: minutesFromNow(-26 * 60), returnedAt: minutesFromNow(-24 * 60) } }, activity: [{ at: minutesFromNow(-24 * 60), message: "Rowboat Aurora returned; responsible-person details cleared." }] }
    ];
}

const state = { events: initialEvents(), selectedId: "spring-fling", filter: "current", pendingBoatId: null };
const elements = {
    eventList: document.getElementById("eventList"), boatTable: document.getElementById("eventBoatTable"), activityList: document.getElementById("activityList"),
    eventName: document.getElementById("selectedEventName"), eventType: document.getElementById("selectedEventType"), eventStatus: document.getElementById("selectedEventStatus"), eventSchedule: document.getElementById("selectedEventSchedule"), eventAction: document.getElementById("eventActionButton"),
    counts: { assigned: document.getElementById("assignedCount"), dock: document.getElementById("dockCount"), underway: document.getElementById("underwayCount"), returned: document.getElementById("returnedCount"), overdue: document.getElementById("overdueCount") },
    eventDialog: document.getElementById("eventDialog"), eventForm: document.getElementById("eventForm"), departureDialog: document.getElementById("departureDialog"), departureForm: document.getElementById("departureForm"), toast: document.getElementById("toast")
};

function node(tag, className = "", text = "") { const element = document.createElement(tag); if (className) element.className = className; if (text) element.textContent = text; return element; }
function selectedEvent() { return state.events.find(event => event.id === state.selectedId); }
function boatById(id) { return BOATS.find(boat => boat.id === id); }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value) : "—"; }
function formatTime(value) { return value ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(value) : "—"; }
function statusLabel(status) { return ({ at_dock: "At dock", out: "Underway", overdue: "Overdue", returned: "Returned" })[status] || status; }
function refreshOverdue(event) { Object.values(event.boats).forEach(session => { if (session.status === "out" && session.dueAt < new Date()) session.status = "overdue"; }); }
function countsFor(event) {
    refreshOverdue(event);
    const sessions = Object.values(event.boats);
    return { assigned: sessions.length, dock: sessions.filter(item => item.status === "at_dock").length, underway: sessions.filter(item => item.status === "out").length, returned: sessions.filter(item => item.status === "returned").length, overdue: sessions.filter(item => item.status === "overdue").length };
}
function showToast(message) { elements.toast.textContent = message; elements.toast.classList.remove("hidden"); clearTimeout(showToast.timeout); showToast.timeout = setTimeout(() => elements.toast.classList.add("hidden"), 3200); }
function refreshIcons() { window.lucide?.createIcons(); }

function renderEventList() {
    const events = state.filter === "all" ? state.events : state.events.filter(event => event.status !== "completed");
    const items = events.map(event => {
        const counts = countsFor(event);
        const accounted = counts.dock + counts.returned;
        const button = node("button", `event-list-item${event.id === state.selectedId ? " selected" : ""}`);
        button.type = "button";
        button.dataset.eventId = event.id;
        button.setAttribute("aria-current", event.id === state.selectedId ? "true" : "false");
        const top = node("span", "event-list-top");
        top.append(node("strong", "", event.name), node("span", `event-status ${event.status}`, event.status));
        const meta = node("span", "event-list-meta");
        meta.append(node("span", "", formatDateTime(event.startsAt)), node("span", "", `${accounted}/${counts.assigned} accounted`));
        const progress = node("span", "event-list-progress");
        const fill = node("span"); fill.style.width = `${counts.assigned ? accounted / counts.assigned * 100 : 0}%`; progress.append(fill);
        button.append(top, meta, progress);
        button.addEventListener("click", () => { state.selectedId = event.id; render(); });
        return button;
    });
    elements.eventList.replaceChildren(...items);
}

function actionButton(boat, session, event) {
    const button = node("button", `dock-action ${["out", "overdue"].includes(session.status) ? "check-in" : "check-out"}`);
    button.type = "button";
    if (event.status === "completed") { button.textContent = "Closed"; button.disabled = true; return button; }
    if (["out", "overdue"].includes(session.status)) {
        button.append(icon("log-in"), "Return");
        button.setAttribute("aria-label", `Return ${boat.name}`);
        button.addEventListener("click", () => returnBoat(event, boat, session));
    } else {
        button.append(icon("log-out"), session.status === "returned" ? "Send again" : "Send out");
        button.setAttribute("aria-label", `Send out ${boat.name}`);
        button.addEventListener("click", () => openDeparture(event, boat));
    }
    return button;
}
function icon(name) { const element = node("i", "h-3 w-3"); element.dataset.lucide = name; return element; }
function tableCell(content, className = "") { const cell = node("td", className); if (content instanceof Node) cell.append(content); else cell.textContent = String(content); return cell; }

function renderBoatTable(event) {
    const rows = Object.entries(event.boats).map(([boatId, session]) => {
        const boat = boatById(boatId);
        const row = node("tr");
        const status = node("span", `badge ${session.status === "at_dock" ? "available" : session.status === "out" ? "rented" : session.status}`);
        status.append(node("i", "badge-dot"), statusLabel(session.status));
        const boatCell = node("span"); boatCell.append(node("span", "vessel-name", boat.name), node("span", "vessel-id", `${boat.type} · capacity ${boat.capacity}`));
        const responsible = session.responsibleName || (session.status === "returned" ? "Cleared on return" : "—");
        row.append(
            tableCell(actionButton(boat, session, event)), tableCell(boatCell), tableCell(status),
            tableCell(responsible, session.status === "returned" ? "responsible-cleared" : ""), tableCell(session.passengers || "—", "data-value"),
            tableCell(formatTime(session.departedAt), "data-value"), tableCell(formatTime(session.dueAt), session.status === "overdue" ? "data-value text-red-400" : "data-value")
        );
        return row;
    });
    elements.boatTable.replaceChildren(...rows);
}

function renderActivity(event) {
    const entries = event.activity.length ? event.activity : [{ at: event.startsAt, message: "No boat movements recorded yet." }];
    elements.activityList.replaceChildren(...entries.map(entry => { const item = node("li"); const time = node("time", "", formatTime(entry.at)); time.dateTime = entry.at.toISOString(); item.append(time, node("span", "", entry.message)); return item; }));
}

function renderDetail() {
    const event = selectedEvent();
    if (!event) return;
    const counts = countsFor(event);
    elements.eventName.textContent = event.name;
    elements.eventType.textContent = event.type;
    elements.eventStatus.textContent = event.status;
    elements.eventStatus.className = `event-status ${event.status}`;
    elements.eventSchedule.textContent = `${formatDateTime(event.startsAt)} · ${event.defaultDuration}-minute default trip`;
    Object.entries(counts).forEach(([key, value]) => { elements.counts[key].textContent = value; });
    elements.eventAction.replaceChildren();
    if (event.status === "planned") elements.eventAction.append(icon("play"), "Start event");
    else if (event.status === "active") elements.eventAction.append(icon("check-circle"), "Complete event");
    else elements.eventAction.append(icon("badge-check"), "Event complete");
    elements.eventAction.disabled = event.status === "completed";
    elements.eventAction.onclick = () => changeEventStatus(event);
    renderBoatTable(event);
    renderActivity(event);
}
function render() { renderEventList(); renderDetail(); refreshIcons(); }

function changeEventStatus(event) {
    if (event.status === "planned") {
        event.status = "active";
        event.activity.unshift({ at: new Date(), message: "Event opened for dock operations." });
        showToast(`${event.name} is now active.`);
    } else {
        const unaccounted = Object.values(event.boats).filter(session => ["out", "overdue"].includes(session.status)).length;
        if (unaccounted) { showToast(`${unaccounted} ${unaccounted === 1 ? "boat is" : "boats are"} still away from the dock.`); return; }
        event.status = "completed";
        event.activity.unshift({ at: new Date(), message: "Event completed with every assigned boat accounted for." });
        showToast(`${event.name} completed.`);
    }
    render();
}

function openDeparture(event, boat) {
    if (event.status === "planned") { showToast("Start the event before recording departures."); return; }
    state.pendingBoatId = boat.id;
    elements.departureForm.reset();
    document.getElementById("departureBoat").textContent = `${boat.name} · ${event.name}`;
    document.getElementById("passengerCount").max = String(boat.capacity);
    document.getElementById("tripDuration").value = String(event.defaultDuration);
    elements.departureDialog.showModal();
    document.getElementById("responsibleName").focus();
}

function returnBoat(event, boat, session) {
    session.status = "returned";
    session.returnedAt = new Date();
    session.dueAt = null;
    delete session.responsibleName;
    delete session.participation;
    event.activity.unshift({ at: new Date(), message: `${boat.name} returned; responsible-person details cleared.` });
    showToast(`${boat.name} returned and tracking stopped.`);
    render();
}

elements.departureForm.addEventListener("submit", event => {
    event.preventDefault();
    const current = selectedEvent();
    const boat = boatById(state.pendingBoatId);
    if (!current || !boat) return;
    const passengers = Number(document.getElementById("passengerCount").value);
    if (!Number.isInteger(passengers) || passengers < 1 || passengers > boat.capacity) { showToast(`${boat.name} capacity is ${boat.capacity}.`); return; }
    const departedAt = new Date();
    current.boats[boat.id] = {
        status: "out", responsibleName: document.getElementById("responsibleName").value.trim(), participation: document.getElementById("participationType").value,
        passengers, departedAt, dueAt: new Date(departedAt.getTime() + Number(document.getElementById("tripDuration").value) * 60000)
    };
    current.activity.unshift({ at: departedAt, message: `${boat.name} departed with ${passengers} ${passengers === 1 ? "person" : "people"} aboard.` });
    elements.departureDialog.close();
    showToast(`${boat.name} departure recorded; tracking active.`);
    render();
});

function populateBoatOptions() {
    document.getElementById("boatOptions").replaceChildren(...BOATS.map((boat, index) => {
        const label = node("label");
        const input = document.createElement("input"); input.type = "checkbox"; input.name = "boats"; input.value = boat.id; input.checked = index < 3;
        label.append(input, node("span", "", boat.name)); return label;
    }));
}

document.getElementById("newEventButton").addEventListener("click", () => {
    elements.eventForm.reset();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60000);
    document.getElementById("eventDate").value = tomorrow.toISOString().slice(0, 10);
    document.getElementById("eventTime").value = "12:30";
    populateBoatOptions();
    elements.eventDialog.showModal();
    document.getElementById("eventName").focus();
});

elements.eventForm.addEventListener("submit", event => {
    event.preventDefault();
    const boatIds = [...elements.eventForm.querySelectorAll('input[name="boats"]:checked')].map(input => input.value);
    if (!boatIds.length) { showToast("Assign at least one boat to the event."); return; }
    const id = crypto.randomUUID();
    const date = document.getElementById("eventDate").value;
    const time = document.getElementById("eventTime").value;
    state.events.unshift({
        id, name: document.getElementById("eventName").value.trim(), type: document.getElementById("eventType").value, status: "planned",
        startsAt: new Date(`${date}T${time}:00`), defaultDuration: Number(document.getElementById("eventDuration").value),
        boats: Object.fromEntries(boatIds.map(boatId => [boatId, { status: "at_dock" }])), activity: []
    });
    state.selectedId = id;
    elements.eventDialog.close();
    showToast("Event created in this prototype session.");
    render();
});

document.querySelectorAll("[data-close-dialog]").forEach(button => button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close()));
document.querySelectorAll(".event-filters button").forEach(button => button.addEventListener("click", () => { state.filter = button.dataset.filter; document.querySelectorAll(".event-filters button").forEach(item => item.classList.toggle("active", item === button)); renderEventList(); }));
document.getElementById("resetPrototype").addEventListener("click", () => { state.events = initialEvents(); state.selectedId = "spring-fling"; state.filter = "current"; document.querySelectorAll(".event-filters button").forEach(button => button.classList.toggle("active", button.dataset.filter === "current")); showToast("Prototype data reset."); render(); });

initHeaderControls();
populateBoatOptions();
render();