import { db, collection, onSnapshot, parseDetectionDate, getEffectiveCount } from './firebase-config.js';

let map;
let heatmapLayer = null;
let markers = [];
let allDetections = [];
let filteredDetections = [];
let mapInitialized = false;
let infoWindow = null;
let markersVisible = true;
let adaptiveScaleEnabled = true;
let forceUnclusterAtCurrentZoom = false;

let currentClusterRadius = -1;
let currentScaleTierKey = "";

function haversineDistance(lat1, lng1, lat2, lng2) {
    function toRad(x) { return x * Math.PI / 180; }
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function getDynamicRadiusMeters(zoom) {
    if (forceUnclusterAtCurrentZoom) return 0;
    if (zoom >= 20) return 0;
    if (zoom >= 18) return 5;
    if (zoom >= 16) return 20;
    if (zoom >= 14) return 50;
    return 100;
}

// Menentukan target level zoom berikutnya yang pasti menurunkan radius klaster
function getNextTierZoom(currentZoom, currentRadius) {
    if (currentRadius >= 100) return Math.max(currentZoom + 2, 14);
    if (currentRadius >= 50) return 16;
    if (currentRadius >= 20) return 18;
    return 20;
}

function getScaleConfig(zoom) {
    const z = zoom || 13;
    const radiusMeters = getDynamicRadiusMeters(z);

    if (!adaptiveScaleEnabled || radiusMeters === 0) {
        let hmRadius = 20;
        if (z >= 19) hmRadius = 40;
        else if (z >= 16) hmRadius = 20;
        else if (z >= 13) hmRadius = 10;
        else hmRadius = 5;

        return {
            tierKey: `base-${radiusMeters}-${z}`,
            radiusMeters,
            thresholds: [10, 25, 40],
            heatmapMaxIntensity: radiusMeters === 0 ? 35 : 50,
            heatmapRadius: hmRadius,
            scaleLabel: radiusMeters === 0
                ? `Zoom ${z} · Radius 0m (Sel Tunggal ~11m)`
                : `Zoom ${z} · Radius Klaster ${radiusMeters}m (Statis)`
        };
    }

    if (z >= 18) {
        return {
            tierKey: 'tier-18',
            radiusMeters: 5,
            thresholds: [12, 30, 48],
            heatmapMaxIntensity: 50,
            heatmapRadius: 32,
            scaleLabel: `Zoom ${z} · Radius Klaster 5m`
        };
    }
    if (z >= 16) {
        return {
            tierKey: 'tier-16',
            radiusMeters: 20,
            thresholds: [20, 50, 80],
            heatmapMaxIntensity: 85,
            heatmapRadius: 22,
            scaleLabel: `Zoom ${z} · Radius Klaster 20m`
        };
    }
    if (z >= 14) {
        return {
            tierKey: 'tier-14',
            radiusMeters: 50,
            thresholds: [35, 88, 140],
            heatmapMaxIntensity: 140,
            heatmapRadius: 14,
            scaleLabel: `Zoom ${z} · Radius Klaster 50m`
        };
    }
    return {
        tierKey: 'tier-macro',
        radiusMeters: 100,
        thresholds: [60, 150, 240],
        heatmapMaxIntensity: 240,
        heatmapRadius: 9,
        scaleLabel: `Zoom ${z} · Radius Klaster 100m`
    };
}

function updateLegendUI(scale) {
    const [t1, t2, t3] = scale.thresholds;
    const r1El = document.getElementById('leg-r1');
    const r2El = document.getElementById('leg-r2');
    const r3El = document.getElementById('leg-r3');
    const r4El = document.getElementById('leg-r4');
    const badgeEl = document.getElementById('leg-scale-badge');
    const captionEl = document.getElementById('leg-caption');

    if (r1El) r1El.textContent = `1–${t1}`;
    if (r2El) r2El.textContent = `${t1 + 1}–${t2}`;
    if (r3El) r3El.textContent = `${t2 + 1}–${t3}`;
    if (r4El) r4El.textContent = `${t3 + 1}+`;
    if (badgeEl) badgeEl.textContent = scale.scaleLabel;
    if (captionEl) {
        captionEl.textContent = adaptiveScaleEnabled
            ? `KDE maxIntensity: ${scale.heatmapMaxIntensity} (proporsional zoom)`
            : `KDE maxIntensity: 50 (skala statis 1–50)`;
    }
}

function updateHudBar() {
    const totalWasteEl = document.getElementById('hud-total-waste');
    const totalCellsEl = document.getElementById('hud-total-cells');
    const clusterInfoEl = document.getElementById('hud-cluster-info');

    const totalWaste = filteredDetections.reduce((acc, d) => acc + d.effectiveCount, 0);
    if (totalWasteEl) totalWasteEl.textContent = totalWaste.toLocaleString('id-ID');
    if (totalCellsEl) totalCellsEl.textContent = filteredDetections.length.toLocaleString('id-ID');

    if (clusterInfoEl && map) {
        const z = map.getZoom() || 13;
        const r = getDynamicRadiusMeters(z);
        clusterInfoEl.innerHTML = r === 0
            ? `Zoom ${z} · Radius: <span class="hud-val">0m (Ground Truth)</span>`
            : `Zoom ${z} · Radius: <span class="hud-val">${r}m</span>`;
    }
}

// Fungsi global untuk tombol interaktif di dalam InfoWindow Klaster
window.aksiZoomKlaster = function(lat, lng, radiusSaatIni) {
    if (!map) return;
    if (infoWindow) infoWindow.close();
    const prevZoom = map.getZoom() || 13;
    const targetZoom = getNextTierZoom(prevZoom, radiusSaatIni);

    map.panTo({ lat, lng });
    map.setZoom(targetZoom);

    // Jika mode Satellite membatasi maxZoom di bawah 20 (misal tertahan di Zoom 19),
    // paksa pembukaan klaster (radius = 0m) agar titik tetap terurai.
    setTimeout(() => {
        const actualZoom = map.getZoom();
        if (actualZoom < targetZoom || (targetZoom >= 20 && actualZoom < 20)) {
            forceUnclusterAtCurrentZoom = true;
            const scale = updateHeatmapVisuals();
            updateHudBar();
            currentClusterRadius = 0;
            renderClusteredMarkers(filteredDetections, 0, scale);
        }
    }, 250);
};

window.aksiUraiPenuhKlaster = function(lat, lng) {
    if (!map) return;
    forceUnclusterAtCurrentZoom = true;
    map.panTo({ lat, lng });
    if ((map.getZoom() || 13) < 19) {
        map.setZoom(19);
    }
    const scale = updateHeatmapVisuals();
    updateHudBar();
    currentClusterRadius = 0;
    renderClusteredMarkers(filteredDetections, 0, scale);
    if (infoWindow) infoWindow.close();
};

function initMap() {
    map = new google.maps.Map(document.getElementById("map"), {
        center: { lat: -6.92, lng: 107.71 },
        zoom: 13,
        minZoom: 3,
        maxZoom: 22,
        mapTypeControl: true,
        mapTypeControlOptions: {
            style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
            position: google.maps.ControlPosition.TOP_LEFT
        },
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
        data: [],
        map: map,
        radius: 20,
        maxIntensity: 50,
        opacity: 0.85,
        gradient: [
            'rgba(0, 255, 0, 0)', 'rgba(0, 255, 0, 1)', 'rgba(0, 255, 0, 1)',
            'rgba(255, 255, 0, 1)', 'rgba(255, 255, 0, 1)', 'rgba(255, 255, 0, 1)',
            'rgba(255, 165, 0, 1)', 'rgba(255, 165, 0, 1)', 'rgba(255, 165, 0, 1)',
            'rgba(255, 0, 0, 1)', 'rgba(255, 0, 0, 1)'
        ]
    });

    map.addListener('zoom_changed', () => {
        const z = map.getZoom() || 13;
        // Jika pengguna melakukan zoom-out manual ke bawah level 18, kembalikan klasterisasi normal
        if (z < 18 && forceUnclusterAtCurrentZoom) {
            forceUnclusterAtCurrentZoom = false;
        }
        const scale = updateHeatmapVisuals();
        updateHudBar();
        if (scale.radiusMeters !== currentClusterRadius || scale.tierKey !== currentScaleTierKey) {
            currentClusterRadius = scale.radiusMeters;
            currentScaleTierKey = scale.tierKey;
            renderClusteredMarkers(filteredDetections, currentClusterRadius, scale);
        }
    });

    const toggleScaleBtn = document.getElementById('toggleScaleModeBtn');
    if (toggleScaleBtn) {
        toggleScaleBtn.addEventListener('click', () => {
            adaptiveScaleEnabled = !adaptiveScaleEnabled;
            toggleScaleBtn.textContent = adaptiveScaleEnabled ? "Mode: Adaptif" : "Mode: Statis";
            const scale = updateHeatmapVisuals();
            currentClusterRadius = scale.radiusMeters;
            currentScaleTierKey = scale.tierKey;
            renderClusteredMarkers(filteredDetections, currentClusterRadius, scale);
        });
    }

    onSnapshot(collection(db, "waste_detections_v2"), (snapshot) => {
        allDetections = [];
        snapshot.docs.forEach(docSnap => {
            const data = docSnap.data();
            const lat = parseFloat(data.latitude);
            const lng = parseFloat(data.longitude);
            const parsedTime = parseDetectionDate(data);

            if (!isNaN(lat) && !isNaN(lng) && parsedTime !== null) {
                const effectiveCount = getEffectiveCount(data);
                const simPeak = Number(data.simultaneousPeak) > 0 ? Number(data.simultaneousPeak) : effectiveCount;
                const uniqueTracks = Number(data.uniqueTrackCount) > 0 ? Number(data.uniqueTrackCount) : effectiveCount;
                const confNum = Number(data.confidence);
                const confidencePct = !isNaN(confNum)
                    ? (confNum <= 1 && confNum > 0 ? Math.round(confNum * 100) : Math.round(confNum))
                    : 0;

                allDetections.push({
                    id: docSnap.id,
                    ...data,
                    lat,
                    lng,
                    effectiveCount,
                    simultaneousPeak: simPeak,
                    uniqueTrackCount: uniqueTracks,
                    confidencePct,
                    cellKey: data.cellKey || docSnap.id,
                    parsedTime,
                    epochMs: parsedTime.getTime()
                });
            }
        });
        applyFilter();
    });
}

if (window.googleMapsScriptSudahSiap) { initMap(); }
else { window.jalankanInisialisasiPeta = initMap; }

function updateHeatmapVisuals() {
    const zoom = map ? map.getZoom() : 13;
    const scale = getScaleConfig(zoom);
    if (map && heatmapLayer) {
        heatmapLayer.setOptions({
            radius: scale.heatmapRadius,
            maxIntensity: scale.heatmapMaxIntensity
        });
    }
    updateLegendUI(scale);
    return scale;
}

function createControlButton(title, svgHtml) {
    const btn = document.createElement("button");
    btn.title = title;
    btn.style.backgroundColor = "#fff";
    btn.style.border = "1px solid #e2e8f0";
    btn.style.width = "40px";
    btn.style.height = "40px";
    btn.style.borderRadius = "6px";
    btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
    btn.style.cursor = "pointer";
    btn.style.display = "flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.innerHTML = svgHtml;
    return btn;
}

function setupNativeCustomControls() {
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.flexDirection = "column";
    container.style.gap = "6px";
    container.style.marginRight = "10px";
    container.style.marginBottom = "10px";

    const fitBoundsBtn = createControlButton("Fokus ke Semua Titik", `
        <svg viewBox="0 0 24 24" style="width:18px; height:18px; stroke:#334155; stroke-width:2; fill:none;">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
        </svg>
    `);
    fitBoundsBtn.addEventListener("click", () => {
        forceUnclusterAtCurrentZoom = false;
        if (filteredDetections.length > 0) {
            const bounds = new google.maps.LatLngBounds();
            filteredDetections.forEach(d => bounds.extend({ lat: d.lat, lng: d.lng }));
            map.fitBounds(bounds);
        }
    });

    const toggleMarkerBtn = createControlButton("Tampilkan/Sembunyikan Marker", `
        <svg viewBox="0 0 24 24" style="width:18px; height:18px; stroke:#334155; stroke-width:2; fill:none;">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
        </svg>
    `);
    toggleMarkerBtn.addEventListener("click", () => {
        markersVisible = !markersVisible;
        markers.forEach(m => m.setMap(markersVisible ? map : null));
        toggleMarkerBtn.style.opacity = markersVisible ? "1" : "0.4";
    });

    const locationBtn = createControlButton("Lokasi GPS Saya", `
        <svg viewBox="0 0 24 24" style="width:18px; height:18px; stroke:#334155; stroke-width:2; fill:none;">
            <circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3"/>
        </svg>
    `);
    locationBtn.addEventListener("click", () => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((pos) => {
                const center = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                map.setCenter(center);
                map.setZoom(18);
                new google.maps.Marker({
                    position: center,
                    map: map,
                    icon: {
                        path: google.maps.SymbolPath.CIRCLE,
                        scale: 7,
                        fillColor: "#1d4ed8",
                        fillOpacity: 1,
                        strokeWeight: 2,
                        strokeColor: "#fff"
                    }
                });
            }, () => alert("Pastikan izin GPS pada peramban aktif."));
        }
    });

    container.appendChild(fitBoundsBtn);
    container.appendChild(toggleMarkerBtn);
    container.appendChild(locationBtn);
    map.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push(container);
}

