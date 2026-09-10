import { getFirebase, initAuthGuard, showAuthModal, signOut, isConfigValid } from "./auth-guard.js";

const connectionEl = document.getElementById("usersConnection");
const adminPanel = document.getElementById("adminPanel");
const deniedPanel = document.getElementById("deniedPanel");
const deniedText = document.getElementById("deniedText");
const tableBody = document.getElementById("usersTableBody");
const usersCountEl = document.getElementById("usersCount");
const refreshUsersButton = document.getElementById("refreshUsersButton");
const addUserButton = document.getElementById("addUserButton");
const userSearchInput = document.getElementById("userSearch");
const roleFilterSelect = document.getElementById("roleFilter");
const statusFilterSelect = document.getElementById("statusFilter");
const authActionButton = document.getElementById("authActionButton");

// KPI elements
const kpiTotalUsers = document.getElementById("kpiTotalUsers");
const kpiActiveUsers = document.getElementById("kpiActiveUsers");
const kpiMfaEnrolled = document.getElementById("kpiMfaEnrolled");
const kpiSuspendedUsers = document.getElementById("kpiSuspendedUsers");

// Drawer elements
const userDrawer = document.getElementById("userDrawer");
const drawerBackdrop = document.getElementById("drawerBackdrop");
const userForm = document.getElementById("userForm");
const drawerTitle = document.getElementById("drawerTitle");
const formMessage = document.getElementById("formMessage");
const closeDrawerButton = document.getElementById("closeDrawerButton");
const cancelButton = document.getElementById("cancelButton");
const saveUserButton = document.getElementById("saveUserButton");
const deleteUserButton = document.getElementById("deleteUserButton");

const userEmailInput = document.getElementById("userEmail");
const emailHelpText = document.getElementById("emailHelp");
const userDisplayNameInput = document.getElementById("userDisplayName");
const userAddressInput = document.getElementById("userAddress");
const userRoleSelect = document.getElementById("userRole");
const userFunctionLevelSelect = document.getElementById("userFunctionLevel");
const securitySection = document.getElementById("securitySection");
const drawerMfaStatus = document.getElementById("drawerMfaStatus");
const drawerLoginCount = document.getElementById("drawerLoginCount");
const drawerLastLogin = document.getElementById("drawerLastLogin");

const state = {
    users: [],
    filteredUsers: [],
    currentUser: null,
    editingUid: null,
    searchQuery: "",
    roleFilter: "all",
    statusFilter: "all",
    functions: null,
    httpsCallable: null,
    db: null,
    firestoreModule: null,
    // True once the listUsers callable has returned for this session; fast
    // (cache/Firestore) renders never overwrite authoritative data.
    authoritativeLoaded: false
};

const ROSTER_CACHE_KEY = "cwb_users_roster";

