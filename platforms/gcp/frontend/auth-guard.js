// Shared authentication, TOTP MFA, and role/functionLevel gating for all pages.
// Provides automated Auth Modal UI, Google Sign-In with TOTP 2FA prompt,
// and role/functionLevel verification.

import { firebaseConfig } from "./firebase-config.js";

export const ROLES = ["admin", "manager", "staff", "volunteer"];
export const FUNCTION_LEVELS = ["operations", "administration"];

const SDK = "https://www.gstatic.com/firebasejs/10.7.1";
let appModule, appCheckModule, authModule, firestoreModule, functionsModule;
let modulesPromise = null;
let cachedApp = null, cachedAuth = null, cachedDb = null, cachedFunctions = null;
let pendingMfaResolver = null;

export function isConfigValid() {
    return Boolean(firebaseConfig.projectId) && !firebaseConfig.projectId.startsWith("your-") && Boolean(firebaseConfig.apiKey);
}

export function revealProtectedPage() {
    document.documentElement.classList.remove("auth-pending");
}

async function loadModules() {
    // Fetched in parallel: these are four independent requests to gstatic and
    // awaiting them one at a time serialised the whole page start-up.
    if (!modulesPromise) {
        modulesPromise = Promise.all([
            import(`${SDK}/firebase-app.js`),
            import(`${SDK}/firebase-app-check.js`),
            import(`${SDK}/firebase-auth.js`),
            import(`${SDK}/firebase-firestore.js`),
            import(`${SDK}/firebase-functions.js`)
        ]).then(([app, appCheck, auth, firestore, functions]) => {
            appModule = app;
            appCheckModule = appCheck;
            authModule = auth;
            firestoreModule = firestore;
            functionsModule = functions;
            return { appModule, appCheckModule, authModule, firestoreModule, functionsModule };
        }).catch((error) => {
            modulesPromise = null;
            throw error;
        });
    }
    return modulesPromise;
}

export async function getFirebase() {
    const { appModule, appCheckModule, authModule, firestoreModule, functionsModule } = await loadModules();
    if (!cachedApp) {
        cachedApp = appModule.initializeApp(firebaseConfig);
        if (!firebaseConfig.appCheckSiteKey) {
            throw new Error("Firebase App Check is not configured.");
        }
        appCheckModule.initializeAppCheck(cachedApp, {
            provider: new appCheckModule.ReCaptchaEnterpriseProvider(firebaseConfig.appCheckSiteKey),
            isTokenAutoRefreshEnabled: true
        });
        cachedAuth = authModule.getAuth(cachedApp);
        cachedDb = firestoreModule.getFirestore(cachedApp);
        cachedFunctions = functionsModule.getFunctions(cachedApp, firebaseConfig.region || "us-west1");
    }
    return {
        app: cachedApp,
        auth: cachedAuth,
        db: cachedDb,
        functions: cachedFunctions,
        appModule, appCheckModule, authModule, firestoreModule, functionsModule
    };
}

export function tokenHasMfa(tokenResult) {
    const claims = tokenResult?.claims || {};
    return claims.firebase?.sign_in_second_factor === "totp"
        || claims.firebase?.second_factor_identifier != null;
}

export function claimsFromToken(tokenResult) {
    const claims = tokenResult?.claims || {};
    return {
        isAdmin: claims.admin === true && claims.role === "admin",
        role: typeof claims.role === "string" ? claims.role : null,
        functionLevel: typeof claims.functionLevel === "string" ? claims.functionLevel : null,
        email: typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "",
        emailVerified: claims.email_verified === true
    };
}

function claimsFromProfile(profile) {
    const role = typeof profile?.role === "string" ? profile.role : null;
    const functionLevel = typeof profile?.functionLevel === "string" ? profile.functionLevel : null;
    const email = typeof profile?.email === "string" ? profile.email.trim().toLowerCase() : "";
    return { isAdmin: role === "admin", role, functionLevel, email, status: profile?.status || null };
}

