import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.mjs";

const frontendRoot = fileURLToPath(new URL("../platforms/gcp/frontend/", import.meta.url)).replace(/[\\/]$/, "");
const env = loadEnv("../local.env");
const port = Number(process.env.PORT || env.PORT || 5173);
const maxConcurrentRequests = 32;
let activeRequests = 0;

// Build the firebase-config.js module from local.env so secrets stay out of the repo.
function firebaseConfigModule() {
    const config = {
        apiKey: env.FIREBASE_API_KEY || "",
        authDomain: env.FIREBASE_AUTH_DOMAIN || "",
        projectId: env.FIREBASE_PROJECT_ID || "",
        storageBucket: env.FIREBASE_STORAGE_BUCKET || "",
        messagingSenderId: env.FIREBASE_MESSAGING_SENDER_ID || "",
        appId: env.FIREBASE_APP_ID || "",
        region: env.GCP_REGION || env.FIREBASE_REGION || "us-west1"
    };
    return `// Generated at runtime from local.env - do not edit.\nexport const firebaseConfig = ${JSON.stringify(config, null, 2)};\n`;
}

const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
    if (activeRequests >= maxConcurrentRequests) {
        response.writeHead(503, { "Retry-After": "1" });
        response.end("Server busy");
        return;
    }
    activeRequests += 1;
    response.once("close", () => { activeRequests -= 1; });
    const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);

    if (requestPath === "/firebase-config.js") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        response.end(firebaseConfigModule());
        return;
    }

    const relativePath = requestPath === "/" ? "/index.html" : requestPath;
    const filePath = normalize(join(frontendRoot, relativePath));

    if (!filePath.startsWith(frontendRoot + sep)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
    }

    try {
        const fileStats = await stat(filePath);
        if (!fileStats.isFile()) {
            response.writeHead(404);
            response.end("Not found");
            return;
        }

        response.writeHead(200, {
            "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
        });
        createReadStream(filePath).pipe(response);
    } catch {
        response.writeHead(404);
        response.end("Not found");
    }
});

server.listen(port, "127.0.0.1", () => {
    console.log(`CWB frontend available at http://localhost:${port}/`);
    console.log(env.FIREBASE_PROJECT_ID ? `Firebase project: ${env.FIREBASE_PROJECT_ID}` : "local.env not configured - pages will run in demo mode");
});

server.requestTimeout = 10_000;
server.headersTimeout = 5_000;
server.maxRequestsPerSocket = 100;