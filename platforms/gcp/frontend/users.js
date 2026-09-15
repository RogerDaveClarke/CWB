import { getFirebase, initAuthGuard, showAuthModal, signOut, isConfigValid } from "./auth-guard.js";
import { initHeaderControls, setAdminNavigation, setHeaderUser } from "./header-nav.js";

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
    editingEmail: null,
    searchQuery: "",
    roleFilter: "all",
    statusFilter: "all",
    functions: null,
    httpsCallable: null,
    auth: null,
    authModule: null,
    db: null,
    firestoreModule: null,
    // True once the listUsers callable has returned for this session; fast
    // (cache/Firestore) renders never overwrite authoritative data.
    authoritativeLoaded: false
};


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
    const dot = document.createElement("span");
    dot.className = "status-dot";
    const text = document.createElement("span");
    text.className = "hidden sm:inline";
    text.textContent = label;
    connectionEl.replaceChildren(dot, text);
}

function icon(name, className = "h-4 w-4") {
    const element = document.createElement("i");
    element.dataset.lucide = name;
    element.className = className;
    return element;
}

function tableMessage(message, className = "empty-cell") {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 9;
    cell.className = className;
    cell.textContent = message;
    row.appendChild(cell);
    tableBody.replaceChildren(row);
}

function span(className, text) {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = text;
    return element;
}

function div(className, text = null) {
    const element = document.createElement("div");
    element.className = className;
    if (text != null) element.textContent = text;
    return element;
}

function userActionButton(className, title, iconName, iconClass = "h-4 w-4", disabled = false) {
    const button = document.createElement("button");
    button.className = `icon-button ${className}`;
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.disabled = disabled;
    button.appendChild(icon(iconName, iconClass));
    return button;
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
        tableMessage("No user accounts found matching current filters.");
        return;
    }

    tableBody.replaceChildren(...list.map(user => {
        const role = user.role || "volunteer";
        const roleBadgeClass = `badge-role-${role}`;
        const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

        const func = user.functionLevel ? user.functionLevel.charAt(0).toUpperCase() + user.functionLevel.slice(1) : "Operations";
        const isInvitation = user.status === "invited";
        const isSuspended = user.status === "suspended" || user.disabled;
        const statusBadgeClass = isSuspended || isInvitation ? "badge-status-suspended" : "badge-status-active";
        const statusLabel = isInvitation ? "Invitation sent" : isSuspended ? "Suspended" : "Active";
        const mfaBadgeClass = user.mfaEnrolled ? "badge-mfa-yes" : "badge-mfa-no";
        const mfaLabel = user.mfaEnrolled ? "Enrolled" : "Not set";
        const isSelf = state.currentUser && state.currentUser.uid === user.uid;
        const accountLabel = user.displayName || user.email || "this account";

        const row = document.createElement("tr");
        row.dataset.uid = user.uid;

        const nameCell = document.createElement("td");
        nameCell.appendChild(div("font-bold text-zinc-100", user.displayName || "—"));
        if (isSelf) nameCell.appendChild(span("text-[10px] text-sky-400 font-medium", "(You)"));
        row.appendChild(nameCell);

        const emailCell = document.createElement("td");
        emailCell.appendChild(span("font-mono text-zinc-300 text-xs", user.email || "—"));
        row.appendChild(emailCell);

        const addressCell = document.createElement("td");
        const address = div("truncate max-w-[200px] text-zinc-400 text-xs", user.address || "—");
        address.title = user.address || "No address on file";
        addressCell.appendChild(address);
        row.appendChild(addressCell);

        const roleCell = document.createElement("td");
        roleCell.appendChild(span(`badge-pill ${roleBadgeClass}`, roleLabel));
        row.appendChild(roleCell);

        const functionCell = document.createElement("td");
        functionCell.appendChild(span("text-xs text-zinc-300", func));
        row.appendChild(functionCell);

        const mfaCell = document.createElement("td");
        mfaCell.appendChild(span(`badge-pill ${mfaBadgeClass}`, mfaLabel));
        row.appendChild(mfaCell);

        const loginCell = document.createElement("td");
        loginCell.appendChild(span("font-mono text-xs text-zinc-200", String(user.loginCount || 0)));
        row.appendChild(loginCell);

        const statusCell = document.createElement("td");
        statusCell.appendChild(span(`badge-pill ${statusBadgeClass}`, statusLabel));
        row.appendChild(statusCell);

        const actionCell = document.createElement("td");
        const actions = div("flex items-center justify-end gap-1.5 whitespace-nowrap");
        if (isInvitation) {
            actions.append(userActionButton("cancel-invitation", `Cancel invitation for ${accountLabel}`, "mail-x", "h-4 w-4 text-red-400"));
        } else {
            actions.append(
                userActionButton("edit-user", `Edit ${accountLabel}`, "pencil"),
                userActionButton("reset-mfa", `Reset 2FA for ${accountLabel}`, "shield-alert", "h-4 w-4 text-sky-400"),
                isSuspended
                    ? userActionButton("enable-user", `Activate ${accountLabel}`, "user-check", "h-4 w-4 text-emerald-400")
                    : userActionButton("suspend-user", `Suspend ${accountLabel}`, "user-x", "h-4 w-4 text-amber-400", isSelf),
                userActionButton("delete-user", `Delete ${accountLabel}`, "trash-2", "h-4 w-4 text-red-400", isSelf)
            );
        }
        actionCell.appendChild(actions);
        row.appendChild(actionCell);

        return row;
    }));

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
        updateKPIs(state.users);
        renderUsers();
        setConnection("live", "Admin access");
    } catch {
        console.error("Account list request failed.");
        // A fast render may already be showing usable data; only surface the
        // failure state when the table would otherwise be empty.
        if (!state.users.length) {
            setConnection("error", "Failed to load");
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 9;
            cell.className = "empty-cell text-red-400";
            cell.textContent = "Unable to load accounts. Access denied.";
            row.appendChild(cell);
            tableBody.replaceChildren(row);
        } else {
            setConnection("live", "Admin access");
        }
    }
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