function applyFilter() {
    if (!map || !heatmapLayer) return;

    const activeBtn = document.querySelector('.time-button.active');
    const filterType = activeBtn ? activeBtn.getAttribute('data-filter') : 'all';

    const now = new Date();
    let startMs = 0;
    let endMs = 8640000000000000;

    if (filterType === 'today') {
        startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
        endMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime();
    } else if (filterType === 'week') {
        const dayOfWeek = now.getDay();
        const diffToMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
        const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday, 0, 0, 0, 0);
        const endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 6, 23, 59, 59, 999);
        startMs = startDate.getTime();
        endMs = endDate.getTime();
    } else if (filterType === 'month') {
        startMs = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime();
        endMs = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    }

    filteredDetections = allDetections.filter(d => d.epochMs >= startMs && d.epochMs <= endMs);

    const heatMapData = filteredDetections.map(d => ({
        location: new google.maps.LatLng(d.lat, d.lng),
        weight: d.effectiveCount
    }));
    heatmapLayer.setData(heatMapData);

    if (!mapInitialized && filteredDetections.length > 0) {
        const bounds = new google.maps.LatLngBounds();
        filteredDetections.forEach(d => bounds.extend(new google.maps.LatLng(d.lat, d.lng)));
        map.fitBounds(bounds);
        mapInitialized = true;
    }

    const scale = updateHeatmapVisuals();
    updateHudBar();

    currentClusterRadius = scale.radiusMeters;
    currentScaleTierKey = scale.tierKey;
    renderClusteredMarkers(filteredDetections, currentClusterRadius, scale);
}

