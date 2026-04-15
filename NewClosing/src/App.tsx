/// <reference types="vite/client" />
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Clock, MapPin, NotebookText, Filter, Tv, CheckCircle2, AlertTriangle, XCircle, Hourglass, Printer } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import './index.css'; // or './tailwind.css';
import * as Papa from "papaparse";
import { ref, onValue, set } from "firebase/database";
import { db } from "./firebase"; // Importing the db instance

// === CONFIG ===
const CYCLE_START_YEAR = 2026;
const CYCLE_START_MONTH = 1; // January
const CYCLE_END_YEAR = 2026;
const CYCLE_END_MONTH = 12; // December
const COMING_SOON_DAYS = 30;
const THIS_WEEK_DAYS = 7;
const AUTO_ROTATE_SECONDS = 10;

const GOOGLE_CLIENT_ID = "618939462260-f41tit1ulgu1mluv2e937odvr4jnu453.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_AUTH_FLAG_KEY = "driveAuthGranted";

// Paste a published Google Sheets CSV URL here or leave blank and paste into the input at runtime:  :
const SHEET_CSV_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SHEET_CSV_URL) || "";

declare global {
    interface Window {
        google?: any;
    }
}

// === Types ===
type ClosingRow = {
  id: string;
  address: string;
  client_name?: string;
  type?: string;
  foreman?: string;
  expected_closing_date?: string;
  agreement_date?: string; // <-- Add this line
  listing_url?: string; // Column Y (Spec listing URL)
  days_delayed?: string;
  project_status?: string;
  all_dates?: string[];
  closing_data_status?: string;
  // Optional fields referenced elsewhere in the UI
  original_closing_date?: string;
  financial_status?: string;
  permit?: string;
  closing_year_n?: number; // Year from column N
  for_sale?: boolean; // flag from column A
};

type DepositEntry = {
    date: string;
    amount: string;
};

type ChangeOrderEntry = {
    link: string;
    amount: string;
    description?: string;
};

type StageValue = boolean | number | string | DepositEntry[] | ChangeOrderEntry[];

