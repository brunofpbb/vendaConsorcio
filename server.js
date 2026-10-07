require('dotenv').config();

const express = require('express');
const path = require('path');
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');
const safeText = (v, max = 250) => String(v ?? '').trim().slice(0, max);
const money = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const prev = Array.from({ length: t.length + 1 }, (_, i) => i);

  for (let i = 1; i <= s.length; i++) {
    let left = i;
    let diagonal = i - 1;
    for (let j = 1; j <= t.length; j++) {
      const up = prev[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      const current = Math.min(up + 1, left + 1, diagonal + cost);
      prev[j] = current;
      diagonal = up;
      left = current;
    }
  }
  return prev[t.length];
}

function isInstitutionalEmail(emailValue) {
  const email = safeText(emailValue || '', 160).toLowerCase();
  if (!email.includes('@')) return false;

  const domain = email.split('@').pop();
  const labels = domain.split('.')
    .map(x => x.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);

  const target = 'turintransportes';
  return labels.some(label =>
    label.includes(target) ||
    (
      Math.abs(label.length - target.length) <= 2 &&
      levenshtein(label, target) <= 2
    )
  );
}

function isValidPersonalEmail(emailValue) {
  const email = safeText(emailValue || '', 160).toLowerCase();
  return isEmail(email) && !isInstitutionalEmail(email);
}

function isValidPhone(phoneValue) {
  const phone = onlyDigits(phoneValue || '');
  return phone.length >= 10 && phone.length <= 11;
}

function contactUpdateRequired(emailValue, phoneValue) {
  return !isValidPersonalEmail(emailValue) || !isValidPhone(phoneValue);
}


async function findStoredContactByCpf(cpf) {
  const spreadsheetId = process.env.SHEETS_RECHARGE_ID;
  if (!spreadsheetId) return { email: '', phone: '' };

  try {
    const sheets = sheetsClient();
    const rechargeTab = await getRechargeTab(sheets, spreadsheetId);
    const customersTab = safeText(process.env.SHEETS_CUSTOMERS_TAB || 'Clientes_Cadastrados', 120);

    const [rechargeRes, customerRes] = await Promise.all([
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: sheetRange(rechargeTab, 'A:S')
      }),
      sheets.spreadsheets.values.get({
        spreadsheetId,
        range: sheetRange(customersTab, 'A:F')
      }).catch(() => ({ data: { values: [] } }))
    ]);

    let email = '';
    let phone = '';

    // Solicitação Recarga:
    // D=telefone, E=e-mail, F=CPF. Varre de baixo para cima para priorizar o cadastro mais recente.
    const rechargeRows = rechargeRes.data.values || [];
    for (let i = rechargeRows.length - 1; i >= 1 && (!email || !phone); i--) {
      const row = rechargeRows[i] || [];
      if (onlyDigits(row[5]) !== cpf) continue;

      const rowEmail = safeText(row[4] || '', 160).replace(/^'/, '').toLowerCase();
      const rowPhone = onlyDigits(row[3] || '');

      if (!email && isValidPersonalEmail(rowEmail)) email = rowEmail;
      if (!phone && isValidPhone(rowPhone)) phone = rowPhone;
    }

    // Clientes_Cadastrados:
    // C=telefone, D=e-mail, E=CPF. Também prioriza a linha mais recente.
    const customerRows = customerRes.data.values || [];
    for (let i = customerRows.length - 1; i >= 1 && (!email || !phone); i--) {
      const row = customerRows[i] || [];
      if (onlyDigits(row[4]) !== cpf) continue;

      const rowEmail = safeText(row[3] || '', 160).replace(/^'/, '').toLowerCase();
      const rowPhone = onlyDigits(row[2] || '');

      if (!email && isValidPersonalEmail(rowEmail)) email = rowEmail;
      if (!phone && isValidPhone(rowPhone)) phone = rowPhone;
    }

    return { email, phone };
  } catch (_) {
    // O histórico é apenas complemento. Falha no Sheets não deve impedir a consulta TACOM.
    return { email: '', phone: '' };
  }
}

/* ========================= TACOM ========================= */

