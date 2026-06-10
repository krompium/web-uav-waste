import { db, collection, onSnapshot, parseFirestoreTimestamp } from './firebase-config.js';

let map;
let heatmapLayer = null; 
let markers = [];
let allDetections = [];
let filteredDetections = []; 
let mapInitialized = false;
let infoWindow = null;

let currentClusterRadius = -1; 

// RUMUS HAVERSINE
function haversineDistance(lat1, lng1, lat2, lng2) {
    function toRad(x) { return x * Math.PI / 180; }
    const R = 6371000; 
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// RADIUS DECLUSTERING BERDASARKAN LEVEL ZOOM
function getDynamicRadiusMeters(zoom) {
    if (zoom >= 20) return 0;       
    if (zoom >= 18) return 5;       
    if (zoom >= 16) return 20;      
    if (zoom >= 14) return 50;      
    return 100;                     
}

function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: -6.2, lng: 106.8 },
        zoom: 13,
        minZoom: 3,        
        maxZoom: 22,       
        mapTypeControl: true,
        mapTypeControlOptions: { style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR, position: google.maps.ControlPosition.TOP_LEFT },
        zoomControl: true,
        zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
        streetViewControl: true,
        streetViewControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
        fullscreenControl: true,
        fullscreenControlOptions: { position: google.maps.ControlPosition.TOP_RIGHT },
        rotateControl: false,
        scaleControl: true
    });

    infoWindow = new google.maps.InfoWindow();
    setupNativeCustomControls();

    heatmapLayer = new google.maps.visualization.HeatmapLayer({
        data: [], map: map, radius: 20, maxIntensity: 50, opacity: 0.85,
        gradient: [ 
            'rgba(0, 255, 0, 0)', 'rgba(0, 255, 0, 1)', 'rgba(0, 255, 0, 1)',
            'rgba(255, 255, 0, 1)', 'rgba(255, 255, 0, 1)', 'rgba(255, 255, 0, 1)',
            'rgba(255, 165, 0, 1)', 'rgba(255, 165, 0, 1)', 'rgba(255, 165, 0, 1)',
            'rgba(255, 0, 0, 1)', 'rgba(255, 0, 0, 1)'     
        ]
    });

    map.addListener('zoom_changed', () => {
        updateHeatmapVisuals();
        const newRadius = getDynamicRadiusMeters(map.getZoom());
        if (newRadius !== currentClusterRadius) {
            currentClusterRadius = newRadius;
            renderClusteredMarkers(filteredDetections, currentClusterRadius);
        }
    });

    onSnapshot(collection(db, "waste_detections_v2"), (snapshot) => {
        allDetections = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        applyFilter();
    });
}

if (window.googleMapsScriptSudahSiap) { initMap(); } 
else { window.jalankanInisialisasiPeta = initMap; }

function updateHeatmapVisuals() {
    if (!map || !heatmapLayer) return;
    const zoom = map.getZoom();
    if (zoom >= 19) heatmapLayer.setOptions({ radius: 40 }); 
    else if (zoom >= 16) heatmapLayer.setOptions({ radius: 20 }); 
    else if (zoom >= 13) heatmapLayer.setOptions({ radius: 10 }); 
    else heatmapLayer.setOptions({ radius: 5 }); 
}

