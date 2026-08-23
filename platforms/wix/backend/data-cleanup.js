import wixData from 'wix-data';

export async function pruneOldTelemetry() {
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        // Find items older than 30 days
        const results = await wixData.query("VesselTelemetry")
            .lt("timestamp", thirtyDaysAgo)
            .limit(1000)
            .find();

        if (results.items.length === 0) {
            return "No expired logs found.";
        }

        const options = {
            "suppressAuth": true,
            "suppressHooks": false
        };

        // Remove expired entries loop
        for (let item of results.items) {
            await wixData.remove("VesselTelemetry", item._id, options);
        }

        return `Successfully pruned ${results.items.length} telemetry logs.`;
    } catch (err) {
        console.error("Cleanup job encountered an error: " + err.toString());
        return "Cleanup interrupted.";
    }
}