export async function getEffectiveUserClaims(user, db, firestoreModule, forceRefresh = false) {
    // The cached ID token already carries the claims we need on the common
    // path. Refreshing unconditionally added a token-service round-trip to
    // every page load; initAuthGuard re-reads with forceRefresh only when the
    // cached claims fail the page's requirements.
    let tokenResult = await user.getIdTokenResult(forceRefresh);
    let effectiveClaims = claimsFromToken(tokenResult);
    if (db && firestoreModule) {
        const userSnap = await firestoreModule.getDoc(firestoreModule.doc(db, "users", user.uid));
        effectiveClaims = userSnap.exists()
            ? claimsFromProfile(userSnap.data())
            : { isAdmin: false, role: null, functionLevel: null, status: null };
    }

    return {
        tokenResult,
        claims: effectiveClaims
    };
}

export function satisfies(claims, tokenResult, spec = {}, user = null) {
    if (spec.requireAdmin && !claims.isAdmin) return { ok: false, reason: "admin-required" };
    if (spec.roles && !spec.roles.includes(claims.role) && !claims.isAdmin) return { ok: false, reason: "role-required" };
    if (spec.functionLevels && !spec.functionLevels.includes(claims.functionLevel) && !claims.isAdmin) return { ok: false, reason: "function-required" };
    if (spec.requireMfa && !tokenHasMfa(tokenResult)) return { ok: false, reason: "mfa-required" };
    return { ok: true };
}

function evaluateAccess(claims, tokenResult, spec, user) {
    if (!claims.role) return { ok: false, reason: "pending-role" };
    if (claims.status !== "active") return { ok: false, reason: "session-revoked" };
    const tokenClaims = claimsFromToken(tokenResult);
    const userEmail = String(user?.email || "").trim().toLowerCase();
    if (claims.role !== tokenClaims.role
        || claims.isAdmin !== tokenClaims.isAdmin
        || claims.functionLevel !== tokenClaims.functionLevel
        || !tokenClaims.emailVerified || !claims.email
        || claims.email !== tokenClaims.email || claims.email !== userEmail) {
        return { ok: false, reason: "session-revoked" };
    }
    return satisfies(claims, tokenResult, spec, user);
}

export async function handleGoogleSignIn() {
    const { auth, authModule } = await getFirebase();
    try {
        const provider = new authModule.GoogleAuthProvider();
        // Add scopes and custom parameters to ensure proper popup behavior
        provider.addScope('email');
        provider.addScope('profile');
        provider.setCustomParameters({
            prompt: 'select_account'
        });
        const res = await authModule.signInWithPopup(auth, provider);
        return { ok: true, user: res.user };
    } catch (error) {
        console.error("Sign-in error:", error.code, error.message);
        if (error.code === "auth/multi-factor-auth-required") {
            pendingMfaResolver = authModule.getMultiFactorResolver(auth, error);
            return { ok: false, needMfa: true, resolver: pendingMfaResolver };
        }
        if (error.code === "auth/popup-blocked") {
            return { ok: false, error: "Popup was blocked. Please allow popups for this site." };
        }
        if (error.code === "auth/popup-closed-by-user") {
            return { ok: false, error: "Sign-in was cancelled." };
        }
        return { ok: false, error: error.message || "Sign in failed" };
    }
}

export async function handleMfaVerification(code) {
    if (!pendingMfaResolver) return { ok: false, error: "No pending MFA verification" };
    const { authModule } = await getFirebase();
    try {
        const hint = pendingMfaResolver.hints.find(h => h.factorId === authModule.TotpMultiFactorGenerator.FACTOR_ID) || pendingMfaResolver.hints[0];
        if (!hint) return { ok: false, error: "No TOTP factor found on account" };
        const assertion = authModule.TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code);
        await pendingMfaResolver.resolveSignIn(assertion);
        pendingMfaResolver = null;
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message || "Invalid 2FA verification code" };
    }
}

