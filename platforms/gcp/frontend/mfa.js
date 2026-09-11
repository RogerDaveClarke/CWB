import { getFirebase, beginTotpEnrollment, completeTotpEnrollment, reauthenticate, isConfigValid, revealProtectedPage } from "./auth-guard.js";

const statusEl = document.getElementById("mfaStatus");
const mfaConnection = document.getElementById("mfaConnection");
const enrollPanel = document.getElementById("enrollPanel");
const donePanel = document.getElementById("donePanel");
const signinPanel = document.getElementById("signinPanel");
const reauthPanel = document.getElementById("reauthPanel");
const reauthButton = document.getElementById("reauthButton");
const reauthMessage = document.getElementById("reauthMessage");
const qrBox = document.getElementById("qrBox");
const secretKey = document.getElementById("secretKey");
const copySecretBtn = document.getElementById("copySecretBtn");
const mfaAccountEmail = document.getElementById("mfaAccountEmail");
const codeInput = document.getElementById("totpCode");
const verifyButton = document.getElementById("verifyButton");
const messageEl = document.getElementById("enrollMessage");

function setConnection(mode, label) {
    if (!mfaConnection) return;
    mfaConnection.className = `connection-pill ${mode}`;
    mfaConnection.innerHTML = `<span class="status-dot"></span><span class="hidden sm:inline">${label}</span>`;
}

function show(panel) {
    [enrollPanel, donePanel, signinPanel, reauthPanel].forEach(p => p?.classList.add("hidden"));
    panel?.classList.remove("hidden");
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

// Render the MFA seed entirely in-browser so it never reaches a QR service.
function renderQr(otpauthUrl) {
    qrBox.replaceChildren();
    const qr = window.qrcode(0, "M");
    qr.addData(otpauthUrl);
    qr.make();
    const img = document.createElement("img");
    img.alt = "Scan with your authenticator app";
    img.width = 160;
    img.height = 160;
    img.className = "rounded block";
    img.src = qr.createDataURL(4, 0);
    qrBox.appendChild(img);
}

// Auto-format OTP input with clean UX (numbers only, auto-submit on 6 digits)
function setupCodeInput() {
    codeInput.addEventListener("input", (e) => {
        codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 6);
        if (codeInput.value.length === 6 && !verifyButton.disabled) {
            verifyButton.click();
        }
    });

    copySecretBtn?.addEventListener("click", async () => {
        const key = secretKey.textContent;
        if (!key) return;
        try {
            await navigator.clipboard.writeText(key);
            const originalHTML = copySecretBtn.innerHTML;
            copySecretBtn.innerHTML = `<i data-lucide="check" class="h-3.5 w-3.5 text-emerald-400"></i><span class="text-emerald-400">Copied!</span>`;
            if (window.lucide) window.lucide.createIcons();
            setTimeout(() => {
                copySecretBtn.innerHTML = originalHTML;
                if (window.lucide) window.lucide.createIcons();
            }, 2000);
        } catch {
            // fallback
            const textarea = document.createElement("textarea");
            textarea.value = key;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
        }
    });
}

async function startEnrollment(user) {
    statusEl.textContent = `Setting up 2FA for ${user.email || user.uid}`;
    if (mfaAccountEmail) mfaAccountEmail.textContent = user.email || user.uid;
    setConnection("live", "Ready to enroll");
    show(enrollPanel);
    
    try {
        const { secret, qrUrl } = await beginTotpEnrollment(user, "CWB Operations");
        secretKey.textContent = secret.secretKey;
        renderQr(qrUrl);
        codeInput.value = "";
        codeInput.focus();

        verifyButton.onclick = async () => {
            messageEl.textContent = "";
            const code = codeInput.value.trim();
            if (!/^\d{6}$/.test(code)) {
                messageEl.textContent = "Please enter the 6-digit verification code from your authenticator app.";
                codeInput.focus();
                return;
            }
            
            verifyButton.disabled = true;
            verifyButton.innerHTML = `<i data-lucide="loader-2" class="h-4 w-4 animate-spin"></i><span>Verifying...</span>`;
            if (window.lucide) window.lucide.createIcons();

            try {
                await completeTotpEnrollment(user, secret, code);
                // Mirror enrollment into the user's profile doc so admin views
                // can show 2FA state without querying Firebase Auth.
                try {
                    const { db, firestoreModule } = await getFirebase();
                    firestoreModule.setDoc(firestoreModule.doc(db, "users", user.uid), {
                        email: user.email || "",
                        mfaEnrolled: true
                    }, { merge: true }).catch((err) => console.warn("Could not mirror 2FA state", err));
                } catch (err) {
                    console.warn("Could not mirror 2FA state", err);
                }
                statusEl.textContent = "";
                setConnection("live", "Enrolled");
                show(donePanel);
            } catch (error) {
                console.error("TOTP enrollment failed", error);
                messageEl.textContent = error.code === "auth/invalid-verification-code"
                    ? "Invalid verification code. Check that your device clock is synchronized and try again."
                    : `Enrollment failed: ${error.message || "Unknown error"}`;
                codeInput.select();
            } finally {
                verifyButton.disabled = false;
                verifyButton.innerHTML = `<i data-lucide="check-circle" class="h-4 w-4"></i><span>Verify Code & Enable 2FA</span>`;
                if (window.lucide) window.lucide.createIcons();
            }
        };
    } catch (error) {
        console.error("Could not start TOTP enrollment", error);
        if (error.code === "auth/requires-recent-login") {
            statusEl.textContent = "";
            reauthMessage.textContent = "";
            setConnection("", "Security check");
            show(reauthPanel);
            return;
        }
        setConnection("error", "Error");
        statusEl.textContent = error.code === "auth/operation-not-allowed"
            ? "TOTP authentication is not enabled in Firebase Identity Platform."
            : "Could not start enrollment. Please refresh and try again.";
    }
}

async function init() {
    setupCodeInput();

    if (!isConfigValid()) {
        statusEl.textContent = "Firebase is not configured. Check configuration.";
        setConnection("error", "Config error");
        revealProtectedPage();
        return;
    }

    const { auth, authModule } = await getFirebase();
    authModule.onAuthStateChanged(auth, async (user) => {
        revealProtectedPage();
        if (!user) {
            statusEl.textContent = "";
            setConnection("", "Signed out");
            show(signinPanel);
            return;
        }

        const enrolled = authModule.multiFactor(user).enrolledFactors;
        if (enrolled.length > 0) {
            statusEl.textContent = `Signed in as ${user.email}`;
            setConnection("live", "2FA Active");
            show(donePanel);
            return;
        }

        reauthButton.onclick = async () => {
            reauthMessage.textContent = "";
            reauthButton.disabled = true;
            reauthButton.innerHTML = `<i data-lucide="loader-2" class="h-4 w-4 animate-spin"></i><span>Confirming...</span>`;
            if (window.lucide) window.lucide.createIcons();

            try {
                const result = await reauthenticate(user);
                if (result.ok) {
                    await startEnrollment(auth.currentUser || user);
                } else {
                    reauthMessage.textContent = result.error;
                }
            } finally {
                reauthButton.disabled = false;
                reauthButton.innerHTML = `<i data-lucide="check" class="h-4 w-4"></i><span>Confirm Identity</span>`;
                if (window.lucide) window.lucide.createIcons();
            }
        };

        await startEnrollment(user);
    });
}

init().catch(() => {
    statusEl.textContent = "Authentication could not be initialized. Please refresh and try again.";
    setConnection("error", "Authentication error");
    revealProtectedPage();
});