function renderClusteredMarkers(data, radiusMeters, scaleConfig = null) {
    markers.forEach(m => m.setMap(null));
    markers = [];

    if (data.length === 0) return;

    const scale = scaleConfig || getScaleConfig(map ? map.getZoom() : 13);
    const [t1, t2, t3] = scale.thresholds;

    const clusters = [];

    data.forEach(d => {
        const point = {
            lat: d.lat,
            lng: d.lng,
            jumlah: d.effectiveCount,
            simPeakSum: d.simultaneousPeak,
            uniqueTrackSum: d.uniqueTrackCount,
            weightedConfSum: d.confidencePct * d.effectiveCount,
            docCount: 1,
            latestEpochMs: d.epochMs,
            rawRef: d,
            members: [d]
        };

        let foundCluster = false;
        if (radiusMeters > 0) {
            for (let cluster of clusters) {
                const dist = haversineDistance(point.lat, point.lng, cluster.lat, cluster.lng);
                if (dist <= radiusMeters) {
                    const totalWeight = cluster.jumlah + point.jumlah;
                    cluster.lat = (cluster.lat * cluster.jumlah + point.lat * point.jumlah) / totalWeight;
                    cluster.lng = (cluster.lng * cluster.jumlah + point.lng * point.jumlah) / totalWeight;
                    cluster.jumlah = totalWeight;
                    cluster.simPeakSum += point.simPeakSum;
                    cluster.uniqueTrackSum += point.uniqueTrackSum;
                    cluster.weightedConfSum += point.weightedConfSum;
                    cluster.docCount += 1;
                    if (point.latestEpochMs > cluster.latestEpochMs) {
                        cluster.latestEpochMs = point.latestEpochMs;
                        cluster.rawRef = point.rawRef;
                    }
                    cluster.members.push(d);
                    foundCluster = true;
                    break;
                }
            }
        }

        if (!foundCluster) clusters.push(point);
    });

    clusters.forEach(c => {
        let color = "#00FF00";
        let textColor = "#000000";
        let categoryName = "Rendah";

        const isSingleCell = (c.docCount === 1 || radiusMeters === 0);
        const isSingleObjectPin = (isSingleCell && c.jumlah === 1);

        if (c.jumlah > t1 && c.jumlah <= t2) {
            color = "#FFFF00"; textColor = "#000000"; categoryName = "Sedang";
        } else if (c.jumlah > t2 && c.jumlah <= t3) {
            color = "#FFA500"; textColor = "#ffffff"; categoryName = "Tinggi";
        } else if (c.jumlah > t3) {
            color = "#FF0000"; textColor = "#ffffff"; categoryName = "Padat";
        }

        const marker = new google.maps.Marker({
            position: { lat: c.lat, lng: c.lng },
            map: markersVisible ? map : null,
            icon: {
                path: "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z",
                fillColor: color,
                fillOpacity: 1,
                strokeWeight: 1.5,
                strokeColor: "#0f172a",
                scale: isSingleObjectPin ? 1.2 : 1.5,
                anchor: new google.maps.Point(12, 24),
                labelOrigin: new google.maps.Point(12, 10)
            },
            label: isSingleObjectPin ? null : {
                text: String(c.jumlah),
                color: textColor,
                fontSize: "11px",
                fontWeight: "bold"
            },
            zIndex: c.jumlah
        });

        marker.addListener('click', () => {
            if (isSingleCell) {
                const geocoder = new google.maps.Geocoder();
                const latlng = { lat: c.lat, lng: c.lng };
                const ref = c.rawRef;

                infoWindow.setContent(`
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 8px; color: #64748b; font-size: 12px; min-width: 220px;">
                        Memuat data koordinat & alamat...
                    </div>
                `);
                infoWindow.open({ anchor: marker, map: map, shouldFocus: false });

                geocoder.geocode({ location: latlng }, (results, status) => {
                    let address = "Alamat jalan tidak tersedia.";
                    if (status === "OK" && results && results[0]) {
                        address = results[0].formatted_address;
                    }

                    const tsStr = ref.parsedTime
                        ? ref.parsedTime.toLocaleString('id-ID', {
                            day: '2-digit', month: 'short', year: 'numeric',
                            hour: '2-digit', minute: '2-digit', second: '2-digit'
                          }) + ' WIB'
                        : (ref.timestamp || '-');

                    const altText = (ref.altitude !== undefined && ref.altitude !== null && !isNaN(Number(ref.altitude)))
                        ? `${Number(ref.altitude).toFixed(1)} m`
                        : '-';

                    const gmapsUrl = `https://www.google.com/maps?q=${c.lat.toFixed(6)},${c.lng.toFixed(6)}`;

                    const popUpContent = `
                        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-width: 250px; max-width: 290px; padding: 2px; color: #0f172a;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">
                                <span style="font-size: 13px; font-weight: 700;">Sel Grid Deteksi</span>
                                <span style="font-family: monospace; background:#f1f5f9; color:#0f172a; border:1px solid #cbd5e1; font-size:11px; font-weight:700; padding:1px 6px; border-radius:4px;">
                                    ${ref.label || 'rubbish'} · ${ref.confidencePct}%
                                </span>
                            </div>

                            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; margin-bottom:10px; text-align:center;">
                                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:4px; padding:6px 4px;">
                                    <div style="font-size:16px; font-weight:800; color:#0f172a; font-variant-numeric:tabular-nums;">${c.jumlah}</div>
                                    <div style="font-size:9.5px; color:#64748b; margin-top:2px;">Jumlah Objek</div>
                                </div>
                                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:4px; padding:6px 4px;">
                                    <div style="font-size:16px; font-weight:700; color:#334155; font-variant-numeric:tabular-nums;">${ref.simultaneousPeak}</div>
                                    <div style="font-size:9.5px; color:#64748b; margin-top:2px;">Peak Simultan</div>
                                </div>
                                <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:4px; padding:6px 4px;">
                                    <div style="font-size:16px; font-weight:700; color:#334155; font-variant-numeric:tabular-nums;">${ref.uniqueTrackCount}</div>
                                    <div style="font-size:9.5px; color:#64748b; margin-top:2px;">Track ID Unik</div>
                                </div>
                            </div>

                            <div style="font-size: 12px; line-height: 1.4; color: #334155; margin-bottom: 8px;">
                                ${address}
                            </div>

                            <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 6px 8px; border-radius: 4px; font-size: 11px; color: #0f172a; margin-bottom: 8px; font-variant-numeric: tabular-nums;">
                                <div style="display:flex; justify-content:space-between; margin-bottom:2px;">
                                    <span style="color:#64748b;">ID Sel (~11m):</span>
                                    <span style="font-family:monospace; font-weight:600;">${ref.cellKey}</span>
                                </div>
                                <div style="display:flex; justify-content:space-between; margin-bottom:2px;">
                                    <span style="color:#64748b;">Koordinat:</span>
                                    <span style="font-family:monospace; font-weight:600;">${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}</span>
                                </div>
                                <div style="display:flex; justify-content:space-between;">
                                    <span style="color:#64748b;">Altitude:</span>
                                    <span style="font-family:monospace; font-weight:600;">${altText}</span>
                                </div>
                            </div>

                            <div style="display:flex; justify-content:space-between; align-items:center; border-top: 1px solid #e2e8f0; padding-top: 6px; font-size: 11px; color: #64748b;">
                                <span>${tsStr}</span>
                                <a href="${gmapsUrl}" target="_blank" rel="noopener" style="color:#1d4ed8; font-weight:600; text-decoration:none;">
                                    Buka di Maps &rarr;
                                </a>
                            </div>
                        </div>
                    `;
                    infoWindow.setContent(popUpContent);
                });
            } else {
                const avgClusterConf = Math.round(c.weightedConfSum / Math.max(1, c.jumlah));
                const densityPerCell = (c.jumlah / Math.max(1, c.docCount)).toFixed(1);
                const latestStr = new Date(c.latestEpochMs).toLocaleString('id-ID', {
                    day: '2-digit', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit'
                });

                const popUpContent = `
                    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-width: 245px; padding: 2px; color: #0f172a;">
                        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding-bottom:6px; margin-bottom:8px;">
                            <span style="font-size: 12px; font-weight: 700; color: #0f172a;">
                                Klaster Haversine (${c.docCount} Sel)
                            </span>
                            <span style="font-size: 10.5px; font-weight: 600; background:#f1f5f9; padding:1px 6px; border-radius:4px; color:#334155;">
                                Radius ${radiusMeters}m
                            </span>
                        </div>

                        <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size: 22px; font-weight: 800; color: #0f172a; line-height: 1; font-variant-numeric:tabular-nums;">
                                    ${c.jumlah} <span style="font-size:11px; font-weight:600; color:#475569;">objek</span>
                                </div>
                                <div style="font-size: 11px; color: #64748b; margin-top: 3px;">
                                    Kepadatan: <b>${densityPerCell} objek/sel</b> (${categoryName})
                                </div>
                            </div>
                            <div style="text-align:right; font-size:11px; color:#475569;">
                                <div>Mean Conf</div>
                                <div style="font-size:14px; font-weight:700; color:#0f172a;">${avgClusterConf}%</div>
                            </div>
                        </div>

                        <div style="font-size: 11px; color: #475569; margin-bottom: 10px; font-variant-numeric:tabular-nums;">
                            <div>Titik Pusat: <span style="font-family:monospace;">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</span></div>
                            <div>Pembaruan: ${latestStr}</div>
                        </div>

                        <div style="display:flex; gap:6px;">
                            <button type="button" onclick="window.aksiZoomKlaster(${c.lat}, ${c.lng}, ${radiusMeters})"
                                style="flex:1; background:#0f172a; color:#ffffff; border:none; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:600; cursor:pointer;">
                                Perbesar Bertahap
                            </button>
                            <button type="button" onclick="window.aksiUraiPenuhKlaster(${c.lat}, ${c.lng})"
                                style="flex:1; background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; border-radius:4px; padding:6px 8px; font-size:11px; font-weight:600; cursor:pointer;">
                                Urai Semua Sel
                            </button>
                        </div>
                    </div>
                `;
                infoWindow.setContent(popUpContent);
                infoWindow.setPosition({ lat: c.lat, lng: c.lng });
                infoWindow.open({ map: map, shouldFocus: false });
            }
        });

        markers.push(marker);
    });
}

document.querySelectorAll('.time-button').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.time-button').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        applyFilter();
    });
});