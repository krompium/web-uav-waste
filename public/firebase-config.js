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

/**
 * Mengekstrak objek Date secara aman dari dokumen Firestore atau nilai timestamp.
 * Prioritas 1: timestampEpochMs (Number) dari aplikasi Android v2
 * Prioritas 2: Firestore Timestamp object (.toDate() / .seconds)
 * Prioritas 3: String format "MMMM dd, yyyy 'at' hh:mm:ss a z" (dengan berbagai zona waktu)
 */
export function parseDetectionDate(input, fallbackTimestampStr = null) {
    if (!input && !fallbackTimestampStr) return null;

    // Jika input adalah objek dokumen Firestore utuh
    if (typeof input === 'object' && input !== null && !(input instanceof Date)) {
        if (typeof input.timestampEpochMs === 'number' && !isNaN(input.timestampEpochMs) && input.timestampEpochMs > 0) {
            return new Date(input.timestampEpochMs);
        }
        if (typeof input.timestampEpochMs === 'string' && input.timestampEpochMs.trim() !== '') {
            const parsedEpoch = Number(input.timestampEpochMs);
            if (!isNaN(parsedEpoch) && parsedEpoch > 0) return new Date(parsedEpoch);
        }
        if (typeof input.toDate === 'function') {
            return input.toDate();
        }
        if (typeof input.seconds === 'number') {
            return new Date(input.seconds * 1000);
        }
        if (input.timestamp) {
            return parseDetectionDate(input.timestamp);
        }
        return null;
    }

    if (input instanceof Date) {
        return !isNaN(input.getTime()) ? input : null;
    }

    if (typeof input === 'number' && !isNaN(input) && input > 0) {
        return new Date(input);
    }

    const rawStr = typeof input === 'string' ? input.trim() : (fallbackTimestampStr ? String(fallbackTimestampStr).trim() : '');
    if (!rawStr) return null;

    // Coba parsing langsung jika string berupa angka epoch
    if (/^\d{10,15}$/.test(rawStr)) {
        const num = Number(rawStr);
        return num < 1e12 ? new Date(num * 1000) : new Date(num);
    }

    try {
        // Normalisasi zona waktu Indonesia & format SimpleDateFormat Android
        let normalized = rawStr
            .replace(/\s+at\s+/i, ' ')
            .replace(/\bWIB\b/i, 'GMT+0700')
            .replace(/\bWITA\b/i, 'GMT+0800')
            .replace(/\bWIT\b/i, 'GMT+0900')
            .replace(/\bUTC([+-]\d{2}):?(\d{2})\b/i, 'GMT$1$2')
            .replace(/\bGMT([+-]\d{2}):(\d{2})\b/i, 'GMT$1$2')
            .replace(/\bUTC\b/i, 'GMT');

        let d = new Date(normalized);
        if (!isNaN(d.getTime())) return d;

        // Regex eksplisit untuk "MMMM dd, yyyy at hh:mm:ss AM/PM <tz>"
        const match = rawStr.match(/^([A-Za-z]+\s+\d{1,2},\s+\d{4})\s+at\s+(\d{1,2}:\d{2}:\d{2})\s+(AM|PM)(?:\s+(.+))?$/i);
        if (match) {
            const [, datePart, timePart, meridian, tzPart] = match;
            let [hours, minutes, seconds] = timePart.split(':').map(Number);
            const upperMeridian = meridian.toUpperCase();
            if (upperMeridian === 'PM' && hours !== 12) hours += 12;
            if (upperMeridian === 'AM' && hours === 12) hours = 0;

            const hh = String(hours).padStart(2, '0');
            const mm = String(minutes).padStart(2, '0');
            const ss = String(seconds).padStart(2, '0');

            let tzOffset = '+0700'; // Default WIB
            if (tzPart) {
                const tzClean = tzPart.trim().toUpperCase();
                if (tzClean === 'WITA') tzOffset = '+0800';
                else if (tzClean === 'WIT') tzOffset = '+0900';
                else {
                    const offsetMatch = tzClean.match(/([+-]\d{2}):?(\d{2})/);
                    if (offsetMatch) tzOffset = `${offsetMatch[1]}${offsetMatch[2]}`;
                }
            }

            d = new Date(`${datePart} ${hh}:${mm}:${ss} GMT${tzOffset}`);
            if (!isNaN(d.getTime())) return d;
        }

        // Fallback terakhir: ambil bagian tanggal dan jam saja
        const dateOnly = rawStr.split(' at ')[0];
        const timeMatch = rawStr.match(/(\d{1,2}:\d{2}:\d{2}\s*[AP]M)/i);
        if (dateOnly && timeMatch) {
            d = new Date(`${dateOnly} ${timeMatch[1]}`);
            if (!isNaN(d.getTime())) return d;
        }
    } catch (e) {
        console.warn("Gagal mem-parsing timestamp:", rawStr, e);
    }

    return null;
}

/**
 * Kompatibilitas mundur: mengembalikan epoch milliseconds (Number)
 */
export function parseFirestoreTimestamp(input) {
    const d = parseDetectionDate(input);
    return d ? d.getTime() : 0;
}

/**
 * Mengambil nilai jumlah sampah efektif per sel (jumlahDeteksi / peakCount)
 * sesuai kontrak GeoGridAggregator Android: effectiveCount = max(simultaneousPeak, uniqueTrackCount)
 */
export function getEffectiveCount(data) {
    if (!data) return 1;
    const jml = Number(data.jumlahDeteksi);
    if (!isNaN(jml) && jml > 0) return Math.round(jml);

    const peak = Number(data.peakCount);
    if (!isNaN(peak) && peak > 0) return Math.round(peak);

    const sim = Number(data.simultaneousPeak) || 0;
    const uniq = Number(data.uniqueTrackCount) || 0;
    const combined = Math.max(sim, uniq);
    return combined > 0 ? Math.round(combined) : 1;
}

export { db, collection, onSnapshot, deleteDoc, doc };