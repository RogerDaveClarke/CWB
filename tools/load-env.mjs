// Minimal .env file loader with no external dependencies.
// Reads KEY=value pairs, ignores blank lines and # comments.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadEnv(relativePath) {
    const filePath = fileURLToPath(new URL(relativePath, import.meta.url));
    let contents;
    try {
        contents = readFileSync(filePath, "utf8");
    } catch {
        return {};
    }
    const env = {};
    for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const separator = line.indexOf("=");
        if (separator === -1) continue;
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) env[key] = value;
    }
    return env;
}
