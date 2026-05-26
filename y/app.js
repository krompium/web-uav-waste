// IMPORT FIXED: Added onSnapshot
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCviQcPHm2QRhBmJd4mzSc9SkukV-U4XuY",
    authDomain: "uavwaste.firebaseapp.com",
    projectId: "uavwaste",
    storageBucket: "uavwaste.firebasestorage.app",
    messagingSenderId: "882801598844",
    appId: "1:882801598844:web:3b8ba0746ad40f44d684f9",
    measurementId: "G-KS4ZGS907C"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Initialize Map
const map = L.map('map').setView([-6.2, 106.8], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OSM' }).addTo(map);

let heatLayer = L.heatLayer([], {radius: 25}).addTo(map);
let markerLayer = L.layerGroup().addTo(map);

let allDetections = []; 
const statusText = document.getElementById('status');

// Fetch & Listen (Real-time)
onSnapshot(collection(db, "waste_detections_v2"), (snapshot) => {
    allDetections = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    renderDashboard(allDetections);
    
    // Update UI Status
    statusText.innerText = "Live: Synchronized";
    statusText.style.color = "#2ecc71"; // Green
}, (error) => {
    console.error("Firebase Error: ", error);
    statusText.innerText = "Connection Error";
    statusText.style.color = "#e74c3c"; // Red
});

function renderDashboard(data) {
    // Update Heatmap
    heatLayer.setLatLngs(data.map(d => [d.latitude, d.longitude, (d.confidence || 50)/100]));
    
    // Update Markers
    markerLayer.clearLayers();
    data.forEach(d => {
        L.marker([d.latitude, d.longitude])
         .addTo(markerLayer)
         .bindPopup(`<b>${d.label}</b><br>${d.confidence}%<br>${d.timestamp}`);
    });

    // Update Stats
    const total = data.length;
    const labels = data.reduce((acc, d) => { 
        acc[d.label] = (acc[d.label] || 0) + 1; 
        return acc; 
    }, {});
    
    document.getElementById('stats-panel').innerHTML = `
        <p>Total Detections: ${total}</p>
        <p>Breakdown: ${JSON.stringify(labels)}</p>
    `;
}

// Timestamp Helper
function parseFirestoreTimestamp(timestampStr) {
    if (!timestampStr) return 0;
    const datePart = timestampStr.split(' at ')[0];
    return new Date(datePart).getTime();
}

// SCOPE FIXED: Filter logic moved safely inside the event listener
document.getElementById('apply-filter').addEventListener('click', () => {
    const fromVal = document.getElementById('date-from').value;
    const toVal = document.getElementById('date-to').value;
    
    const from = fromVal ? new Date(fromVal).getTime() : null;
    const to = toVal ? new Date(toVal).getTime() : null;
    
    const filtered = allDetections.filter(d => {
        const dTime = parseFirestoreTimestamp(d.timestamp); 
        
        const afterFrom = from ? (dTime >= from) : true;
        const beforeTo = to ? (dTime <= to) : true;
        
        return afterFrom && beforeTo;
    });
    
    renderDashboard(filtered);
});