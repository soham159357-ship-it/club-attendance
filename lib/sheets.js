const { google } = require('googleapis');

const ATT = 'Attendance';

// Columns A-F are the ones the club asked for; G-L are helpers.
// Column I holds the college email. J-L are used to spot one device marking several people.
const ATT_HEADERS = [
  'Timestamp',
  'Full Name',
  'Domain Name',
  'Position / Role',
  'Geolocation',
  'Attendance Status',
  'Distance from venue (m)',
  'Date',
  'Email',
  'Device ID',
  'Device settings',
  'Review flag',
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

// Creates the Attendance tab if missing and keeps the header row up to date
async function init() {
  const s = client();
  const meta = await s.spreadsheets.get({ spreadsheetId: spreadsheetId() });
  const titles = meta.data.sheets.map((x) => x.properties.title);
  if (!titles.includes(ATT)) {
    await s.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        requests: [{ addSheet: { properties: { title: ATT, gridProperties: { frozenRowCount: 1 } } } }],
      },
    });
  }
  await s.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${ATT}!A1:L1`,
    valueInputOption: 'RAW',
    requestBody: { values: [ATT_HEADERS] },
  });
}

// All of today's rows: who marked, and from which device
async function getToday(date) {
  const r = await client().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${ATT}!H2:K`,
  });
  return (r.data.values || [])
    .filter((v) => v[0] === date)
    .map((v) => ({
      email: String(v[1] || '').toLowerCase(),
      device: v[2] || '',
      fp: v[3] || '',
    }));
}

async function appendAttendance({ timestamp, date, email, name, domain, role, lat, lng, status, distance, deviceHash, fpHash, flag }) {
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
    email,
    deviceHash ? `'${deviceHash}` : '',
    fpHash ? `'${fpHash}` : '',
    flag || '',
  ];
  await client().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `${ATT}!A:L`,
    valueInputOption: 'USER_ENTERED', // needed for the HYPERLINK formula
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

module.exports = { init, getToday, appendAttendance };
