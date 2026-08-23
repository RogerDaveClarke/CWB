class LeafletMapElement extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.map = null;
        this.markers = {};
    }

    connectedCallback() {
        this.shadowRoot.innerHTML = `
            <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
            <style>
                #map-container { width: 100%; height: 100%; min-height: 500px; border-radius: 8px; }
            </style>
            <div id="map-container"></div>
        `;

        // Inject Leaflet JavaScript Core Script directly into Wix DOM sandbox layout context
        const script = document.createElement('script');
        script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
        script.onload = () => this.initMap();
        document.head.appendChild(script);
    }

    static get observedAttributes() {
        return ['vessel-data'];
    }

    attributeChangedCallback(name, oldVal, newVal) {
        if (name === 'vessel-data' && this.map && newVal) {
            this.updateMarkers(JSON.parse(newVal));
        }
    }

    initMap() {
        const container = this.shadowRoot.getElementById('map-container');
        // Center view near Seattle Lake Union coordinates
        this.map = L.map(container).setView([47.6254, -122.3344], 14);
        
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.map);
    }

    updateMarkers(vessels) {
        vessels.forEach(vessel => {
            const { title, latitude, longitude, statusString, batteryMv } = vessel;
            if (!latitude || !longitude) return;

            if (this.markers[title]) {
                this.markers[title].setLatLng([latitude, longitude]);
            } else {
                this.markers[title] = L.marker([latitude, longitude]).addTo(this.map);
            }
            
            this.markers[title].bindPopup(`
                <strong>Vessel ID: ${title}</strong><br>
                Status: ${statusString}<br>
                Battery: ${batteryMv} mV
            `);
        });
    }
}
customElements.define('leaflet-map-element', LeafletMapElement);
