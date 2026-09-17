import { getFirebase, beginTotpEnrollment, completeTotpEnrollment, reauthenticate, signOut, isConfigValid, revealProtectedPage } from "./auth-guard.js";

const statusEl = document.getElementById("mfaStatus");
const enrollPanel = document.getElementById("enrollPanel");
const donePanel = document.getElementById("donePanel");
const signinPanel = document.getElementById("signinPanel");
const reauthPanel = document.getElementById("reauthPanel");
const invitePanel = document.getElementById("invitePanel");
const inviteForm = document.getElementById("inviteForm");
const inviteEmail = document.getElementById("inviteEmail");
const acceptInviteButton = document.getElementById("acceptInviteButton");
const inviteMessage = document.getElementById("inviteMessage");
const reauthButton = document.getElementById("reauthButton");
const reauthMessage = document.getElementById("reauthMessage");
const qrImage = document.getElementById("qrImage");
const secretKey = document.getElementById("secretKey");
const copySecretBtn = document.getElementById("copySecretBtn");
const mfaAccountEmail = document.getElementById("mfaAccountEmail");
const mfaSetupLabel = document.getElementById("mfaSetupLabel");
const codeInput = document.getElementById("totpCode");
const verifyButton = document.getElementById("verifyButton");
const messageEl = document.getElementById("enrollMessage");

function setConnection(mode, label) {
    document.body.dataset.connection = mode;
    document.title = `${label} - CWB`;
}

function show(panel) {
    [enrollPanel, donePanel, signinPanel, reauthPanel, invitePanel].forEach(p => p?.classList.add("hidden"));
    panel?.classList.remove("hidden");
    if (window.lucide) {
        window.lucide.createIcons();
    }
}

function invitationToken() {
    return new URLSearchParams(window.location.hash.slice(1)).get("invite") || "";
}

function isReauthenticationLink() {
    return new URLSearchParams(window.location.hash.slice(1)).get("reauth") === "1";
}

function invitationFailureMessage(error, stage) {
    if (stage === "acceptance" && error?.code === "functions/failed-precondition") {
        return "This invitation link is expired, already used, or was replaced. Open the newest invitation email or ask an administrator to resend it.";
    }
    if (stage === "sign-in" && ["auth/invalid-action-code", "auth/expired-action-code"].includes(error?.code)) {
        return "This email verification link is expired or already used. Ask an administrator to resend the invitation.";
    }
    if (stage === "sign-in" && ["auth/invalid-email", "auth/user-mismatch"].includes(error?.code)) {
        return "Enter the exact email address that received this invitation.";
    }
    if (error?.code === "functions/unauthenticated") {
        return "Browser verification failed. Refresh this page and open the newest invitation link again.";
    }
    return "This invitation could not be verified. Confirm the invited email address or ask a CWB administrator for a new invitation.";
}

async function callFunction(name, data) {
    const { functions, functionsModule } = await getFirebase();
    return functionsModule.httpsCallable(functions, name)(data);
}

// Render the MFA seed entirely in-browser so it never reaches a QR service.
function renderQr(otpauthUrl) {
    qrImage.classList.add("hidden");
    const parsedUrl = new URL(otpauthUrl);
    if (parsedUrl.protocol !== "otpauth:" || parsedUrl.hostname !== "totp") {
        throw new Error("Invalid authenticator setup URL.");
    }
    const qr = window.qrcode(0, "M");
    qr.addData(parsedUrl.toString());
    qr.make();
    const imageData = qr.createDataURL(4, 0);
    if (!/^data:image\/gif;base64,[A-Za-z0-9+/=]+$/.test(imageData)) {
        throw new Error("Invalid authenticator QR image.");
    }
    const binary = atob(imageData.slice("data:image/gif;base64,".length));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "image/gif" }));
    qrImage.addEventListener("load", () => URL.revokeObjectURL(objectUrl), { once: true });
    qrImage.addEventListener("error", () => URL.revokeObjectURL(objectUrl), { once: true });
    qrImage.src = objectUrl;
    qrImage.classList.remove("hidden");
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
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(secretKey);
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand("copy");
            selection.removeAllRanges();
        }
    });
}

