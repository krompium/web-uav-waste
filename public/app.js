import { db, collection, onSnapshot, parseFirestoreTimestamp } from './firebase-config.js';

let map;
let heatmapLayer = null; 
let markers = [];
let allDetections = [];
let mapInitialized = false;
let infoWindow = null;

// Inisialisasi Utama Google Maps Command Center
function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: -6.2, lng: 106.8 },
        zoom: 13,
        minZoom: 3,        
        maxZoom: 22,       
        
        mapTypeControl: true, // Bilah navigasi "Map" & "Satellite" di Kiri Atas
        mapTypeControlOptions: {
            style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
            position: google.maps.ControlPosition.TOP_LEFT
        },
        zoomControl: true,              // Tombol + - di Kanan Bawah
        zoomControlOptions: {
            position: google.maps.ControlPosition.RIGHT_BOTTOM
        },
        streetViewControl: true,        // Orang kuning Pegman di Kanan Bawah
        streetViewControlOptions: {
            position: google.maps.ControlPosition.RIGHT_BOTTOM
        },
        fullscreenControl: true,        // Tombol layar penuh di Kanan Atas
        fullscreenControlOptions: {
            position: google.maps.ControlPosition.TOP_RIGHT
        },
        rotateControl: false,           // MEMATIKAN KOMPAS
        scaleControl: true              // Garis skala jarak di Kiri Bawah
    });

    infoWindow = new google.maps.InfoWindow();

    // Suntikkan Tombol Lokasi Saat Ini (Hanya lokasi, tanpa 3D)
    setupNativeCustomControls();

    heatmapLayer = new google.maps.visualization.HeatmapLayer({
        data: [],
        map: map,
        radius: 35, 
        opacity: 0.8,
        gradient: [
            'rgba(0, 0, 255, 0)', 'rgba(0, 255, 255, 1)', 'rgba(0, 255, 0, 1)',
            'rgba(255, 255, 0, 1)', 'rgba(255, 0, 0, 1)'
        ]
    });

    map.addListener('zoom_changed', toggleMarkersOnZoom);

    onSnapshot(collection(db, "waste_detections_v2"), (snapshot) => {
        allDetections = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        applyFilter();
    });
}

if (window.googleMapsScriptSudahSiap) { initMap(); } 
else { window.jalankanInisialisasiPeta = initMap; }

// MEMBANGUN WIDGET KUSTOM BERGAYA RESMI GOOGLE (Hanya Widget Geolokasi)
function setupNativeCustomControls() {
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "6px";
    container.style.marginRight = "10px";
    container.style.marginBottom = "10px";

    const locationBtn = document.createElement("button");
    locationBtn.title = "Tunjukkan Lokasi Saya Saat Ini";
    locationBtn.style.backgroundColor = "#fff";
    locationBtn.style.border = "none";
    locationBtn.style.width = "40px";
    locationBtn.style.height = "40px";
    locationBtn.style.borderRadius = "2px";
    locationBtn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.3)";
    locationBtn.style.cursor = "pointer";
    locationBtn.style.display = "flex";
    locationBtn.style.alignItems = "center";
    locationBtn.style.justifyContent = "center";
    locationBtn.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:20px; height:20px; fill:#666;">
            <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.55-4.45-4.04-7.94-8.49-8.49V1c0-.55-.45-1-1-1s-1 .45-1 1v1.51C6.01 3.06 2.52 6.55 1.97 11H.5c-.55 0-1 .45-1 1s.45 1 1 1h1.47c.55 4.45 4.04 7.94 8.49 8.49V23c0 .55.45 1 1 1s1-.45 1-1v-1.51c4.45-.55 7.94-4.04 8.49-8.49H23c.55 0 1-.45 1-1s-.45-1-1-1h-1.06zM12 21c-4.97 0-9-4.03-9-9s4.03-9 9-9 9 4.03 9 9-4.03 9-9 9z"/>
        </svg>
    `;
    
    locationBtn.addEventListener("click", () => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((position) => {
                const pos = { lat: position.coords.latitude, lng: position.coords.longitude };
                map.setCenter(pos);
                map.setZoom(17);
                new google.maps.Marker({
                    position: pos, map: map, title: "Lokasi Anda",
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE, scale: 7,
                        fillColor: "#4285F4", fillOpacity: 1, strokeWeight: 2, strokeColor: "#fff"
                    }
                });
            }, () => { alert("Pastikan izin GPS browser Anda aktif."); });
        }
    });

    container.appendChild(locationBtn);
    map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(container);
}

// Logika Penghitungan Filter Jangka Waktu
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

// Engine Render Data Sampah
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
                path: google.maps.SymbolPath.CIRCLE, scale: 4,
                fillColor: "#000", fillOpacity: 1, strokeWeight: 1, strokeColor: "#fff"
            }
        });

        marker.addListener('click', () => {
            infoWindow.setContent(`
                <div style="color: #333;">
                    <b style="font-size: 14px;">${d.label}</b><br>
                    Keyakinan: ${d.confidence}%<br>
                    <small style="color: #777;">${d.timestamp}</small>
                </div>
            `);
            infoWindow.open({ anchor: marker, map: map, shouldFocus: false });
        });

        markers.push(marker);
    });

    if (!mapInitialized) {
        const bounds = new google.maps.LatLngBounds();
        data.forEach(d => bounds.extend(new google.maps.LatLng(parseFloat(d.latitude), parseFloat(d.longitude))));
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
    markers.forEach(m => m.setMap(zoomLvl > 16 ? map : null));
}

document.querySelectorAll('.time-button').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.time-button').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        applyFilter();
    });
});