export async function signInWithGoogle() {
    return handleGoogleSignIn();
}

export async function signOut() {
    const { auth, authModule } = await getFirebase();
    return authModule.signOut(auth);
}

// ---- Auth Modal Injection and Management ----

let modalEl = null;

function injectModalStyles() {
    if (document.getElementById("cwbAuthModalStyles")) return;
    const style = document.createElement("style");
    style.id = "cwbAuthModalStyles";
    style.textContent = `
        #cwbAuthModalOverlay {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            z-index: 999999 !important;
            background: rgba(15, 23, 42, 0.92) !important;
            backdrop-filter: blur(8px) !important;
            -webkit-backdrop-filter: blur(8px) !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            padding: 1rem !important;
            box-sizing: border-box !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
        }
        #cwbAuthModalOverlay.cwb-hidden {
            display: none !important;
        }
        .cwb-auth-card {
            background: #ffffff !important;
            border-radius: 1rem !important;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4) !important;
            max-width: 440px !important;
            width: 100% !important;
            padding: 2rem !important;
            box-sizing: border-box !important;
            color: #1e293b !important;
            border: 1px solid #cbd5e1 !important;
            text-align: center !important;
        }
        .cwb-auth-badge {
            display: block !important;
            width: auto !important;
            height: 52px !important;
            max-width: 100% !important;
            object-fit: contain !important;
            margin: 0 auto 0.75rem auto !important;
        }
        .cwb-auth-title {
            font-size: 1.35rem !important;
            font-weight: 700 !important;
            color: #0f172a !important;
            margin: 0 !important;
            line-height: 1.25 !important;
        }
        .cwb-auth-subtitle {
            font-size: 0.75rem !important;
            color: #64748b !important;
            margin-top: 0.25rem !important;
            margin-bottom: 1.25rem !important;
        }
        .cwb-auth-btn-google {
            width: 100% !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 0.75rem !important;
            background: #ffffff !important;
            border: 1px solid #cbd5e1 !important;
            color: #334155 !important;
            font-weight: 600 !important;
            padding: 0.75rem 1rem !important;
            border-radius: 0.75rem !important;
            cursor: pointer !important;
            font-size: 0.95rem !important;
            box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.08) !important;
            transition: all 0.15s ease !important;
        }
        .cwb-auth-btn-google:hover {
            background: #f8fafc !important;
            border-color: #94a3b8 !important;
        }
        .cwb-auth-btn-primary {
            width: 100% !important;
            background: #2563eb !important;
            color: #ffffff !important;
            font-weight: 600 !important;
            padding: 0.75rem 1rem !important;
            border-radius: 0.75rem !important;
            border: none !important;
            cursor: pointer !important;
            font-size: 0.95rem !important;
            transition: background 0.15s ease !important;
        }
        .cwb-auth-btn-primary:hover {
            background: #1d4ed8 !important;
        }
        .cwb-auth-btn-secondary {
            width: 100% !important;
            background: #f1f5f9 !important;
            color: #334155 !important;
            font-weight: 600 !important;
            padding: 0.65rem 1rem !important;
            border-radius: 0.75rem !important;
            border: 1px solid #e2e8f0 !important;
            cursor: pointer !important;
            font-size: 0.875rem !important;
            margin-top: 0.5rem !important;
            transition: background 0.15s ease !important;
        }
        .cwb-auth-btn-secondary:hover {
            background: #e2e8f0 !important;
        }
        .cwb-auth-input {
            width: 100% !important;
            text-align: center !important;
            letter-spacing: 0.25em !important;
            font-size: 1.5rem !important;
            font-family: monospace !important;
            border: 1px solid #cbd5e1 !important;
            border-radius: 0.75rem !important;
            padding: 0.75rem 1rem !important;
            box-sizing: border-box !important;
            margin-bottom: 1rem !important;
        }
        .cwb-auth-input:focus {
            outline: none !important;
            border-color: #2563eb !important;
            box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.25) !important;
        }
        .cwb-auth-error {
            margin-top: 0.75rem !important;
            font-size: 0.8rem !important;
            color: #dc2626 !important;
            text-align: center !important;
            font-weight: 500 !important;
        }
        .cwb-auth-info {
            padding: 0.75rem 1rem !important;
            border-radius: 0.75rem !important;
            font-size: 0.8rem !important;
            text-align: left !important;
            margin-bottom: 1rem !important;
            line-height: 1.4 !important;
        }
        .cwb-auth-info.amber {
            background: #fffbeb !important;
            border: 1px solid #fef3c7 !important;
            color: #92400e !important;
        }
        .cwb-auth-info.red {
            background: #fef2f2 !important;
            border: 1px solid #fee2e2 !important;
            color: #991b1b !important;
        }
        .cwb-auth-step {
            display: block !important;
        }
        .cwb-auth-step.cwb-hidden {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
}

function ensureAuthModal() {
    injectModalStyles();
    if (modalEl) return modalEl;
    modalEl = document.createElement("div");
    modalEl.id = "cwbAuthModalOverlay";
    modalEl.className = "cwb-hidden";
    modalEl.innerHTML = `
        <div class="cwb-auth-card">
            <img class="cwb-auth-badge" src="./assets/CWBLogo.png" alt="The Center for Wooden Boats">
            <h2 class="cwb-auth-title" id="authModalTitle">Sign in to CWB Operations</h2>
            <p class="cwb-auth-subtitle">Center for Wooden Boats Fleet Management</p>

            <div id="authModalContent">
                <!-- Step: Sign In -->
                <div id="authStepSignIn" class="cwb-auth-step">
                    <p style="font-size: 0.8rem; color: #64748b; margin-bottom: 1.25rem;">Authorized staff, managers, and administrators must sign in with their account to access CWB Operations.</p>
                    <button id="authGoogleBtn" class="cwb-auth-btn-google" type="button">
                        <svg style="width:20px;height:20px;" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
                        <span>Sign In</span>
                    </button>
                </div>

                <!-- Step: TOTP 2FA -->
                <div id="authStepMfa" class="cwb-auth-step cwb-hidden">
                    <p style="font-size: 0.8rem; color: #475569; margin-bottom: 1rem;">Two-factor authentication required. Enter the 6-digit verification code from your authenticator app.</p>
                    <input id="authTotpInput" class="cwb-auth-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" placeholder="000000">
                    <button id="authVerifyMfaBtn" class="cwb-auth-btn-primary" type="button">Verify & Sign In</button>
                </div>

                <!-- Step: Pending Role Assignment -->
                <div id="authStepPendingRole" class="cwb-auth-step cwb-hidden">
                    <div class="cwb-auth-info amber">
                        Signed in as <strong id="authPendingEmail"></strong>.<br>Your account requires an invitation from a CWB Administrator before you can access operations.
                    </div>
                    <button id="authSignOutBtn1" class="cwb-auth-btn-secondary" type="button">Sign Out</button>
                </div>

                <!-- Step: Access Denied / Wrong Role -->
                <div id="authStepDenied" class="cwb-auth-step cwb-hidden">
                    <div class="cwb-auth-info red" id="authDeniedMsg">
                        Your account does not have permission to access this page.
                    </div>
                    <button id="authSignOutBtn2" class="cwb-auth-btn-secondary" type="button">Sign Out</button>
                </div>

                <!-- Step: Configuration Error -->
                <div id="authStepError" class="cwb-auth-step cwb-hidden">
                    <div class="cwb-auth-info red" id="authErrorMsg">
                        Application configuration error. Please contact administrator.
                    </div>
                </div>
            </div>

            <div id="authModalError" class="cwb-auth-error cwb-hidden"></div>
        </div>
    `;
    document.body.appendChild(modalEl);

    // Event listeners inside modal
    const googleBtn = modalEl.querySelector("#authGoogleBtn");
    const totpInput = modalEl.querySelector("#authTotpInput");
    const verifyMfaBtn = modalEl.querySelector("#authVerifyMfaBtn");
    const errorEl = modalEl.querySelector("#authModalError");

    function showError(msg) {
        if (!msg) { errorEl.classList.add("cwb-hidden"); errorEl.textContent = ""; }
        else { errorEl.textContent = msg; errorEl.classList.remove("cwb-hidden"); }
    }

    googleBtn.addEventListener("click", async () => {
        showError("");
        googleBtn.disabled = true;
        const res = await handleGoogleSignIn();
        googleBtn.disabled = false;
        if (res.needMfa) {
            showStep("mfa");
        } else if (!res.ok) {
            showError(res.error);
        }
    });

    verifyMfaBtn.addEventListener("click", async () => {
        showError("");
        const code = totpInput.value.trim();
        if (!/^\d{6}$/.test(code)) { showError("Enter a 6-digit code."); return; }
        verifyMfaBtn.disabled = true;
        const res = await handleMfaVerification(code);
        verifyMfaBtn.disabled = false;
        if (!res.ok) { showError(res.error); }
    });

    totpInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") verifyMfaBtn.click();
    });

    modalEl.querySelector("#authSignOutBtn1").addEventListener("click", signOut);
    modalEl.querySelector("#authSignOutBtn2").addEventListener("click", signOut);

    return modalEl;
}

export function showAuthModal(step = "signIn", details = {}) {
    const modal = ensureAuthModal();
    modal.classList.remove("cwb-hidden");
    showStep(step, details);
}

export function hideAuthModal() {
    if (modalEl) modalEl.classList.add("cwb-hidden");
}

function showStep(stepName, details = {}) {
    const modal = ensureAuthModal();
    const steps = ["signIn", "mfa", "pendingRole", "denied", "error"];
    steps.forEach(s => {
        const el = modal.querySelector(`#authStep${s.charAt(0).toUpperCase() + s.slice(1)}`);
        if (el) el.classList.add("cwb-hidden");
    });

    const errorEl = modal.querySelector("#authModalError");
    if (errorEl) {
        errorEl.classList.add("cwb-hidden");
        errorEl.textContent = "";
    }

    const titleEl = modal.querySelector("#authModalTitle");
    const target = modal.querySelector(`#authStep${stepName.charAt(0).toUpperCase() + stepName.slice(1)}`);
    if (target) target.classList.remove("cwb-hidden");

    if (stepName === "signIn") {
        titleEl.textContent = "Sign in to CWB Operations";
    } else if (stepName === "mfa") {
        titleEl.textContent = "Two-Factor Verification";
    } else if (stepName === "pendingRole") {
        titleEl.textContent = "Pending Role Assignment";
        const emailEl = modal.querySelector("#authPendingEmail");
        if (emailEl) emailEl.textContent = details.email || "your account";
    } else if (stepName === "denied") {
        titleEl.textContent = "Access Restricted";
        if (details.message) {
            const msgEl = modal.querySelector("#authDeniedMsg");
            if (msgEl) msgEl.textContent = details.message;
        }
    } else if (stepName === "error") {
        titleEl.textContent = "Configuration Error";
        const errEl = modal.querySelector("#authErrorMsg");
        if (errEl) errEl.textContent = details.message || "Application configuration error.";
    }
}