// === Helpers ===
function parseCSV(text: string): ClosingRow[] {
    // Use PapaParse to handle multiline and quoted fields
    const { data } = Papa.parse(text, { skipEmptyLines: true });

    if (!data.length || !Array.isArray(data[0])) return [];

    // Skip the first column (A)
    const headers = (data[0] as string[]).slice(1).map(h =>
        h.replace(/[\n\r]+/g, "")
            .replace(/"/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase()
    );

    const rows: ClosingRow[] = [];

    for (let i = 1; i < data.length; i++) {
        const fullRow = data[i] as string[];
        const firstCol = (fullRow[0] ?? "").trim();
        const rowCells = fullRow.slice(1);
        if (rowCells.length === 0) continue;

        // Column O (FOR SALE flag): after skipping A, index 13 is column O (B=0,...,O=13)
        const colORaw = (rowCells[13] ?? "").trim();
        const forSale = /for\s*sale/i.test(colORaw);

        // Column Y (Spec listing URL): after skipping A, index 23 is column Y (B=0,...,Y=23)
        const listingUrlRaw = (rowCells[23] ?? "").trim();

        const obj: any = {};
        headers.forEach((h, idx) => {
            obj[h] = (rowCells[idx] ?? "").replace(/[\n\r]+/g, "").replace(/\s+/g, " ").trim();
        });

        // Helper to get a column value by name (case-insensitive, whitespace-insensitive)
        const get = (key: string) => {
            const norm = (s: string) => s.replace(/[\s\n\r"]+/g, "").toLowerCase();
            const keys = Object.keys(obj);
            let found = keys.find(k => norm(k) === norm(key));
            return found ? obj[found] : "";
        };

        // Flexible finder for Agreement Date (handles headers like 'agreement date (k)' etc.)
        const getAgreementDate = () => {
            const keys = Object.keys(obj);
            const found = keys.find(k => /agreement/i.test(k) && /date/i.test(k));
            return found ? obj[found] : get("agreement date");
        };

        const address = get("address").trim();
        const expectedClosing = get("expected closing date").trim();
        // Only require address; allow missing expected closing date so search can find these rows
        if (!address) continue;

        const all_dates = ["expected closing date"]
            .map(col => normalizeDate(get(col)))
            .filter(date => date && date !== "");

        // Column K mapping: after skipping A, index 9 is column K (B=0,...,K=9)
        const agreementK = normalizeDate((rowCells[9] ?? "").trim());
        const agreementDate = normalizeDate(getAgreementDate() || (rowCells[9] ?? "").trim());
        // Column N year: after skipping A, index 12 is column N (B=0,...,N=12)
        const yearNRaw = (rowCells[12] ?? "").trim();
        // If format is MMM-DD-YYYY, extract the YYYY part; else try to coerce to a Date and read the year
        let yearN: number | undefined = undefined;
        const mmyMatch = yearNRaw.match(/^([A-Za-z]{3})-\d{2}-(\d{4})$/);
        if (mmyMatch) {
            yearN = parseInt(mmyMatch[2], 10);
        } else {
            const yrMatch = yearNRaw.match(/\b(\d{4})\b/);
            if (yrMatch) {
                const y = parseInt(yrMatch[1], 10);
                yearN = Number.isFinite(y) ? y : undefined;
            } else {
                const d = new Date(normalizeDate(yearNRaw));
                const y = d.getFullYear();
                yearN = Number.isFinite(y) && !isNaN(d.getTime()) ? y : undefined;
            }
        }

        const row: ClosingRow = {
            id: address,
            address,
            client_name: get("client name"),
            type: get("type"),
            foreman: get("foreman"),
            expected_closing_date: normalizeDate(expectedClosing),
            agreement_date: agreementDate,
            listing_url: listingUrlRaw,
            permit: get("permit") || get("permit application") || get("permit status"),
            days_delayed: get("days delayed"),
            project_status: get("project status"),
            all_dates,
            closing_data_status: get("closing date status"),
            original_closing_date: normalizeDate(get("original closing date")),
            financial_status: get("financial status"),
            closing_year_n: typeof yearN === 'number' && !isNaN(yearN) ? yearN : undefined,
            for_sale: forSale,
        };

        rows.push(row);
    }

    return rows;
}

function daysUntil(dateStr: string): number | null {
    if (!dateStr) return null;
    const target = new Date(dateStr + "T00:00:00");
    if (isNaN(target.getTime())) return null;
    const today = new Date();
    const diffMs = target.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

function fmt(dateStr?: string) {
    if (!dateStr) return "";
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return dateStr;
    // Format as MON-DD-YYYY (e.g., Feb-05-2025)
    const month = d.toLocaleString("en-US", { month: "short" });
    const day = String(d.getDate()).padStart(2, "0");
    const year = d.getFullYear();
    return `${month}-${day}-${year}`;
}

function normalizeUrl(url?: string): string {
    const raw = (url || "").trim();
    if (!raw) return "";
    // If already absolute, keep it
    if (/^https?:\/\//i.test(raw)) return raw;
    // If looks like a domain (e.g., newvictorianhomes.ca/listing), add https
    if (/^[\w-]+\.[\w.-]+\//.test(raw) || /^[\w-]+\.[\w.-]+$/i.test(raw)) return `https://${raw}`;
    // Otherwise, return as-is (could be a relative path handled by the deployment)
    return raw;
}

// Helper used when filtering rows for display
function isWithinLast30Days(dateStr?: string): boolean {
    if (!dateStr) return false;
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return false;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const thirtyDaysAgo = new Date(start.getTime() - 30 * 24 * 60 * 60 * 1000);
    return d >= thirtyDaysAgo; // includes today and any future date
}

function isWithinLastDays(dateStr?: string, days: number = 60): boolean {
    if (!dateStr) return false;
    const d = new Date(dateStr + "T00:00:00");
    if (isNaN(d.getTime())) return false;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diffMs = start.getTime() - d.getTime();
    if (diffMs < 0) return false;
    return diffMs <= days * 24 * 60 * 60 * 1000;
}

const monthLabels = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function groupByMonth(rows: ClosingRow[]) {
    const map = new Map<string, ClosingRow[]>();
    for (const r of rows) {
        let dateStr = r.expected_closing_date;
        let d: Date;
        if (dateStr && !isNaN(new Date(dateStr + "T00:00:00").getTime())) {
            d = new Date(dateStr + "T00:00:00");
        } else {
            // Skip rows with missing/invalid dates
            continue;
        }
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(r);
    }
    for (const [k, arr] of map) {
        arr.sort((a, b) => {
            const da = new Date(a.expected_closing_date + "T00:00:00").getTime();
            const db = new Date(b.expected_closing_date + "T00:00:00").getTime();
            return da - db;
        });
        map.set(k, arr);
    }
    return map;
}

function statusBadgeColor(status?: string) {
    switch ((status || "").toLowerCase()) {
        case "delay expected": return "bg-nvh-red border-nvh-redDark";
        case "confirmed": return "bg-white/10 border-white/20";
        case "amendment complete": return "bg-slate-500 border-slate-400";
        case "amendment pending": return "bg-slate-600 border-slate-500";
        case "cancelled": return "bg-nvh-redDark border-nvh-red";
        default: return "bg-slate-600 border-slate-500";
    }
}

function statusBgColor(status?: string) {
    switch ((status || "").toLowerCase()) {
        case "delay expected": return ["bg-nvh-red/15"]; 
        case "confirmed": return ["bg-white/5"]; 
        case "amendment complete": return ["bg-slate-800/40"]; 
        case "amendment pending": return ["bg-slate-800/40"]; 
        case "cancelled": return ["bg-nvh-redDark/20"]; 
        default: return ["bg-slate-800/40"]; 
    }
}

function ComingSoonBadge({ days }: { days: number }) {
    let label = "Coming Soon";
    let extra = "";
    if (days <= THIS_WEEK_DAYS) { label = "This Week"; extra = ` · ${days}d`; }
    else if (days >= 0) { extra = ` · ${days}d`; }
    return (
        <span className="ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-white/10 text-white ring-1 ring-white/20">
            <Clock className="h-3 w-3 mr-1" /> {label}{extra}
        </span>
    );
}

// Helper to generate all month keys between Sept 2025 and Dec 2026
function getAllMonthKeys(): string[] {
    const keys: string[] = [];
    let year = CYCLE_START_YEAR;
    let month = CYCLE_START_MONTH;
    while (year < CYCLE_END_YEAR || (year === CYCLE_END_YEAR && month <= CYCLE_END_MONTH)) {
        keys.push(`${year}-${String(month).padStart(2, "0")}`);
        month++;
        if (month > 12) {
            month = 1;
            year++;
        }
    }
    return keys;
}

const STAGES = [
    "Plumbing",
    "Lighting",
    "Cabinets",
    "Kitchen Plan",
    "Flooring",
    "Paint",
    "Foreman Selections",
    "Closets",
    "Fireplace",
    "Stairs",
    "Siding",
    "Custom 1",
    "Custom 2"
];

const PROJECT_STATUS_ORDER: string[] = [
    "Permit Application",
    "Permit",
    "Foundation",
    "Framing",
    "Dug Out",
    "Trusses",
    "Windows & Shingles",
    "Siding",
    "Plumbing",
    "Electrical",
    "Insulation",
    "Drywall",
    "Plaster",
    "Trim",
    "Paint",
    "Flooring",
    "Kitchen",
    "Fixtures",
    "Final Occupancy",
    "Closing Prep",
    "Closed",
];

const PROJECT_STATUS_COLORS = [
    "bg-red-500/90",       // Permit Application
    "bg-red-400/90",       // Permit
    "bg-orange-500/90",    // Foundation
    "bg-orange-400/90",    // Framing
    "bg-amber-500/90",     // Dug Out
    "bg-amber-400/90",     // Trusses
    "bg-yellow-500/90",    // Windows & Shingles
    "bg-yellow-400/90",    // Siding
    "bg-lime-500/90",      // Plumbing
    "bg-lime-400/90",      // Electrical
    "bg-green-500/90",     // Insulation
    "bg-green-400/90",     // Drywall
    "bg-emerald-500/90",   // Plaster
    "bg-emerald-400/90",   // Trim
    "bg-teal-500/90",      // Paint
    "bg-teal-400/90",      // Flooring
    "bg-cyan-500/90",      // Kitchen
    "bg-cyan-400/90",      // Fixtures
    "bg-sky-500/90",       // Final Occupancy
    "bg-sky-400/90",       // Closing Prep
    "bg-blue-500/90",      // Closed (blue to match scheme)
];

const getProgressBarClass = (status: string, index: number) => {
    const idx = index >= 0 ? index : PROJECT_STATUS_ORDER.findIndex(s => s.toLowerCase() === status.toLowerCase());
    return PROJECT_STATUS_COLORS[idx >= 0 ? idx % PROJECT_STATUS_COLORS.length : PROJECT_STATUS_COLORS.length - 1];
};

function getWeatherConditionLabel(code?: number): string {
    if (code === undefined || code === null || Number.isNaN(code)) return "";
    switch (code) {
        case 0: return "Clear";
        case 1: return "Mainly clear";
        case 2: return "Partly cloudy";
        case 3: return "Overcast";
        case 45: return "Fog";
        case 48: return "Depositing rime fog";
        case 51: return "Light drizzle";
        case 53: return "Drizzle";
        case 55: return "Heavy drizzle";
        case 56: return "Freezing drizzle";
        case 57: return "Freezing drizzle";
        case 61: return "Light rain";
        case 63: return "Rain";
        case 65: return "Heavy rain";
        case 66: return "Freezing rain";
        case 67: return "Freezing rain";
        case 71: return "Light snow";
        case 73: return "Snow";
        case 75: return "Heavy snow";
        case 77: return "Snow grains";
        case 80: return "Rain showers";
        case 81: return "Rain showers";
        case 82: return "Heavy showers";
        case 85: return "Snow showers";
        case 86: return "Heavy snow showers";
        case 95: return "Thunderstorm";
        case 96: return "Thunderstorm with hail";
        case 99: return "Thunderstorm with hail";
        default: return "Unknown";
    }
}

export default function App() {
     const csvUrl = SHEET_CSV_URL; // Always use the env variable
 
     const [raw, setRaw] = useState<string>("");
     const [loading, setLoading] = useState(false);
     const [error, setError] = useState<string | null>(null);
     const [filterText, setFilterText] = useState("");
     const [showAll, setShowAll] = useState(false); // <-- Add this line
     const [stageModal, setStageModal] = useState<null | { jobId: string }>(null);
     // Checklist selections state
    const [stageChecks, setStageChecks] = useState<{ [jobId: string]: { [stage: string]: StageValue } }>({});
     const [showDieter, setShowDieter] = useState(false);
     const [showSpecs, setShowSpecs] = useState(false);
     const [showPermitApp, setShowPermitApp] = useState(false);
     const [tvMode, setTvMode] = useState(false);
    const [compactCards, setCompactCards] = useState(false);
    const [showFilters, setShowFilters] = useState(true);
    const [showBackToTop, setShowBackToTop] = useState(false);
    const [fullscreenMode, setFullscreenMode] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [showProgressChart, setShowProgressChart] = useState(false);
    const [weather, setWeather] = useState<null | { tempC: number; windKph: number; code: number; time: string }>(null);
    const [weatherError, setWeatherError] = useState<string | null>(null);
    const [nowTime, setNowTime] = useState(() => new Date());
    const weatherCondition = useMemo(() => getWeatherConditionLabel(weather?.code), [weather?.code]);
    const weatherTime = useMemo(() => {
        if (!weather?.time) return null;
        const d = new Date(weather.time);
        return isNaN(d.getTime()) ? null : d;
    }, [weather?.time]);
    useEffect(() => {
        if (typeof window === "undefined") return;
        const mq = window.matchMedia("(max-width: 639px)");
        const update = () => setIsMobile(mq.matches);
        update();
        if (mq.addEventListener) mq.addEventListener("change", update);
        else mq.addListener(update);
        return () => {
            if (mq.removeEventListener) mq.removeEventListener("change", update);
            else mq.removeListener(update);
        };
    }, []);
    useEffect(() => {
        const id = setInterval(() => setNowTime(new Date()), 60000);
        return () => clearInterval(id);
    }, []);
    const clockTime = weatherTime ?? nowTime;
    const clockAngles = useMemo(() => {
        const hours = clockTime.getHours() % 12;
        const minutes = clockTime.getMinutes();
        return {
            hour: (hours + minutes / 60) * 30,
            minute: minutes * 6,
        };
    }, [clockTime]);
    const timeOfDay = useMemo(() => {
        if (!weatherTime) return "";
        const h = weatherTime.getHours();
        if (h >= 5 && h < 12) return "Morning";
        if (h >= 12 && h < 17) return "Afternoon";
        if (h >= 17 && h < 21) return "Evening";
        return "Night";
    }, [weatherTime]);
    const updatedTime = useMemo(() => {
        if (!weatherTime) return "";
        return weatherTime.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });
    }, [weatherTime]);
 
     // Mobile search suggestions dropdown management
     const inputRef = useRef<HTMLInputElement | null>(null);
     const [showSuggestions, setShowSuggestions] = useState(false);
     const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
 
     const computeAnchorRect = () => {
         const el = inputRef.current;
         if (!el) return;
         const rect = el.getBoundingClientRect();
         setAnchorRect({ top: rect.bottom, left: rect.left, width: rect.width });
     };
 
     useEffect(() => {
         if (!showSuggestions) return;
         computeAnchorRect();
         const onResize = () => computeAnchorRect();
         const onScroll = () => computeAnchorRect();
         window.addEventListener('resize', onResize);
         window.addEventListener('scroll', onScroll, { passive: true });
         const vv: any = (window as any).visualViewport;
         if (vv && typeof vv.addEventListener === 'function') {
             vv.addEventListener('resize', onResize);
             vv.addEventListener('scroll', onResize);
         }
         return () => {
             window.removeEventListener('resize', onResize);
             window.removeEventListener('scroll', onScroll);
             if (vv && typeof vv.removeEventListener === 'function') {
                 vv.removeEventListener('resize', onResize);
                 vv.removeEventListener('scroll', onResize);
             }
         };
     }, [showSuggestions]);
 
     // Load checklist selections from Firebase on mount
     useEffect(() => {
         const dbRef = ref(db, "stageChecks/shared");
         const unsubscribe = onValue(dbRef, (snapshot) => {
             setStageChecks(snapshot.exists() ? snapshot.val() : {});
         }); 
         return () => unsubscribe();
     }, []);
 
     const fetchData = async () => {
         if (!csvUrl) { setError(null); setRaw(""); return; }
         try {
             setLoading(true); setError(null);
             const res = await fetch(csvUrl, { cache: "no-store" });
             if (!res.ok) throw new Error(`HTTP ${res.status}`);
             const text = await res.text();
             console.log("RAW CSV:", text); // <--- Add this line
             setRaw(text);
         } catch (e: any) {
             setError(e?.message || "Failed to load data");
         } finally { setLoading(false); }
     };
 
     useEffect(() => { fetchData(); }, [csvUrl]);

    useEffect(() => {
        const controller = new AbortController();
        const fetchWeather = async () => {
            try {
                setWeatherError(null);
                const url = "https://api.open-meteo.com/v1/forecast?latitude=47.5615&longitude=-52.7126&current=temperature_2m,weather_code,wind_speed_10m&timezone=America%2FSt_Johns";
                const res = await fetch(url, { signal: controller.signal });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                const current = data?.current;
                if (!current) throw new Error("No weather data");
                setWeather({
                    tempC: Number(current.temperature_2m),
                    windKph: Number(current.wind_speed_10m),
                    code: Number(current.weather_code),
                    time: String(current.time),
                });
            } catch (e: any) {
                if (e?.name === 'AbortError') return;
                setWeatherError(e?.message || "Weather unavailable");
            }
        };
        fetchWeather();
        const id = window.setInterval(fetchWeather, 10 * 60 * 1000);
        return () => { controller.abort(); window.clearInterval(id); };
    }, []);

     // Parse once, derive all other views from this.
     const parsedRows = useMemo(() => (raw ? parseCSV(raw) : []), [raw]);
 
      // Rows used by the board:
      // - no search: last 30 days + future (keeps the board tight)
      // - searching: open jobs + closed in the last 60 days
     // Search behavior:
     // - if query contains a digit, prefer fast address-prefix matching
     // - otherwise, search across address/client/foreman/type/status/permit
      const searchableRows = useMemo(() => {
          return parsedRows.filter(r => {
                const isClosed = (r.project_status || '').toLowerCase() === 'closed';
                if (!isClosed) return true;
                return isWithinLastDays(r.expected_closing_date, 60);
          });
      }, [parsedRows]);

     const rows = useMemo(() => {
        const base = parsedRows.filter(r => isWithinLast30Days(r.expected_closing_date));

         const q = filterText.trim().toLowerCase();
         if (!q) return base;

         const hasDigit = /\d/.test(q);
         const includes = (v?: string) => (v || "").toLowerCase().includes(q);
         const addr = (r: ClosingRow) => (r.address || "").toLowerCase();

         const matches = (r: ClosingRow) => {
             if (hasDigit) return addr(r).startsWith(q);
             return (
                 includes(r.address) ||
                 includes(r.client_name) ||
                 includes(r.foreman) ||
                 includes(r.type) ||
                 includes(r.closing_data_status) ||
                 includes(r.project_status) ||
                 includes(r.permit) ||
                 includes(String(stageChecks?.[r.id]?.PermitNumber ?? ""))
             );
         };

         return searchableRows.filter(matches);
     }, [parsedRows, searchableRows, filterText, stageChecks]);
 
     const totalSpecs = rows.filter(r => (r.type || "").toLowerCase().includes("spec")).length;

    const fullscreenOpenRows = useMemo(() => {
        const openRows = parsedRows.filter(r => (r.project_status || '').toLowerCase() !== 'closed');
        const toTime = (s?: string) => (s ? new Date(s + 'T00:00:00').getTime() : NaN);
        return [...openRows].sort((a, b) => {
            const ta = toTime(a.expected_closing_date);
            const tb = toTime(b.expected_closing_date);
            const va = isNaN(ta) ? Infinity : ta;
            const vb = isNaN(tb) ? Infinity : tb;
            return va - vb;
        });
    }, [parsedRows]);

    const mobileOpenRows = useMemo(() => {
        const openRows = parsedRows.filter(r => (r.project_status || '').toLowerCase() !== 'closed');
        const q = filterText.trim().toLowerCase();
        const hasDigit = /\d/.test(q);
        const includes = (v?: string) => (v || "").toLowerCase().includes(q);
        const addr = (r: ClosingRow) => (r.address || "").toLowerCase();
        const matches = (r: ClosingRow) => {
            if (!q) return true;
            if (hasDigit) return addr(r).startsWith(q);
            return (
                includes(r.address) ||
                includes(r.client_name) ||
                includes(r.foreman) ||
                includes(r.type) ||
                includes(r.closing_data_status) ||
                includes(r.project_status) ||
                includes(r.permit) ||
                includes(String(stageChecks?.[r.id]?.PermitNumber ?? ""))
            );
        };
        // On mobile, default to open rows, but when searching include open + closed in last 60 days.
        const baseRows = q ? searchableRows : openRows;
        const filtered = q ? baseRows.filter(matches) : baseRows;
        const toTime = (s?: string) => (s ? new Date(s + 'T00:00:00').getTime() : NaN);
        return [...filtered].sort((a, b) => {
            const ta = toTime(a.expected_closing_date);
            const tb = toTime(b.expected_closing_date);
            const va = isNaN(ta) ? Infinity : ta;
            const vb = isNaN(tb) ? Infinity : tb;
            return va - vb;
        });
    }, [parsedRows, searchableRows, filterText, stageChecks]);

    const stats = useMemo(() => {
        const openCount = rows.filter(r => (r.project_status || '').toLowerCase() !== 'closed').length;
        const closedCount = rows.filter(r => (r.project_status || '').toLowerCase() === 'closed').length;
        const soonCount = rows.filter(r => {
            const d = daysUntil(r.expected_closing_date || "");
            return d !== null && d >= 0 && d <= COMING_SOON_DAYS;
        }).length;
        return { openCount, closedCount, soonCount };
    }, [rows]);

    const progressCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const status of PROJECT_STATUS_ORDER) counts[status] = 0;
        for (const r of parsedRows) {
            const raw = String(r.project_status || '').trim();
            if (!raw) continue;
            const idx = PROJECT_STATUS_ORDER.findIndex(s => s.toLowerCase() === raw.toLowerCase());
            if (idx >= 0) counts[PROJECT_STATUS_ORDER[idx]] += 1;
            else counts[raw] = (counts[raw] || 0) + 1;
        }
        return counts;
    }, [parsedRows]);

     // Count closings per year used in the Summary table (Expected Closing Date year)
        const closingYearCounts = useMemo(() => {
                const counts: Record<number, number> = {};
                for (const r of parsedRows) {
                        // Exclude rows marked FOR SALE in column O
                        if (r.for_sale) continue;
                        if ((r.type || "").toLowerCase().includes("spec")) continue;
                        if (!r.expected_closing_date) continue;
                        const d = new Date(r.expected_closing_date + "T00:00:00");
                        if (isNaN(d.getTime())) continue;
                        const y = d.getFullYear();
                        counts[y] = (counts[y] || 0) + 1;
                }
                return counts;
        }, [parsedRows]);

        // Count closed jobs per year (Expected Closing Date year)
        const closedYearCounts = useMemo(() => {
            const counts: Record<number, number> = {};
            for (const r of parsedRows) {
                if ((r.project_status || '').toLowerCase() !== 'closed') continue;
                if (r.for_sale) continue;
                if ((r.type || "").toLowerCase().includes("spec")) continue;
                if (!r.expected_closing_date) continue;
                const d = new Date(r.expected_closing_date + "T00:00:00");
                if (isNaN(d.getTime())) continue;
                const y = d.getFullYear();
                counts[y] = (counts[y] || 0) + 1;
            }
            return counts;
        }, [parsedRows]);

     const specRows = useMemo(() => {
         const arr = parsedRows.filter(r => (r.type || '').toLowerCase().includes('spec'));
         // sort by expected closing date asc, invalids last
         const toTime = (s?: string) => (s ? new Date(s + 'T00:00:00').getTime() : NaN);
         return [...arr].sort((a, b) => {
             const ta = toTime(a.expected_closing_date);
             const tb = toTime(b.expected_closing_date);
             const va = isNaN(ta) ? Infinity : ta;
             const vb = isNaN(tb) ? Infinity : tb;
             return va - vb;
         });
     }, [parsedRows]);
 
     // Permit Application rows: any job where closing_data_status includes 'permit application' or project_status/permit field mentions permit
     const permitRows = useMemo(() => {
         return parsedRows
             .filter(r => {
                 const status = (r.closing_data_status || '').toLowerCase();
                 const permitField = (r.permit || '').toLowerCase();
                 const projectStatus = (r.project_status || '').toLowerCase();
                // PermitNumber may be stored in stageChecks (from Firebase) or in the `permit` CSV column.
                const permitNumStage = String((stageChecks?.[r.id]?.PermitNumber) ?? '').trim().toUpperCase();
                const permitNumField = String(r.permit ?? '').trim().toUpperCase();
                // prefer explicit stageChecks permit number but fall back to CSV permit column
                const permitNum = permitNumStage || permitNumField;
                // Accept if starts with AP or NOT, but exclude if it starts with a digit or with NCS
                const hasPermitNumPrefix = (permitNum.startsWith('AP') || permitNum.startsWith('NOT')) && !permitNum.match(/^[0-9]/) && !permitNum.startsWith('NCS');

                return (projectStatus.includes('permit application') ||
                    status.includes('permit application') ||
                    permitField.includes('permit application')) &&
                    hasPermitNumPrefix;
             })
             .sort((a, b) => {
                 const ta = a.expected_closing_date ? new Date(a.expected_closing_date + 'T00:00:00').getTime() : Infinity;
                 const tb = b.expected_closing_date ? new Date(b.expected_closing_date + 'T00:00:00').getTime() : Infinity;
                 const va = isNaN(ta) ? Infinity : ta;
                 const vb = isNaN(tb) ? Infinity : tb;
                 return va - vb;
             });
     }, [parsedRows, stageChecks]);
 
     // Group rows by month for tabs and month view
     const grouped = useMemo(() => groupByMonth(rows), [rows]);
 
     // Compute current year/month and monthKeys from grouped map
     const now = new Date();
     const currentYear = now.getFullYear();
     const currentMonth = now.getMonth() + 1; // JS months are 0-based
 
     const monthKeys = useMemo(() => {
         // Show all months in the configured cycle window, regardless of whether there are rows.
         // The Month panel will handle empty months gracefully.
         return getAllMonthKeys();
     }, []);
 
    const [active, setActive] = useState(() => {
        const key = `${currentYear}-${String(currentMonth).padStart(2, "0")}`;
        const idx = monthKeys.indexOf(key);
        return idx >= 0 ? idx : 0;
    });
     const activeKey = monthKeys[active];
     const viewMode = showAll
         ? "all"
         : showDieter
         ? "dieter"
         : showSpecs
         ? "specs"
         : showPermitApp
         ? "permit"
         : tvMode
         ? "tv"
         : "month";

     const toTime = (s?: string) => (s ? new Date(s + 'T00:00:00').getTime() : NaN);
     const sortByClosingAsc = (a: ClosingRow, b: ClosingRow) => {
         const ta = toTime(a.expected_closing_date);
         const tb = toTime(b.expected_closing_date);
         const va = isNaN(ta) ? Infinity : ta;
         const vb = isNaN(tb) ? Infinity : tb;
         return va - vb;
     };
 
     // Dieter rows: all open + closed within past 3 months, ordered by soonest closing date
     const dieterRows = useMemo(() => {
         const today = new Date();
         const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
         const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
         const since = startToday - ninetyDaysMs;
         const toTime = (s?: string) => (s ? new Date(s + 'T00:00:00').getTime() : NaN);
 
         const open = parsedRows.filter(r => (r.project_status || '').toLowerCase() !== 'closed');
         const closedRecent = parsedRows.filter(r => {
             if ((r.project_status || '').toLowerCase() !== 'closed') return false;
             const t = toTime(r.expected_closing_date);
             return !isNaN(t) && t >= since && t <= startToday;
         });
         const combined = [...open, ...closedRecent];
         // unique by id
         const map = new Map<string, ClosingRow>();
         for (const r of combined) map.set(r.id, r);
         const unique = Array.from(map.values());
         unique.sort((a, b) => {
             const ta = toTime(a.expected_closing_date);
             const tb = toTime(b.expected_closing_date);
             const va = isNaN(ta) ? Infinity : ta;
             const vb = isNaN(tb) ? Infinity : tb;
             return va - vb;
         });
         return unique;
     }, [parsedRows]);
 
     // The list used for modal Prev/Next should follow what the user is currently looking at.
     const currentList = useMemo(() => {
        if (isMobile) return mobileOpenRows;
         if (filterText.trim()) return [...rows].sort(sortByClosingAsc);
         if (showDieter) return dieterRows;
         if (showSpecs) return specRows;
         if (showPermitApp) return permitRows;
         if (showAll) return [...rows].sort(sortByClosingAsc);
         return grouped.get(activeKey) || [];
    }, [isMobile, mobileOpenRows, filterText, rows, showDieter, dieterRows, showSpecs, specRows, showPermitApp, permitRows, showAll, grouped, activeKey]);

     const currentIndex = useMemo(() => {
         if (!stageModal) return -1;
         return currentList.findIndex(r => r.id === stageModal?.jobId);
     }, [stageModal, currentList]);
 
     const hasPrev = currentIndex > 0;
     const hasNext = currentIndex >= 0 && currentIndex < currentList.length - 1;
     const prevId = hasPrev ? currentList[currentIndex - 1].id : undefined;
     const nextId = hasNext ? currentList[currentIndex + 1].id : undefined;
 
     const openPrevJob = () => { if (prevId) setStageModal({ jobId: prevId }); };
     const openNextJob = () => { if (nextId) setStageModal({ jobId: nextId }); };

     // Keyboard shortcuts: / focuses search, Esc clears/closes, arrows navigate modal.
     useEffect(() => {
         const onKeyDown = (e: KeyboardEvent) => {
             const target = e.target as HTMLElement | null;
             const tag = (target?.tagName || '').toLowerCase();
             const typing = tag === 'input' || tag === 'textarea' || (target as any)?.isContentEditable;

             if (e.key === '/' && !typing) {
                 e.preventDefault();
                 inputRef.current?.focus();
                 return;
             }
             if (e.key === 'Escape') {
                if (stageModal) {
                    e.preventDefault();
                    setStageModal(null);
                } else if (showProgressChart) {
                    closeProgressChart();
                } else {
                    setFilterText('');
                }
                 return;
             }
             if (stageModal && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                 e.preventDefault();
                 if (e.key === 'ArrowLeft') openPrevJob();
                 else openNextJob();
             }
         };
         window.addEventListener('keydown', onKeyDown);
         return () => window.removeEventListener('keydown', onKeyDown);
    }, [stageModal, showProgressChart, closeProgressChart, openPrevJob, openNextJob]);

    useEffect(() => {
        if (!stageModal) return;
        const onKeyDownCapture = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            setStageModal(null);
        };
        document.addEventListener('keydown', onKeyDownCapture, true);
        return () => document.removeEventListener('keydown', onKeyDownCapture, true);
    }, [stageModal]);

    useEffect(() => {
        const onScroll = () => setShowBackToTop(window.scrollY > 200);
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        const onFullscreenChange = () => {
            const d: any = document;
            const isFullscreen = Boolean(d.fullscreenElement);
            setFullscreenMode(isFullscreen);
            if (!isFullscreen && stageModal) {
                try { d.documentElement.requestFullscreen(); } catch { /* ignore */ }
            }
        };
        document.addEventListener('fullscreenchange', onFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, [stageModal]);

    useEffect(() => {
        if (!fullscreenMode) return;
        if (showProgressChart) return;
        const step = 1.5;
        const id = window.setInterval(() => {
            const max = document.documentElement.scrollHeight - window.innerHeight;
            if (max <= 0) return;
            const next = window.scrollY + step;
            window.scrollTo({ top: next >= max ? 0 : next, behavior: 'auto' });
        }, 30);

        return () => window.clearInterval(id);
    }, [fullscreenMode, fullscreenOpenRows.length, showProgressChart]);

    // TV mode auto-rotates months when in Month view.
    useEffect(() => {
        if (!tvMode) return;
        if (stageModal) return;
        if (filterText.trim()) return;
        if (showAll || showDieter || showSpecs || showPermitApp) return;
        if (!monthKeys.length) return;

        const id = window.setInterval(() => {
            setActive(a => (a + 1) % monthKeys.length);
            try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); }
        }, Math.max(3, AUTO_ROTATE_SECONDS) * 1000);

        return () => window.clearInterval(id);
    }, [tvMode, stageModal, filterText, showAll, showDieter, showSpecs, showPermitApp, monthKeys.length]);
 
     const currentJob = useMemo(() => {
         if (!stageModal?.jobId) return undefined;
         // Use parsedRows to ensure we can find any job by id
         return parsedRows.find(r => r.id === stageModal.jobId);
     }, [stageModal, parsedRows]);
 
     // Handler to open modal
     const handleJobClick = (jobId: string) => setStageModal({ jobId });

     // Save handler for StageModal (persist to Firebase and update local state)
    const handleSaveStages = async (jobId: string, stages: { [stage: string]: StageValue }) => {
         try {
             // Optimistic local update
             setStageChecks(prev => ({ ...prev, [jobId]: stages }));
             // Persist to Firebase under shared namespace
             await set(ref(db, `stageChecks/shared/${jobId}`), stages);
         } catch (e) {
             console.error('Failed to save stages', e);
         }
     };

     // Print report: selections for all jobs not yet closed
     const handlePrintSelections = () => {
         try {
             const openJobs = parsedRows.filter(r => (r.project_status || '').toLowerCase() !== 'closed');
            const selectionKeysOrdered: string[] = [
                'Finance',
                'Permit',
                'PermitNumber',
                'AHWP',
                'Welcome Sent',
                'Kickoff Booked',
                'NL Power',
                'Deposits',
            ];

             const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Selections Report</title>
  <style>
    :root { color-scheme: light dark; }
    @page { size: letter landscape; margin: 8mm; }
    html, body { margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; margin: 8mm; }
    h1 { margin: 0 0 6px 0; font-size: 14px; }
    .meta { color: #666; margin-bottom: 8px; font-size: 10px; }
    /* Let columns size to content */
    table { border-collapse: collapse; width: auto; table-layout: auto; font-size: 13.5px; line-height: 1.2; }
    th, td { border: 1px solid #ccc; padding: 6px 8px; vertical-align: middle; }
    th { background: #f3f4f6; text-align: left; font-size: 13.5px; }
    td.center, th.center { text-align: center; }
    .nowrap { white-space: normal; }
    /* Horizontal header labels for readability */
    th.vhead { writing-mode: horizontal-tb; transform: none; text-align: center; padding: 6px 8px; height: auto; line-height: 1.1; }
    thead tr th.addr, thead tr th.client, thead tr th.foreman, thead tr th.type, thead tr th.closing { writing-mode: horizontal-tb; transform: none; height: auto; }
    /* Keep selection cells tight while still auto-sized */
    td.sel { text-align: center; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <h1>Selections Report (Open Jobs)</h1>
  <div class="meta">Generated ${new Date().toLocaleString()}</div>
  <table>
    <thead>
      <tr>
        <th class="nowrap addr">Address</th>
        <th class="nowrap client">Client</th>
        <th class="nowrap foreman">Foreman</th>
        <th class="nowrap type">Type</th>
        <th class="nowrap closing">Closing</th>
        ${selectionKeysOrdered.map(k => `<th class="center vhead">${k}</th>`).join('')}
      </tr>
    </thead>
    <tbody>
      ${openJobs.map(r => {
          const checks = stageChecks[r.id] || {};
          const valToText = (v: any) => {
              if (Array.isArray(v)) {
                  const hasDeposit = v.some((d: any) => d && (String(d.date || '').trim() || String(d.amount || '').trim()));
                  return hasDeposit ? '✓' : '';
              }
              if (typeof v === 'boolean') return v ? '✓' : '';
              if (v === null || v === undefined) return '';
              const s = String(v).trim();
              return s.length > 24 ? s.slice(0, 24) + '…' : s;
          };
          return `
        <tr>
          <td>${r.address ?? ''}</td>
          <td>${r.client_name ?? ''}</td>
          <td>${r.foreman ?? ''}</td>
          <td>${r.type ?? ''}</td>
          <td>${r.expected_closing_date ? fmt(r.expected_closing_date) : ''}</td>
          ${selectionKeysOrdered.map(k => `<td class="center sel">${valToText(checks[k])}</td>`).join('')}
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <div class="no-print" style="margin-top:8px; display:flex; gap:8px;">
    <button onclick="window.print()">Print</button>
    <button id="exportBtn">Export CSV</button>
  </div>
  <script>
    (function(){
      const headers = [
        'Address','Client','Foreman','Type','Closing',
        ${JSON.stringify(selectionKeysOrdered)}
      ];
      function exportCSV(){
        const rows = [];
        const table = document.querySelector('table');
        const bodyRows = table.querySelectorAll('tbody tr');
        rows.push(headers);
        bodyRows.forEach(tr => {
          const cells = tr.querySelectorAll('td');
          const row = Array.from(cells).map(td => td.textContent || '');
          rows.push(row);
        });
        const csv = rows.map(r => r.map(cell => '"' + String(cell).replace(/"/g,'""') + '"').join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'selections_report.csv';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
      }
      document.getElementById('exportBtn')?.addEventListener('click', exportCSV);
    })();
  </script>
</body>
</html>
             `.trim();

             const w = window.open('', '_blank');
             if (!w) return;
             w.document.open();
             w.document.write(html);
             w.document.close();
             setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 250);
         } catch (e) {
             console.error('Failed to print selections report', e);
         }
     };

     // Export selections as CSV directly (without opening print window)
     const handleExportSelections = () => {
         try {
             const openJobs = parsedRows.filter(r => (r.project_status || '').toLowerCase() !== 'closed');
             const selectionKeysOrdered: string[] = [
                 'Finance',
                 'Permit',
                 'PermitNumber',
                 'AHWP',
                 'Welcome Sent',
                 'Kickoff Booked',
                 'NL Power',
                'Deposits',
                 'Custom1',
                 'Custom2',
                 ...STAGES,
             ];
             const headers = ['Address','Client','Foreman','Type','Closing',...selectionKeysOrdered];
             const rowsCsv: string[][] = [headers];
             openJobs.forEach(r => {
                 const checks = stageChecks[r.id] || {};
                const valToRaw = (v: any) => {
                    if (Array.isArray(v)) {
                        const hasDeposit = v.some((d: any) => d && (String(d.date || '').trim() || String(d.amount || '').trim()));
                        return hasDeposit ? 'TRUE' : 'FALSE';
                    }
                    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
                    if (v === null || v === undefined) return '';
                    return String(v);
                };
                 const row = [
                     r.address ?? '',
                     r.client_name ?? '',
                     r.foreman ?? '',
                     r.type ?? '',
                     r.expected_closing_date ? fmt(r.expected_closing_date) : '',
                     ...selectionKeysOrdered.map(k => valToRaw(checks[k]))
                 ];
                 rowsCsv.push(row);
             });
             const csv = rowsCsv.map(r => r.map(cell => '"' + String(cell).replace(/"/g,'""') + '"').join(',')).join('\n');
             const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
             const url = URL.createObjectURL(blob);
             const a = document.createElement('a');
             a.href = url;
             a.download = 'selections_report.csv';
             document.body.appendChild(a);
             a.click();
             setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
         } catch (e) {
             console.error('Failed to export selections report', e);
         }
     };

    // Print report: scheduled closings in the next 8 weeks
    const handlePrint8WeekReport = () => {
        try {
            const today = new Date();
            const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            const endDate = new Date(startToday.getTime() + 8 * 7 * 24 * 60 * 60 * 1000);

            const upcoming = parsedRows
                .filter(r => {
                    if (!r.expected_closing_date) return false;
                    const d = new Date(r.expected_closing_date + 'T00:00:00');
                    if (isNaN(d.getTime())) return false;
                    return d >= startToday && d <= endDate;
                })
                .sort((a, b) => {
                    const ta = new Date(a.expected_closing_date! + 'T00:00:00').getTime();
                    const tb = new Date(b.expected_closing_date! + 'T00:00:00').getTime();
                    return ta - tb;
                });

            const reportTitle = `Scheduled Closings – Next 8 Weeks`;
            const reportSubtitle = `${fmt(startToday.toISOString().slice(0, 10))} to ${fmt(endDate.toISOString().slice(0, 10))}`;

            const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${reportTitle}</title>
  <style>
    @page { size: letter portrait; margin: 15mm 12mm; }
    html, body { margin: 0; padding: 0; font-family: Arial, Helvetica, sans-serif; color: #111; }
    h1 { margin: 0 0 2px 0; font-size: 16px; }
    .subtitle { font-size: 11px; color: #555; margin-bottom: 4px; }
    .meta { font-size: 10px; color: #888; margin-bottom: 14px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    thead th { background: #1e293b; color: #fff; text-align: left; padding: 7px 10px; font-size: 12px; }
    tbody tr:nth-child(even) { background: #f8fafc; }
    tbody td { border-bottom: 1px solid #e2e8f0; padding: 7px 10px; vertical-align: middle; }
    .week-header td { background: #e2e8f0; font-weight: bold; font-size: 11px; color: #334155; padding: 4px 10px; }
    .count { font-size: 11px; color: #555; margin-bottom: 10px; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <h1>${reportTitle}</h1>
  <div class="subtitle">${reportSubtitle}</div>
  <div class="meta">Generated ${new Date().toLocaleString()} &nbsp;|&nbsp; ${upcoming.length} closing${upcoming.length !== 1 ? 's' : ''} scheduled</div>
  ${upcoming.length === 0
    ? '<p style="color:#888;">No closings scheduled in the next 8 weeks.</p>'
    : (() => {
        // Group by week
        const weeks: { label: string; rows: typeof upcoming }[] = [];
        for (let w = 0; w < 8; w++) {
            const wStart = new Date(startToday.getTime() + w * 7 * 24 * 60 * 60 * 1000);
            const wEnd = new Date(wStart.getTime() + 6 * 24 * 60 * 60 * 1000);
            const wRows = upcoming.filter(r => {
                const d = new Date(r.expected_closing_date! + 'T00:00:00');
                return d >= wStart && d <= wEnd;
            });
            weeks.push({
                label: `Week ${w + 1}: ${fmt(wStart.toISOString().slice(0,10))} – ${fmt(wEnd.toISOString().slice(0,10))}`,
                rows: wRows,
            });
        }
        return `<table>
  <thead>
    <tr>
      <th>#</th>
      <th>Address</th>
      <th>Client</th>
      <th>Type</th>
      <th>Foreman</th>
      <th>Closing Date</th>
      <th>Status</th>
    </tr>
  </thead>
  <tbody>
    ${weeks.map(wk => {
      if (wk.rows.length === 0) return '';
      const weekRow = `<tr class="week-header"><td colspan="7">${wk.label} &mdash; ${wk.rows.length} closing${wk.rows.length !== 1 ? 's' : ''}</td></tr>`;
      const dataRows = wk.rows.map((r, i) =>
        `<tr>
          <td>${i + 1}</td>
          <td>${r.address ?? ''}</td>
          <td>${r.client_name ?? ''}</td>
          <td>${r.type ?? ''}</td>
          <td>${r.foreman ?? ''}</td>
          <td><strong>${r.expected_closing_date ? fmt(r.expected_closing_date) : ''}</strong></td>
          <td>${r.closing_data_status ?? r.project_status ?? ''}</td>
        </tr>`
      ).join('');
      return weekRow + dataRows;
    }).join('')}
  </tbody>
</table>`;
      })()
  }
  <div class="no-print" style="margin-top:16px; display:flex; gap:8px;">
    <button onclick="window.print()" style="padding:6px 16px; background:#1e293b; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Print / Save PDF</button>
    <button onclick="window.close()" style="padding:6px 16px; background:#e2e8f0; color:#111; border:none; border-radius:4px; cursor:pointer; font-size:13px;">Close</button>
  </div>
</body>
</html>`.trim();

            const w = window.open('', '_blank');
            if (!w) return;
            w.document.open();
            w.document.write(html);
            w.document.close();
            setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 300);
        } catch (e) {
            console.error('Failed to generate 8-week report', e);
        }
    };

    async function toggleFullscreen() {
        try {
            const d: any = document;
            if (d.fullscreenElement) {
                await d.exitFullscreen();
                setFullscreenMode(false);
            } else {
                await d.documentElement.requestFullscreen();
                setFullscreenMode(true);
            }
        } catch {
            // ignore
        }
    }

    function openProgressChart() {
        setShowProgressChart(true);
        const d: any = document;
        if (!d.fullscreenElement) {
            toggleFullscreen();
        }
    }

    async function closeProgressChart() {
        setShowProgressChart(false);
        try {
            const d: any = document;
            if (d.fullscreenElement) {
                await d.exitFullscreen();
                setFullscreenMode(false);
            }
        } catch {
            // ignore
        }
    }

    if (fullscreenMode) {
        if (showProgressChart) {
            return (
                <ProgressChartView
                    rows={parsedRows}
                    onClose={closeProgressChart}
                    fullScreen
                />
            );
        }
        return (
            <div className="min-h-screen w-full bg-gradient-to-br from-nvh-bg via-nvh-navy to-nvh-bg text-nvh-text p-4 md:p-8 text-base md:text-lg">
                <div className="max-w-7xl mx-auto">
                    <div className="sticky top-0 z-10 -mx-4 md:-mx-8 px-4 md:px-8 py-3 backdrop-blur bg-nvh-bg/80 border-b border-white/10">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                                <h2 className="text-lg md:text-2xl font-bold text-slate-100">Fullscreen – Open Closings</h2>
                                <div className="text-sm text-slate-400">{fullscreenOpenRows.length} open jobs</div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setCompactCards(v => !v)}
                                    className="px-3 py-1 rounded bg-slate-800 border border-slate-700 text-slate-100 text-sm"
                                >
                                    {compactCards ? "Expanded" : "Condensed"}
                                </button>
                                <button
                                    onClick={toggleFullscreen}
                                    className="px-3 py-1 rounded bg-rose-700 text-white text-sm"
                                >
                                    Exit Fullscreen
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="mt-4 rounded-xl bg-slate-900/70 border border-slate-700 shadow-xl p-3 md:p-4">
                        <AllClosingsPanel
                            rows={fullscreenOpenRows}
                            onJobClick={handleJobClick}
                            stageChecks={stageChecks}
                            compactCards={compactCards}
                        />
                    </div>

                </div>
            </div>
        );
    }
 
    return (
        <div className="min-h-screen w-full bg-gradient-to-br from-nvh-bg via-nvh-navy to-nvh-bg text-nvh-text p-2 sm:p-4 md:p-8">
   <div className="max-w-7xl mx-auto">
        <div className="sm:hidden">
            <div className="flex items-center justify-between mb-2">
                <img
                    src="/nvh-logo.png"
                    alt="New Victorian Homes"
                    className="h-8 w-auto object-contain"
                />
            </div>
            <div className="relative mb-2">
                <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-nvh-red pointer-events-none" />
                <input
                    ref={inputRef}
                    type="search"
                    placeholder="Filter by address, client, or status…"
                    value={filterText}
                    onChange={e => {
                        const v = e.target.value;
                        setFilterText(v);
                        if (/\d/.test(v)) setShowSuggestions(true); else setShowSuggestions(false);
                    }}
                    onKeyDown={e => {
                        if (e.key === "Enter") {
                            setShowSuggestions(false);
                            (e.currentTarget as HTMLInputElement).blur();
                        }
                    }}
                    onFocus={() => {
                        if (/\d/.test(filterText)) setShowSuggestions(true); else setShowSuggestions(false);
                    }}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
                    inputMode="search"
                    enterKeyHint="search"
                    autoComplete="new-password"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    name="search_no_autofill"
                    className="w-full rounded-xl bg-slate-800 border border-slate-700 pl-9 pr-3 py-2 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-nvh-red text-sm"
                />
                {showSuggestions && (
                    <MobileSuggestions
                        anchorRect={anchorRect}
                        topProvider={computeAnchorRect}
                        inputRef={inputRef}
                        rows={searchableRows}
                        filterText={filterText}
                        setFilterText={setFilterText}
                        onHide={() => setShowSuggestions(false)}
                        onSelectJob={(row) => {
                            setShowSuggestions(false);
                            setFilterText(row.address || "");
                            onSelectJob(row);
                        }}
                    />
                )}
            </div>
            <div className="flex items-center justify-end mb-3">
                <details className="relative">
                    <summary className="list-none inline-flex items-center gap-1 rounded-lg bg-slate-800 text-slate-100 border border-slate-700 px-2.5 py-1.5 font-semibold text-xs shadow hover:bg-slate-700 transition cursor-pointer">
                        Menu
                    </summary>
                    <div className="absolute right-0 mt-2 w-48 rounded-lg bg-slate-800 border border-slate-700 shadow-lg z-50 overflow-hidden">
                        <button
                            onClick={handlePrint8WeekReport}
                            className="w-full text-left px-3 py-2 text-xs text-slate-100 hover:bg-slate-700 font-semibold border-b border-slate-700"
                        >
                            8-Week Closing Report
                        </button>
                        <button
                            onClick={handlePrintSelections}
                            className="w-full text-left px-3 py-2 text-xs text-slate-100 hover:bg-slate-700"
                        >
                            Print Selections
                        </button>
                        <button
                            onClick={handleExportSelections}
                            className="w-full text-left px-3 py-2 text-xs text-slate-100 hover:bg-slate-700"
                        >
                            Export CSV
                        </button>
                        <button
                            onClick={() => setShowProgressChart(true)}
                            className="w-full text-left px-3 py-2 text-xs text-slate-100 hover:bg-slate-700"
                        >
                            Project Progress Graph
                        </button>
                        <button
                            onClick={toggleFullscreen}
                            className="w-full text-left px-3 py-2 text-xs text-slate-100 hover:bg-slate-700"
                        >
                            Fullscreen
                        </button>
                    </div>
                </details>
            </div>
            {mobileOpenRows.length === 0 ? (
                <div className="text-slate-400 text-sm">
                    {filterText.trim() ? "No matching jobs." : "No open jobs."}
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-4">
                    {mobileOpenRows.map((r) => (
                        <ClosingCard key={r.id} row={r} onJobClick={handleJobClick} stageChecks={stageChecks} compactCards={compactCards} />
                    ))}
                </div>
            )}
        </div>

        <div className="hidden sm:block">
     {/* Sticky header + controls */}
    <div className="sm:sticky top-0 z-40 -mx-2 sm:-mx-4 md:-mx-8 px-2 sm:px-4 md:px-8 pt-2 pb-2 backdrop-blur bg-nvh-bg/70 border-b border-white/10">
        <div className="flex flex-col gap-2">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
                <div className="flex items-center gap-3">
                    <img
                        src="/nvh-logo.png"
                        alt="New Victorian Homes"
                        className="h-9 md:h-10 w-auto object-contain"
                    />
                    <span className="rounded-full bg-white/10 text-slate-200 text-xs px-2.5 py-0.5 border border-white/10">2026</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <div className="relative">
                        <label htmlFor="view-select-desktop" className="sr-only">View</label>
                        <select
                            id="view-select-desktop"
                            value=""
                            onChange={(e) => {
                                const v = e.target.value;
                                if (v === "month") {
                                    setShowAll(false); setShowDieter(false); setShowSpecs(false); setShowPermitApp(false); setTvMode(false);
                                } else if (v === "all") {
                                    setShowAll(true); setShowDieter(false); setShowSpecs(false); setShowPermitApp(false); setTvMode(false);
                                } else if (v === "dieter") {
                                    setShowDieter(true); setShowAll(false); setShowSpecs(false); setShowPermitApp(false); setTvMode(false);
                                } else if (v === "specs") {
                                    setShowSpecs(true); setShowAll(false); setShowDieter(false); setShowPermitApp(false); setTvMode(false);
                                } else if (v === "permit") {
                                    setShowPermitApp(true); setShowAll(false); setShowDieter(false); setShowSpecs(false); setTvMode(false);
                                } else if (v === "tv") {
                                    setTvMode(true); setFilterText(''); setShowAll(false); setShowDieter(false); setShowSpecs(false); setShowPermitApp(false);
                                }
                            }}
                            className="inline-flex items-center rounded-xl bg-slate-800 text-slate-100 border border-slate-700 px-3 py-2 text-sm font-semibold shadow hover:bg-slate-700 transition w-32"
                            title="View mode"
                        >
                            <option value="">View</option>
                            <option value="month">Month View</option>
                            <option value="all">All Closings</option>
                            <option value="dieter">Dieter</option>
                            <option value="specs">Specs</option>
                            <option value="permit">Permit App</option>
                            <option value="tv">TV Mode</option>
                        </select>
                    </div>

                    {showFilters && (
                        <div className="relative w-[220px] lg:w-[320px]">
                            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-nvh-red pointer-events-none" />
                            <input
                                ref={inputRef}
                                type="search"
                                placeholder="Filter by address, client, or status…"
                                value={filterText}
                                onChange={e => {
                                    const v = e.target.value;
                                    setFilterText(v);
                                    if (/\d/.test(v)) setShowSuggestions(true); else setShowSuggestions(false);
                                }}
                                onFocus={() => {
                                    if (/\d/.test(filterText)) setShowSuggestions(true); else setShowSuggestions(false);
                                }}
                                onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
                                inputMode="search"
                                enterKeyHint="search"
                                autoComplete="new-password"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                name="search_no_autofill"
                                className="w-full rounded-xl bg-slate-800 border border-slate-700 pl-9 pr-3 py-2 text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-nvh-red text-sm"
                            />
                            {showSuggestions && (
                                <MobileSuggestions
                                    anchorRect={anchorRect}
                                    topProvider={computeAnchorRect}
                                    inputRef={inputRef}
                                    rows={searchableRows}
                                    filterText={filterText}
                                    setFilterText={setFilterText}
                                    onHide={() => setShowSuggestions(false)}
                                    onSelectJob={(row) => {
                                        setShowSuggestions(false);
                                        setFilterText(row.address || "");
                                        onSelectJob(row);
                                    }}
                                />
                            )}
                        </div>
                    )}

                    {showFilters && (
                        <button
                            onClick={() => setFilterText("")}
                            className={
                                "hidden sm:inline-flex items-center justify-center whitespace-nowrap rounded-xl px-3 py-2 text-sm font-semibold border transition-all duration-200 " +
                                (filterText.trim()
                                    ? "bg-nvh-red text-white border-nvh-red hover:bg-nvh-redDark shadow"
                                    : "bg-slate-800 text-slate-300 border-slate-700 cursor-pointer")
                            }
                            title="Clear search"
                        >
                            <XCircle className="h-4 w-4 mr-2" />
                            Clear
                        </button>
                    )}

                    <div className="relative">
                        <label htmlFor="display-select-desktop" className="sr-only">Display</label>
                        <select
                            id="display-select-desktop"
                            value=""
                            onChange={(e) => setCompactCards(e.target.value === "compact")}
                            className="inline-flex items-center rounded-xl bg-slate-800 text-slate-100 border border-slate-700 px-3 py-2 text-sm font-semibold shadow hover:bg-slate-700 transition w-28"
                            title="Display density"
                        >
                            <option value="">Display</option>
                            <option value="compact">Compact</option>
                            <option value="detailed">Detailed</option>
                        </select>
                    </div>

                    <button
                        onClick={() => setShowFilters(v => !v)}
                        className="inline-flex items-center gap-2 rounded-xl bg-slate-800 text-slate-100 border border-slate-700 px-3 py-2 font-semibold text-sm shadow hover:bg-slate-700 transition"
                        title="Toggle filters"
                    >
                        <Filter className="h-4 w-4" />
                        {showFilters ? "Hide Filters" : "Show Filters"}
                    </button>

                    <details className="relative">
                        <summary className="list-none inline-flex items-center gap-2 rounded-xl bg-slate-800 text-slate-100 border border-slate-700 px-3 py-2 font-semibold text-sm shadow hover:bg-slate-700 transition cursor-pointer">
                            More
                        </summary>
                        <div className="absolute right-0 mt-2 w-52 rounded-lg bg-slate-800 border border-slate-700 shadow-lg z-50 overflow-hidden">
                            <button
                                onClick={handlePrint8WeekReport}
                                className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700 font-semibold border-b border-slate-700"
                            >
                                8-Week Closing Report
                            </button>
                            <button
                                onClick={handlePrintSelections}
                                className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
                            >
                                Print Selections
                            </button>
                            <button
                                onClick={handleExportSelections}
                                className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
                            >
                                Export CSV
                            </button>
                            <button
                                onClick={() => setShowProgressChart(true)}
                                className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
                            >
                                Project Progress Graph
                            </button>
                            <button
                                onClick={toggleFullscreen}
                                className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
                            >
                                Fullscreen
                            </button>
                        </div>
                    </details>
                </div>
                <div className="flex flex-col lg:items-end gap-2">
                    <div className="text-xs text-slate-400">
                        Showing {rows.length} closings across {monthKeys.length} month{monthKeys.length === 1 ? "" : "s"}.
                    </div>
                </div>
            </div>

            <div className="sm:hidden flex items-center gap-2 flex-wrap">
                <button
                    onClick={() => setFilterText("")}
                    className="sm:hidden inline-flex items-center gap-2 rounded-xl bg-slate-800 text-white px-6 py-3 font-semibold text-lg shadow border border-white/10 hover:bg-slate-700 transition"
                    title="Clear search"
                >
                    <XCircle className="h-5 w-5" />
                    Clear
                </button>
                <div className="relative">
                    <label htmlFor="view-select" className="sr-only">View</label>
                    <select
                        id="view-select"
                        value=""
                        onChange={(e) => {
                            const v = e.target.value;
                            if (v === "month") {
                                setShowAll(false); setShowDieter(false); setShowSpecs(false); setShowPermitApp(false); setTvMode(false);
                            } else if (v === "all") {
                                setShowAll(true); setShowDieter(false); setShowSpecs(false); setShowPermitApp(false); setTvMode(false);
                            } else if (v === "dieter") {
                                setShowDieter(true); setShowAll(false); setShowSpecs(false); setShowPermitApp(false); setTvMode(false);
                            } else if (v === "specs") {
                                setShowSpecs(true); setShowAll(false); setShowDieter(false); setShowPermitApp(false); setTvMode(false);
                            } else if (v === "permit") {
                                setShowPermitApp(true); setShowAll(false); setShowDieter(false); setShowSpecs(false); setTvMode(false);
                            } else if (v === "tv") {
                                setTvMode(true); setFilterText(''); setShowAll(false); setShowDieter(false); setShowSpecs(false); setShowPermitApp(false);
                            }
                        }}
                        className="inline-flex items-center rounded-xl bg-slate-800 text-slate-100 border border-slate-700 px-3 py-2 text-sm font-semibold shadow hover:bg-slate-700 transition w-40"
                        title="View mode"
                    >
                        <option value="">View</option>
                        <option value="month">Month View</option>
                        <option value="all">All Closings</option>
                        <option value="dieter">Dieter</option>
                        <option value="specs">Specs</option>
                        <option value="permit">Permit App</option>
                        <option value="tv">TV Mode</option>
                    </select>
                </div>

                <div className="relative">
                    <label htmlFor="display-select" className="sr-only">Display</label>
                    <select
                        id="display-select"
                        value=""
                        onChange={(e) => setCompactCards(e.target.value === "compact")}
                        className="inline-flex items-center rounded-xl bg-slate-800 text-slate-100 border border-slate-700 px-3 py-2 text-sm font-semibold shadow hover:bg-slate-700 transition w-36"
                        title="Display density"
                    >
                        <option value="">Display</option>
                        <option value="compact">Compact</option>
                        <option value="detailed">Detailed</option>
                    </select>
                </div>

                <button
                    onClick={() => setShowFilters(v => !v)}
                    className="inline-flex items-center gap-2 rounded-xl bg-slate-800 text-slate-100 border border-slate-700 px-4 py-2 font-semibold text-sm shadow hover:bg-slate-700 transition"
                    title="Toggle filters"
                >
                    <Filter className="h-4 w-4" />
                    {showFilters ? "Hide Filters" : "Show Filters"}
                </button>

                <details className="relative">
                    <summary className="list-none inline-flex items-center gap-2 rounded-xl bg-slate-800 text-slate-100 border border-slate-700 px-4 py-2 font-semibold text-sm shadow hover:bg-slate-700 transition cursor-pointer">
                        More
                    </summary>
                    <div className="absolute right-0 mt-2 w-52 rounded-lg bg-slate-800 border border-slate-700 shadow-lg z-50 overflow-hidden">
                        <button
                            onClick={handlePrint8WeekReport}
                            className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700 font-semibold border-b border-slate-700"
                        >
                            8-Week Closing Report
                        </button>
                        <button
                            onClick={handlePrintSelections}
                            className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
                        >
                            Print Selections
                        </button>
                        <button
                            onClick={handleExportSelections}
                            className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
                        >
                            Export CSV
                        </button>
                        <button
                            onClick={() => setShowProgressChart(true)}
                            className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
                        >
                            Project Progress Graph
                        </button>
                        <button
                            onClick={toggleFullscreen}
                            className="w-full text-left px-4 py-2 text-sm text-slate-100 hover:bg-slate-700"
                        >
                            Fullscreen
                        </button>
                    </div>
                </details>
            </div>

            <div className="hidden sm:flex flex-wrap items-center gap-2">
                <div className="px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs text-slate-200">
                    Open: <span className="font-semibold text-white">{stats.openCount}</span>
                </div>
                <div className="px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs text-slate-200">
                    Closed: <span className="font-semibold text-white">{stats.closedCount}</span>
                </div>
                <div className="px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs text-slate-200">
                    Soon: <span className="font-semibold text-white">{stats.soonCount}</span>
                </div>
            </div>
        </div>
    </div>{/* end sticky header */}

    {/* Active filters + quick shortcuts */}
    {showFilters && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
            <span className="text-slate-400">Shortcuts: <b>/</b> search · <b>Esc</b> clear · <b>←/→</b> modal</span>
            {filterText.trim() && (
                <button onClick={() => setFilterText('')} className="px-2 py-1 rounded-full bg-slate-800 border border-slate-700 hover:bg-slate-700">
                    Search: <span className="font-semibold">{filterText.trim().slice(0, 24)}{filterText.trim().length > 24 ? '…' : ''}</span> ×
                </button>
            )}
            {showAll && (
                <button onClick={() => setShowAll(false)} className="px-2 py-1 rounded-full bg-fuchsia-900/50 border border-fuchsia-700 hover:bg-fuchsia-800/60">
                    ALL ×
                </button>
            )}
            {showSpecs && (
                <button onClick={() => setShowSpecs(false)} className="px-2 py-1 rounded-full bg-cyan-900/50 border border-cyan-700 hover:bg-cyan-800/60">
                    Specs ×
                </button>
            )}
            {showDieter && (
                <button onClick={() => setShowDieter(false)} className="px-2 py-1 rounded-full bg-emerald-900/50 border border-emerald-700 hover:bg-emerald-800/60">
                    Dieter ×
                </button>
            )}
            {showPermitApp && (
                <button onClick={() => setShowPermitApp(false)} className="px-2 py-1 rounded-full bg-yellow-900/40 border border-yellow-700 hover:bg-yellow-800/50">
                    Permit App ×
                </button>
            )}
            {tvMode && (
                <button onClick={() => setTvMode(false)} className="px-2 py-1 rounded-full bg-emerald-900/40 border border-emerald-700 hover:bg-emerald-800/60">
                    TV ×
                </button>
            )}
        </div>
    )}

        {showBackToTop && (
            <button
                onClick={() => { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); } }}
                className="sm:hidden fixed bottom-4 right-4 z-50 rounded-full bg-nvh-red text-white px-4 py-3 shadow-lg hover:bg-nvh-redDark"
                title="Back to top"
            >
                ↑ Top
            </button>
        )}
 
     {/* Color Key / Legend */}
     <div className="hidden sm:flex flex-wrap gap-3 items-center text-xs mb-6 md:mb-8">
       <span className="flex items-center gap-1">
         <span className="inline-block w-4 h-4 rounded bg-purple-600 border border-purple-700"></span>
         <span>Amendment Pending</span>
       </span>
       <span className="flex items-center gap-1">
         <span className="inline-block w-4 h-4 rounded bg-emerald-600 border border-emerald-700"></span>
         <span>Confirmed</span>
       </span>
       <span className="flex items-center gap-1">
         <span className="inline-block w-4 h-4 rounded bg-amber-600 border border-amber-700"></span>
         <span>Expect Delay</span>
       </span>
       <span className="flex items-center gap-1">
         <span className="inline-block w-4 h-4 rounded bg-pink-600 border border-pink-700"></span>
         <span>Unsolded Spec</span>
       </span>
     </div>
 
     {/* --- Summary Table --- */}
    <div className="flex mb-6 flex-col gap-4">

       {/* Main summary table */}
       <div className="overflow-x-auto">
         <table className="min-w-fit bg-slate-800 rounded-lg overflow-hidden shadow text-slate-100 text-sm">
           <caption className="caption-top text-slate-300 font-semibold mb-2">Summary</caption>
           <thead>
             <tr className="bg-slate-700/60">
               <th className="px-4 py-2 text-left">Sold in 2026</th>
               <th className="px-4 py-2 text-left">Specs</th>
               <th className="px-4 py-2 text-left">Closing in 2026</th>
               <th className="px-4 py-2 text-left">Sold in 2025</th>
               <th className="px-4 py-2 text-left">Closed in 2025</th>
               <th className="px-4 py-2 text-left">Closing in 2027</th>
               <th className="px-4 py-2 text-left">Jobs with Allan</th>
               <th className="px-4 py-2 text-left">Jobs with Max</th>
             </tr>
           </thead>
           <tbody>
             <tr className="even:bg-slate-700/40 odd:bg-slate-800">
               <td className="px-4 py-2 font-bold text-center">
                   {
                       parsedRows.filter(r => {
                           const d = r.agreement_date && new Date(r.agreement_date + "T00:00:00");
                           return d && d.getFullYear() === 2026;
                       }).length
                   }
               </td>
               <td className="px-4 py-2 font-bold text-center">
                   {totalSpecs}
               </td>
               <td className="px-4 py-2 font-bold text-center">
                   {closingYearCounts?.[2026] ?? 0}
               </td>
               <td className="px-4 py-2 font-bold text-center">
                   {
                       parsedRows.filter(r => {
                           const d = r.agreement_date && new Date(r.agreement_date + "T00:00:00");
                           return d && d.getFullYear() === 2025;
                       }).length
                   }
               </td>
               <td className="px-4 py-2 font-bold text-center">
                   {53}
               </td>
               <td className="px-4 py-2 font-bold text-center">
                   {closingYearCounts?.[2027] ?? 0}
               </td>
               <td className="px-4 py-2 font-bold text-center">
                   {rows.filter(r => (r.foreman || "").toLowerCase().includes("allan") && (r.project_status || '').toLowerCase() !== 'closed').length}
               </td>
               <td className="px-4 py-2 font-bold text-center">
                   {rows.filter(r => (r.foreman || "").toLowerCase().includes("max") && (r.project_status || '').toLowerCase() !== 'closed').length}
               </td>
             </tr>
           </tbody>
         </table>
       </div>

       {/* Closings by month table */}
       {(() => {
         const now = new Date();
         const latestClosingDate = rows
             .map(r => r.expected_closing_date)
             .filter(Boolean)
             .map(dateStr => new Date(dateStr + "T00:00:00"))
             .filter(d => !isNaN(d.getTime()))
             .sort((a, b) => b.getTime() - a.getTime())[0];

         const endYear = latestClosingDate ? latestClosingDate.getFullYear() : now.getFullYear();
         const endMonth = latestClosingDate ? latestClosingDate.getMonth() : now.getMonth();

         const months: { key: string; label: string }[] = [];
         let year = now.getFullYear();
         let month = now.getMonth();
         while (year < endYear || (year === endYear && month <= endMonth)) {
             const key = `${year}-${String(month + 1).padStart(2, "0")}`;
             const label = `${monthLabels[month]} ${year}`;
             months.push({ key, label });
             month++;
             if (month > 11) {
                 month = 0;
                 year++;
             }
         }

         const closingsByMonth = months.map(({ key }) =>
             rows.filter(r => {
                 if (!r.expected_closing_date) return false;
                 const d = new Date(r.expected_closing_date + "T00:00:00");
                 return !isNaN(d.getTime()) &&
                     d.getFullYear() === Number(key.split("-")[0]) &&
                     d.getMonth() + 1 === Number(key.split("-")[1]);
             }).length
         );

         return (
             <div className="overflow-x-auto">
                 <table className="min-w-fit bg-slate-800 rounded-lg overflow-hidden shadow text-slate-100 text-sm">
                     <caption className="caption-top text-slate-300 font-semibold mb-2">Closings by Month (Next 12 Months)</caption>
                     <thead>
                         <tr className="bg-slate-700/60">
                             {months.map(m => (
                                 <th key={m.key} className="px-4 py-2 text-center whitespace-nowrap">{m.label}</th>
                             ))}
                         </tr>
                     </thead>
                     <tbody>
                         <tr className="even:bg-slate-700/40 odd:bg-slate-800">
                             {closingsByMonth.map((count, i) => (
                                 <td key={months[i].key} className="px-4 py-2 font-bold text-center">{count}</td>
                             ))}
                         </tr>
                     </tbody>
                 </table>
             </div>
         );
     })()}
     </div>

                {/* Month picker */}
                {monthKeys.length === 0 ? (
                    <div className="text-slate-400 mb-3">No months to display.</div>
                ) : (
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                        <button
                            onClick={() => { if (active > 0) { setActive(active - 1); setShowAll(false); } }}
                            disabled={active <= 0}
                            className={
                                "rounded-lg px-3 py-2 text-sm font-semibold border transition " +
                                (active <= 0 ? "bg-slate-800/50 text-slate-500 border-slate-800 cursor-not-allowed" : "bg-slate-800 text-slate-100 border-slate-700 hover:bg-slate-700")
                            }
                        >
                            Prev
                        </button>
                        <div className="min-w-[220px] flex-1 sm:flex-none">
                            <label htmlFor="month-select" className="sr-only">Select month</label>
                            <select
                                id="month-select"
                                value={activeKey || ""}
                                onChange={(e) => {
                                    const key = e.target.value;
                                    const idx = monthKeys.indexOf(key);
                                    if (idx >= 0) {
                                        setActive(idx);
                                        setShowAll(false);
                                    }
                                }}
                                className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-nvh-red"
                            >
                                {monthKeys.map((k) => {
                                    const [yy, mm] = k.split("-").map(Number);
                                    const label = `${monthLabels[mm - 1]} ${yy}`;
                                    return (
                                        <option key={k} value={k}>{label}</option>
                                    );
                                })}
                            </select>
                        </div>
                        <button
                            onClick={() => { if (active < monthKeys.length - 1) { setActive(active + 1); setShowAll(false); } }}
                            disabled={active >= monthKeys.length - 1}
                            className={
                                "rounded-lg px-3 py-2 text-sm font-semibold border transition " +
                                (active >= monthKeys.length - 1 ? "bg-slate-800/50 text-slate-500 border-slate-800 cursor-not-allowed" : "bg-slate-800 text-slate-100 border-slate-700 hover:bg-slate-700")
                            }
                        >
                            Next
                        </button>
                    </div>
                )}

                 <AnimatePresence mode="wait">
                     {filterText.trim() ? (
                          <motion.div
                              key="search-results"
                              initial={{ opacity: 0, y: 8 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -8 }}
                              transition={{ duration: 0.25 }}
                          >
                              <AllClosingsPanel
                                  rows={[...rows].sort((a, b) => {
                                      const toTime = (s?: string) => (s ? new Date(s + 'T00:00:00').getTime() : NaN);
                                      const ta = toTime(a.expected_closing_date);
                                      const tb = toTime(b.expected_closing_date);
                                      const va = isNaN(ta) ? Infinity : ta;
                                      const vb = isNaN(tb) ? Infinity : tb;
                                      return va - vb;
                                  })}
                                  onJobClick={handleJobClick}
                                  stageChecks={stageChecks}
                                  compactCards={compactCards}
                              />
                          </motion.div>
                     ) : showDieter ? (
                          <motion.div
                              key="dieter-view"
                              initial={{ opacity: 0, y: 8 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -8 }}
                              transition={{ duration: 0.25 }}
                          >
                              <DieterPanel rows={dieterRows} onJobClick={handleJobClick} stageChecks={stageChecks} compactCards={compactCards} />
                          </motion.div>
                     ) : showSpecs ? (
                         <motion.div
                             key="specs-view"
                             initial={{ opacity: 0, y: 8 }}
                             animate={{ opacity: 1, y: 0 }}
                             exit={{ opacity: 0, y: -8 }}
                             transition={{ duration: 0.25 }}
                         >
                             <AllClosingsPanel rows={specRows} onJobClick={handleJobClick} stageChecks={stageChecks} compactCards={compactCards} />
                         </motion.div>
                     ) : showPermitApp ? (
                        <motion.div
                            key="permit-view"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ duration: 0.25 }}
                        >
                            <AllClosingsPanel rows={permitRows} onJobClick={handleJobClick} stageChecks={stageChecks} compactCards={compactCards} />
                        </motion.div>
                      ) : showAll ? (
                          <motion.div
                              key="all-closings"
                              initial={{ opacity: 0, y: 8 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -8 }}
                              transition={{ duration: 0.25 }}
                          >
                              <AllClosingsPanel
                                  rows={[...rows].sort((a, b) => {
                                      const da = new Date((a.expected_closing_date || "") + "T00:00:00").getTime();
                                      const db = new Date((b.expected_closing_date || "") + "T00:00:00").getTime();
                                      const va = isNaN(da) ? Infinity : da;
                                      const vb = isNaN(db) ? Infinity : db;
                                      return va - vb;
                                  })}

                                  onJobClick={handleJobClick}

                                  stageChecks={stageChecks}
                                  compactCards={compactCards}
                              />
                          </motion.div>
                      ) : monthKeys.length === 0 || !activeKey ? (
                          <div className="text-slate-400 text-lg mt-8">No closings to display.</div>
                      ) : (
                          <motion.div key={activeKey}
                              initial={{ opacity: 0, y: 8 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -8 }}
                              transition={{ duration: 0.25 }}
                          >
                              <MonthPanel monthKey={activeKey} rows={grouped.get(activeKey) || []} onJobClick={handleJobClick} stageChecks={stageChecks} compactCards={compactCards} />
                          </motion.div>
                      )}
                 </AnimatePresence>

                 {/* New alert component for empty data */}
                 {!loading && rows.length === 0 && (
                     <div className="text-yellow-400 font-bold mb-4">
                         No closing data found.<br />
                         Please check your spreadsheet and ensure each row has both an <b>Address</b> and an <b>Expected Closing Date</b>.<br />
                         Dates can be in formats like <code>YYYY-MM-DD</code>, <code>Month DD, YYYY</code>, or <code>MMM-DD-YYYY</code>.
                     </div>
                 )}
 
                 {/*<div className="mt-6 text-xs text-slate-400 flex items-center justify-between">
                     <div>
                         Status colors:
                         <span className="inline-block h-3 w-3 align-middle rounded-sm bg-slate-600 ml-1 mr-1"></span>Scheduled
                         <span className="inline-block h-3 w-3 align-middle rounded-sm bg-amber-600 ml-3 mr-1"></span>Delayed
                         <span className="inline-block h-3 w-3 align-middle rounded-sm bg-emerald-600 ml-3 mr-1"></span>Closed
                         <span className="inline-block h-3 w-3 align-middle rounded-sm bg-rose-700 ml-3 mr-1"></span>Cancelled
                     </div>
                     <div>Tip: Keep dates in YYYY-MM-DD. The board highlights anything within {COMING_SOON_DAYS} days.</div>
                 </div>*/}
               </div>

        {showProgressChart && (
            <ProgressChartView
                rows={parsedRows}
                onClose={closeProgressChart}
            />
        )}
         </div>
     </div>
     );
 }
 
 function MonthPanel({ monthKey, rows, onJobClick, stageChecks, compactCards }: { monthKey: string; rows: ClosingRow[]; onJobClick: (jobId: string) => void, stageChecks: any; compactCards: boolean }) {
     const [y, m] = monthKey.split("-").map(Number);
     const label = `${monthLabels[m - 1]} ${y}`;
 
     return (
         <div>
             <div className="flex items-center gap-3 mb-4">
                 <CalendarDays className="h-6 w-6" />
                 <h2 className="text-xl sm:text-2xl font-bold">{label}</h2>
             </div>
             {rows.length === 0 ? (
                 <p className="text-slate-400">No closings this month.</p>
             ) : (
                 <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-6 md:gap-8">
                     {rows.map((r) => (
                         <ClosingCard key={r.id} row={r} onJobClick={onJobClick} stageChecks={stageChecks} compactCards={compactCards} />
                     ))}
                 </div>
             )}
         </div>
     );
 }
 
 function AllClosingsPanel({ rows, onJobClick, stageChecks, compactCards }: { rows: ClosingRow[]; onJobClick: (jobId: string) => void; stageChecks: any; compactCards: boolean }) {
     return (
         <div>
             <div className="flex items-center gap-3 mb-4">
                 <CalendarDays className="h-6 w-6" />
                 <h2 className="text-xl sm:text-2xl font-bold">All Closings</h2>
                 <span className="text-slate-400 text-base">({rows.length} total)</span>
             </div>
             {rows.length === 0 ? (
                 <p className="text-slate-400">No closings found.</p>
             ) : (
                 <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-6 md:gap-8">
                     {rows.map((r) => (
                         <ClosingCard key={r.id} row={r} onJobClick={onJobClick} stageChecks={stageChecks} compactCards={compactCards} />
                     ))}
                 </div>
             )}
         </div>
     );
 }
 
 function projectStatusIcon(status?: string) {
     switch ((status || "").toLowerCase()) {
         case "on time": return <CheckCircle2 className="h-4 w-4 text-emerald-400 inline mr-1" />;
         case "delayed": return <AlertTriangle className="h-4 w-4 text-amber-400 inline mr-1" />;
         case "cancelled": return <XCircle className="h-4 w-4 text-rose-400 inline mr-1" />;
         case "early": return <Hourglass className="h-4 w-4 text-blue-400 inline mr-1" />;
         default: return <NotebookText className="h-4 w-4 text-slate-400 inline mr-1" />;
     }
 }
 
 // Helper to calculate day difference between two dates
 function daysBetween(dateA?: string, dateB?: string): number | null {
     if (!dateA || !dateB) return null;
     const a = new Date(dateA + "T00:00:00");
     const b = new Date(dateB + "T00:00:00");
     if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
     return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
 }
 
function ClosingCard({ row, onJobClick, stageChecks, compactCards }: { row: ClosingRow; onJobClick: (jobId: string) => void; stageChecks: any; compactCards: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const dateStr = row.expected_closing_date || "";
    const d = daysUntil(dateStr);
    const soon = d !== null && d >= 0 && d <= COMING_SOON_DAYS;
    const statusColor = statusBadgeColor(row.closing_data_status);
    const statusBg = statusBgColor(row.closing_data_status);
    const permitNumber = stageChecks?.[row.id]?.PermitNumber;
    const checks = stageChecks?.[row.id] || {};
    const selectionsDone = STAGES.reduce((acc, s) => acc + (checks[s] ? 1 : 0), 0);
    const selectionsTotal = STAGES.length;
    const selectionsPct = selectionsTotal ? Math.round((selectionsDone / selectionsTotal) * 100) : 0;
    const showDetails = !compactCards || expanded;
    const projectStatusRaw = String(row.project_status ?? "").trim();
    const projectStatusIndex = projectStatusRaw
        ? PROJECT_STATUS_ORDER.findIndex(s => s.toLowerCase() === projectStatusRaw.toLowerCase())
        : -1;
    const projectStatusTotal = PROJECT_STATUS_ORDER.length;
    const projectStatusStep = projectStatusIndex >= 0 ? projectStatusIndex + 1 : 0;
    const projectStatusPct = projectStatusIndex >= 0 && projectStatusTotal > 1
        ? Math.round((projectStatusIndex / (projectStatusTotal - 1)) * 100)
        : 0;

    const isSpec = (row.type || "").toLowerCase().includes("spec");
    const listingUrl = normalizeUrl(row.listing_url);
    const hasListing = Boolean(listingUrl);
 
     // Calculate difference between original and expected closing date
     const closingDiff = daysBetween(row.original_closing_date, row.expected_closing_date);
     const isClosed = (row.project_status || "").toLowerCase() === "closed";
 
     // Style for CLOSED background pattern overlay
     const closedBgStyle = isClosed
         ? {
               backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(
                   `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>\n  <g transform='rotate(-25 12 12)'>\n    <text x='12' y='14' font-size='9' text-anchor='middle' fill='rgb(254,226,226)' font-family='Arial, Helvetica, sans-serif' font-weight='800' opacity='0.9'>CLOSED</text>\n  </g>\n</svg>`
               )}")`,
               backgroundSize: "20px 20px",
               backgroundRepeat: "repeat",
               backgroundPosition: "center",
           }
         : undefined;
 
     return (
         <motion.div
             style={{ minWidth: "340px" }} // <-- Added minWidth for wider cards
             whileHover={{
                 y: -6,
                 scale: 1.04,
                 boxShadow: "0 8px 32px 0 rgba(0,0,0,0.35), 0 0 0 2px #E11B22"
             }}
             transition={{ type: "spring", stiffness: 300, damping: 20 }}
             className={[...statusBg, "relative overflow-hidden border border-slate-700/60 shadow-xl rounded-xl p-4 transition-all duration-200 flex flex-col justify-between min-h-[220px]"].join(" ")}
         >
             {/* Full-card CLOSED stamp overlay when project is closed */}
             {isClosed && (
                 <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                     <div className="-rotate-12">
                         <span
                             className="inline-block px-4 py-2 border-8 border-rose-500/80 text-rose-50 font-black uppercase whitespace-nowrap tracking-[0.12em] opacity-70 bg-rose-900/70 rounded-xl shadow-[0_10px_30px_rgba(0,0,0,0.45)] ring-2 ring-rose-300/50 backdrop-blur-[1px] max-w-[92%]"
                             style={{ textShadow: "0 2px 6px rgba(0,0,0,0.5)", fontSize: "clamp(22px, 6vw, 56px)" }}
                         >
                             CLOSED
                         </span>
                     </div>
                 </div>
             )}
             <div className="flex items-start justify-between gap-3">
                 <div className="flex items-center gap-3">
                     {/* Colored square with CLOSED stamp overlay when project is closed */}
                     <div className="relative w-5 h-5">
                         <span className={`inline-block w-5 h-5 rounded-md border ${statusColor}`}></span>
                         {isClosed && (
                             <span
                                 className="pointer-events-none absolute inset-0 rounded-md border border-rose-700"
                                 style={{
                                     backgroundColor: "rgba(76, 5, 25, 0.85)",
                                     ...closedBgStyle,
                                 }}
                             />
                         )}
                     </div>
                     <div>
                         <div className="text-lg font-semibold leading-tight flex items-center gap-2">
                             <MapPin className="h-5 w-5 text-nvh-red animate-pulse" />
                             {row.address || "(Address TBD)"}
                         </div>
                         <div className="text-sm text-slate-300 mt-0.5">
                             Closing Date: <span className="font-medium text-slate-100">{fmt(dateStr)}</span>
                         </div>
                         {row.original_closing_date && (
                             <div className="text-xs text-slate-400">
                                 Original Closing Date: <span className="font-medium text-slate-100">{fmt(row.original_closing_date)}</span>
                                 {closingDiff !== null && (
                                     <span className="ml-2">
                                         ({closingDiff === 0
                                             ? "No change"
                                             : closingDiff > 0
                                                 ? `+${closingDiff} day${closingDiff === 1 ? "" : "s"}`
                                                 : `${closingDiff} day${closingDiff === -1 ? "" : "s"}`})
                                     </span>
                                 )}
                             </div>
                         )}
                     </div>
                 </div>
                 <div className="flex flex-col items-end gap-2">
                     <span className={`px-2 py-1 rounded text-xs font-semibold text-white border ${statusColor} shadow-md`}>
                         {row.closing_data_status || "Scheduled"}
                     </span>
                     {d !== null && (
                        <span
                            className={
                                "px-2 py-1 rounded-full text-xs font-bold border shadow " +
                                (d < 0
                                    ? "bg-slate-900/40 text-slate-200 border-slate-700"
                                    : d <= THIS_WEEK_DAYS
                                        ? "bg-nvh-red/30 text-white border-nvh-red/50"
                                        : d <= COMING_SOON_DAYS
                                            ? "bg-white/10 text-white border-white/20"
                                            : "bg-slate-900/40 text-slate-200 border-slate-700")
                            }
                        >
                            {d === 0 ? "Today" : d > 0 ? `${d}d` : `${-d}d ago`}
                        </span>
                     )}
                </div>
            </div>
            <div className="mt-3 text-sm text-slate-300 flex flex-col gap-1">
                 {row.client_name && <span>Client: <span className="font-medium text-slate-100">{row.client_name}</span></span>}
                 {row.foreman && <span>Foreman: <span className="font-medium text-slate-100">{row.foreman}</span></span>}
                 {showDetails && row.type && <span>Type: <span className="font-medium text-slate-100">{row.type}</span></span>}
                 {showDetails && permitNumber && (
                     <span>
                         Permit Number: <span className="font-medium text-nvh-red">{permitNumber}</span>
                     </span>
                 )}
                 {showDetails && row.days_delayed && <span>Days Delayed: <span className="font-medium text-slate-100">{row.days_delayed}</span></span>}
                 {showDetails && row.agreement_date && <span>Agreement Date: <span className="font-medium text-slate-100">{fmt(row.agreement_date)}</span></span>}
                 {row.project_status && (
                     <span>
                         Project Status: {projectStatusIcon(row.project_status)}
                         <span className="font-medium text-slate-100">{row.project_status}</span>
                     </span>
                 )}
                 {showDetails && row.financial_status && <span>Financial Status: <span className="font-medium text-slate-100">{row.financial_status}</span></span>}
             </div>

            {/* Project Status progress */}
            {projectStatusIndex >= 0 && (
                <div className="mt-3">
                    <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
                        <span>Project Progress</span>
                        <span className="font-semibold text-slate-100">
                            {PROJECT_STATUS_ORDER[projectStatusIndex]} · {projectStatusStep}/{projectStatusTotal} · {projectStatusPct}%
                        </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-900/40 border border-slate-700 overflow-hidden">
                        <div className="h-full bg-nvh-red/80" style={{ width: `${projectStatusPct}%` }} />
                    </div>
                </div>
            )}
             {/* Selections progress */}
             <div className="mt-3">
                 <div className="flex items-center justify-between text-xs text-slate-300 mb-1">
                     <span>Selections</span>
                     <span className="font-semibold text-slate-100">{selectionsDone}/{selectionsTotal} · {selectionsPct}%</span>
                 </div>
                 <div className="h-2 rounded-full bg-slate-900/40 border border-slate-700 overflow-hidden">
                     <div className="h-full bg-nvh-red/80" style={{ width: `${selectionsPct}%` }} />
                 </div>
                 <div className="flex items-center justify-between mt-2">
                     <div className="flex items-center gap-2">
                         {soon && <ComingSoonBadge days={d!} />}
                         {isSpec && hasListing && (
                             <a
                                 href={listingUrl}
                                 target="_blank"
                                 rel="noopener noreferrer"
                                 onClick={(e) => e.stopPropagation()}
                                 className="inline-flex items-center justify-center rounded-lg bg-nvh-red px-3 py-1.5 text-xs font-bold text:white hover:bg-nvh-redDark transition"
                                 title="Open the listing page"
                             >
                                 View Listing →
                             </a>
                         )}
                     </div>
                     <button
                         type="button"
                         onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
                         className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-xs text-slate-200 hover:bg-slate-700"
                         title="Toggle details"
                     >
                         {showDetails ? "Less" : "Details"}
                     </button>
                 </div>
             </div>
         </motion.div>
     );
 }
 
 // Remove tailwind.config.js code from here. Place it in tailwind.config.js at your project root.
 
 function normalizeDate(dateStr: string): string {
     if (!dateStr) return "";
     // Try to parse as YYYY-MM-DD or YYYY/MM/DD
     if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || /^\d{4}\/\d{2}\/\d{2}$/.test(dateStr)) return dateStr;
     // Try to parse as MON-DD-YYYY
     const monMatch = dateStr.match(/^([A-Za-z]{3})-(\d{2})-(\d{4})$/);
     if (monMatch) {
         const [_, mon, day, year] = monMatch;
         const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].findIndex(m => m.toLowerCase() === mon.toLowerCase());
         if (month >= 0) {
             return `${year}-${String(month + 1).padStart(2, "0")}-${day}`;
         }
     }
     // Fallback
     let d = new Date(dateStr);
     if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
     return dateStr;
 }
 
 // Modal component for stage checkboxes with passcode protection
 function StageModal({
     jobId,
     address,
     stages,
     onClose,
     onSave,
     onPrev,
     onNext,
     hasPrev,
     hasNext,
 }: {
     jobId: string;
     address: string;
     stages: { [stage: string]: StageValue };
     onClose: () => void;
     onSave: (jobId: string, stages: { [stage: string]: StageValue }) => void;
     onPrev?: () => void;
     onNext?: () => void;
     hasPrev?: boolean;
     hasNext?: boolean;
 }) {
     const PASSCODE = "42";
     const UNLOCK_KEY = "stageModalUnlockedUntil";
     const TEN_MINUTES = 10 * 60 * 1000;
 
     const normalizeField = (field: any) => {
         if (typeof field === 'object' && field !== null && ('value' in field || 'link' in field)) return field;
         return { value: field ?? '', link: '' };
     };
     const [localStages, setLocalStages] = useState<{ [stage: string]: StageValue }>({
         Finance: stages.Finance ?? false,
         Permit: stages.Permit ?? false,
         PermitNumber: typeof stages.PermitNumber === "number" || typeof stages.PermitNumber === "string" ? stages.PermitNumber : "",
         Siding: normalizeField(stages.Siding),
         Custom1: normalizeField(stages.Custom1),
         Custom2: normalizeField(stages.Custom2),
         AHWP: stages.AHWP ?? false,
         "Welcome Sent": stages["Welcome Sent"] ?? false,
         "Kickoff Booked": stages["Kickoff Booked"] ?? false,
         // New checkbox
         "NL Power": stages["NL Power"] ?? false,
         // New dynamic selections defaults
         Fireplace: stages["Fireplace"] ?? false,
         Stairs: stages["Stairs"] ?? false,
         ...stages,
         Deposits: Array.isArray(stages.Deposits) ? stages.Deposits : [],
         ChangeOrders: Array.isArray(stages.ChangeOrders) ? stages.ChangeOrders : [],
     });
    const [passcode, setPasscode] = useState("");
     const [error, setError] = useState("");
     const [unlocked, setUnlocked] = useState(false);
    const autosaveTimerRef = useRef<number | null>(null);
    const onSaveRef = useRef(onSave);
    const modalBodyRef = useRef<HTMLDivElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState("");
    const [uploadLog, setUploadLog] = useState<string[]>([]);
    const [pendingFiles, setPendingFiles] = useState<File[]>([]);
    const [authRetryNeeded, setAuthRetryNeeded] = useState(false);
    const tokenRef = useRef<string | null>(null);
    const tokenClientRef = useRef<any>(null);
    const autoReauthAttemptedRef = useRef(false);
 
     // Reset local stages when switching jobs or stages prop changes
     useEffect(() => {
         setLocalStages({
             Finance: stages.Finance ?? false,
             Permit: stages.Permit ?? false,
             PermitNumber: typeof stages.PermitNumber === "number" || typeof stages.PermitNumber === "string" ? stages.PermitNumber : "",
             Siding: normalizeField(stages.Siding),
             Custom1: normalizeField(stages.Custom1),
             Custom2: normalizeField(stages.Custom2),
             AHWP: stages.AHWP ?? false,
             "Welcome Sent": stages["Welcome Sent"] ?? false,
             "Kickoff Booked": stages["Kickoff Booked"] ?? false,
             // New checkbox
             "NL Power": stages["NL Power"] ?? false,
             // New dynamic selections defaults
             Fireplace: stages["Fireplace"] ?? false,
             Stairs: stages["Stairs"] ?? false,
             ...stages,
             Deposits: Array.isArray(stages.Deposits) ? stages.Deposits : [],
             ChangeOrders: Array.isArray(stages.ChangeOrders) ? stages.ChangeOrders : [],
         });
         setError("");
     }, [jobId, stages]);
     // Check localStorage for unlock status on mount
     useEffect(() => {
         try {
             const untilStr = localStorage.getItem(UNLOCK_KEY);
             if (untilStr) {
                 const until = parseInt(untilStr, 10);
                 if (!isNaN(until) && Date.now() < until) {
                     setUnlocked(true);
                 }
             }
         } catch {
             // ignore
         }
     }, []);

    useEffect(() => {
        onSaveRef.current = onSave;
    }, [onSave]);

    useEffect(() => {
        if (modalBodyRef.current) {
            modalBodyRef.current.scrollTop = 0;
        }
    }, [jobId]);

    useEffect(() => {
        if (!authRetryNeeded) {
            autoReauthAttemptedRef.current = false;
            return;
        }
        if (autoReauthAttemptedRef.current || uploading || pendingFiles.length === 0) return;
        autoReauthAttemptedRef.current = true;
        const timerId = window.setTimeout(() => {
            retryPendingUpload();
        }, 500);
        return () => window.clearTimeout(timerId);
    }, [authRetryNeeded, uploading, pendingFiles.length]);

    const rawPhotosFolderId = String((localStages as any).photosFolderId || (localStages as any).PhotosFolderId || "").trim();
    const photosFolderId = rawPhotosFolderId.replace(/^.*\/folders\//i, "").replace(/\?.*$/, "").trim();

    const logUpload = (msg: string) => {
        setUploadLog(prev => [...prev, msg]);
    };

    const getAccessToken = (forcePrompt = false) => {
        return new Promise<string>((resolve, reject) => {
            const google = window.google;
            if (!google?.accounts?.oauth2) {
                reject(new Error("Google auth not available"));
                return;
            }
            if (!tokenClientRef.current) {
                tokenClientRef.current = google.accounts.oauth2.initTokenClient({
                    client_id: GOOGLE_CLIENT_ID,
                    scope: DRIVE_SCOPE,
                    callback: () => {},
                });
            }
            let hasPriorConsent = false;
            try {
                hasPriorConsent = localStorage.getItem(DRIVE_AUTH_FLAG_KEY) === "1";
            } catch {
                hasPriorConsent = false;
            }
            let timeoutId = 0;
            let retried = false;
            const clearAuthTimeout = () => {
                if (timeoutId) window.clearTimeout(timeoutId);
                timeoutId = 0;
            };
            const startAuthTimeout = (prompt: string) => {
                clearAuthTimeout();
                timeoutId = window.setTimeout(() => {
                    if (!retried && !forcePrompt) {
                        retried = true;
                        logUpload("Retrying Google authorization...");
                        tokenClientRef.current.requestAccessToken({ prompt });
                        startAuthTimeout(prompt);
                        return;
                    }
                    setAuthRetryNeeded(true);
                    reject(new Error("Auth popup blocked or not completed"));
                }, 20000);
            };
            tokenClientRef.current.callback = (resp: any) => {
                clearAuthTimeout();
                if (resp?.error) {
                    setAuthRetryNeeded(true);
                    reject(new Error(resp.error));
                    return;
                }
                tokenRef.current = resp.access_token;
                try {
                    localStorage.setItem(DRIVE_AUTH_FLAG_KEY, "1");
                } catch {
                    // ignore
                }
                setAuthRetryNeeded(false);
                resolve(resp.access_token);
            };
            const prompt = forcePrompt ? "consent" : (tokenRef.current || hasPriorConsent ? "" : "consent");
            startAuthTimeout(prompt);
            tokenClientRef.current.requestAccessToken({ prompt });
        });
    };

    const uploadFileToDrive = async (file: File, folderId: string) => {
        logUpload("Authorizing with Google...");
        const token = tokenRef.current || await getAccessToken();
        logUpload("Authorization complete. Starting upload...");
        const boundary = "----nvhFormBoundary" + Date.now().toString(16);
        const delimiter = `\r\n--${boundary}\r\n`;
        const closeDelimiter = `\r\n--${boundary}--`;
        const metadata = {
            name: file.name,
            parents: [folderId],
        };
        const multipartBody = new Blob([
            delimiter,
            "Content-Type: application/json; charset=UTF-8\r\n\r\n",
            JSON.stringify(metadata),
            delimiter,
            `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
            file,
            closeDelimiter,
        ]);
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 60000);
        try {
            const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": `multipart/related; boundary=${boundary}`,
                },
                body: multipartBody,
                signal: controller.signal,
            });
            if (!res.ok) {
                const msg = await res.text();
                throw new Error(msg || `Upload failed (${res.status})`);
            }
            await res.json().catch(() => null);
        } catch (err: any) {
            if (err?.name === "AbortError") {
                throw new Error("Upload timed out after 60s");
            }
            throw err;
        } finally {
            window.clearTimeout(timeoutId);
        }
    };

    const handlePhotoButton = () => {
        setUploadError("");
        setUploadLog([]);
        if (!photosFolderId) {
            setUploadError("Missing photosFolderId for this job.");
            return;
        }
        fileInputRef.current?.click();
    };

    const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        if (!photosFolderId) {
            setUploadError("Missing photosFolderId for this job.");
            return;
        }
        setUploading(true);
        setUploadError("");
        setUploadLog([]);
        setPendingFiles(files);
        const stallId = window.setTimeout(() => {
            logUpload("Still uploading... (auth or network may be blocked)");
        }, 8000);
        try {
            logUpload("Requesting Google authorization...");
            await getAccessToken();
            logUpload("Authorization complete.");
            for (const file of files) {
                setUploadLog(prev => [...prev, `Uploading ${file.name}...`]);
                logUpload("Starting upload request...");
                await uploadFileToDrive(file, photosFolderId);
                setUploadLog(prev => [...prev, `Uploaded ${file.name}`]);
            }
            setPendingFiles([]);
        } catch (err: any) {
            console.error("Photo upload failed", err);
            setUploadError(err?.message || "Upload failed");
            setUploadLog(prev => [...prev, `Error: ${err?.message || "Upload failed"}`]);
        } finally {
            window.clearTimeout(stallId);
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    };

    const retryPendingUpload = async () => {
        if (!pendingFiles.length || !photosFolderId) return;
        setUploading(true);
        setUploadError("");
        setUploadLog([]);
        try {
            logUpload("Requesting Google authorization...");
            await getAccessToken(true);
            logUpload("Authorization complete.");
            for (const file of pendingFiles) {
                setUploadLog(prev => [...prev, `Uploading ${file.name}...`]);
                logUpload("Starting upload request...");
                await uploadFileToDrive(file, photosFolderId);
                setUploadLog(prev => [...prev, `Uploaded ${file.name}`]);
            }
            setPendingFiles([]);
        } catch (err: any) {
            console.error("Photo upload failed", err);
            setUploadError(err?.message || "Upload failed");
            setUploadLog(prev => [...prev, `Error: ${err?.message || "Upload failed"}`]);
        } finally {
            setUploading(false);
        }
    };
 
     const handleUnlock = () => {
         if (passcode.trim() === PASSCODE) {
             setUnlocked(true);
             setError("");
             setPasscode("");
             try {
                 localStorage.setItem(UNLOCK_KEY, String(Date.now() + TEN_MINUTES));
             } catch {
                 // ignore
             }
         } else {
             setError("Invalid passcode");
         }
     };
 
     const toggleStage = (key: string) => {
         setLocalStages(prev => ({ ...prev, [key]: !prev[key] }));
     };
 
     const updateValue = (key: string, value: string | number) => {
         setLocalStages(prev => ({ ...prev, [key]: value }));
     };

     const deposits = Array.isArray(localStages.Deposits) ? (localStages.Deposits as DepositEntry[]) : [];

     const updateDeposit = (idx: number, field: "date" | "amount", value: string) => {
         const next = deposits.map((d, i) => (i === idx ? { ...d, [field]: value } : d));
         setLocalStages(prev => ({ ...prev, Deposits: next }));
     };

     const addDeposit = () => {
         const next = [...deposits, { date: "", amount: "" }];
         setLocalStages(prev => ({ ...prev, Deposits: next }));
     };

     const removeDeposit = (idx: number) => {
         const next = deposits.filter((_, i) => i !== idx);
         setLocalStages(prev => ({ ...prev, Deposits: next }));
     };

    const changeOrders = Array.isArray(localStages.ChangeOrders) ? (localStages.ChangeOrders as ChangeOrderEntry[]) : [];

    const updateChangeOrder = (idx: number, field: "link" | "amount" | "description", value: string) => {
        const next = changeOrders.map((d, i) => (i === idx ? { ...d, [field]: value } : d));
        setLocalStages(prev => ({ ...prev, ChangeOrders: next }));
    };

    const addChangeOrder = () => {
        const next = [...changeOrders, { link: "", amount: "", description: "" }];
        setLocalStages(prev => ({ ...prev, ChangeOrders: next }));
    };

    const removeChangeOrder = (idx: number) => {
        const next = changeOrders.filter((_, i) => i !== idx);
        setLocalStages(prev => ({ ...prev, ChangeOrders: next }));
    };

    useEffect(() => {
        if (!unlocked) return;
        if (autosaveTimerRef.current) {
            window.clearTimeout(autosaveTimerRef.current);
        }
        autosaveTimerRef.current = window.setTimeout(() => {
            onSaveRef.current(jobId, localStages);
        }, 500);
        return () => {
            if (autosaveTimerRef.current) {
                window.clearTimeout(autosaveTimerRef.current);
            }
        };
    }, [localStages, unlocked, jobId]);
 
     const handleSave = () => {
         onSave(jobId, localStages);
     };

     const handleSaveAndNext = () => {
         onSave(jobId, localStages);
         if (onNext) onNext();
     };

    const stageLabelClass = (checked: boolean) =>
        "flex items-center gap-2 rounded-lg border px-2 py-1.5 relative " +
        (checked
            ? "bg-emerald-500/20 border-emerald-500 text-white"
            : "bg-slate-800/40 border-slate-700 text-slate-200");

    // Link state per stage
    const [links, setLinks] = useState<{ [stage: string]: string }>(() => {
        const obj: { [stage: string]: string } = {};
        STAGES.forEach(k => {
            obj[k] = typeof localStages[`${k}_link`] === "string" ? localStages[`${k}_link`] : "";
        });
        return obj;
    });
    const [showLinkInput, setShowLinkInput] = useState<string | null>(null);

    // Handle link input change
    const handleLinkChange = (stage: string, value: string) => {
        setLinks(prev => ({ ...prev, [stage]: value }));
        setLocalStages(prev => ({ ...prev, [`${stage}_link`]: value }));
    };

    // Open link in new tab
    const handleOpenLink = (stage: string) => {
        if (links[stage]) window.open(links[stage], '_blank');
    };

    // Toggle stage and show link input if checked
    const handleStageToggle = (stage: string) => {
        setLocalStages(prev => {
            // Only allow unchecking if user manually clicks
            const nextChecked = !prev[stage];
            return { ...prev, [stage]: nextChecked };
        });
        // Show link input only when checking
        if (!localStages[stage]) setShowLinkInput(stage);
        else setShowLinkInput(null);
    };
 
     return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
             <div className="absolute inset-0 bg-black/60" onClick={onClose} />
            <div
                ref={modalBodyRef}
                className="relative w-full max-w-3xl bg-slate-900 border border-slate-700 rounded-xl p-4 md:p-6 shadow-2xl overflow-y-auto max-h-[92vh]"
            >
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg md:text-xl font-bold text-slate-100">{address || jobId}</h3>
                    <div className="flex items:center gap-2">
                        <button
                            type="button"
                            onClick={handlePhotoButton}
                            disabled={uploading}
                            className={"px-2 py-1 rounded border text-slate-100 " + (uploading ? "bg-slate-800/60 border-slate-700 cursor-not-allowed" : "bg-slate-800 border-slate-700 hover:bg-slate-700")}
                            title={photosFolderId ? "Add photo" : "Missing photosFolderId"}
                        >
                            {uploading ? "Uploading…" : "Photos"}
                        </button>
                        {hasPrev && <button onClick={onPrev} className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200">Prev</button>}
                        {hasNext && <button onClick={onNext} className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200">Next</button>}
                        <button onClick={onClose} className="px-2 py-1 rounded bg-rose-700 text-white">Close</button>
                    </div>
                </div>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    className="hidden"
                    onChange={handlePhotoChange}
                />
                {uploadError && <div className="text-rose-400 text-sm mb-2">{uploadError}</div>}
                {uploadLog.length > 0 && (
                    <div className="mb-3 rounded border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-200">
                        {uploadLog.map((line, idx) => (
                            <div key={idx}>{line}</div>
                        ))}
                    </div>
                )}
                {pendingFiles.length > 0 && !uploading && (
                    <button
                        type="button"
                        onClick={retryPendingUpload}
                        className="mb-3 px-3 py-2 rounded bg-slate-800 border border-slate-700 text-slate-100 text-xs hover:bg-slate-700"
                    >
                        Authorize and Upload
                    </button>
                )}
                {authRetryNeeded && (
                    <button
                        type="button"
                        onClick={retryPendingUpload}
                        className="mb-3 px-3 py-2 rounded bg-amber-700/60 border border-amber-600 text-amber-50 text-xs hover:bg-amber-700"
                    >
                        Reauthorize (popup blocked)
                    </button>
                )}
 
                <div className="space-y-4">
                    {!unlocked && (
                        <div className="space-y-3">
                            <p className="text-slate-300">Enter passcode to edit stages. You can view selections without unlocking.</p>
                            <div className="flex items-center gap-2">
                                <input
                                    type="password"
                                    value={passcode}
                                    onChange={e => setPasscode(e.target.value)}
                                    className="flex-1 rounded bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                                    placeholder="Passcode"
                                />
                                <button onClick={handleUnlock} className="px-4 py-2 bg-nvh-red hover:bg-nvh-redDark rounded text-white font-semibold">Unlock</button>
                            </div>
                            {error && <div className="text-rose-400 text-sm">{error}</div>}
                        </div>
                    )}
 
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {/* Core fields */}
                        <label className={stageLabelClass(Boolean(localStages.Finance))}>
                            <input className="accent-emerald-500" type="checkbox" disabled={!unlocked} checked={Boolean(localStages.Finance)} onChange={() => toggleStage('Finance')} />
                            <span>Finance</span>
                        </label>
                        <label className={stageLabelClass(Boolean(localStages.Permit))}>
                            <input className="accent-emerald-500" type="checkbox" disabled={!unlocked} checked={Boolean(localStages.Permit)} onChange={() => toggleStage('Permit')} />
                            <span>Permit</span>
                        </label>
                        <div className="flex items-center gap-2">
                            <span className="text-slate-200 w-40">Photos Folder ID</span>
                            <input
                                type="text"
                                disabled={!unlocked}
                                value={String((localStages as any).photosFolderId ?? '')}
                                onChange={e => updateValue('photosFolderId', e.target.value)}
                                className="flex-1 rounded bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                                placeholder="Drive folder ID"
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-slate-200 w-40">Permit Number</span>
                            <input
                                type="text"
                                disabled={!unlocked}
                                value={String(localStages.PermitNumber ?? '')}
                                onChange={e => updateValue('PermitNumber', e.target.value)}
                                className="flex-1 rounded bg-slate-800 border border-slate-700 px-3 py-2 text-slate-100"
                                placeholder="123456"
                            />
                        </div>
                        <label className={stageLabelClass(Boolean(localStages.AHWP))}>
                            <input className="accent-emerald-500" type="checkbox" disabled={!unlocked} checked={Boolean(localStages.AHWP)} onChange={() => toggleStage('AHWP')} />
                            <span>AHWP</span>
                        </label>
                        <label className={stageLabelClass(Boolean(localStages['Welcome Sent']))}>
                            <input className="accent-emerald-500" type="checkbox" disabled={!unlocked} checked={Boolean(localStages['Welcome Sent'])} onChange={() => toggleStage('Welcome Sent')} />
                            <span>Welcome Sent</span>
                        </label>
                        <label className={stageLabelClass(Boolean(localStages["Kickoff Booked"]))}>
                           <input className="accent-emerald-500" type="checkbox" disabled={!unlocked} checked={Boolean(localStages["Kickoff Booked"])} onChange={() => toggleStage("Kickoff Booked")} />
                           <span>Kickoff Booked</span>
                         </label>
                         {/* New NL Power checkbox */}
                         <label className={stageLabelClass(Boolean(localStages['NL Power']))}>
                             <input className="accent-emerald-500" type="checkbox" disabled={!unlocked} checked={Boolean(localStages['NL Power'])} onChange={() => toggleStage('NL Power')} />
                             <span>NL Power</span>
                         </label>
                         <div className="md:col-span-2 rounded-lg border border-slate-700 bg-slate-800/30 p-3">
                             <div className="flex items-center justify-between mb-2">
                                 <span className="text-slate-300 font-semibold">Deposits</span>
                                 <button
                                     type="button"
                                     onClick={addDeposit}
                                     disabled={!unlocked}
                                     className={"px-2 py-1 rounded text-xs font-semibold " + (unlocked ? "bg-slate-700 hover:bg-slate-600 text-slate-100" : "bg-slate-800/60 text-slate-500 cursor-not-allowed")}
                                 >
                                     Add deposit
                                 </button>
                             </div>
                             {deposits.length === 0 ? (
                                 <div className="text-slate-500 text-sm">No deposits added.</div>
                             ) : (
                                 <div className="space-y-2">
                                     {deposits.map((d, idx) => (
                                         <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-2 items-center">
                                             <input
                                                 type="date"
                                                 disabled={!unlocked}
                                                 value={d.date}
                                                 onChange={e => updateDeposit(idx, "date", e.target.value)}
                                                 className="rounded bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                                             />
                                            <div className="relative">
                                                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
                                                <input
                                                    type="text"
                                                    inputMode="decimal"
                                                    disabled={!unlocked}
                                                    value={d.amount}
                                                    onChange={e => updateDeposit(idx, "amount", e.target.value.replace(/[^\d.]/g, ""))}
                                                    className="w-full rounded bg-slate-900 border border-slate-700 pl-7 pr-3 py-2 text-slate-100"
                                                    placeholder="0.00"
                                                />
                                            </div>
                                             <button
                                                 type="button"
                                                 onClick={() => removeDeposit(idx)}
                                                 disabled={!unlocked}
                                                 className={"px-2 py-1 rounded text-xs font-semibold " + (unlocked ? "bg-rose-700 hover:bg-rose-600 text-white" : "bg-rose-900/40 text-rose-300/40 cursor-not-allowed")}
                                             >
                                                 Remove
                                             </button>
                                         </div>
                                     ))}
                                 </div>
                             )}
                         </div>
                        <div className="md:col-span-2 rounded-lg border border-slate-700 bg-slate-800/30 p-3">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-slate-300 font-semibold">Change Orders</span>
                                <button
                                    type="button"
                                    onClick={addChangeOrder}
                                    disabled={!unlocked}
                                    className={"px-2 py-1 rounded text-xs font-semibold " + (unlocked ? "bg-slate-700 hover:bg-slate-600 text-slate-100" : "bg-slate-800/60 text-slate-500 cursor-not-allowed")}
                                >
                                    Add change order
                                </button>
                            </div>
                            {changeOrders.length === 0 ? (
                                <div className="text-slate-500 text-sm">No change orders added.</div>
                            ) : (
                                <div className="space-y-2">
                                    {changeOrders.map((d, idx) => (
                                        <div key={idx} className="grid grid-cols-1 md:grid-cols-[2fr_1fr_auto_auto] gap-2 items-center">
                                            {/* Description first */}
                                            <input
                                                type="text"
                                                disabled={!unlocked}
                                                value={d.description || ""}
                                                onChange={e => updateChangeOrder(idx, "description", e.target.value)}
                                                className="rounded bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 w-full"
                                                placeholder="Description"
                                            />
                                            {/* Amount second */}
                                            <div className="relative w-full">
                                                <input
                                                    type="text"
                                                    inputMode="decimal"
                                                    disabled={!unlocked}
                                                    value={d.amount ?? ''}
                                                    onChange={e => {
                                                        // Remove all non-numeric except dot
                                                        let val = e.target.value.replace(/[^\d.]/g, '');
                                                        // Only allow one dot
                                                        const parts = val.split('.');
                                                        if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
                                                        updateChangeOrder(idx, "amount", val);
                                                    }}
                                                    className="rounded bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 w-full pl-6"
                                                    placeholder="$0.00"
                                                />
                                                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">$</span>
                                            </div>
                                            {/* Link as button third */}
                                            <div className="flex items-center gap-1">
                                                {d.link ? (
                                                    <a
                                                        href={d.link}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="px-2 py-1 rounded text-xs font-semibold bg-sky-700 hover:bg-sky-600 text-white whitespace-nowrap"
                                                        title={d.link}
                                                    >
                                                        Link
                                                    </a>
                                                ) : null}
                                                {unlocked && (
                                                    <input
                                                        type="url"
                                                        value={d.link}
                                                        onChange={e => updateChangeOrder(idx, "link", e.target.value)}
                                                        className="rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100 text-xs w-28"
                                                        placeholder="Paste link"
                                                        style={{ display: d.link ? 'none' : 'block' }}
                                                    />
                                                )}
                                            </div>
                                            {/* Remove button */}
                                            <button
                                                type="button"
                                                onClick={() => removeChangeOrder(idx)}
                                                disabled={!unlocked}
                                                className={"px-2 py-1 rounded text-xs font-semibold " + (unlocked ? "bg-rose-700 hover:bg-rose-600 text-white" : "bg-rose-900/40 text-rose-300/40 cursor-not-allowed")}
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                     </div>
 
                     {/* Dynamic selection stages */}
                     <div>
                         <div className="text-slate-300 font-semibold mb-2">Selections</div>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {STAGES.map(s => (
                                <label key={s} className={stageLabelClass(Boolean(localStages[s]))}>
                                    <input className="accent-emerald-500" type="checkbox" disabled={!unlocked} checked={Boolean(localStages[s])} onChange={() => handleStageToggle(s)} />
                                    {/* If link exists, show icon and make clickable */}
                                    {links[s] ? (
                                        <span
                                            className="ml-1 text-sky-400 underline cursor-pointer text-xs"
                                            onClick={() => handleOpenLink(s)}
                                            title="Open linked document"
                                        >🔗</span>
                                    ) : null}
                                    <span>{s}</span>
                                    {/* Show link input popup if checked and unlocked */}
                                    {showLinkInput === s && unlocked && !!localStages[s] && (
                                        <div className="absolute left-24 top-0 bg-slate-800 border border-slate-600 rounded p-2 flex items-center gap-2 shadow-lg z-10">
                                            <input
                                                type="text"
                                                value={links[s] || ""}
                                                onChange={e => handleLinkChange(s, e.target.value)}
                                                placeholder="Paste link (optional)"
                                                className="w-40 px-2 py-1 rounded bg-slate-700 text-slate-100 border border-slate-600 text-xs"
                                                autoFocus
                                            />
                                            <button
                                                type="button"
                                                className="text-xs px-2 py-1 bg-sky-600 rounded text-white"
                                                onClick={() => setShowLinkInput(null)}
                                            >Done</button>
                                        </div>
                                    )}
                                </label>
                            ))}
                        </div>
                     </div>
 
                     <div className="flex justify-end gap-2 pt-2">
                         {hasNext && (
                             <button
                                 onClick={handleSaveAndNext}
                                 disabled={!unlocked}
                                 className={"px-4 py-2 rounded text-white font-semibold " + (unlocked ? "bg-nvh-red hover:bg-nvh-redDark" : "bg-nvh-redDark/40 cursor-not-allowed")}
                             >
                                 Save + Next
                             </button>
                         )}
                         <button onClick={handleSave} disabled={!unlocked} className={"px-4 py-2 rounded text-white font-semibold " + (unlocked ? "bg-emerald-600 hover:bg-emerald-700" : "bg-emerald-900/50 cursor-not-allowed")}>Save</button>
                         <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-white">Cancel</button>
                     </div>
                 </div>
             </div>
         </div>
     );
 }
 
 function DieterPanel({ rows, onJobClick, stageChecks, compactCards }: { rows: ClosingRow[]; onJobClick: (jobId: string) => void; stageChecks: any; compactCards: boolean }) {
     const openCount = rows.filter(r => (r.project_status || '').toLowerCase() !== 'closed').length;
     const closedRecentCount = rows.length - openCount;
     return (
         <div>
             <div className="flex items-center gap-3 mb-4">
                 <CalendarDays className="h-6 w-6" />
                 <h2 className="text-xl sm:text-2xl font-bold">Dieter View</h2>
                 <span className="text-slate-400 text-base">({rows.length} total · {openCount} open · {closedRecentCount} closed last 3 months)</span>
             </div>
             {rows.length === 0 ? (
                 <p className="text-slate-400">No results.</p>
             ) : (
                 <div className="grid grid-cols-1 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-8">
                     {rows.map((r) => (
                         <ClosingCard key={r.id} row={r} onJobClick={onJobClick} stageChecks={stageChecks} compactCards={compactCards} />
                     ))}
                 </div>
             )}
         </div>
     );
 }
 
 // Suggestion item type derived from data
function suggestionLabel(r: ClosingRow) {
    const parts = [r.address];
    if (r.client_name) parts.push(`· ${r.client_name}`);
    if (r.expected_closing_date) parts.push(`· ${fmt(r.expected_closing_date)}`);
    return parts.filter(Boolean).join(' ');
}

function MobileSuggestions({
  anchorRect,
  topProvider,
  inputRef,
  rows,
  filterText,
  setFilterText,
  onHide,
  onSelectJob,
}: {
  anchorRect?: { top: number; left: number; width: number };
  topProvider: () => void;
  inputRef: React.RefObject<any>;
  rows: ClosingRow[];
  filterText: string;
  setFilterText: (s: string) => void;
  onHide: () => void;
  onSelectJob: (row: ClosingRow) => void;
}) {
        const [activeIndex, setActiveIndex] = useState(0);
    // Use all parsed rows to show suggestions, including closed and undated
    const options = useMemo(() => {
        const q = filterText.trim().toLowerCase();
        const base = rows;
        const result = q && /\d/.test(q) // only start when a digit is entered
             ? base.filter(r => {
                 const addr = (r.address || '').toLowerCase();
                 const client = (r.client_name || '').toLowerCase();
                 const type = (r.type || '').toLowerCase();
                 const foreman = (r.foreman || '').toLowerCase();
                 // Linear/prefix match: only match when the field starts with the query
                 return (
                     addr.startsWith(q) ||
                     client.startsWith(q) ||
                     type.startsWith(q) ||
                     foreman.startsWith(q)
                 );
             })
             : base;
        // Limit to 100 to avoid giant lists; sort by date then address
        return [...result].sort((a, b) => {
            const ta = a.expected_closing_date ? new Date(a.expected_closing_date + 'T00:00:00').getTime() : Infinity;
            const tb = b.expected_closing_date ? new Date(b.expected_closing_date + 'T00:00:00').getTime() : Infinity;
            const va = isNaN(ta) ? Infinity : ta;
            const vb = isNaN(tb) ? Infinity : tb;
            return va - vb;
        }).slice(0, 100);
    }, [ rows, filterText]);

    useEffect(() => {
        setActiveIndex(0);
    }, [options.length, filterText]);

    // Keep the dropdown positioned during viewport changes
    useEffect(() => {
        const id = setInterval(topProvider, 250);
        return () => clearInterval(id);
    }, [topProvider]);

    useEffect(() => {
        const el = inputRef.current as HTMLInputElement | null;
        if (!el) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (!options.length) return;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex(i => (i + 1) % options.length);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex(i => (i - 1 + options.length) % options.length);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const row = options[activeIndex] || options[0];
                if (row) onSelect(row);
            } else if (e.key === 'Escape') {
                onHide();
            }
        };
        el.addEventListener('keydown', onKeyDown);
        return () => el.removeEventListener('keydown', onKeyDown);
    }, [inputRef, options, activeIndex, onHide]);

    const onSelect = (row: ClosingRow) => {
        setFilterText(row.address || "");
        onSelectJob(row);
    };


    return (
        <div className="sm:hidden">
            <div
                className="absolute left-0 right-0 rounded-lg bg-slate-800 border border-slate-700 shadow-2xl overflow-hidden"
                style={{
                    maxHeight: '45vh',
                    overflowY: 'auto',
                    top: '100%',
                    zIndex: 40,
                }}
            >
                {options.length > 0 && (
                     <ul className="divide-y divide-slate-700/70">
                        {options.map((o, idx) => (
                            <li key={o.id}>
                                <button
                                     type="button"
                                     onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => onSelect(o)}
                                    className={
                                        "w-full text-left px-3 py-2 text-slate-100 text-sm " +
                                        (idx === activeIndex ? "bg-slate-700/60" : "hover:bg-slate-700/60")
                                    }
                                >
                                    {suggestionLabel(o)}
                                </button>
                            </li>
                        ))}
                     </ul>
                 )}
            </div>
        </div>
    );
}

function ProgressChartView({ rows, onClose, fullScreen }: { rows: ClosingRow[]; onClose: () => void; fullScreen?: boolean }) {
    const [condensed, setCondensed] = useState(!!fullScreen);
    const entries = useMemo(() => {
        const toIndex = (status: string) => PROJECT_STATUS_ORDER.findIndex(s => s.toLowerCase() === status.toLowerCase());
        return rows
            .map(r => {
                const raw = String(r.project_status || '').trim();
                const idx = raw ? toIndex(raw) : -1;
                return {
                    id: r.id,
                    address: r.address || r.id,
                    status: raw || 'Unknown',
                    index: idx,
                };
            })
            .filter(entry => entry.status !== 'Unknown')
            .sort((a, b) => {
                const ia = a.index >= 0 ? a.index : -1;
                const ib = b.index >= 0 ? b.index : -1;
                if (ia !== ib) return ib - ia;
                return a.address.localeCompare(b.address);
            });
    }, [rows]);
    const rowPaddingClass = fullScreen ? "py-0.5" : (condensed ? "py-1" : "py-1.5");
    const rowTextClass = fullScreen ? "text-xs" : (condensed ? "text-sm" : "text-base");
    const columnHeight = fullScreen ? "calc(100vh - 150px)" : "calc(100vh - 160px)";
    const legendItems = Array.from(new Set([...PROJECT_STATUS_ORDER]));

    const chartContent = (
        <div className={fullScreen ? "" : (condensed ? "space-y-1" : "space-y-2")}>
            <div className="flex gap-3">
                <div className="min-w-0 flex-1">
                    <div
                        className="grid gap-1"
                        style={{
                            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                            gridAutoRows: "minmax(26px, 1fr)",
                            height: columnHeight,
                            alignContent: "start",
                        }}
                    >
                        {entries.map(({ id, address, status, index }) => {
                            const boxClass = getProgressBarClass(status, index);
                            return (
                                <div
                                    key={id}
                                    className={
                                        "rounded-lg border border-slate-900/40 px-3 " +
                                        rowPaddingClass +
                                        " flex items-center gap-2 w-full " +
                                        boxClass +
                                        " mb-1"
                                    }
                                    style={{ minWidth: 0 }}
                                    title={`${address} — ${status}`}
                                >
                                    <div className={`${rowTextClass} text-slate-100 truncate`} title={address}>{address}</div>
                                </div>
                            );
                        })}
                    </div>
                </div>
                <div
                    className="w-40 lg:w-48 rounded-lg border border-slate-700 bg-slate-900/60 p-2"
                    style={{ maxHeight: columnHeight }}
                >
                    <div className="text-[22px] uppercase tracking-wide text-slate-400 mb-2">Status Key</div>
                    <div className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: `calc(${columnHeight} - 28px)` }}>
                        {legendItems.map((label, index) => {
                            const dotClass = getProgressBarClass(label, index);
                            return (
                                <div key={label} className="flex items-center gap-2 text-[18px] text-slate-200">
                                    <span className={`h-2.5 w-2.5 rounded-full ${dotClass}`} />
                                    <span className="truncate" title={label}>{label}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>
    );

    if (fullScreen) {
        return (
            <div className="min-h-screen w-full bg-gradient-to-br from-nvh-bg via-nvh-navy to-nvh-bg text-nvh-text p-4 md:p-8 text-base md:text-lg">
                <div className="max-w-7xl mx-auto">
                    <div className="sticky top-0 z-10 -mx-4 md:-mx-8 px-4 md:px-8 py-3 backdrop-blur bg-nvh-bg/80 border-b border-white/10">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                                <img
                                    src="/nvh-logo.png"
                                    alt="New Victorian Homes"
                                    className="h-9 w-auto object-contain"
                                />
                                <div>
                                    <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">New Victorian Homes</div>
                                    <h3 className="text-lg md:text-2xl font-bold text-slate-100">Project Progress</h3>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setCondensed(v => !v)}
                                    className="px-3 py-1 rounded bg-slate-800 border border-slate-700 text-slate-100 text-sm"
                                >
                                    {condensed ? "Expanded" : "Condensed"}
                                </button>
                                <button onClick={onClose} className="px-3 py-1 rounded bg-rose-700 text-white text-sm">Close</button>
                            </div>
                        </div>
                    </div>
                    <div className="mt-4 rounded-xl bg-slate-900/70 border border-slate-700 shadow-xl p-3 md:p-4 overflow-hidden">
                        {entries.length === 0 ? (
                            <div className="text-slate-400">No project status data.</div>
                        ) : (
                            chartContent
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/60" onClick={onClose} />
            <div className="relative w-full h-full max-w-none bg-slate-900 border border-slate-700 rounded-xl p-4 md:p-6 shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <img
                            src="/nvh-logo.png"
                            alt="New Victorian Homes"
                            className="h-7 w-auto object-contain"
                        />
                        <div>
                            <div className="text-[10px] uppercase tracking-[0.2em] text-slate-400">New Victorian Homes</div>
                            <h3 className="text-lg md:text-xl font-bold text-slate-100">Project Progress</h3>
                        </div>
                    </div>
                    <button onClick={onClose} className="px-3 py-1 rounded bg-rose-700 text-white">Close</button>
                </div>
                {entries.length === 0 ? (
                    <div className="text-slate-400">No project status data.</div>
                ) : (
                    chartContent
                )}
            </div>
        </div>
    );
}