function escapeHtml(value) {
    return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatDate(value) {
    if (!value) return "Never";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

function setConnection(mode, label) {
    connectionEl.className = `connection-pill ${mode}`;
    connectionEl.innerHTML = `<span class="status-dot"></span><span class="hidden sm:inline">${escapeHtml(label)}</span>`;
}

function updateKPIs(users) {
    const total = users.length;
    const active = users.filter(u => u.status === "active" && !u.disabled).length;
    const mfa = users.filter(u => u.mfaEnrolled).length;
    const suspended = users.filter(u => u.status === "suspended" || u.disabled).length;

    kpiTotalUsers.textContent = total;
    kpiActiveUsers.textContent = active;
    kpiMfaEnrolled.textContent = mfa;
    kpiSuspendedUsers.textContent = suspended;
    usersCountEl.textContent = `${total} ${total === 1 ? "account" : "accounts"}`;
}

function renderUsers() {
    let list = [...state.users];

    // Filter by role
    if (state.roleFilter !== "all") {
        list = list.filter(u => u.role === state.roleFilter);
    }

    // Filter by status
    if (state.statusFilter !== "all") {
        list = list.filter(u => {
            const isSuspended = u.status === "suspended" || u.disabled;
            return state.statusFilter === "suspended" ? isSuspended : !isSuspended;
        });
    }

    // Search query
    if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        list = list.filter(u =>
            (u.displayName && u.displayName.toLowerCase().includes(q)) ||
            (u.email && u.email.toLowerCase().includes(q)) ||
            (u.address && u.address.toLowerCase().includes(q)) ||
            (u.role && u.role.toLowerCase().includes(q))
        );
    }

    state.filteredUsers = list;

    if (!list.length) {
        tableBody.innerHTML = `<tr><td colspan="9" class="empty-cell">No user accounts found matching current filters.</td></tr>`;
        return;
    }

    tableBody.innerHTML = list.map(user => {
        const role = user.role || "volunteer";
        const roleBadgeClass = `badge-role-${role}`;
        const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

        const func = user.functionLevel ? user.functionLevel.charAt(0).toUpperCase() + user.functionLevel.slice(1) : "Operations";
        const isSuspended = user.status === "suspended" || user.disabled;
        const statusBadgeClass = isSuspended ? "badge-status-suspended" : "badge-status-active";
        const statusLabel = isSuspended ? "Suspended" : "Active";

        const mfaBadgeClass = user.mfaEnrolled ? "badge-mfa-yes" : "badge-mfa-no";
        const mfaLabel = user.mfaEnrolled ? "Enrolled" : "Not set";

        const isSelf = state.currentUser && state.currentUser.uid === user.uid;

        return `<tr data-uid="${escapeHtml(user.uid)}">
            <td>
                <div class="font-bold text-zinc-100">${escapeHtml(user.displayName || "—")}</div>
                ${isSelf ? '<span class="text-[10px] text-sky-400 font-medium">(You)</span>' : ''}
            </td>
            <td><span class="font-mono text-zinc-300 text-xs">${escapeHtml(user.email || "—")}</span></td>
            <td>
                <div class="truncate max-w-[200px] text-zinc-400 text-xs" title="${escapeHtml(user.address || "No address on file")}">
                    ${escapeHtml(user.address || "—")}
                </div>
            </td>
            <td><span class="badge-pill ${roleBadgeClass}">${escapeHtml(roleLabel)}</span></td>
            <td><span class="text-xs text-zinc-300">${escapeHtml(func)}</span></td>
            <td><span class="badge-pill ${mfaBadgeClass}">${escapeHtml(mfaLabel)}</span></td>
            <td><span class="font-mono text-xs text-zinc-200">${user.loginCount || 0}</span></td>
            <td><span class="badge-pill ${statusBadgeClass}">${escapeHtml(statusLabel)}</span></td>
            <td>
                <div class="flex items-center justify-end gap-1.5 whitespace-nowrap">
                    <button class="icon-button edit-user" type="button" title="Edit account" aria-label="Edit account">
                        <i data-lucide="pencil" class="h-4 w-4"></i>
                    </button>
                    <button class="icon-button reset-mfa" type="button" title="Reset 2FA" aria-label="Reset 2FA">
                        <i data-lucide="shield-alert" class="h-4 w-4 text-sky-400"></i>
                    </button>
                    ${isSuspended
                        ? `<button class="icon-button enable-user" type="button" title="Activate account" aria-label="Activate account">
                               <i data-lucide="user-check" class="h-4 w-4 text-emerald-400"></i>
                           </button>`
                        : `<button class="icon-button suspend-user" type="button" title="Suspend account" aria-label="Suspend account" ${isSelf ? 'disabled' : ''}>
                               <i data-lucide="user-x" class="h-4 w-4 text-amber-400"></i>
                           </button>`}
                    <button class="icon-button delete-user" type="button" title="Delete user" aria-label="Delete user" ${isSelf ? 'disabled' : ''}>
                        <i data-lucide="trash-2" class="h-4 w-4 text-red-400"></i>
                    </button>
                </div>
            </td>
        </tr>`;
    }).join("");

    if (window.lucide) {
        window.lucide.createIcons();
    }
}

async function callFunction(name, data) {
    const { httpsCallable } = state;
    if (!state.functions || !httpsCallable) {
        throw new Error("Cloud functions not initialized.");
    }
    return httpsCallable(state.functions, name)(data);
}

async function loadUsers() {
    setConnection("live", "Syncing…");
    try {
        const result = await callFunction("listUsers", {});
        state.users = result.data.users || [];
        state.authoritativeLoaded = true;
        try {
            sessionStorage.setItem(ROSTER_CACHE_KEY, JSON.stringify(state.users));
        } catch { /* quota/serialization issues are non-fatal */ }
        updateKPIs(state.users);
        renderUsers();
        setConnection("live", "Admin access");
    } catch (error) {
        console.error("listUsers failed", error);
        // A fast render may already be showing usable data; only surface the
        // failure state when the table would otherwise be empty.
        if (!state.users.length) {
            setConnection("error", "Failed to load");
            tableBody.innerHTML = `<tr><td colspan="9" class="empty-cell text-red-400">Unable to load accounts: ${escapeHtml(error.message || "Access denied")}</td></tr>`;
        } else {
            setConnection("live", "Admin access");
        }
    }
}

// Instant paint from this tab's last authoritative roster, if any.
function primeUsersFromCache() {
    if (state.authoritativeLoaded || state.users.length) return;
    try {
        const cached = JSON.parse(sessionStorage.getItem(ROSTER_CACHE_KEY) || "null");
        if (Array.isArray(cached) && cached.length) {
            state.users = cached;
            updateKPIs(state.users);
            renderUsers();
        }
    } catch { /* ignore bad cache */ }
}

// Fast first load straight from the Firestore users collection (no Cloud
// Function cold start). Admin clients are allowed to list it by the security
// rules. Auth-only fields (disabled flag, factors for older accounts) are
// reconciled when the authoritative listUsers call returns.
async function loadUsersFast() {
    if (!state.db || !state.firestoreModule) return;
    try {
        const snapshot = await state.firestoreModule.getDocs(
            state.firestoreModule.collection(state.db, "users")
        );
        if (state.authoritativeLoaded) return;
        const users = [];
        snapshot.forEach((doc) => {
            const data = doc.data() || {};
            const suspended = data.status === "suspended";
            users.push({
                uid: doc.id,
                email: data.email || "",
                displayName: data.displayName || "",
                address: data.address || "",
                disabled: suspended,
                mfaEnrolled: data.mfaEnrolled === true,
                role: data.role ?? null,
                functionLevel: data.functionLevel ?? null,
                status: suspended ? "suspended" : (data.status || "active"),
                loginCount: data.loginCount || 0,
                lastLogin: data.lastLogin || null,
                createdAt: data.createdAt || null
            });
        });
        if (users.length && !state.authoritativeLoaded) {
            state.users = users;
            updateKPIs(state.users);
            renderUsers();
        }
    } catch (error) {
        console.warn("Fast roster load failed; waiting for listUsers", error);
    }
}

// Apply the result of a mutation to the in-memory roster so the table reflects
// it immediately; the authoritative reload runs in the background.
function patchUser(uid, patch) {
    const user = state.users.find(u => u.uid === uid);
    if (!user) return;
    Object.assign(user, patch);
    updateKPIs(state.users);
    renderUsers();
}

function removeUserLocally(uid) {
    state.users = state.users.filter(u => u.uid !== uid);
    updateKPIs(state.users);
    renderUsers();
}

function showFormMessage(message, isSuccess = false) {
    formMessage.textContent = message;
    formMessage.className = `form-message ${isSuccess ? 'success' : ''}`;
    formMessage.classList.remove("hidden");
}

function hideFormMessage() {
    formMessage.classList.add("hidden");
    formMessage.textContent = "";
}

function openDrawer(user = null) {
    state.editingUid = user?.uid || null;
    hideFormMessage();

    if (user) {
        drawerTitle.textContent = "Edit User";
        userEmailInput.value = user.email || "";
        userEmailInput.disabled = true;
        emailHelpText.textContent = "Email address cannot be changed once created.";
        userDisplayNameInput.value = user.displayName || "";
        userAddressInput.value = user.address || "";
        userRoleSelect.value = user.role || "staff";
        userFunctionLevelSelect.value = user.functionLevel || "operations";

        securitySection.classList.remove("hidden");
        drawerMfaStatus.textContent = user.mfaEnrolled ? "Enrolled (TOTP)" : "Not configured";
        drawerMfaStatus.className = `font-medium ${user.mfaEnrolled ? 'text-sky-400' : 'text-zinc-500'}`;
        drawerLoginCount.textContent = String(user.loginCount || 0);
        drawerLastLogin.textContent = formatDate(user.lastLogin);

        const isSelf = state.currentUser && state.currentUser.uid === user.uid;
        userRoleSelect.disabled = isSelf;
        userRoleSelect.title = isSelf ? "You cannot change your own role." : "";
        deleteUserButton.classList.toggle("hidden", isSelf);
    } else {
        drawerTitle.textContent = "Add User";
        userEmailInput.value = "";
        userEmailInput.disabled = false;
        emailHelpText.textContent = "Used for sign-in and initial invitation.";
        userDisplayNameInput.value = "";
        userAddressInput.value = "";
        userRoleSelect.value = "staff";
        userRoleSelect.disabled = false;
        userRoleSelect.title = "";
        userFunctionLevelSelect.value = "operations";

        securitySection.classList.add("hidden");
        deleteUserButton.classList.add("hidden");
    }

    drawerBackdrop.classList.remove("hidden");
    userDrawer.classList.add("open");
    userDrawer.setAttribute("aria-hidden", "false");

    if (window.lucide) window.lucide.createIcons();
    setTimeout(() => (user ? userDisplayNameInput : userEmailInput).focus(), 100);
}

function closeDrawer() {
    userDrawer.classList.remove("open");
    userDrawer.setAttribute("aria-hidden", "true");
    drawerBackdrop.classList.add("hidden");
    state.editingUid = null;
    hideFormMessage();
}

function wireEventListeners() {
    // Search and filters
    userSearchInput.addEventListener("input", (e) => {
        state.searchQuery = e.target.value.trim();
        renderUsers();
    });

    roleFilterSelect.addEventListener("change", (e) => {
        state.roleFilter = e.target.value;
        renderUsers();
    });

    statusFilterSelect.addEventListener("change", (e) => {
        state.statusFilter = e.target.value;
        renderUsers();
    });

    refreshUsersButton.addEventListener("click", loadUsers);
    addUserButton.addEventListener("click", () => openDrawer(null));
    closeDrawerButton.addEventListener("click", closeDrawer);
    cancelButton.addEventListener("click", closeDrawer);
    drawerBackdrop.addEventListener("click", closeDrawer);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && userDrawer.classList.contains("open")) {
            closeDrawer();
        }
    });

    // Sign in / Sign out button in header
    authActionButton.addEventListener("click", async () => {
        if (state.currentUser) {
            await signOut();
        } else {
            showAuthModal("signIn");
        }
    });

    // Form submission (Add / Edit user)
    userForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        hideFormMessage();

        const email = userEmailInput.value.trim();
        const displayName = userDisplayNameInput.value.trim();
        const address = userAddressInput.value.trim();
        const role = userRoleSelect.value;
        const functionLevel = userFunctionLevelSelect.value;

        if (role === "volunteer" && functionLevel === "administration") {
            showFormMessage("Volunteers cannot be assigned the Administration function.");
            return;
        }

        saveUserButton.disabled = true;
        saveUserButton.querySelector("span").textContent = "Saving…";

        try {
            if (state.editingUid) {
                await callFunction("updateUserProfile", {
                    uid: state.editingUid,
                    displayName,
                    address,
                    role,
                    functionLevel
                });
                patchUser(state.editingUid, { displayName, address, role, functionLevel });
                showFormMessage("User profile updated successfully.", true);
            } else {
                const created = await callFunction("inviteUser", {
                    email,
                    displayName,
                    address,
                    role,
                    functionLevel
                });
                const uid = created?.data?.uid;
                if (uid && !state.users.some(u => u.uid === uid)) {
                    state.users.push({
                        uid, email, displayName, address, role, functionLevel,
                        status: "active", disabled: false, mfaEnrolled: false,
                        loginCount: 0, lastLogin: null, createdAt: null
                    });
                    updateKPIs(state.users);
                    renderUsers();
                }
                showFormMessage(`User ${email} created and permissions assigned.`, true);
            }

            loadUsers();
            setTimeout(closeDrawer, 800);
        } catch (error) {
            console.error("Save user failed", error);
            showFormMessage(error.message || "Failed to save user account.");
        } finally {
            saveUserButton.disabled = false;
            saveUserButton.querySelector("span").textContent = "Save User";
        }
    });

    // Delete user button in drawer
    deleteUserButton.addEventListener("click", async () => {
        if (!state.editingUid) return;
        const user = state.users.find(u => u.uid === state.editingUid);
        const name = user?.displayName || user?.email || "this user";
        if (!confirm(`Are you sure you want to permanently delete ${name}? This cannot be undone.`)) {
            return;
        }

        deleteUserButton.disabled = true;
        deleteUserButton.querySelector("span").textContent = "Deleting…";

        try {
            await callFunction("deleteUser", { uid: state.editingUid });
            removeUserLocally(state.editingUid);
            closeDrawer();
            loadUsers();
        } catch (error) {
            console.error("Delete user failed", error);
            showFormMessage(error.message || "Failed to delete user.");
        } finally {
            deleteUserButton.disabled = false;
            deleteUserButton.querySelector("span").textContent = "Delete User";
        }
    });

    // Table action buttons
    tableBody.addEventListener("click", async (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const row = button.closest("tr");
        const uid = row?.dataset.uid;
        if (!uid) return;

        const user = state.users.find(u => u.uid === uid);
        if (!user) return;

        if (button.classList.contains("edit-user")) {
            openDrawer(user);
            return;
        }

        button.disabled = true;
        try {
            if (button.classList.contains("reset-mfa")) {
                if (confirm(`Reset two-factor authentication for ${user.displayName || user.email}? They will be required to re-enroll TOTP at next login.`)) {
                    await callFunction("resetUserMfa", { uid });
                    patchUser(uid, { mfaEnrolled: false });
                    loadUsers();
                }
            } else if (button.classList.contains("suspend-user")) {
                if (confirm(`Suspend access for ${user.displayName || user.email}? The user will be immediately logged out and unable to access the system.`)) {
                    await callFunction("disableUser", { uid });
                    patchUser(uid, { status: "suspended", disabled: true, role: null, functionLevel: null });
                    loadUsers();
                }
            } else if (button.classList.contains("enable-user")) {
                const role = user.role || "staff";
                const functionLevel = user.functionLevel || "operations";
                await callFunction("enableUser", { uid, role, functionLevel });
                patchUser(uid, { status: "active", disabled: false, role, functionLevel });
                loadUsers();
            } else if (button.classList.contains("delete-user")) {
                if (confirm(`Permanently delete account for ${user.displayName || user.email}? All permissions and user metadata will be removed.`)) {
                    await callFunction("deleteUser", { uid });
                    removeUserLocally(uid);
                    loadUsers();
                }
            }
        } catch (error) {
            console.error("User action failed", error);
            alert(error.message || "Action failed.");
        } finally {
            button.disabled = false;
        }
    });
}