// Main Guard initializer:
// Auto-prompts sign-in / 2FA modal if user is not signed in or fails requirements.
export async function initAuthGuard(spec, { onReady, onDenied, onSignedOut }) {
    if (!isConfigValid()) {
        console.warn("Firebase config not valid, cannot authenticate");
        showAuthModal("error", { message: "Application not configured. Please contact administrator." });
        return () => {};
    }

    try {
        const { auth, authModule, db, firestoreModule, functions } = await getFirebase();
        let profileUnsubscribe = null;
        let offlineHandler = null;
        let forcingExit = false;

        const stopProfileWatch = () => {
            profileUnsubscribe?.();
            profileUnsubscribe = null;
            if (offlineHandler) window.removeEventListener("offline", offlineHandler);
            offlineHandler = null;
        };

        const forceSessionExit = async (reason, claims = {}) => {
            if (forcingExit) return;
            forcingExit = true;
            document.documentElement.classList.add("auth-pending");
            stopProfileWatch();
            onDenied?.(reason, null, claims);
            try {
                const reportExit = functionsModule.httpsCallable(functions, "reportSessionExit")({ reason });
                await Promise.race([
                    reportExit.catch(() => null),
                    new Promise(resolve => setTimeout(resolve, 500))
                ]);
                await Promise.race([
                    authModule.signOut(auth).catch(() => null),
                    new Promise(resolve => setTimeout(resolve, 1500))
                ]);
            } finally {
                window.location.replace("/");
            }
        };

        const watchLiveProfile = (user, tokenResult) => new Promise(resolve => {
            stopProfileWatch();
            let initialSnapshot = true;
            const profileRef = firestoreModule.doc(db, "users", user.uid);
            profileUnsubscribe = firestoreModule.onSnapshot(profileRef, snapshot => {
                const profile = snapshot.exists() ? snapshot.data() : null;
                const claims = profile
                    ? claimsFromProfile(profile)
                    : { isAdmin: false, role: null, functionLevel: null, status: null };
                const profileEmail = String(profile?.email || "").trim().toLowerCase();
                const signedInEmail = String(user.email || "").trim().toLowerCase();
                const tokenClaims = claimsFromToken(tokenResult);
                const claimsMatch = claims.role === tokenClaims.role
                    && claims.isAdmin === tokenClaims.isAdmin
                    && claims.functionLevel === tokenClaims.functionLevel
                    && tokenClaims.emailVerified && profileEmail === tokenClaims.email;
                const check = claims.status === "active" && profileEmail && profileEmail === signedInEmail && claimsMatch
                    ? satisfies(claims, tokenResult, spec, user)
                    : { ok: false, reason: "session-revoked" };
                if (!check.ok) {
                    if (initialSnapshot) resolve(false);
                    initialSnapshot = false;
                    void forceSessionExit(check.reason || "session-revoked", claims);
                    return;
                }
                if (initialSnapshot) resolve(true);
                initialSnapshot = false;
            }, () => {
                if (initialSnapshot) resolve(false);
                initialSnapshot = false;
                void forceSessionExit("session-revoked");
            });
            offlineHandler = () => void forceSessionExit("session-unverifiable");
            window.addEventListener("offline", offlineHandler);
        });

        const handleAuthStateChange = async (user) => {
            if (!user) {
                stopProfileWatch();
                showAuthModal("signIn");
                onSignedOut?.();
                return;
            }

            let { tokenResult, claims } = await getEffectiveUserClaims(user, db, firestoreModule);
            let check = evaluateAccess(claims, tokenResult, spec, user);

            // A stale cached token is the most likely reason for a first-pass
            // failure (claims were changed since the token was minted), so pay
            // for the forced refresh only on that path.
            if (!check.ok) {
                ({ tokenResult, claims } = await getEffectiveUserClaims(user, db, firestoreModule, true));
                check = evaluateAccess(claims, tokenResult, spec, user);
            }

            if (check.reason === "pending-role") {
                showAuthModal("pendingRole", { email: user.email });
                onDenied?.("pending-role", user, claims);
                return;
            }

            if (check.reason === "session-revoked") {
                await forceSessionExit("session-revoked", claims);
                return;
            }

            if (check.reason === "mfa-required") {
                window.location.replace("/mfa");
                return;
            }

            if (check.ok) {
                if (!await watchLiveProfile(user, tokenResult)) return;
                revealProtectedPage();
                hideAuthModal();
                // Record/increment login session in Firestore users collection.
                // Deliberately not awaited: the page has everything it needs to
                // start loading, and this write only feeds admin reporting.
                try {
                    const sessionKey = `cwb_logged_session_${user.uid}`;
                    const lastSessionTime = sessionStorage.getItem(sessionKey);
                    const now = Date.now();
                    // Increment login count once per browser session or if 30+ mins since last recorded in session
                    if (!lastSessionTime || (now - Number(lastSessionTime) > 30 * 60 * 1000)) {
                        sessionStorage.setItem(sessionKey, String(now));
                        functionsModule.httpsCallable(functions, "recordUserLogin")({})
                            .catch((err) => console.warn("Could not record login metadata", err));
                    }
                } catch (err) {
                    console.warn("Could not record login metadata", err);
                }
                onReady?.({ user, claims, tokenResult, db, functions });
            } else {
                let msg = "Your account does not have permission to access this page.";
                if (check.reason === "role-required") {
                    msg = `Role restricted. Allowed roles: ${(spec.roles || []).join(", ")}. Your role: ${claims.role || "none"}.`;
                } else if (check.reason === "function-required") {
                    msg = `Function level restricted. Allowed levels: ${(spec.functionLevels || []).join(", ")}. Your level: ${claims.functionLevel || "none"}.`;
                } else if (check.reason === "mfa-required") {
                    msg = `Two-factor authentication (2FA) is required.`;
                }
                showAuthModal("denied", { message: msg });
                onDenied?.(check.reason, user, claims);
            }
        };

        return authModule.onAuthStateChanged(auth, user => {
            void handleAuthStateChange(user).catch(error => {
                console.error("Authentication state verification failed", error);
                void forceSessionExit("session-unverifiable");
            });
        });
    } catch (error) {
        console.error("Auth guard initialization failed:", error);
        showAuthModal("error", { message: `Authentication system error: ${error.message}` });
        return () => {};
    }
}