const TACOM_BASE_URL = (process.env.TACOM_BASE_URL || 'https://api.tacom.srv.br').replace(/\/$/, '');
let tacomTokenCache = { token: '', expiresAt: 0 };
let tacomLoginPromise = null;

async function getTacomToken(force = false) {
  const now = Date.now();
  if (!force && tacomTokenCache.token && now < tacomTokenCache.expiresAt) {
    return tacomTokenCache.token;
  }
  if (!force && tacomLoginPromise) return tacomLoginPromise;

  tacomLoginPromise = (async () => {
    const username = process.env.TACOM_USERNAME;
    const password = process.env.TACOM_PASSWORD;
    if (!username || !password) throw new Error('Credenciais TACOM não configuradas.');

    const r = await fetch(`${TACOM_BASE_URL}/authentication/v1/auth2/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const raw = await r.text();
    let j = {};
    try { j = raw ? JSON.parse(raw) : {}; } catch (_) {}

    if (!r.ok) throw new Error(j?.message || j?.mensagem || `Falha no login TACOM (${r.status})`);

    const token = j.access_token || j.accessToken || j.token || j?.data?.access_token || j?.data?.accessToken;
    if (!token) throw new Error('TACOM não retornou access_token.');

    const expiresIn = Number(j.expires_in || j.expiresIn || 1800);
    const ttlMs = Math.max(60, expiresIn - 60) * 1000;
    tacomTokenCache = { token, expiresAt: Date.now() + ttlMs };
    return token;
  })();

  try {
    return await tacomLoginPromise;
  } finally {
    tacomLoginPromise = null;
  }
}

async function fetchTacomCards(cpf, retry = true) {
  const token = await getTacomToken();

  async function callCards(url) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    const raw = await response.text();
    let json = {};
    try { json = raw ? JSON.parse(raw) : {}; } catch (_) {}
    return { response, raw, json, url };
  }

  // Endpoint TACOM confirmado: o CPF deve ser seguido por /0
  // Ex.: /citsoa-cartao/v1/citsbe/cartao/10522997686/0
  const cardsUrl = `${TACOM_BASE_URL}/citsoa-cartao/v1/citsbe/cartao/${encodeURIComponent(cpf)}/0`;

  let result = await callCards(cardsUrl);

  if (result.response.status === 401 && retry) {
    tacomTokenCache = { token: '', expiresAt: 0 };
    await getTacomToken(true);
    return fetchTacomCards(cpf, false);
  }

  const { response: r, raw, json: j, url } = result;

  if (!r.ok) {
    console.error('[TACOM][cards]', {
      status: r.status,
      body: raw.slice(0, 500)
    });
    const err = new Error(j?.mensagemDeErro || j?.message || j?.error || `Falha na consulta TACOM (${r.status})`);
    err.statusCode = r.status;
    throw err;
  }

  return j;
}

app.post('/api/cards/search', async (req, res) => {
  try {
    const cpf = onlyDigits(req.body?.cpf);
    if (cpf.length !== 11) {
      return res.status(400).json({ ok: false, message: 'Informe um CPF com 11 dígitos.' });
    }

    const result = await fetchTacomCards(cpf);
    const source = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : []);
    const eligible = source.filter(x => String(x?.codigoExternoCartao || '').startsWith('0362'));

    if (!eligible.length) {
      return res.status(404).json({
        ok: false,
        code: 'NO_ELIGIBLE_CARD',
        message: 'Não encontramos cartão habilitado para recarga vinculado a este CPF.'
      });
    }

    // Primeiro aproveita os dados válidos retornados pela TACOM.
    let bestEmail = eligible
      .map(x => safeText(x.email || '', 160).toLowerCase())
      .find(isValidPersonalEmail) || '';

    let bestPhone = eligible
      .map(x => onlyDigits(x.telefone || ''))
      .find(isValidPhone) || '';

    // Se a TACOM estiver incompleta, reaproveita o contato válido já usado
    // anteriormente nas abas do Sheets para não pedir ao cliente o mesmo dado novamente.
    if (!bestEmail || !bestPhone) {
      const storedContact = await findStoredContactByCpf(cpf);
      if (!bestEmail && storedContact.email) bestEmail = storedContact.email;
      if (!bestPhone && storedContact.phone) bestPhone = storedContact.phone;
    }

    const needsContactUpdate = !bestEmail || !bestPhone;

    const cards = eligible.map(x => ({
      cardNumber: safeText(x.codigoExternoCartao, 40),
      name: safeText(x.nomeDependente || x.nome || '', 120),
      cpf: onlyDigits(x.cpf || cpf),
      email: bestEmail,
      phone: bestPhone,
      balance: x.saldoCartao ?? null,
      balanceDate: safeText(x.dataSaldo || '', 40),
      contactUpdateRequired: needsContactUpdate
    }));

    res.json({
      ok: true,
      cards,
      contact: {
        email: bestEmail,
        phone: bestPhone,
        updateRequired: needsContactUpdate
      }
    });
  } catch (e) {
    console.error('[TACOM]', e);
    if (e?.statusCode === 404) {
      return res.status(404).json({
        ok: false,
        code: 'TACOM_NOT_FOUND',
        message: 'Não encontramos cartão habilitado para recarga vinculado a este CPF.'
      });
    }
    res.status(502).json({
      ok: false,
      message: 'Não foi possível consultar os cartões agora. Tente novamente.'
    });
  }
});

/* ================= ATUALIZAÇÃO CADASTRAL ================= */

async function appendCustomerRegistration({ cpf, name, phone, email, cards }) {
  const spreadsheetId = process.env.SHEETS_RECHARGE_ID;
  if (!spreadsheetId) throw new Error('SHEETS_RECHARGE_ID não configurado.');

  const sheets = sheetsClient();
  const tab = safeText(process.env.SHEETS_CUSTOMERS_TAB || 'Clientes_Cadastrados', 120);

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title'
  });
  const titles = (meta.data.sheets || []).map(x => x?.properties?.title).filter(Boolean);
  if (!titles.includes(tab)) {
    throw new Error(`Aba de clientes "${tab}" não encontrada na planilha.`);
  }

  const cardList = Array.isArray(cards) && cards.length ? cards : [''];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetRange(tab, 'A:F'),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: cardList.map(cardNumber => [
        asSheetText(nowBr()),
        safeText(name, 120),
        asSheetText(onlyDigits(phone)),
        safeText(email, 160),
        asSheetText(onlyDigits(cpf)),
        asSheetText(safeText(cardNumber, 40))
      ])
    }
  });
}

app.post('/api/customer/update', async (req, res) => {
  try {
    const cpf = onlyDigits(req.body?.cpf);
    const email = safeText(req.body?.email, 160).toLowerCase();
    const phone = onlyDigits(req.body?.phone);
    const name = safeText(req.body?.name, 120);
    const cards = Array.isArray(req.body?.cards)
      ? [...new Set(req.body.cards.map(x => safeText(x, 40)).filter(Boolean))]
      : [];

    if (cpf.length !== 11) {
      return res.status(400).json({ ok: false, message: 'CPF inválido.' });
    }
    if (!isValidPersonalEmail(email)) {
      return res.status(400).json({ ok: false, message: 'Informe um e-mail pessoal válido.' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ ok: false, message: 'Informe um telefone válido com DDD.' });
    }
    if (!name || !cards.length) {
      return res.status(400).json({
        ok: false,
        message: 'Não foi possível identificar os dados consultados. Consulte o CPF novamente.'
      });
    }

    // Não consulta novamente a TACOM aqui. Os cartões/nome vieram da consulta
    // imediatamente anterior; a atualização preenchida pelo cliente é gravada
    // para tratamento manual do operador e o fluxo de recarga segue normalmente.
    await appendCustomerRegistration({ cpf, name, phone, email, cards });

    return res.json({
      ok: true,
      customer: { cpf, name, phone, email },
      cards
    });
  } catch (e) {
    console.error('[Customer update]', e);
    return res.status(500).json({
      ok: false,
      message: 'Não foi possível salvar a atualização cadastral. Tente novamente.'
    });
  }
});

/* ====================== MERCADO PAGO ====================== */

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || '';
const mp = MP_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN }) : null;
const payments = mp ? new Payment(mp) : null;

app.get('/api/mp/pubkey', (_req, res) => res.json({ publicKey: MP_PUBLIC_KEY }));

async function mpGetPayment(id) {
  if (!payments) throw new Error('Mercado Pago não configurado.');
  return payments.get({ id: String(id) });
}

/* ====================== GOOGLE SHEETS ====================== */

const SHEET_HEADERS = [
  'Data/hora Solicitação', 'At.', 'Nome', 'Telefone', 'Endereço de e-mail', 'CPF',
  'Número do Cartão', 'Valor', 'Data/hora_Pagamento', 'Lançado?', 'Nome Pagador',
  'CPF Pagador', 'ID Transação', 'correlationID', 'idURL', 'Referencia',
  'Forma_Pagamento', 'idUser', 'Transação_ID'
];

function nowBr() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type)?.value || '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

const asSheetText = value => {
  const v = String(value ?? '');
  return v ? `'${v}` : '';
};

function sheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado.');
  const key = JSON.parse(raw);
  const auth = new google.auth.JWT(
    key.client_email,
    null,
    String(key.private_key || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

let resolvedRechargeTab = null;

async function getRechargeTab(sheets, spreadsheetId) {
  if (resolvedRechargeTab) return resolvedRechargeTab;

  const configured = safeText(process.env.SHEETS_RECHARGE_TAB || 'Recargas', 120);
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title'
  });

  const titles = (meta.data.sheets || [])
    .map(x => x?.properties?.title)
    .filter(Boolean);

  if (!titles.length) throw new Error('A planilha não possui nenhuma aba.');

  if (titles.includes(configured)) {
    resolvedRechargeTab = configured;
  } else {
    resolvedRechargeTab = titles[0];
    console.warn('[Sheets] Aba configurada não encontrada; usando a primeira aba.', {
      configured,
      resolved: resolvedRechargeTab
    });
  }

  return resolvedRechargeTab;
}

const sheetRange = (tab, range) => `'${String(tab).replace(/'/g, "''")}'!${range}`;

async function ensureSheetHeader() {
  const spreadsheetId = process.env.SHEETS_RECHARGE_ID;
  if (!spreadsheetId) throw new Error('SHEETS_RECHARGE_ID não configurado.');

  const sheets = sheetsClient();
  const tab = await getRechargeTab(sheets, spreadsheetId);
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(tab, 'A1:S1')
  });

  const first = r.data.values?.[0] || [];
  if (!first.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: sheetRange(tab, 'A1:S1'),
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] }
    });
  }

  return { sheets, spreadsheetId, tab };
}

