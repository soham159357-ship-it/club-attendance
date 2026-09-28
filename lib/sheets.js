const { google } = require('googleapis');

const ATT = 'Attendance';
const FACES = 'Faces';

// First six columns are the ones the club asked for; the rest are helpers.
const ATT_HEADERS = [
  'Timestamp',
  'Full Name',
  'Domain Name',
  'Position / Role',
  'Geolocation',
  'Attendance Status',
  'Distance from venue (m)',
  'Date',
  'User ID',
];
const FACE_HEADERS = [
  'User ID',
  'Full Name',
  'Domain Name',
  'Position / Role',
  'Enrolled At',
  'Encrypted Face Data',
];

let api;
function client() {
  if (!api) {
    const auth = new google.auth.JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    api = google.sheets({ version: 'v4', auth });
  }
  return api;
}
const spreadsheetId = () => process.env.GOOGLE_SHEET_ID;

function colLetter(n) {
  return String.fromCharCode(64 + n); // A..Z is enough here
}

async function ensureHeaders(tab, headers) {
  const s = client();
  const r = await s.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${tab}!A1:A1`,
  });
  if (!r.data.values) {
    await s.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${tab}!A1:${colLetter(headers.length)}1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
  }
}

// Creates the two tabs and header rows if they are missing
async function init() {
  const s = client();
  const meta = await s.spreadsheets.get({ spreadsheetId: spreadsheetId() });
  const titles = meta.data.sheets.map((x) => x.properties.title);
  const missing = [ATT, FACES].filter((t) => !titles.includes(t));
  if (missing.length) {
    await s.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        requests: missing.map((title) => ({
          addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } },
        })),
      },
    });
  }
  await ensureHeaders(ATT, ATT_HEADERS);
  await ensureHeaders(FACES, FACE_HEADERS);
}

async function loadFaces() {
  const r = await client().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${FACES}!A2:F`,
  });
  return (r.data.values || []).map(([userId, name, domain, role, enrolledAt, data]) => ({
    userId,
    name,
    domain,
    role,
    enrolledAt,
    data,
  }));
}

async function addFace(row) {
  await client().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${FACES}!A:F`,
    valueInputOption: 'RAW', // keep the encrypted blob exactly as written
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

async function hasAttended(date, userId) {
  const r = await client().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${ATT}!H2:I`,
  });
  return (r.data.values || []).some((v) => v[0] === date && v[1] === userId);
}

async function appendAttendance({ timestamp, date, userId, name, domain, role, lat, lng, status, distance }) {
  const mapLink = `=HYPERLINK("https://www.google.com/maps?q=${lat},${lng}","${lat.toFixed(6)}, ${lng.toFixed(6)}")`;
  // A leading apostrophe stops Sheets from re-parsing text as dates/numbers
  const row = [
    `'${timestamp}`,
    name,
    domain,
    role,
    mapLink,
    status,
    Math.round(distance),
    `'${date}`,
    `'${userId}`,
  ];
  await client().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${ATT}!A:I`,
    valueInputOption: 'USER_ENTERED', // needed for the HYPERLINK formula
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

module.exports = { init, loadFaces, addFace, hasAttended, appendAttendance };