// ---- TOTP enrollment helpers (used by mfa.html) ----

// Firebase requires a recent credential before a second factor may be added.
// Re-running the Google popup refreshes it without a full sign-out.
export async function reauthenticate(user) {
    const { authModule } = await getFirebase();
    try {
        const provider = new authModule.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account", login_hint: user.email || "" });
        await authModule.reauthenticateWithPopup(user, provider);
        return { ok: true };
    } catch (error) {
        console.error("Reauthentication failed", error.code, error.message);
        if (error.code === "auth/popup-blocked") {
            return { ok: false, error: "Popup was blocked. Allow popups for this site and try again." };
        }
        if (error.code === "auth/popup-closed-by-user" || error.code === "auth/cancelled-popup-request") {
            return { ok: false, error: "Confirmation was cancelled." };
        }
        return { ok: false, error: error.message || "Could not confirm your identity." };
    }
}

export async function beginTotpEnrollment(user, displayName = "CWB Tracker") {
    const { authModule } = await getFirebase();
    const mfaUser = authModule.multiFactor(user);
    const session = await mfaUser.getSession();
    const secret = await authModule.TotpMultiFactorGenerator.generateSecret(session);
    const setupId = crypto.randomUUID().slice(0, 6).toUpperCase();
    const account = `${user.email || user.uid} [setup ${setupId}]`;
    const qrUrl = secret.generateQrCodeUrl(account, displayName);
    return { session, secret, qrUrl, setupId };
}

export async function completeTotpEnrollment(user, secret, code, label = "Authenticator") {
    const { authModule } = await getFirebase();
    const assertion = authModule.TotpMultiFactorGenerator.assertionForEnrollment(secret, code);
    await authModule.multiFactor(user).enroll(assertion, label);
}

export async function resolveMfaSignIn(resolver, code) {
    const { authModule } = await getFirebase();
    const hint = resolver.hints.find(h => h.factorId === authModule.TotpMultiFactorGenerator.FACTOR_ID) || resolver.hints[0];
    const assertion = authModule.TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code);
    return resolver.resolveSignIn(assertion);
}
