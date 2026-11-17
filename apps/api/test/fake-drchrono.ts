// A minimal fake of the DrChrono API v4, built from its documentation, for contract tests.
// Times are clinic-local naive strings like DrChrono's ("2030-01-07T09:00:00").
import type { AddressInfo } from 'node:net';
import express from 'express';

export interface FakeAppointment {
  id: number;
  doctor: number;
  patient: number | null;
  office: number;
  exam_room: number;
  profile: number | null;
  scheduled_time: string;
  duration: number;
  status: string;
  updated_at: string;
  deleted_flag?: boolean;
  appt_is_break?: boolean;
}

export interface FakeDrChrono {
  baseUrl: string;
  appointments: FakeAppointment[];
  requests: { method: string; path: string; body: unknown; auth: string | undefined }[];
  /** Make the current access token invalid (forces a refresh). */
  expireAccessToken(): void;
  close(): Promise<void>;
}

export async function startFakeDrChrono(): Promise<FakeDrChrono> {
  let accessToken = 'access-1';
  let refreshToken = 'refresh-1';
  let tokenSerial = 1;
  let nextId = 1000;
  const appointments: FakeAppointment[] = [];
  const requests: FakeDrChrono['requests'] = [];
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.post('/o/token/', (req, res) => {
    const body = req.body as Record<string, string>;
    const okCode = body.grant_type === 'authorization_code' && body.code === 'good-code';
    const okRefresh = body.grant_type === 'refresh_token' && body.refresh_token === refreshToken;
    if (
      body.client_id !== 'client-id' ||
      body.client_secret !== 'client-secret' ||
      (!okCode && !okRefresh)
    ) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    tokenSerial++;
    accessToken = `access-${String(tokenSerial)}`;
    refreshToken = `refresh-${String(tokenSerial)}`;
    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 172_800,
      token_type: 'Bearer',
    });
  });

  app.use('/api', (req, res, next) => {
    requests.push({
      method: req.method,
      path: req.originalUrl,
      body: req.body,
      auth: req.get('authorization'),
    });
    if (req.get('authorization') !== `Bearer ${accessToken}`) {
      res.status(401).json({ detail: 'Invalid token' });
      return;
    }
    next();
  });

  /** Cursor pagination: 2 per page; alternate `results`/`data` keys (the docs mention both). */
  const page = (req: express.Request, res: express.Response, items: unknown[]) => {
    const cursor = Number(req.query.cursor ?? 0);
    const slice = items.slice(cursor, cursor + 2);
    const rest = new URLSearchParams(req.query as Record<string, string>);
    rest.set('cursor', String(cursor + 2));
    const next =
      cursor + 2 < items.length
        ? `${baseUrl}${req.path.startsWith('/api') ? '' : '/api'}${req.baseUrl}${req.path}?${rest.toString()}`
        : null;
    res.json({ previous: null, next, [cursor % 4 === 0 ? 'results' : 'data']: slice });
  };

  app.get('/api/offices', (req, res) => {
    page(req, res, [{ id: 77, name: 'Main office', exam_rooms: [{ index: 3, name: 'Room 3' }] }]);
  });
  app.get('/api/doctors', (req, res) => {
    page(req, res, [
      { id: 501, first_name: 'Ada', last_name: 'Lovelace' },
      { id: 502, first_name: 'Grace', last_name: 'Hopper' },
    ]);
  });
  app.get('/api/appointment_profiles', (req, res) => {
    page(req, res, [{ id: 9, name: 'Follow-up', duration: 30 }]);
  });
  app.get('/api/patients/:id', (req, res) => {
    const patients: Record<string, unknown> = {
      '7001': { id: 7001, first_name: 'Pat', last_name: 'Example', cell_phone: '(555) 123-4567' },
      '7002': { id: 7002, first_name: 'Leo', last_name: 'Nophone', cell_phone: '' },
    };
    const p = patients[req.params.id];
    if (p) res.json(p);
    else res.status(404).json({ detail: 'Not found' });
  });
  app.get('/api/appointments', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (!q.date_range && !q.since && !q.date) {
      res.status(400).json({ detail: 'date, date_range or since required' });
      return;
    }
    const day = (a: FakeAppointment) => a.scheduled_time.slice(0, 10);
    const [from, to] = (q.date_range ?? '').split('/');
    const items = appointments.filter(
      (a) =>
        (!q.date_range ||
          (from !== undefined && to !== undefined && day(a) >= from && day(a) <= to)) &&
        (!q.since || a.updated_at.slice(0, 10) >= q.since) &&
        (!q.date || day(a) === q.date) &&
        (!q.doctor || String(a.doctor) === q.doctor),
    );
    page(req, res, items);
  });
  app.post('/api/appointments', (req, res) => {
    const b = req.body as Partial<FakeAppointment>;
    for (const field of ['doctor', 'exam_room', 'office', 'patient', 'scheduled_time'] as const) {
      if (b[field] === undefined) {
        res.status(400).json({ [field]: ['This field is required.'] });
        return;
      }
    }
    const created: FakeAppointment = {
      id: nextId++,
      doctor: Number(b.doctor),
      patient: Number(b.patient),
      office: Number(b.office),
      exam_room: Number(b.exam_room),
      profile: b.profile ?? null,
      scheduled_time: String(b.scheduled_time),
      duration: b.duration ?? 30,
      status: '',
      updated_at: new Date().toISOString(),
    };
    appointments.push(created);
    res.status(201).json(created);
  });
  app.patch('/api/appointments/:id', (req, res) => {
    const a = appointments.find((x) => String(x.id) === req.params.id);
    if (!a) {
      res.status(404).json({ detail: 'Not found' });
      return;
    }
    Object.assign(a, req.body, { updated_at: new Date().toISOString() });
    res.status(204).end();
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      resolve();
    });
  });
  const baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  return {
    baseUrl,
    appointments,
    requests,
    expireAccessToken: () => {
      accessToken = `access-rotated-${String(tokenSerial)}`;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
