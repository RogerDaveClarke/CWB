import wixData from 'wix-data';

$w.onReady(async function () {
    // Poll Wix CMS table tracking collections for active fleet status summaries
    const results = await wixData.query("VesselTelemetry")
        .descending("timestamp")
        .limit(100)
        .find();
        
    const customMapElement = $w('#customMapWidget');
    
    // Inject structural JSON parameter variables directly into Custom Web Canvas Element
    if (results.items.length > 0) {
        customMapElement.setAttribute('vessel-data', JSON.stringify(results.items));
    }
});
