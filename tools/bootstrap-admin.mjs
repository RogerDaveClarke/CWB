#!/usr/bin/env node
// Grant the first administrator their admin claim. Run once against a project
// where BOOTSTRAP_ADMIN_EMAIL has already signed in at least once.
//
//   node tools/bootstrap-admin.mjs              (uses local.env)
//   node tools/bootstrap-admin.mjs production   (uses production.env)
//
// Requires GOOGLE_APPLICATION_CREDENTIALS to point at a service-account key
// with the Firebase Admin SDK role, or application-default credentials.
import { loadEnv } from "./load-env.mjs";

const target = process.argv[2] === "production" ? "../production.env" : "../local.env";
const env = loadEnv(target);
const email = env.BOOTSTRAP_ADMIN_EMAIL;
const projectId = env.FIREBASE_PROJECT_ID;

if (!email) {
    console.error(`BOOTSTRAP_ADMIN_EMAIL is not set in ${target.replace("../", "")}.`);
    process.exit(1);
}

const { initializeApp, cert, applicationDefault } = await import("firebase-admin/app");
const { getAuth } = await import("firebase-admin/auth");
const { getFirestore, FieldValue } = await import("firebase-admin/firestore");

const credential = env.GOOGLE_APPLICATION_CREDENTIALS ? cert(env.GOOGLE_APPLICATION_CREDENTIALS) : applicationDefault();
initializeApp({ credential, projectId });

const auth = getAuth();
try {
    const user = await auth.getUserByEmail(email);
    const existing = user.customClaims || {};
    await auth.setCustomUserClaims(user.uid, { ...existing, admin: true, role: "admin", functionLevel: "operations" });

    // Mirror the claim into the users collection so the account admin UI and
    // the Firestore rules see the same profile as UI-created accounts.
    await getFirestore().collection("users").doc(user.uid).set({
        email: user.email || email,
        displayName: user.displayName || "",
        role: "admin",
        functionLevel: "operations",
        status: "active",
        mfaEnrolled: (user.multiFactor?.enrolledFactors || []).length > 0,
        updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`Granted admin claim to ${email} (uid ${user.uid}).`);
    console.log("Wrote users/" + user.uid + " profile document.");
    console.log("They must sign out and sign back in for the claim to take effect.");
} catch (error) {
    if (error.code === "auth/user-not-found") {
        console.error(`No user with email ${email} exists yet. Have them sign in once first.`);
    } else {
        console.error("Bootstrap failed:", error.message);
    }
    process.exit(1);
}