function requestEmailConfirmation(user, action) {
    const email = String(user?.email || "").trim();
    const confirmationEmail = window.prompt(`To ${action} this account, type the full email address exactly:\n\n${email}`);
    if (confirmationEmail == null) return null;
    if (confirmationEmail.trim() !== email) {
        alert("The email address did not match. No changes were made.");
        return null;
    }
    return confirmationEmail.trim();
}

function requestSuspension(user) {
    const reason = window.prompt(`Explain why ${user.email} is being suspended. This explanation will be emailed to the user.`);
    if (reason == null) return null;
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 10 || normalizedReason.length > 1000) {
        alert("Enter an explanation between 10 and 1000 characters.");
        return null;
    }
    const confirmationEmail = requestEmailConfirmation(user, "suspend");
    return confirmationEmail ? { confirmationEmail, reason: normalizedReason } : null;
}

function requestReactivationAccess() {
    const role = window.prompt("Assign a role: admin, manager, staff, or volunteer", "staff");
    if (role == null) return null;
    const normalizedRole = role.trim().toLowerCase();
    if (!["admin", "manager", "staff", "volunteer"].includes(normalizedRole)) {
        alert("Enter admin, manager, staff, or volunteer.");
        return null;
    }
    const functionLevel = window.prompt("Assign a function level: operations or administration", "operations");
    if (functionLevel == null) return null;
    const normalizedFunction = functionLevel.trim().toLowerCase();
    if (!["operations", "administration"].includes(normalizedFunction)
        || (normalizedRole === "volunteer" && normalizedFunction === "administration")) {
        alert("Enter a compatible function level.");
        return null;
    }
    return { role: normalizedRole, functionLevel: normalizedFunction };
}

function reportNotificationFailure(action, email) {
    alert(`${action} completed, but the notification email to ${email} is queued for retry. Contact the user through another verified channel if delivery remains unsuccessful.`);
}

