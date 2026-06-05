import { db, collection, onSnapshot, parseFirestoreTimestamp } from './firebase-config.js';

const map = L.map('map', {
    maxZoom: 24,
    minZoom: 3,          
    worldCopyJump: true 
}).setView([-6.2, 106.8], 13);

const lightStyle = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
    attribution: '© OSM',
    maxZoom: 24,
    maxNativeZoom: 19
});

const darkStyle = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
    attribution: '© CARTO',
    maxZoom: 24,
    maxNativeZoom: 19
});

let heatmapLayer = null; 
let markerLayer = L.layerGroup().addTo(map);
let allDetections = [];
let mapInitialized = false;

const modeBtn = document.getElementById('mode-toggle');
let isDark = localStorage.getItem('darkMode') === 'true';

function updateTheme() {
    if (isDark) {
        document.body.classList.add('dark-mode');
        if (modeBtn) modeBtn.textContent = '☀️';
        map.removeLayer(lightStyle);
        darkStyle.addTo(map);
    } else {
        document.body.classList.remove('dark-mode');
        if (modeBtn) modeBtn.textContent = '🌙';
        map.removeLayer(darkStyle);
        lightStyle.addTo(map);
    }
}
updateTheme();

if (modeBtn) {
    modeBtn.addEventListener('click', () => {
        isDark = !isDark;
        localStorage.setItem('darkMode', isDark);
        updateTheme();
    });
}

onSnapshot(collection(db, "waste_detections_v2"), (snapshot) => {
    allDetections = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    applyFilter();
});

function applyFilter() {
    const activeBtn = document.querySelector('.time-button.active');
    const filterType = activeBtn ? activeBtn.getAttribute('data-filter') : 'all';
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    const filtered = allDetections.filter(d => {
        const dTime = parseFirestoreTimestamp(d.timestamp);
        if (filterType === 'today') return (now - dTime) <= oneDay;
        if (filterType === 'week') return (now - dTime) <= (7 * oneDay);
        return true; 
    });

    renderSmoothHeatmap(filtered);
}

function renderSmoothHeatmap(data) {
    if (heatmapLayer) map.removeLayer(heatmapLayer);
    markerLayer.clearLayers();
    
    if (data.length === 0) return;

    const changedDataFormat = {
        max: 5, 
        data: data.map(d => {
            return {
                lat: d.latitude,
                lng: d.longitude,
                count: 1 
            };
        })
    };

    var cfg = {
        "radius": 25, 
        "maxOpacity": 0.85,
        "scaleRadius": false, 
        "useLocalExtrema": false,
        latField: 'lat',
        lngField: 'lng',
        valueField: 'count',
        gradient: {
            '0.1': 'blue',
            '0.4': 'cyan',
            '0.6': 'lime',
            '0.8': 'yellow',
            '1.0': 'red'
        }
    };

    heatmapLayer = new HeatmapOverlay(cfg);
    heatmapLayer.setData(changedDataFormat);
    map.addLayer(heatmapLayer);

    if (map.getZoom() > 16) {
        data.forEach(d => {
            L.circleMarker([d.latitude, d.longitude], {
                radius: 3, color: '#fff', weight: 1, fillColor: '#000', fillOpacity: 1
            }).addTo(markerLayer).bindPopup(`<b>${d.label}</b><br>${d.confidence}%`);
        });
    }

    if (!mapInitialized) {
        const lats = data.map(d => d.latitude);
        const lons = data.map(d => d.longitude);
        const bounds = [
            [Math.min(...lats), Math.min(...lons)],
            [Math.max(...lats), Math.max(...lons)]
        ];
        map.fitBounds(bounds, { padding: [50, 50] });
        mapInitialized = true;
    }
}

document.querySelectorAll('.time-button').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.time-button').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        applyFilter();
    });
});

map.on('zoomend', applyFilter);