async function appendRecharge(row) {
  const { sheets, spreadsheetId, tab } = await ensureSheetHeader();

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetRange(tab, 'A:S'),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      asSheetText(row.requestedAt || nowBr()),
      '',
      row.name,
      asSheetText(row.phone),
      row.email,
      asSheetText(row.cpf),
      asSheetText(String(row.cardNumber || '').slice(0, -1)),
      asSheetText(Number(row.amount || 0).toFixed(2).replace('.', ',')),
      '',
      '',
      row.payerName || row.name,
      asSheetText(row.payerCpf || row.cpf),
      row.paymentId || '',
      row.correlationId,
      '',
      row.reference,
      row.paymentMethodLabel || '',
      row.userId || '',
      row.transactionId || ''
    ]] }
  });
}

async function updateRechargeByCorrelation(correlationId, payment) {
  const spreadsheetId = process.env.SHEETS_RECHARGE_ID;
  if (!spreadsheetId) return false;
  const sheets = sheetsClient();
  const tab = await getRechargeTab(sheets, spreadsheetId);
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetRange(tab, 'A:S') });
  const rows = r.data.values || [];
  if (rows.length < 2) return false;
  const header = rows[0];
  const idxCorrelation = header.indexOf('correlationID');
  if (idxCorrelation < 0) return false;

  const rowIdx = rows.findIndex((row, i) => i > 0 && String(row[idxCorrelation] || '') === String(correlationId));
  if (rowIdx < 1) return false;

  const approved = ['approved', 'accredited'].includes(String(payment?.status || '').toLowerCase());
  const paidAt = payment?.date_approved || (approved ? new Date().toISOString() : '');
  const payerName = safeText(
    [payment?.payer?.first_name, payment?.payer?.last_name].filter(Boolean).join(' ') || '',
    120
  );
  const payerCpf = onlyDigits(payment?.payer?.identification?.number || '');

  const current = rows[rowIdx] || [];
  const paymentType = String(payment?.payment_type_id || '').toLowerCase();
  const paymentMethod = String(payment?.payment_method_id || '').toLowerCase();
  const paymentMethodLabel =
    paymentMethod === 'pix' || paymentType === 'bank_transfer'
      ? 'PIX'
      : (paymentType === 'credit_card' ? 'Cartão de Crédito'
        : (paymentType === 'debit_card' ? 'Cartão de Débito' : (paymentMethod || paymentType || current[16] || '')));
  const values = [[
    paidAt,
    current[9] || 'Não', // "Lançado?" é responsabilidade do fluxo de recarga/n8n
    payerName || current[10] || '',
    payerCpf || current[11] || '',
    String(payment?.id || ''),
    correlationId,
    current[14] || '',
    current[15] || correlationId,
    paymentMethodLabel,
    current[17] || '',
    String(payment?.id || '')
  ]];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(tab, `I${rowIdx + 1}:S${rowIdx + 1}`),
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
  return true;
}