async function startEnrollment(user) {
    statusEl.textContent = `Setting up 2FA for ${user.email || user.uid}`;
    if (mfaAccountEmail) mfaAccountEmail.textContent = user.email || user.uid;
    setConnection("live", "Ready to enroll");
    show(enrollPanel);
    
    try {
        const { secret, qrUrl, setupId } = await beginTotpEnrollment(user, "CWB Operations");
        secretKey.textContent = secret.secretKey;
        mfaSetupLabel.textContent = `${user.email || user.uid} [setup ${setupId}]`;
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
                const token = invitationToken();
                if (token) await callFunction("completeUserInvitation", { token });
                // Mirror enrollment into the user's profile doc so admin views
                // can show 2FA state without querying Firebase Auth.
                try {
                    await callFunction("recordMfaEnrollment", {});
                } catch (err) {
                    console.warn("Could not mirror 2FA state", err);
                }
                statusEl.textContent = "2FA enabled. Sign in again to verify your authenticator.";
                setConnection("live", "Enrolled");
                await signOut();
                window.location.replace("/");
                return;
            } catch (error) {
                console.error("TOTP enrollment failed", error);
                messageEl.textContent = error.code === "auth/invalid-verification-code"
                    ? `That code does not match setup ${setupId}. In your authenticator, use the entry labeled [setup ${setupId}]. If it is missing, remove the older CWB entry and scan this QR again.`
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
            const usesGoogle = user.providerData?.some(provider => provider.providerId === "google.com");
            reauthPanel.dataset.method = usesGoogle ? "google" : "email-link";
            reauthButton.querySelector("span").textContent = usesGoogle
                ? "Continue with Google"
                : "Email a fresh verification link";
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
    const token = invitationToken();
    if (authModule.isSignInWithEmailLink(auth, window.location.href)) {
        const reauthenticationLink = isReauthenticationLink();
        if (!token && !reauthenticationLink) {
            revealProtectedPage();
            statusEl.textContent = "This sign-in link is missing its invitation or security-check context.";
            setConnection("error", "Invalid link");
            show(signinPanel);
            return;
        }
        revealProtectedPage();
        setConnection("", reauthenticationLink ? "Account verification" : "Invitation verification");
        if (reauthenticationLink) {
            invitePanel.querySelector("h2").textContent = "Confirm your CWB account";
            invitePanel.querySelector("p").textContent = "Enter the email address where this security link was delivered.";
            acceptInviteButton.querySelector("span").textContent = "Verify account";
        }
        show(invitePanel);
        inviteForm.addEventListener("submit", async event => {
            event.preventDefault();
            inviteMessage.textContent = "";
            acceptInviteButton.disabled = true;
            let verificationStage = "sign-in";
            try {
                const result = await authModule.signInWithEmailLink(auth, inviteEmail.value.trim(), window.location.href);
                const isNewUser = authModule.getAdditionalUserInfo(result)?.isNewUser === true;
                if (token) {
                    verificationStage = "acceptance";
                    try {
                        await callFunction("acceptUserInvitation", { token });
                    } catch (error) {
                        if (isNewUser) await authModule.deleteUser(result.user).catch(() => null);
                        else await authModule.signOut(auth).catch(() => null);
                        throw error;
                    }
                }
                history.replaceState(null, "", token ? `/mfa#invite=${encodeURIComponent(token)}` : "/mfa");
                await startEnrollment(result.user);
            } catch (error) {
                console.error("Invitation sign-in failed", error.code);
                inviteMessage.textContent = invitationFailureMessage(error, verificationStage);
            } finally {
                acceptInviteButton.disabled = false;
            }
        });
        return;
    }
    authModule.onAuthStateChanged(auth, async (user) => {
        revealProtectedPage();
        if (!user) {
            statusEl.textContent = "";
            setConnection("", "Signed out");
            show(signinPanel);
            return;
        }

        if (token) {
            try {
                await callFunction("acceptUserInvitation", { token });
            } catch (error) {
                console.error("Invitation acceptance failed", error.code);
                statusEl.textContent = "This invitation is invalid, expired, already used, or does not match the signed-in account. Ask a CWB administrator for a new invitation.";
                setConnection("error", "Invalid invitation");
                show(signinPanel);
                return;
            }
        }

        const enrolled = authModule.multiFactor(user).enrolledFactors;
        if (enrolled.length > 0) {
            if (token) {
                try {
                    await callFunction("completeUserInvitation", { token });
                    await signOut();
                    window.location.replace("/");
                    return;
                } catch (error) {
                    console.error("Invitation completion retry failed", error.code);
                    statusEl.textContent = "Your authenticator is enrolled, but account activation could not finish. Retry this invitation link or ask an administrator to cancel and resend it.";
                    setConnection("error", "Activation incomplete");
                    show(signinPanel);
                    return;
                }
            }
            statusEl.textContent = `Signed in as ${user.email}`;
            setConnection("live", "2FA Active");
            show(donePanel);
            return;
        }

        reauthButton.onclick = async () => {
            reauthMessage.textContent = "";
            reauthButton.disabled = true;
            const useEmailLink = reauthPanel.dataset.method === "email-link";
            reauthButton.innerHTML = `<i data-lucide="loader-2" class="h-4 w-4 animate-spin"></i><span>${useEmailLink ? "Sending link..." : "Opening Google..."}</span>`;
            if (window.lucide) window.lucide.createIcons();

            try {
                if (useEmailLink) {
                    const linkState = new URLSearchParams({ reauth: "1" });
                    if (token) linkState.set("invite", token);
                    await authModule.sendSignInLinkToEmail(auth, user.email, {
                        url: `${window.location.origin}/mfa#${linkState}`,
                        handleCodeInApp: true
                    });
                    reauthMessage.textContent = "A fresh verification link was sent. Open it in this browser to continue to QR setup.";
                } else {
                    const result = await reauthenticate(user);
                    if (result.ok) await startEnrollment(auth.currentUser || user);
                    else reauthMessage.textContent = result.error;
                }
            } catch (error) {
                console.error("Account confirmation failed", error.code);
                reauthMessage.textContent = "Could not send a fresh verification link. Ask a CWB administrator to cancel and resend the invitation.";
            } finally {
                reauthButton.disabled = false;
                reauthButton.innerHTML = `<i data-lucide="${useEmailLink ? "mail" : "log-in"}" class="h-4 w-4"></i><span>${useEmailLink ? "Email a fresh verification link" : "Continue with Google"}</span>`;
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