function setupNativeCustomControls() {
    const container = document.createElement("div");
    container.style.display = "flex"; container.style.flexDirection = "column";
    container.style.gap = "6px"; container.style.marginRight = "10px"; container.style.marginBottom = "10px";

    const locationBtn = document.createElement("button");
    locationBtn.title = "Tunjukkan Lokasi Saya Saat Ini";
    locationBtn.style.backgroundColor = "#fff"; locationBtn.style.border = "none";
    locationBtn.style.width = "40px"; locationBtn.style.height = "40px";
    locationBtn.style.borderRadius = "2px"; locationBtn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.3)";
    locationBtn.style.cursor = "pointer"; locationBtn.style.display = "flex";
    locationBtn.style.alignItems = "center"; locationBtn.style.justifyContent = "center";
    locationBtn.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:20px; height:20px; fill:#666;">
            <path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.55-4.45-4.04-7.94-8.49-8.49V1c0-.55-.45-1-1-1s-1 .45-1 1v1.51C6.01 3.06 2.52 6.55 1.97 11H.5c-.55 0-1 .45-1 1s.45 1 1 1h1.47c.55 4.45 4.04 7.94 8.49 8.49V23c0 .55.45 1 1 1s1-.45 1-1v-1.51c4.45-.55 7.94-4.04 8.49-8.49H23c.55 0 1-.45 1-1s-.45-1-1-1h-1.06zM12 21c-4.97 0-9-4.03-9-9s4.03-9 9-9 9 4.03 9 9-4.03 9-9 9z"/>
        </svg>
    `;
    locationBtn.addEventListener("click", () => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => {
                const center = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                map.setCenter(center); map.setZoom(17);
                new google.maps.Marker({ position: center, map: map, icon: { path: google.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#4285F4", fillOpacity: 1, strokeWeight: 2, strokeColor: "#fff" }});
            }, () => alert("Pastikan izin GPS aktif."));
        }
    });

    container.appendChild(locationBtn);
    map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(container);
}

function applyFilter() {
    if (!map || !heatmapLayer) return; 

    const activeBtn = document.querySelector('.time-button.active');
    const filterType = activeBtn ? activeBtn.getAttribute('data-filter') : 'all';
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    filteredDetections = allDetections.filter(d => {
        const dTime = parseFirestoreTimestamp(d.timestamp);
        if (filterType === 'today') return (now - dTime) <= oneDay;
        if (filterType === 'week') return (now - dTime) <= (7 * oneDay);
        if (filterType === 'month') return (now - dTime) <= (30 * oneDay);
        return true; 
    });

    const heatMapData = filteredDetections.map(d => ({
        location: new google.maps.LatLng(parseFloat(d.latitude), parseFloat(d.longitude)),
        weight: d.jumlahDeteksi ? parseInt(d.jumlahDeteksi) : 1 
    }));
    heatmapLayer.setData(heatMapData);

    if (!mapInitialized && filteredDetections.length > 0) {
        const bounds = new google.maps.LatLngBounds();
        filteredDetections.forEach(d => bounds.extend(new google.maps.LatLng(parseFloat(d.latitude), parseFloat(d.longitude))));
        map.fitBounds(bounds);
        mapInitialized = true;
    }

    updateHeatmapVisuals();

    currentClusterRadius = getDynamicRadiusMeters(map.getZoom());
    renderClusteredMarkers(filteredDetections, currentClusterRadius);
}

function renderClusteredMarkers(data, radiusMeters) {
    markers.forEach(m => m.setMap(null));
    markers = [];

    if (data.length === 0) return;

    const rawPoints = [];
    data.forEach(d => {
        const lat = parseFloat(d.latitude);
        const lng = parseFloat(d.longitude);
        const jumlah = d.jumlahDeteksi ? parseInt(d.jumlahDeteksi) : 1; 
        if (!isNaN(lat) && !isNaN(lng)) rawPoints.push({ lat, lng, jumlah, rawRef: d });
    });

    const clusters = [];
    rawPoints.forEach(point => {
        let foundCluster = false;
        
        if (radiusMeters > 0) {
            for (let cluster of clusters) {
                const dist = haversineDistance(point.lat, point.lng, cluster.lat, cluster.lng);
                if (dist <= radiusMeters) {
                    cluster.lat = (cluster.lat * cluster.jumlah + point.lat * point.jumlah) / (cluster.jumlah + point.jumlah);
                    cluster.lng = (cluster.lng * cluster.jumlah + point.lng * point.jumlah) / (cluster.jumlah + point.jumlah);
                    cluster.jumlah += point.jumlah;
                    foundCluster = true;
                    break;
                }
            }
        }
        
        if (!foundCluster) clusters.push({ ...point });
    });

    clusters.forEach(c => {
        let color = "#00FF00"; 
        let textColor = "#ffffff";
        let isSinglePoint = (c.jumlah === 1 && radiusMeters === 0); 

        if (c.jumlah >= 11 && c.jumlah <= 25) { color = "#FFFF00"; textColor = "#000000"; } 
        else if (c.jumlah >= 26 && c.jumlah <= 40) { color = "#FFA500"; } 
        else if (c.jumlah > 40) { color = "#FF0000"; }

        const marker = new google.maps.Marker({
            position: { lat: c.lat, lng: c.lng },
            map: map, 
            icon: {
                path: "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z", 
                fillColor: color,
                fillOpacity: 1,
                strokeWeight: 1.5,
                strokeColor: "#000",
                scale: isSinglePoint ? 1.1 : 1.5, 
                anchor: new google.maps.Point(12, 24),
                labelOrigin: new google.maps.Point(12, 10)
            },
            label: isSinglePoint ? null : { text: String(c.jumlah), color: textColor, fontSize: "11px", fontWeight: "bold" },
            zIndex: c.jumlah 
        });

        marker.addListener('click', () => {
            if (isSinglePoint) {
                const geocoder = new google.maps.Geocoder();
                const latlng = { lat: c.lat, lng: c.lng };

                infoWindow.setContent(`
                    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 10px; color: #64748b; text-align: center; min-width: 200px;">
                        <span style="font-size: 13px;">📡 Mengambil alamat dari satelit...</span>
                    </div>
                `);
                infoWindow.open({ anchor: marker, map: map, shouldFocus: false });

                geocoder.geocode({ location: latlng }, (results, status) => {
                    let address = "Alamat tidak ditemukan";
                    if (status === "OK" && results[0]) {
                        address = results[0].formatted_address; 
                    }

                    const popUpContent = `
                        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; min-width: 220px; max-width: 280px; padding: 4px; color: #1e293b;">
                            
                            <div style="font-size: 15px; font-weight: 800; color: #d97706; margin-bottom: 8px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px;">
                                Lokasi sampah ditemukan
                            </div>
                            
                            <div style="font-size: 13px; line-height: 1.5; color: #334155; margin-bottom: 12px; font-weight: 500;">
                                ${address}
                            </div>
                            
                            <div style="background: #f8fafc; border: 1px solid #cbd5e1; padding: 6px 8px; border-radius: 6px; font-size: 12px; font-family: 'Courier New', Courier, monospace; color: #0f172a; margin-bottom: 12px; text-align: center;">
                                <b>Koordinat:</b> ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}
                            </div>

                            <div style="font-size: 11px; color: #64748b; text-align: right; border-top: 1px dashed #e2e8f0; padding-top: 6px;">
                                ${c.rawRef.timestamp}
                            </div>
                            
                        </div>
                    `;
                    infoWindow.setContent(popUpContent);
                });

            } else {
                let bgSoft, textHighlight, borderColor;
                if (c.jumlah >= 11 && c.jumlah <= 25) { 
                    bgSoft = '#fefce8'; borderColor = '#eab308'; textHighlight = '#b45309'; 
                } else if (c.jumlah >= 26 && c.jumlah <= 40) { 
                    bgSoft = '#fff7ed'; borderColor = '#f97316'; textHighlight = '#c2410c'; 
                } else if (c.jumlah > 40) { 
                    bgSoft = '#fef2f2'; borderColor = '#ef4444'; textHighlight = '#b91c1c'; 
                } else { 
                    bgSoft = '#f0fdf4'; borderColor = '#22c55e'; textHighlight = '#15803d'; 
                }

                const popUpContent = `
                    <div style="font-family: 'Segoe UI', Arial, sans-serif; min-width: 180px; padding: 2px; text-align: center; color: #333;">
                        <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px;">
                            Agregasi Tumpukan
                        </div>
                        <div style="background-color: ${bgSoft}; border: 1.5px solid ${borderColor}; border-radius: 8px; padding: 12px 0; margin-bottom: 12px;">
                            <span style="font-size: 32px; font-weight: 800; color: ${textHighlight}; line-height: 1;">${c.jumlah}</span>
                            <span style="font-size: 13px; font-weight: 700; color: ${textHighlight}; margin-left: 2px;">SAMPAH</span>
                        </div>
                        <div style="font-size: 11px; font-weight: 600; color: #64748b; background: #f1f5f9; padding: 5px 8px; border-radius: 12px; display: inline-block;">
                            Tergabung dalam radius <b>${radiusMeters}m</b>
                        </div>
                    </div>
                `;
                infoWindow.setContent(popUpContent);
                infoWindow.open({ anchor: marker, map: map, shouldFocus: false });

                map.setCenter(marker.getPosition());
                map.setZoom(map.getZoom() + 2);
            }
        });

        markers.push(marker);
    });
}

document.querySelectorAll('.time-button').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.time-button').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        applyFilter();
    });
});