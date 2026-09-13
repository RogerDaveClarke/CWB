import { firebaseConfig } from "./firebase-config.js";
import { initAuthGuard, showAuthModal, signOut, isConfigValid } from "./auth-guard.js";
import { initHeaderControls, setHeaderUser } from "./header-nav.js";
import { collection, limit, onSnapshot, orderBy, query } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const DEMO_RENTAL_HISTORY_KEY = "cwbDemoRentalHistory";
const state = { records: [], search: "", user: null };
const elements = {
    tableBody: document.getElementById("historyTableBody"),
    count: document.getElementById("historyCount"),
    search: document.getElementById("historySearch"),
    connection: document.getElementById("historyConnection"),
    signIn: document.getElementById("signInButton")
};

function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === "function") return value.toDate();
    if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
    const date = toDate(value);
    return date ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(date) : "—";
}

function formatClock(value) {
    const date = toDate(value);
    return date ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date) : "—";
}

function formatDuration(minutes, hasTimes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return hasTimes ? "< 1 min" : "—";
    const hours = Math.floor(minutes / 60);
    return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function setConnection(mode, label) {
    elements.connection.className = `connection-pill ${mode}`;
    const status = document.createElement("span");
    status.className = "status-dot";
    const text = document.createElement("span");
    text.className = "hidden sm:inline";
    text.textContent = label;
    elements.connection.replaceChildren(status, text);
}

function normalizeRecord(raw) {
    return {
        vesselName: raw.vessel_name || raw.device_id || "Unknown boat",
        boatType: raw.boat_type || "—",
        renterType: raw.renter_type || "—",
        checkedOutAt: toDate(raw.checked_out_at),
        checkedInAt: toDate(raw.checked_in_at),
        durationMinutes: Number(raw.duration_minutes ?? 0),
        passengerCount: Number(raw.passenger_count ?? 0)
    };
}

function renderTable() {
    const records = state.records
        .filter(record => record.vesselName.toLowerCase().includes(state.search))
        .sort((a, b) => (b.checkedInAt?.getTime() || 0) - (a.checkedInAt?.getTime() || 0));

    elements.count.textContent = `${records.length} ${records.length === 1 ? "rental" : "rentals"}`;
    if (!records.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 8;
        cell.className = "empty-cell";
        cell.textContent = "No completed rentals recorded yet.";
        row.append(cell);
        elements.tableBody.replaceChildren(row);
        return;
    }
    const rows = records.map(record => {
        const row = document.createElement("tr");
        const values = [
            [record.vesselName, "vessel-name"],
            [record.boatType, "data-value"],
            [record.renterType, "data-value"],
            [formatDate(record.checkedOutAt || record.checkedInAt), "data-value"],
            [formatClock(record.checkedOutAt), "data-value"],
            [formatClock(record.checkedInAt), "data-value"],
            [formatDuration(record.durationMinutes, Boolean(record.checkedOutAt && record.checkedInAt)), "data-value"],
            [record.passengerCount || "—", "data-value"]
        ];
        for (const [value, className] of values) {
            const cell = document.createElement("td");
            const text = document.createElement("span");
            text.className = className;
            text.textContent = String(value);
            cell.append(text);
            row.append(cell);
        }
        return row;
    });
    elements.tableBody.replaceChildren(...rows);
}

function defaultDemoHistory() {
    const now = new Date();
    return [
        { vessel_name: "Rowboat Martha", boat_type: "Row", renter_type: "Public", checked_out_at: new Date(now - 120*60000).toISOString(), checked_in_at: new Date(now - 63*60000).toISOString(), duration_minutes: 57, passenger_count: 3 },
        { vessel_name: "Rowboat Colleen", boat_type: "Row", renter_type: "Volunteer", checked_out_at: new Date(now - 240*60000).toISOString(), checked_in_at: new Date(now - 178*60000).toISOString(), duration_minutes: 62, passenger_count: 2 },
        { vessel_name: "Rowboat Virginia V", boat_type: "Row", renter_type: "Dire Hard", checked_out_at: new Date(now - 360*60000).toISOString(), checked_in_at: new Date(now - 304*60000).toISOString(), duration_minutes: 56, passenger_count: 4 }
    ];
}

function startDemo() {
    try {
        const saved = JSON.parse(localStorage.getItem(DEMO_RENTAL_HISTORY_KEY) || "[]");
        state.records = (saved.length ? saved : defaultDemoHistory()).map(normalizeRecord);
    } catch { state.records = defaultDemoHistory().map(normalizeRecord); }
    setConnection("live", "Demo data");
    renderTable();
}

async function startFirebase() {
    if (!isConfigValid()) {
        setConnection("error", "Not configured");
        showAuthModal("error", { message: "Firebase configuration missing. Please contact administrator." });
        return;
    }
    try {
        await initAuthGuard({ roles: ["admin", "manager", "staff"], functionLevels: ["operations", "administration"] }, {
            onReady: ({ user, db }) => {
                state.user = user;
                setHeaderUser(elements.signIn, user);
                const historyQuery = query(collection(db, "rental_history"), orderBy("checked_in_at", "desc"), limit(500));
                onSnapshot(historyQuery, snapshot => {
                    if (snapshot.empty) {
                        state.records = [];
                        setConnection("live", "Firebase live (0 records)");
                        renderTable();
                        return;
                    }
                    state.records = snapshot.docs.map(document => normalizeRecord(document.data()));
                    setConnection("live", "Firebase live");
                    renderTable();
                }, error => {
                    console.error("Unable to load rental history", error);
                    setConnection("error", "Access denied");
                    elements.tableBody.innerHTML = `<tr><td colspan="8" class="empty-cell">Unable to load rental history. Sign in with an authorized account.</td></tr>`;
                });
            },
            onDenied: (reason, user) => {
                state.user = user;
                setHeaderUser(elements.signIn, user);
                setConnection("error", "Access restricted");
                elements.tableBody.innerHTML = `<tr><td colspan="8" class="empty-cell">Access restricted. Sign in with an authorized account.</td></tr>`;
            },
            onSignedOut: () => {
                state.user = null;
                setHeaderUser(elements.signIn, null);
                setConnection("", "Sign in required");
                elements.tableBody.innerHTML = `<tr><td colspan="8" class="empty-cell">Sign in required to view rental history.</td></tr>`;
            }
        });
    } catch (error) {
        console.error("Firebase initialization failed", error);
        setConnection("error", "Configuration error");
    }
}

elements.search.addEventListener("input", event => { state.search = event.target.value.trim().toLowerCase(); renderTable(); });
elements.signIn.addEventListener("click", async () => {
    if (state.user) await signOut();
    else showAuthModal("signIn");
});
lucide.createIcons();
initHeaderControls();
startFirebase();
