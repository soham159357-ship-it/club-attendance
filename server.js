require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
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
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
};

if (!Number.isFinite(cfg.lat) || !Number.isFinite(cfg.lng)) {
  throw new Error('Set VENUE_LAT and VENUE_LNG in .env');
}
if (!cfg.googleClientId) {
  throw new Error('Set GOOGLE_CLIENT_ID (the OAuth client ID from Google Cloud)');
}

const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]{1,59}$/u;
// Only college mail addresses: something@vit.edu
const EMAIL_RE = /^[a-z0-9._%+-]+@vit\.edu$/i;

// ---- Sign in with Google: the server checks the token itself ----
const oauth = new OAuth2Client(cfg.googleClientId);

async function verifyGoogle(credential) {
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  if (typeof credential !== 'string' || credential.length < 50 || credential.length > 5000) {
    return fail(401, 'AUTH_FAILED', 'Please sign in with your college Google account.');
  }
  try {
    const ticket = await oauth.verifyIdToken({ idToken: credential, audience: cfg.googleClientId });
    const p = ticket.getPayload() || {};
    const email = String(p.email || '').toLowerCase();
    if (!p.email_verified) {
      return fail(403, 'BAD_EMAIL', 'Your Google email is not verified. Sign in with your college account.');
    }
    if (!EMAIL_RE.test(email) || (p.hd && String(p.hd).toLowerCase() !== 'vit.edu')) {
      return fail(403, 'BAD_EMAIL', 'Please sign in with your college Google account ending in @vit.edu.');
    }
    return { ok: true, email, name: String(p.name || '').trim() };
  } catch (e) {
    return fail(401, 'AUTH_FAILED', 'Your sign-in expired or was not accepted. Please sign in again.');
  }
}

// ---- Device recognition (one phone marking attendance for several people) ----
// Each browser gets a random ID, kept in a cookie AND in the page's local storage.
// We store only a short hash of it in the sheet.
const ID_RE = /^[a-f0-9]{32}$/;
const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function readCookie(req, name) {
  const part = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  if (!part) return '';
  try { return decodeURIComponent(part.slice(name.length + 1)); } catch (_) { return ''; }
}

function identifyDevice(req, res, bodyId) {
  const cookieId = ID_RE.test(readCookie(req, 'did')) ? readCookie(req, 'did') : '';
  const storedId = ID_RE.test(String(bodyId || '')) ? String(bodyId) : '';
  const primary = cookieId || storedId || crypto.randomBytes(16).toString('hex');
  res.cookie('did', primary, {
    maxAge: 365 * 24 * 3600 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
  });
  // Check every ID this browser presents, so clearing only one of the two does not help
  const all = [...new Set([cookieId, storedId, primary].filter(Boolean))].map(hashOf);
  return { primary, primaryHash: hashOf(primary), allHashes: all };
}

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
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // needed for the Google sign-in popup
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self)');
  next();
});
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/api/config', (req, res) => {
  res.json({ clubName: cfg.clubName, domains: DOMAINS, roles: ROLES, radius: cfg.radius, clientId: cfg.googleClientId });
});

app.post('/api/auth', async (req, res) => {
  const v = await verifyGoogle((req.body || {}).credential);
  if (!v.ok) return res.status(v.status).json({ error: v.code, message: v.message });
  res.json({ ok: true, email: v.email, name: v.name });
});

app.post('/api/check-location', (req, res) => {
  const { lat, lng, accuracy } = req.body || {};
  const r = checkLocation(lat, lng, accuracy);
  if (!r.ok) return res.status(r.status).json({ error: r.code, message: r.message });
  res.json({ ok: true, distance: r.distance });
});

app.post('/api/attendance', async (req, res) => {
  const b = req.body || {};
  const who = await verifyGoogle(b.credential);
  if (!who.ok) return res.status(who.status).json({ error: who.code, message: who.message });
  const email = who.email; // verified by Google, never taken from the form
  const name = String(b.name || who.name || '').trim().replace(/\s+/g, ' ');
  const domain = b.domain || 'Not specified'; // domain is optional
  const { role, lat, lng, accuracy } = b;
  const fpHash = b.fp ? hashOf(String(b.fp).slice(0, 400)) : '';
  const device = identifyDevice(req, res, b.deviceId);

  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'BAD_NAME', message: 'Enter your full name (letters only).' });
  if (domain !== 'Not specified' && !DOMAINS.includes(domain)) {
    return res.status(400).json({ error: 'BAD_DOMAIN', message: 'Choose a domain from the list, or leave it empty.' });
  }
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'BAD_ROLE', message: 'Choose your position.' });

  const loc = checkLocation(lat, lng, accuracy);
  if (!loc.ok) return res.status(loc.status).json({ error: loc.code, message: loc.message });

  const lockKeys = [`e:${email}`, `d:${device.primaryHash}`];
  if (lockKeys.some((k) => inFlight.has(k))) {
    return res.status(409).json({ error: 'BUSY', message: 'Your attendance is already being processed.' });
  }
  lockKeys.forEach((k) => inFlight.add(k));

  try {
    const { date, timestamp } = nowParts();
    const today = await sheets.getToday(date);

    if (today.some((r) => r.email === email)) {
      return res.status(409).json({ error: 'ALREADY_MARKED', message: 'You have already marked attendance today.' });
    }
    // Same device, different person, same day -> blocked
    if (today.some((r) => r.device && device.allHashes.includes(r.device) && r.email !== email)) {
      return res.status(409).json({
        error: 'DEVICE_USED',
        message: 'This device has already been used to mark attendance for someone else today. Each person must use their own phone. Ask a club head if this is a mistake.',
      });
    }
    // Same phone model/settings as another entry today -> allowed, but marked for a head to review
    const flag = fpHash && today.some((r) => r.fp && r.fp === fpHash && r.email !== email)
      ? 'Same device settings as another entry today - please review'
      : '';

    const status = 'Present';
    await sheets.appendAttendance({
      timestamp, date, email, name, domain, role,
      lat, lng, status, distance: loc.distance,
      deviceHash: device.primaryHash, fpHash, flag,
    });
    res.json({ ok: true, status, name, email, timestamp, distance: Math.round(loc.distance), deviceId: device.primary });
  } catch (err) {
    console.error('attendance error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not save attendance. Try again in a moment.' });
  } finally {
    lockKeys.forEach((k) => inFlight.delete(k));
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
