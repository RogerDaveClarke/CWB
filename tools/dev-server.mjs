import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../platforms/gcp/frontend/", import.meta.url));
const port = Number(process.env.PORT || 5173);
const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
};

const server = createServer(async (request, response) => {
    const requestPath = decodeURIComponent((request.url || "/").split("?")[0]);
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
});