function openDrawer(user = null) {
    state.editingUid = user?.uid || null;
    state.editingEmail = user?.email || null;
    hideFormMessage();

    if (user) {
        drawerTitle.textContent = "Edit User";
        userEmailInput.value = user.email || "";
        userEmailInput.disabled = false;
        emailHelpText.textContent = "Changing this updates the sign-in email and signs the user out.";
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
    state.editingEmail = null;
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

        const emailChanged = state.editingUid
            && email.toLowerCase() !== (state.editingEmail || "").toLowerCase();
        if (emailChanged && !confirm(`Change the sign-in email to ${email}? The user will be signed out and must verify the corrected address.`)) {
            return;
        }

        saveUserButton.disabled = true;
        saveUserButton.querySelector("span").textContent = "Saving…";

        try {
            if (state.editingUid) {
                await callFunction("updateUserProfile", {
                    uid: state.editingUid,
                    email,
                    displayName,
                    address,
                    role,
                    functionLevel
                });
                patchUser(state.editingUid, { email, displayName, address, role, functionLevel });
                showFormMessage("User profile updated successfully.", true);
            } else {
                const created = await callFunction("inviteUser", {
                    email,
                    displayName,
                    address,
                    role,
                    functionLevel
                });
                const token = created?.data?.token;
                const invitationId = created?.data?.invitationId;
                try {
                    await state.authModule.sendSignInLinkToEmail(state.auth, email, {
                        url: `${window.location.origin}/mfa#invite=${encodeURIComponent(token)}`,
                        handleCodeInApp: true
                    });
                } catch (deliveryError) {
                    if (invitationId) {
                        await callFunction("cancelUserInvitation", { invitationId }).catch(() => null);
                    }
                    throw deliveryError;
                }
                showFormMessage(`Invitation sent to ${email}. Permissions activate after the recipient verifies the link and enrolls 2FA.`, true);
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
        const confirmationEmail = requestEmailConfirmation(user, "permanently delete");
        if (!confirmationEmail) return;

        deleteUserButton.disabled = true;
        deleteUserButton.querySelector("span").textContent = "Deleting…";

        try {
            const result = await callFunction("deleteUser", { uid: state.editingUid, confirmationEmail });
            removeUserLocally(state.editingUid);
            closeDrawer();
            loadUsers();
            if (result.data?.notificationSent === false) reportNotificationFailure("Account deletion", user.email);
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

        if (button.classList.contains("cancel-invitation")) {
            if (!confirm(`Cancel the invitation for ${user.email}? The emailed link will no longer work.`)) return;
            button.disabled = true;
            try {
                await callFunction("cancelUserInvitation", { invitationId: user.invitationId });
                removeUserLocally(uid);
            } catch (error) {
                alert(error.message || "Unable to cancel invitation.");
                button.disabled = false;
            }
            return;
        }

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
                const suspension = requestSuspension(user);
                if (suspension) {
                    const result = await callFunction("disableUser", { uid, ...suspension });
                    if (result.data?.operationCompleted) {
                        patchUser(uid, { status: "suspended", disabled: true, role: null, functionLevel: null });
                    } else {
                        alert("Account suspension is queued and will be retried automatically.");
                    }
                    loadUsers();
                    if (result.data?.operationCompleted && result.data?.notificationSent === false) reportNotificationFailure("Account suspension", user.email);
                }
            } else if (button.classList.contains("enable-user")) {
                const access = requestReactivationAccess();
                if (!access) return;
                const { role, functionLevel } = access;
                await callFunction("enableUser", { uid, role, functionLevel });
                patchUser(uid, { status: "active", disabled: false, role, functionLevel });
                loadUsers();
            } else if (button.classList.contains("delete-user")) {
                const confirmationEmail = requestEmailConfirmation(user, "permanently delete");
                if (confirmationEmail) {
                    const result = await callFunction("deleteUser", { uid, confirmationEmail });
                    if (result.data?.operationCompleted) {
                        removeUserLocally(uid);
                    } else {
                        alert("Account deletion is queued and will be retried automatically.");
                    }
                    loadUsers();
                    if (result.data?.operationCompleted && result.data?.notificationSent === false) reportNotificationFailure("Account deletion", user.email);
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
    state.auth = firebase.auth;
    state.authModule = firebase.authModule;
    state.db = firebase.db;
    state.firestoreModule = firebase.firestoreModule;

    wireEventListeners();

    await initAuthGuard({ requireAdmin: true, requireMfa: true }, {
        onReady: ({ user, claims }) => {
            state.currentUser = user;
            setConnection("live", "Admin access");
            adminPanel.classList.remove("hidden");
            deniedPanel.classList.add("hidden");

            setHeaderUser(authActionButton, user);
            setAdminNavigation(claims.isAdmin);

            loadUsersFast();
            loadUsers();
        },
        onDenied: (reason, user) => {
            state.currentUser = user;
            adminPanel.classList.add("hidden");
            deniedPanel.classList.remove("hidden");

            if (reason === "mfa-required") {
                setConnection("error", "2FA required");
                const link = document.createElement("a");
                link.className = "text-sky-400 underline";
                link.href = "/mfa";
                link.textContent = "2FA Setup";
                deniedText.replaceChildren("Two-factor authentication (2FA) is required to manage accounts. Please complete ", link, ".");
            } else {
                setConnection("error", "Access denied");
                deniedText.textContent = "Administrator privileges are required to access Account Administration.";
            }

            setHeaderUser(authActionButton, user);
            setAdminNavigation(false);
        },
        onSignedOut: () => {
            state.currentUser = null;
            state.users = [];
            state.authoritativeLoaded = false;
            adminPanel.classList.add("hidden");
            deniedPanel.classList.remove("hidden");
            deniedText.textContent = "Sign in with an Administrator account is required.";
            setConnection("", "Sign in required");

            setHeaderUser(authActionButton, null);
            setAdminNavigation(false);

            showAuthModal("signIn");
        }
    });
}

initHeaderControls();
init();
