import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { collection, getFirestore, limit, onSnapshot, orderBy, query } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyYourActualAPIKeyHere...",
    authDomain: "your-project-id.firebaseapp.com",
    projectId: "your-project-id",
    storageBucket: "your-project-id.appspot.com",
    messagingSenderId: "1234567890",
    appId: "1:1234567890:web:abcdef123456"
};

const DEMO_RENTAL_HISTORY_KEY = "cwbDemoRentalHistory";
const state = { records: [], search: "" };
const elements = {
    tableBody: document.getElementById("historyTableBody"),
    count: document.getElementById("historyCount"),
    search: document.getElementById("historySearch"),
    connection: document.getElementById("historyConnection")
};

function toDate(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    if (typeof value.toDate === "function") return value.toDate();
    if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
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
    elements.connection.innerHTML = `<span class="status-dot"></span><span class="hidden sm:inline">${escapeHtml(label)}</span>`;
}

function normalizeRecord(raw) {
    return {
        vesselName: raw.vessel_name || raw.device_id || "Unknown boat",
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
        elements.tableBody.innerHTML = `<tr><td colspan="6" class="empty-cell">No completed rentals recorded yet.</td></tr>`;
        return;
    }
    elements.tableBody.innerHTML = records.map(record => `<tr>
        <td><span class="vessel-name">${escapeHtml(record.vesselName)}</span></td>
        <td><span class="data-value">${formatDate(record.checkedOutAt || record.checkedInAt)}</span></td>
        <td><span class="data-value">${formatClock(record.checkedOutAt)}</span></td>
        <td><span class="data-value">${formatClock(record.checkedInAt)}</span></td>
        <td><span class="data-value">${formatDuration(record.durationMinutes, Boolean(record.checkedOutAt && record.checkedInAt))}</span></td>
        <td><span class="data-value">${record.passengerCount || "—"}</span></td>
    </tr>`).join("");
}

function startDemo() {
    try {
        const saved = JSON.parse(localStorage.getItem(DEMO_RENTAL_HISTORY_KEY) || "[]");
        state.records = saved.map(normalizeRecord);
    } catch { state.records = []; }
    setConnection("live", "Demo data");
    renderTable();
}

function startFirebase() {
    if (!firebaseConfig.projectId || firebaseConfig.projectId.startsWith("your-")) { startDemo(); return; }
    try {
        const db = getFirestore(initializeApp(firebaseConfig));
        const historyQuery = query(collection(db, "rental_history"), orderBy("checked_in_at", "desc"), limit(500));
        onSnapshot(historyQuery, snapshot => {
            state.records = snapshot.docs.map(document => normalizeRecord(document.data()));
            setConnection("live", "Firebase live");
            renderTable();
        }, error => {
            console.error("Unable to load rental history", error);
            setConnection("error", "Load failed");
            elements.tableBody.innerHTML = `<tr><td colspan="6" class="empty-cell">Unable to load rental history.</td></tr>`;
        });
    } catch (error) {
        console.error("Firebase initialization failed", error);
        setConnection("error", "Configuration error");
    }
}

elements.search.addEventListener("input", event => { state.search = event.target.value.trim().toLowerCase(); renderTable(); });
document.getElementById("themeToggle").addEventListener("click", () => document.documentElement.classList.toggle("dark"));

lucide.createIcons();
startFirebase();
