require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sheets = require('./lib/sheets');
const { encrypt, decrypt, haversine, euclid, mean, safeEqual } = require('./lib/security');

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
  threshold: Number(process.env.FACE_MATCH_THRESHOLD || 0.5),
  tz: process.env.TIMEZONE || 'Asia/Kolkata',
  enrollCode: process.env.ENROLL_CODE || '',
  port: Number(process.env.PORT || 3000),
};

if (!Number.isFinite(cfg.lat) || !Number.isFinite(cfg.lng)) {
  throw new Error('Set VENUE_LAT and VENUE_LNG in .env');
}
if (!cfg.enrollCode) throw new Error('Set ENROLL_CODE in .env');

// In-memory cache of enrolled faces (loaded from the Faces sheet at startup)
const faces = new Map(); // userId -> { name, domain, role, descriptor }

const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]{1,59}$/u;
const normId = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

function validDescriptors(list, min, max) {
  return (
    Array.isArray(list) &&
    list.length >= min &&
    list.length <= max &&
    list.every((d) => Array.isArray(d) && d.length === 128 && d.every((n) => Number.isFinite(n)))
  );
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

// Lock a name for 10 minutes after 5 failed face checks
const failures = new Map();
function isLocked(id) {
  const f = failures.get(id);
  return f && f.until > Date.now();
}
function recordFailure(id) {
  const f = failures.get(id) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) {
    f.until = Date.now() + 10 * 60 * 1000;
    f.count = 0;
  }
  failures.set(id, f);
}

const inFlight = new Set();

function nowParts() {
  const d = new Date();
  const date = d.toLocaleDateString('en-CA', { timeZone: cfg.tz }); // YYYY-MM-DD
  const time = d.toLocaleTimeString('en-GB', { timeZone: cfg.tz, hour12: false });
  return { date, timestamp: `${date} ${time}`, iso: d.toISOString() };
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // CDN scripts + TF.js need a looser CSP
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self)');
  next();
});
app.use(express.json({ limit: '50kb' }));
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

app.post('/api/status', (req, res) => {
  const name = String((req.body || {}).name || '');
  if (!NAME_RE.test(name.trim())) return res.status(400).json({ error: 'BAD_NAME', message: 'Enter your full name.' });
  res.json({ enrolled: faces.has(normId(name)) });
});

app.post('/api/attendance', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const { domain, role, lat, lng, accuracy, descriptors, enrollCode, consent } = b;

  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'BAD_NAME', message: 'Enter your full name (letters only).' });
  if (!DOMAINS.includes(domain)) return res.status(400).json({ error: 'BAD_DOMAIN', message: 'Choose your domain.' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'BAD_ROLE', message: 'Choose your position.' });
  if (!validDescriptors(descriptors, 1, 5)) return res.status(400).json({ error: 'BAD_FACE', message: 'Face scan was invalid. Scan again.' });

  const loc = checkLocation(lat, lng, accuracy);
  if (!loc.ok) return res.status(loc.status).json({ error: loc.code, message: loc.message });

  const userId = normId(name);
  if (isLocked(userId)) {
    return res.status(429).json({ error: 'LOCKED', message: 'Too many failed face checks. Try again in 10 minutes or ask a club head.' });
  }
  if (inFlight.has(userId)) {
    return res.status(409).json({ error: 'BUSY', message: 'Your attendance is already being processed.' });
  }
  inFlight.add(userId);

  try {
    const { date, timestamp, iso } = nowParts();
    const existing = faces.get(userId);
    let status;

    if (existing) {
      const best = Math.min(...descriptors.map((d) => euclid(d, existing.descriptor)));
      if (best > cfg.threshold) {
        recordFailure(userId);
        return res.status(401).json({
          error: 'FACE_MISMATCH',
          message: 'Your face did not match the registered face for this name. Improve the lighting and scan again.',
        });
      }
      failures.delete(userId);
      if (await sheets.hasAttended(date, userId)) {
        return res.status(409).json({ error: 'ALREADY_MARKED', message: 'You have already marked attendance today.' });
      }
      status = 'Verified';
    } else {
      // First visit: enrollment
      if (!safeEqual(enrollCode || '', cfg.enrollCode)) {
        return res.status(403).json({ error: 'BAD_ENROLL_CODE', message: 'Enrollment code is wrong. Ask a club head for it.' });
      }
      if (consent !== true) {
        return res.status(400).json({ error: 'NO_CONSENT', message: 'Tick the consent box to register your face.' });
      }
      if (!validDescriptors(descriptors, 3, 5)) {
        return res.status(400).json({ error: 'BAD_FACE', message: 'Registration needs a full scan. Scan again.' });
      }
      // The frames must belong to one stable face
      for (let i = 0; i < descriptors.length; i++) {
        for (let j = i + 1; j < descriptors.length; j++) {
          if (euclid(descriptors[i], descriptors[j]) > 0.45) {
            return res.status(422).json({ error: 'UNSTABLE_FACE', message: 'The scan was unclear. Hold still, face the camera, and scan again.' });
          }
        }
      }
      const avg = mean(descriptors);
      // Block one person registering under someone else's name
      for (const f of faces.values()) {
        if (euclid(avg, f.descriptor) < cfg.threshold) {
          return res.status(409).json({ error: 'FACE_ALREADY_ENROLLED', message: 'This face is already registered under a different name. Ask a club head for help.' });
        }
      }
      await sheets.addFace([userId, name, domain, role, iso, encrypt(avg)]);
      faces.set(userId, { name, domain, role, descriptor: avg });
      status = 'Verified (new registration)';
    }

    await sheets.appendAttendance({
      timestamp, date, userId, name, domain, role,
      lat, lng, status, distance: loc.distance,
    });
    res.json({ ok: true, status, name, timestamp, distance: Math.round(loc.distance) });
  } catch (err) {
    console.error('attendance error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not save attendance. Try again in a moment.' });
  } finally {
    inFlight.delete(userId);
  }
});

(async () => {
  await sheets.init();
  for (const row of await sheets.loadFaces()) {
    try {
      faces.set(row.userId, { name: row.name, domain: row.domain, role: row.role, descriptor: decrypt(row.data) });
    } catch (e) {
      console.warn(`Skipping unreadable face row for "${row.userId}" (wrong ENCRYPTION_KEY?)`);
    }
  }
  app.listen(cfg.port, () => {
    console.log(`Attendance app on http://localhost:${cfg.port}  |  ${faces.size} faces loaded`);
  });
})().catch((e) => {
  console.error('Startup failed:', e.message);
  process.exit(1);
});
