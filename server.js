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
      cpf,
      url,
      authorizationHeader: 'Bearer [presente]',
      body: raw.slice(0, 800)
    });
    const err = new Error(j?.mensagemDeErro || j?.message || j?.error || `Falha na consulta TACOM (${r.status})`);
    err.statusCode = r.status;
    throw err;
  }

  console.log('[TACOM][cards] consulta OK', {
    cpf,
    url,
    authorizationHeader: 'Bearer [presente]'
  });

  return j;
}

app.post('/api/cards/search', async (req, res) => {
  try {
    const cpf = onlyDigits(req.body?.cpf);
    if (cpf.length !== 11) return res.status(400).json({ ok: false, message: 'Informe um CPF com 11 dígitos.' });

    const result = await fetchTacomCards(cpf);
    const source = Array.isArray(result) ? result : (Array.isArray(result?.data) ? result.data : []);
    const cards = source
      .filter(x => String(x?.codigoExternoCartao || '').startsWith('0362'))
      .map(x => ({
        cardNumber: safeText(x.codigoExternoCartao, 40),
        name: safeText(x.nomeDependente || x.nome || '', 120),
        cpf: onlyDigits(x.cpf || cpf),
        email: safeText(x.email || '', 160),
        phone: onlyDigits(x.telefone || ''),
        balance: x.saldoCartao ?? null,
        balanceDate: safeText(x.dataSaldo || '', 40),
        contactUpdateRequired:
          !isEmail(safeText(x.email || '', 160)) ||
          safeText(x.email || '', 160).toLowerCase() === 'recepcao@turintransportes.com.br' ||
          onlyDigits(x.telefone || '').length < 10
      }));

    if (!cards.length) {
      return res.status(404).json({
        ok: false,
        code: 'NO_ELIGIBLE_CARD',
        message: 'Não encontramos cartão habilitado para recarga vinculado a este CPF.'
      });
    }

    res.json({ ok: true, cards });
  } catch (e) {
    console.error('[TACOM]', e);
    if (e?.statusCode === 404) {
      return res.status(404).json({
        ok: false,
        code: 'TACOM_NOT_FOUND',
        message: 'Não encontramos cartão habilitado para recarga vinculado a este CPF.'
      });
    }
    res.status(502).json({ ok: false, message: 'Não foi possível consultar os cartões agora. Tente novamente.' });
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
  const now = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: sheetRange(tab, 'A:F'),
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: cardList.map(cardNumber => [
        now,
        safeText(name, 120),
        onlyDigits(phone),
        safeText(email, 160),
        onlyDigits(cpf),
        safeText(cardNumber, 40)
      ])
    }
  });
}

app.post('/api/customer/update', async (req, res) => {
  try {
    const cpf = onlyDigits(req.body?.cpf);
    const email = safeText(req.body?.email, 160).toLowerCase();
    const phone = onlyDigits(req.body?.phone);

    if (cpf.length !== 11) {
      return res.status(400).json({ ok: false, message: 'CPF inválido.' });
    }
    if (!isEmail(email) || email === 'recepcao@turintransportes.com.br') {
      return res.status(400).json({ ok: false, message: 'Informe um e-mail válido.' });
    }
    if (phone.length < 10 || phone.length > 11) {
      return res.status(400).json({ ok: false, message: 'Informe um telefone válido com DDD.' });
    }

    // Revalida o CPF/cartões diretamente na TACOM antes de gravar no Sheets.
    const tacom = await fetchTacomCards(cpf);
    const rows = Array.isArray(tacom) ? tacom : (Array.isArray(tacom?.data) ? tacom.data : []);
    const eligible = rows.filter(x => String(x?.codigoExternoCartao || '').startsWith('0362'));

    if (!eligible.length) {
      return res.status(404).json({
        ok: false,
        message: 'Não encontramos cartão habilitado para este CPF.'
      });
    }

    const name = safeText(eligible[0]?.nomeDependente || eligible[0]?.nome || '', 120);
    const cards = eligible.map(x => safeText(x.codigoExternoCartao, 40));

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
  return new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
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
      row.requestedAt || nowBr(),
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

    console.log('[MP][Webhook] encaminhado ao n8n', {
      type: topic,
      paymentId: String(dataId)
    });

    return res.status(200).json({ ok: true, forwarded: true });
  } catch (e) {
    console.error('[MP][webhook]', e);
    return res.status(500).json({ ok: false });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, () => console.log(`Venda Consórcio ouvindo na porta ${PORT}`));