app.post('/api/mp/pay', async (req, res) => {
  try {
    if (!payments || !MP_PUBLIC_KEY) return res.status(500).json({ ok: false, message: 'Mercado Pago não configurado.' });

    const amount = money(req.body?.transactionAmount ?? req.body?.transaction_amount);
    const cpf = onlyDigits(req.body?.cpf);
    const cardNumber = safeText(req.body?.cardNumber, 40);
    const email = safeText(req.body?.email || req.body?.payer?.email, 160);
    const name = safeText(req.body?.name, 120);
    const phone = onlyDigits(req.body?.phone);
    const paymentMethodId = safeText(req.body?.paymentMethodId ?? req.body?.payment_method_id, 80).toLowerCase();
    const token = safeText(req.body?.token, 500);
    const issuerId = req.body?.issuerId ?? req.body?.issuer_id;
    // Recarga não permite parcelamento: cartão é sempre cobrado em 1x.
    const installments = 1;
    const isPix = paymentMethodId === 'pix' || paymentMethodId === 'bank_transfer';

    if (!(amount > 0)) return res.status(400).json({ ok: false, message: 'Valor de recarga inválido.' });
    if (cpf.length !== 11) return res.status(400).json({ ok: false, message: 'CPF inválido.' });
    if (!cardNumber.startsWith('0362')) return res.status(400).json({ ok: false, message: 'Cartão não habilitado para recarga.' });
    if (!isEmail(email)) return res.status(400).json({ ok: false, message: 'Informe um e-mail válido para o pagamento.' });
    if (!isPix && !token) return res.status(400).json({ ok: false, message: 'Não foi possível tokenizar o cartão.' });

    const tacom = await fetchTacomCards(cpf);
    const tacomRows = Array.isArray(tacom) ? tacom : (Array.isArray(tacom?.data) ? tacom.data : []);
    const validCard = tacomRows.some(x => String(x?.codigoExternoCartao || '') === cardNumber && cardNumber.startsWith('0362'));
    if (!validCard) return res.status(403).json({ ok: false, message: 'Cartão não localizado para este CPF.' });

    const correlationId = uuidv4();
    const base = {
      transaction_amount: amount,
      description: `Recarga cartão ${cardNumber}`,
      external_reference: correlationId,
      payer: {
        email,
        first_name: name || undefined,
        identification: { type: 'CPF', number: cpf }
      },
      metadata: { cpf, card_number: cardNumber, correlation_id: correlationId }
    };
    if (process.env.MP_WEBHOOK_URL) base.notification_url = process.env.MP_WEBHOOK_URL;

    const body = isPix
      ? { ...base, payment_method_id: 'pix' }
      : {
          ...base,
          token,
          payment_method_id: paymentMethodId,
          installments,
          capture: true,
          ...(issuerId ? { issuer_id: issuerId } : {})
        };

    const requestedPaymentMethodLabel = isPix ? 'PIX' : 'Cartão';

    // A solicitação nasce no Sheets antes do pagamento.
    // Assim o correlationID já existe na planilha quando o Mercado Pago/notificação chegar.
    await appendRecharge({
      requestedAt: nowBr(),
      name, phone, email, cpf, cardNumber, amount,
      payerName: name, payerCpf: cpf,
      paymentId: '',
      correlationId,
      reference: correlationId,
      transactionId: '',
      paymentMethodLabel: requestedPaymentMethodLabel
    });

    const payment = await payments.create({
      body,
      requestOptions: { idempotencyKey: correlationId }
    });

    const paymentType = String(payment?.payment_type_id || '').toLowerCase();
    const paymentMethod = String(payment?.payment_method_id || paymentMethodId || '').toLowerCase();
    const paymentMethodLabel =
      isPix || paymentMethod === 'pix' || paymentType === 'bank_transfer'
        ? 'PIX'
        : (paymentType === 'credit_card' ? 'Cartão de Crédito'
          : (paymentType === 'debit_card' ? 'Cartão de Débito' : 'Cartão'));

    res.json({
      ok: true,
      id: payment?.id,
      status: payment?.status,
      status_detail: payment?.status_detail,
      payment_type_id: payment?.payment_type_id,
      payment_method_id: payment?.payment_method_id,
      correlationId,
      external_reference: correlationId,
      point_of_interaction: payment?.point_of_interaction || null
    });
  } catch (e) {
    console.error('[MP][pay]', e);
    const cause = e?.cause?.[0]?.description || e?.cause?.[0]?.message || e?.message || 'Falha ao processar o pagamento.';
    res.status(400).json({ ok: false, message: cause });
  }
});

