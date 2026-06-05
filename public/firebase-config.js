import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, onSnapshot, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCviQcPHm2QRhBmJd4mzSc9SkukV-U4XuY",
    authDomain: "uavwaste.firebaseapp.com",
    projectId: "uavwaste",
    storageBucket: "uavwaste.firebasestorage.app",
    messagingSenderId: "882801598844",
    appId: "1:882801598844:web:3b8ba0746ad40f44d684f9",
    measurementId: "G-KS4ZGS907C"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export function parseFirestoreTimestamp(timestampStr) {
    if (!timestampStr) return Date.now();
    try {
        const datePart = timestampStr.split(' at ')[0];
        const timeMatch = timestampStr.match(/at (\d{1,2}:\d{2}:\d{2} [AP]M)/);
        const timePart = timeMatch ? timeMatch[1] : '12:00:00 AM';
        return new Date(`${datePart} ${timePart}`).getTime();
    } catch (e) {
        console.warn("Could not parse timestamp:", timestampStr);
        return Date.now();
    }
}

export { db, collection, onSnapshot, deleteDoc, doc };