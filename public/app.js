import { db, collection, onSnapshot, parseFirestoreTimestamp } from './firebase-config.js';

let map;
let heatmapLayer = null; 
let markers = [];
let allDetections = [];
let mapInitialized = false;
let infoWindow = null; // Variabel disiapkan di sini

// 1. Konfigurasi Dark Mode untuk Google Maps
const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ visibility: "off" }] } 
];

const modeBtn = document.getElementById('mode-toggle');
let isDark = localStorage.getItem('darkMode') === 'true';

function updateTheme() {
    if (isDark) {
        document.body.classList.add('dark-mode');
        if (modeBtn) modeBtn.textContent = '☀️';
        if (map) map.setOptions({ styles: darkMapStyle });
    } else {
        document.body.classList.remove('dark-mode');
        if (modeBtn) modeBtn.textContent = '🌙';
        if (map) map.setOptions({ styles: [] }); 
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

// 2. Fungsi Utama Inisialisasi Google Maps
function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: -6.2, lng: 106.8 },
        zoom: 13,
        minZoom: 5,        
        maxZoom: 22,       
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false
    });

    updateTheme(); 

    // PENTING: InfoWindow diinisialisasi SETELAH map siap
    infoWindow = new google.maps.InfoWindow();

    // INISIALISASI HEATMAP SATU KALI SAJA
    heatmapLayer = new google.maps.visualization.HeatmapLayer({
        data: [],
        map: map,
        radius: 35, 
        opacity: 0.8,
        gradient: [
            'rgba(0, 0, 255, 0)',
            'rgba(0, 255, 255, 1)',
            'rgba(0, 255, 0, 1)',
            'rgba(255, 255, 0, 1)',
            'rgba(255, 0, 0, 1)'
        ]
    });

    map.addListener('zoom_changed', toggleMarkersOnZoom);

    // 3. Tarik Data Real-Time dari Firebase
    onSnapshot(collection(db, "waste_detections_v2"), (snapshot) => {
        allDetections = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        applyFilter();
    });
}

// EKSEKUSI JEMBATAN PENGAMAN
if (window.googleMapsScriptSudahSiap) {
    initMap();
} else {
    window.jalankanInisialisasiPeta = initMap;
}

// 4. Logika Filter Waktu
function applyFilter() {
    if (!map || !heatmapLayer) return; 

    const activeBtn = document.querySelector('.time-button.active');
    const filterType = activeBtn ? activeBtn.getAttribute('data-filter') : 'all';
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    const filtered = allDetections.filter(d => {
        const dTime = parseFirestoreTimestamp(d.timestamp);
        if (filterType === 'today') return (now - dTime) <= oneDay;
        if (filterType === 'week') return (now - dTime) <= (7 * oneDay);
        if (filterType === 'month') return (now - dTime) <= (30 * oneDay);
        return true; 
    });

    updateMapData(filtered);
}

// 5. Engine Render Google Maps
function updateMapData(data) {
    if (data.length === 0) {
        heatmapLayer.setData([]);
        clearMarkers();
        return;
    }

    const heatMapData = data.map(d => ({
        location: new google.maps.LatLng(parseFloat(d.latitude), parseFloat(d.longitude)),
        weight: 1 
    }));
    heatmapLayer.setData(heatMapData);

    clearMarkers();
    const currentZoom = map.getZoom();
    
    data.forEach(d => {
        const marker = new google.maps.Marker({
            position: { lat: parseFloat(d.latitude), lng: parseFloat(d.longitude) },
            map: currentZoom > 16 ? map : null, 
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 4,
                fillColor: "#000",
                fillOpacity: 1,
                strokeWeight: 1,
                strokeColor: "#fff"
            }
        });

        // Buka Pop-Up Info Saat Diklik
        marker.addListener('click', () => {
            infoWindow.setContent(`
                <div style="color: #333;">
                    <b style="font-size: 14px;">${d.label}</b><br>
                    Keyakinan: ${d.confidence}%<br>
                    <small style="color: #777;">${d.timestamp}</small>
                </div>
            `);
            infoWindow.open({
                anchor: marker,
                map: map,
                shouldFocus: false
            });
        });

        markers.push(marker);
    });

    if (!mapInitialized) {
        const bounds = new google.maps.LatLngBounds();
        data.forEach(d => {
            bounds.extend(new google.maps.LatLng(parseFloat(d.latitude), parseFloat(d.longitude)));
        });
        map.fitBounds(bounds);
        mapInitialized = true;
    }
}

function clearMarkers() {
    markers.forEach(m => m.setMap(null));
    markers = [];
}

function toggleMarkersOnZoom() {
    const zoomLvl = map.getZoom();
    markers.forEach(m => {
        m.setMap(zoomLvl > 16 ? map : null);
    });
}

document.querySelectorAll('.time-button').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.time-button').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        applyFilter();
    });
});