app.get('/api/mp/payment-status', async (req, res) => {
  try {
    const id = safeText(req.query?.id, 60);
    if (!id) return res.status(400).json({ ok: false, message: 'Pagamento não informado.' });
    const p = await mpGetPayment(id);
    res.json({ ok: true, id: p.id, status: p.status, status_detail: p.status_detail, date_approved: p.date_approved || null });
  } catch (e) {
    res.status(400).json({ ok: false, message: 'Falha ao consultar o pagamento.' });
  }
});

app.get('/api/mp/webhook', (_req, res) => {
  res.status(405).json({
    ok: false,
    message: 'Endpoint de webhook ativo. O Mercado Pago deve chamar esta URL via POST.'
  });
});

app.post('/api/mp/webhook', async (req, res) => {
  try {
    const topic = req.body?.type || req.query?.type;
    const dataId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;

    if (topic !== 'payment' || !dataId) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const n8nUrl = process.env.N8N_PAYMENT_WEBHOOK_URL;
    if (!n8nUrl) {
      console.warn('[MP][Webhook] N8N_PAYMENT_WEBHOOK_URL não configurada.');
      return res.status(200).json({ ok: true, forwarded: false });
    }

    // Repassa a requisição como se o Mercado Pago estivesse chamando o n8n diretamente.
    // O próprio Webhook node do n8n montará headers/query/body no formato habitual.
    const target = new URL(n8nUrl);
    for (const [key, value] of Object.entries(req.query || {})) {
      if (Array.isArray(value)) {
        value.forEach(v => target.searchParams.append(key, String(v)));
      } else if (value !== undefined && value !== null) {
        target.searchParams.set(key, String(value));
      }
    }

    const forwardHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Accept': req.headers['accept'] || 'application/json'
    };
    if (req.headers['user-agent']) forwardHeaders['User-Agent'] = req.headers['user-agent'];
    if (req.headers['x-signature']) forwardHeaders['x-signature'] = req.headers['x-signature'];
    if (req.headers['x-request-id']) forwardHeaders['x-request-id'] = req.headers['x-request-id'];

    const nr = await fetch(target, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(req.body || {})
    });

    if (!nr.ok) {
      const responseText = await nr.text().catch(() => '');
      throw new Error(`n8n respondeu ${nr.status}: ${responseText.slice(0, 500)}`);
    }

    return res.status(200).json({ ok: true, forwarded: true });
  } catch (e) {
    console.error('[MP][webhook]', e);
    return res.status(500).json({ ok: false });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => console.log(`Venda Consórcio ouvindo na porta ${PORT}`));
