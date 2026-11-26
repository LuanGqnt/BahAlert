import http from "node:http";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

process.loadEnvFile(".env");

const PORT = process.env.PORT || 3000;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const FLOOD_LEVEL_CODE = {
  NORMAL: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

const VALID_LEVELS = new Set(Object.keys(FLOOD_LEVEL_CODE));

// Optional Firestore setup if FIREBASE_SERVICE_ACCOUNT is provided in env
let db = null;
if (!getApps().length && process.env.FIREBASE_SERVICE_ACCOUNT) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
  db = getFirestore();
}

let state = {
  distanceCm: null,
  rawLevel: "NORMAL",
  rawLevelCode: FLOOD_LEVEL_CODE.NORMAL,
  level: "NORMAL",
  levelCode: FLOOD_LEVEL_CODE.NORMAL,
  alarmActive: false,
  updatedAt: null,
};

function normalizeLevel(value, fallback = "NORMAL") {
  if (typeof value === "string") {
    const upper = value.toUpperCase();
    if (VALID_LEVELS.has(upper)) return upper;
  }
  return fallback;
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
    }),
  });

  if (!res.ok) {
    console.error("Telegram error:", res.status, await res.text());
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload, null, 2));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  // For the esp32 sensor
  if (req.method === "POST" && req.url === "/api/level") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const previousLevel = state.level;

        const nextDistance =
          typeof data.distance_cm === "number" && Number.isFinite(data.distance_cm)
            ? data.distance_cm
            : state.distanceCm;

        const nextRawLevel = normalizeLevel(data.raw_level, state.rawLevel);
        const nextLevel = normalizeLevel(data.level, "NORMAL");

        state = {
          distanceCm: nextDistance,
          rawLevel: nextRawLevel,
          rawLevelCode: FLOOD_LEVEL_CODE[nextRawLevel],
          level: nextLevel,
          levelCode: FLOOD_LEVEL_CODE[nextLevel],
          alarmActive: nextLevel === "HIGH",
          updatedAt: new Date().toISOString(),
        };

        if (db) {
          await db.collection("floodwatch").doc("current").set(state, { merge: true });
        }

        if (
          previousLevel !== state.level &&
          (state.level === "MEDIUM" || state.level === "HIGH")
        ) {
          await sendTelegram(
            `FLOOD ALERT (${state.level} / code ${state.levelCode}): ${previousLevel} -> ${state.level} | Distance: ${state.distanceCm ?? "N/A"} cm`
          );
        }

        console.log("[LEVEL UPDATE]", state);
        sendJson(res, 200, { ok: true, state });
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
      }
    });
    return;
  }

  // For the esp32 alarm
  if (req.method === "GET" && req.url === "/api/alarm") {
    return sendJson(res, 200, {
      alarm: state.alarmActive,
      level: state.level,
      level_code: state.levelCode,
      distance_cm: state.distanceCm,
      updatedAt: state.updatedAt,
    });
  }

  // Full current state check
  if (req.method === "GET" && req.url === "/status") {
    return sendJson(res, 200, state);
  }

  sendJson(res, 404, { error: "Route not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Flood API running at http://localhost:${PORT}`);
});