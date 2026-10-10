require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sheets = require('./lib/sheets');

const DOMAINS = [
  'Documentation Domain',
  'Social Media Domain',
  'Multimedia Design Domain',
  'Video Editing Domain',
  'Human Resources Domain',
  'Decoration Domain',
  'Logistics Domain',
  'Technical Domain',
  'Sponsorship Domain',
  'Cultural Domain',
];
const ROLES = ['Core', 'Coordinator', 'Head'];

const cfg = {
  clubName: process.env.CLUB_NAME || 'Club Attendance',
  lat: Number(process.env.VENUE_LAT),
  lng: Number(process.env.VENUE_LNG),
  radius: Number(process.env.RADIUS_METERS || 75),
  maxAccuracy: Number(process.env.MAX_GPS_ACCURACY_METERS || 100),
  tz: process.env.TIMEZONE || 'Asia/Kolkata',
  port: Number(process.env.PORT || 3000),
};

if (!Number.isFinite(cfg.lat) || !Number.isFinite(cfg.lng)) {
  throw new Error('Set VENUE_LAT and VENUE_LNG in .env');
}

const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]{1,59}$/u;
// Only college mail addresses: something@vit.edu
const EMAIL_RE = /^[a-z0-9._%+-]+@vit\.edu$/i;

// Distance between two GPS points in metres
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Server-side geofence: never trust a check done only in the browser
function checkLocation(lat, lng, accuracy) {
  if (
    !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(accuracy) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180
  ) {
    return { ok: false, status: 400, code: 'BAD_LOCATION', message: 'Location data was invalid. Check your location again.' };
  }
  if (accuracy > cfg.maxAccuracy) {
    return {
      ok: false, status: 403, code: 'LOW_ACCURACY',
      message: `GPS accuracy is too low (±${Math.round(accuracy)} m). Turn on precise location, move near a window or outdoors, and check again.`,
    };
  }
  const distance = haversine(lat, lng, cfg.lat, cfg.lng);
  if (distance > cfg.radius) {
    return {
      ok: false, status: 403, code: 'OUT_OF_RANGE', distance,
      message: `You are about ${Math.round(distance)} m from the venue. Move within ${cfg.radius} m to mark attendance.`,
    };
  }
  return { ok: true, distance };
}

const inFlight = new Set();

function nowParts() {
  const d = new Date();
  const date = d.toLocaleDateString('en-CA', { timeZone: cfg.tz }); // YYYY-MM-DD
  const time = d.toLocaleTimeString('en-GB', { timeZone: cfg.tz, hour12: false });
  return { date, timestamp: `${date} ${time}` };
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self)');
  next();
});
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/api/config', (req, res) => {
  res.json({ clubName: cfg.clubName, domains: DOMAINS, roles: ROLES, radius: cfg.radius });
});

app.post('/api/check-location', (req, res) => {
  const { lat, lng, accuracy } = req.body || {};
  const r = checkLocation(lat, lng, accuracy);
  if (!r.ok) return res.status(r.status).json({ error: r.code, message: r.message });
  res.json({ ok: true, distance: r.distance });
});

app.post('/api/attendance', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const email = String(b.email || '').trim().toLowerCase();
  const domain = b.domain || 'Not specified'; // domain is optional
  const { role, lat, lng, accuracy } = b;

  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'BAD_NAME', message: 'Enter your full name (letters only).' });
  if (email.length > 100 || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'BAD_EMAIL', message: 'Use your college email address ending in @vit.edu.' });
  }
  if (domain !== 'Not specified' && !DOMAINS.includes(domain)) {
    return res.status(400).json({ error: 'BAD_DOMAIN', message: 'Choose a domain from the list, or leave it empty.' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'BAD_ROLE', message: 'Choose your position.' });

  const loc = checkLocation(lat, lng, accuracy);
  if (!loc.ok) return res.status(loc.status).json({ error: loc.code, message: loc.message });

  if (inFlight.has(email)) {
    return res.status(409).json({ error: 'BUSY', message: 'Your attendance is already being processed.' });
  }
  inFlight.add(email);

  try {
    const { date, timestamp } = nowParts();
    if (await sheets.hasAttended(date, email)) {
      return res.status(409).json({ error: 'ALREADY_MARKED', message: 'You have already marked attendance today.' });
    }
    const status = 'Present';
    await sheets.appendAttendance({
      timestamp, date, email, name, domain, role,
      lat, lng, status, distance: loc.distance,
    });
    res.json({ ok: true, status, name, email, timestamp, distance: Math.round(loc.distance) });
  } catch (err) {
    console.error('attendance error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not save attendance. Try again in a moment.' });
  } finally {
    inFlight.delete(email);
  }
});

(async () => {
  await sheets.init();
  app.listen(cfg.port, () => {
    console.log(`Attendance app on http://localhost:${cfg.port}`);
  });
})().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
