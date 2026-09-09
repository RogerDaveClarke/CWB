import { getFirebase, initAuthGuard, showAuthModal, isConfigValid } from "./auth-guard.js";

const connectionEl = document.getElementById("usersConnection");
const adminPanel = document.getElementById("adminPanel");
const deniedPanel = document.getElementById("deniedPanel");
const tableBody = document.getElementById("usersTableBody");
const inviteForm = document.getElementById("inviteForm");
const inviteMessage = document.getElementById("inviteMessage");
const inviteButton = document.getElementById("inviteButton");
const refreshButton = document.getElementById("refreshButton");

const state = { functions: null, httpsCallable: null };

function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function setConnection(mode, label) {
    connectionEl.className = `connection-pill ${mode}`;
    connectionEl.innerHTML = `<span class="status-dot"></span><span class="hidden sm:inline">${escapeHtml(label)}</span>`;
}

function roleBadge(role) {
    const colors = { admin: "bg-purple-100 text-purple-700", manager: "bg-blue-100 text-blue-700", staff: "bg-teal-100 text-teal-700", volunteer: "bg-amber-100 text-amber-700" };
    const label = role ? role.charAt(0).toUpperCase() + role.slice(1) : "—";
    return `<span class="px-2 py-0.5 rounded-full text-xs font-medium ${colors[role] || "bg-slate-100 text-slate-600"}">${escapeHtml(label)}</span>`;
}

function renderUsers(users) {
    if (!users.length) {
        tableBody.innerHTML = `<tr><td colspan="7" class="empty-cell">No users found.</td></tr>`;
        return;
    }
    tableBody.innerHTML = users.map(user => `<tr class="border-b border-slate-100" data-uid="${escapeHtml(user.uid)}">
        <td class="py-2 pr-4 font-medium text-slate-800">${escapeHtml(user.displayName || "—")}</td>
        <td class="py-2 pr-4 text-slate-600">${escapeHtml(user.email || "—")}</td>
        <td class="py-2 pr-4">${roleBadge(user.role)}</td>
        <td class="py-2 pr-4 text-slate-600">${escapeHtml(user.functionLevel ? user.functionLevel[0].toUpperCase() + user.functionLevel.slice(1) : "—")}</td>
        <td class="py-2 pr-4">${user.mfaEnrolled ? '<span class="text-green-600 text-xs font-medium">Enrolled</span>' : '<span class="text-slate-400 text-xs">Not set</span>'}</td>
        <td class="py-2 pr-4">${user.disabled ? '<span class="text-red-600 text-xs font-medium">Disabled</span>' : '<span class="text-green-600 text-xs font-medium">Active</span>'}</td>
        <td class="py-2 pr-4 text-right whitespace-nowrap">
            <button class="text-blue-600 hover:underline text-xs reset-mfa" type="button">Reset 2FA</button>
            ${user.disabled
                ? '<button class="text-green-600 hover:underline text-xs enable-user ml-2" type="button">Enable</button>'
                : '<button class="text-red-600 hover:underline text-xs disable-user ml-2" type="button">Disable</button>'}
        </td>
    </tr>`).join("");
}

async function callFunction(name, data) {
    const { httpsCallable } = state;
    return state.functions ? httpsCallable(state.functions, name)(data) : Promise.reject(new Error("Functions not ready"));
}

async function loadUsers() {
    try {
        const result = await callFunction("listUsers", {});
        renderUsers(result.data.users || []);
    } catch (error) {
        console.error("listUsers failed", error);
        tableBody.innerHTML = `<tr><td colspan="7" class="empty-cell">Unable to load users.</td></tr>`;
    }
}

function wireTableActions() {
    tableBody.addEventListener("click", async (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const uid = button.closest("tr")?.dataset.uid;
        if (!uid) return;
        button.disabled = true;
        try {
            if (button.classList.contains("reset-mfa")) {
                if (confirm("Reset two-factor authentication for this user? They must re-enroll at next sign-in.")) {
                    await callFunction("resetUserMfa", { uid });
                }
            } else if (button.classList.contains("disable-user")) {
                if (confirm("Disable this account? The user will be signed out and cannot sign in.")) {
                    await callFunction("disableUser", { uid });
                }
            } else if (button.classList.contains("enable-user")) {
                await callFunction("enableUser", { uid, role: "volunteer", functionLevel: "operations" });
            }
            await loadUsers();
        } catch (error) {
            console.error("Action failed", error);
            alert(error.message || "Action failed.");
        } finally {
            button.disabled = false;
        }
    });
}

async function init() {
    if (!isConfigValid()) {
        setConnection("error", "Not configured");
        deniedPanel.classList.remove("hidden");
        deniedPanel.querySelector("p").textContent = "Firebase is not configured. Fill in local.env and restart the dev server.";
        return;
    }
    const firebase = await getFirebase();
    state.functions = firebase.functions;
    state.httpsCallable = firebase.functionsModule.httpsCallable;

    await initAuthGuard({ requireAdmin: true, requireMfa: true }, {
        onReady: () => {
            setConnection("live", "Admin access");
            adminPanel.classList.remove("hidden");
            deniedPanel.classList.add("hidden");
            loadUsers();
        },
        onDenied: (reason) => {
            adminPanel.classList.add("hidden");
            deniedPanel.classList.remove("hidden");
            if (reason === "mfa-required") {
                setConnection("error", "2FA required");
                deniedPanel.querySelector("p").innerHTML = 'Two-factor authentication is required to manage accounts. <a class="text-blue-600 hover:underline" href="./mfa.html">Set up 2FA</a>.';
            } else {
                setConnection("error", "Denied");
            }
        },
        onSignedOut: () => {
            adminPanel.classList.add("hidden");
            deniedPanel.classList.remove("hidden");
            deniedPanel.querySelector("p").innerHTML = 'Sign in required to manage user accounts.';
            setConnection("", "Signed out");
            showAuthModal("signIn");
        }
    });

    inviteForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        inviteMessage.className = "text-sm text-slate-500";
        inviteMessage.textContent = "";
        const email = document.getElementById("inviteEmail").value.trim();
        const displayName = document.getElementById("inviteName").value.trim();
        const role = document.getElementById("inviteRole").value;
        const functionLevel = document.getElementById("inviteFunction").value;
        inviteButton.disabled = true;
        try {
            await callFunction("inviteUser", { email, displayName, role, functionLevel });
            inviteMessage.className = "text-sm text-green-600";
            inviteMessage.textContent = `Invited ${email} as ${role} / ${functionLevel}.`;
            inviteForm.reset();
            await loadUsers();
        } catch (error) {
            console.error("inviteUser failed", error);
            inviteMessage.className = "text-sm text-red-600";
            inviteMessage.textContent = error.message || "Invite failed.";
        } finally {
            inviteButton.disabled = false;
        }
    });

    refreshButton.addEventListener("click", loadUsers);
    wireTableActions();
}

init();