async function init() {
    if (!isConfigValid()) {
        setConnection("error", "Not configured");
        adminPanel.classList.add("hidden");
        deniedPanel.classList.remove("hidden");
        deniedText.textContent = "Firebase configuration is missing or incomplete.";
        return;
    }

    const firebase = await getFirebase();
    state.functions = firebase.functions;
    state.httpsCallable = firebase.functionsModule.httpsCallable;
    state.db = firebase.db;
    state.firestoreModule = firebase.firestoreModule;

    wireEventListeners();

    await initAuthGuard({ requireAdmin: true, requireMfa: true }, {
        onReady: ({ user }) => {
            state.currentUser = user;
            setConnection("live", "Admin access");
            adminPanel.classList.remove("hidden");
            deniedPanel.classList.add("hidden");

            authActionButton.innerHTML = `<i data-lucide="log-out" class="h-4 w-4"></i><span>${escapeHtml(user.displayName || user.email || "Sign out")}</span>`;
            if (window.lucide) window.lucide.createIcons();

            // Instant paint from cache, fast paint from Firestore, then the
            // authoritative Auth-merged roster reconciles on arrival.
            primeUsersFromCache();
            loadUsersFast();
            loadUsers();
        },
        onDenied: (reason, user) => {
            state.currentUser = user;
            adminPanel.classList.add("hidden");
            deniedPanel.classList.remove("hidden");

            if (reason === "mfa-required") {
                setConnection("error", "2FA required");
                deniedText.innerHTML = 'Two-factor authentication (2FA) is required to manage accounts. Please complete <a class="text-sky-400 underline" href="./mfa.html">2FA Setup</a>.';
            } else {
                setConnection("error", "Access denied");
                deniedText.textContent = "Administrator privileges are required to access Account Administration.";
            }

            authActionButton.innerHTML = user
                ? `<i data-lucide="log-out" class="h-4 w-4"></i><span>Sign out</span>`
                : `<i data-lucide="log-in" class="h-4 w-4"></i><span>Sign in</span>`;
            if (window.lucide) window.lucide.createIcons();
        },
        onSignedOut: () => {
            state.currentUser = null;
            adminPanel.classList.add("hidden");
            deniedPanel.classList.remove("hidden");
            deniedText.textContent = "Sign in with an Administrator account is required.";
            setConnection("", "Sign in required");

            authActionButton.innerHTML = `<i data-lucide="log-in" class="h-4 w-4"></i><span>Sign in</span>`;
            if (window.lucide) window.lucide.createIcons();

            showAuthModal("signIn");
        }
    });
}

init();
