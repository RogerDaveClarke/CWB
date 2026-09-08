import { getFirebase, beginTotpEnrollment, completeTotpEnrollment, reauthenticate, isConfigValid } from "./auth-guard.js";

const statusEl = document.getElementById("mfaStatus");
const enrollPanel = document.getElementById("enrollPanel");
const donePanel = document.getElementById("donePanel");
const signinPanel = document.getElementById("signinPanel");
const reauthPanel = document.getElementById("reauthPanel");
const reauthButton = document.getElementById("reauthButton");
const reauthMessage = document.getElementById("reauthMessage");
const qrBox = document.getElementById("qrBox");
const secretKey = document.getElementById("secretKey");
const codeInput = document.getElementById("totpCode");
const verifyButton = document.getElementById("verifyButton");
const messageEl = document.getElementById("enrollMessage");

function show(panel) {
    [enrollPanel, donePanel, signinPanel, reauthPanel].forEach(p => p?.classList.add("hidden"));
    panel?.classList.remove("hidden");
}

// Render a QR code as an image using the otpauth URL via a simple canvas-free
// approach: Google Charts is deprecated, so we build an SVG QR via the qrcode
// data the authenticator expects. To avoid a new dependency we render the URL
// into an <img> using a lightweight inline QR generator fallback message.
function renderQr(otpauthUrl) {
    qrBox.innerHTML = "";
    const img = document.createElement("img");
    img.alt = "Scan with your authenticator app";
    img.width = 180;
    img.height = 180;
    // Use the well-known qrserver image API for rendering only; the otpauth URL
    // never leaves the page otherwise. If offline, the manual key still works.
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(otpauthUrl)}`;
    img.onerror = () => {
        qrBox.innerHTML = `<p class="text-xs text-slate-500 text-center">QR unavailable.<br>Use the manual setup key below.</p>`;
    };
    qrBox.appendChild(img);
}

async function startEnrollment(user) {
    statusEl.textContent = `Signed in as ${user.email || user.uid}.`;
    show(enrollPanel);
    try {
        const { secret, qrUrl } = await beginTotpEnrollment(user);
        secretKey.textContent = secret.secretKey;
        renderQr(qrUrl);
        verifyButton.onclick = async () => {
            messageEl.textContent = "";
            const code = codeInput.value.trim();
            if (!/^\d{6}$/.test(code)) { messageEl.textContent = "Enter the 6-digit code from your app."; return; }
            verifyButton.disabled = true;
            try {
                await completeTotpEnrollment(user, secret, code);
                statusEl.textContent = "";
                show(donePanel);
            } catch (error) {
                console.error("TOTP enrollment failed", error);
                messageEl.textContent = error.code === "auth/invalid-verification-code"
                    ? "That code did not work. Check your device clock and try again."
                    : "Enrollment failed. Try again.";
            } finally {
                verifyButton.disabled = false;
            }
        };
    } catch (error) {
        console.error("Could not start TOTP enrollment", error);
        if (error.code === "auth/requires-recent-login") {
            statusEl.textContent = "";
            reauthMessage.textContent = "";
            show(reauthPanel);
            return;
        }
        statusEl.textContent = error.code === "auth/operation-not-allowed"
            ? "TOTP is not enabled for this project. Enable multi-factor authentication in Firebase."
            : "Could not start enrollment. Try again, or contact an administrator.";
    }
}

async function init() {
    if (!isConfigValid()) {
        statusEl.textContent = "Firebase is not configured. Check local.env.";
        return;
    }
    const { auth, authModule } = await getFirebase();
    authModule.onAuthStateChanged(auth, async (user) => {
        if (!user) {
            statusEl.textContent = "";
            show(signinPanel);
            return;
        }
        const enrolled = authModule.multiFactor(user).enrolledFactors;
        if (enrolled.length > 0) {
            statusEl.textContent = "";
            show(donePanel);
            return;
        }

        reauthButton.onclick = async () => {
            reauthMessage.textContent = "";
            reauthButton.disabled = true;
            try {
                const result = await reauthenticate(user);
                if (result.ok) {
                    await startEnrollment(auth.currentUser || user);
                } else {
                    reauthMessage.textContent = result.error;
                }
            } finally {
                reauthButton.disabled = false;
            }
        };

        await startEnrollment(user);
    });
}

init();
