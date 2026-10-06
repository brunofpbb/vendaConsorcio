document.addEventListener('DOMContentLoaded', () => {
  const state = { cpf: '', cards: [], card: null, amount: 0, paymentId: null, mpController: null, email: '', phone: '' };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const alertBox = $('#alert');

  const mobileMenu = document.querySelector('.mobile-menu');
  const siteNav = document.querySelector('.site-nav');
  if (mobileMenu && siteNav) {
    mobileMenu.addEventListener('click', () => {
      const open = siteNav.classList.toggle('open');
      mobileMenu.classList.toggle('open', open);
      mobileMenu.setAttribute('aria-expanded', open ? 'true' : 'false');
      mobileMenu.textContent = open ? '✕' : '☰';
    });

    siteNav.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        siteNav.classList.remove('open');
        mobileMenu.classList.remove('open');
        mobileMenu.setAttribute('aria-expanded', 'false');
        mobileMenu.textContent = '☰';
      });
    });
  }


  function digits(v){ return String(v || '').replace(/\D/g, ''); }
  function brl(v){ return Number(v || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
  function formatBalanceDate(v){
    const raw = String(v || '').trim();
    if(!raw) return 'Não informada';
    const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
    if(m) return m[4] ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}` : `${m[1]}/${m[2]}/${m[3]}`;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? raw : d.toLocaleString('pt-BR');
  }
  function escapeHtml(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
  let alertTimer = null;
  function showAlert(msg){
    if (alertTimer) clearTimeout(alertTimer);
    alertBox.textContent = msg;
    alertBox.hidden = false;
    alertBox.classList.remove('leaving');
    alertTimer = setTimeout(() => {
      alertBox.classList.add('leaving');
      setTimeout(clearAlert, 260);
    }, 5000);
  }
  function clearAlert(){
    if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
    alertBox.hidden = true;
    alertBox.classList.remove('leaving');
    alertBox.textContent = '';
  }

  function renderView(view){
    clearAlert();
    $('.panel').forEach(p => p.classList.remove('active'));

    if(view === 'update'){
      $('.step').forEach(s => s.classList.toggle('active', Number(s.dataset.step) <= 1));
      $('#panel-update').classList.add('active');
    }else{
      const step = Number(view) || 1;
      $('.step').forEach(s => s.classList.toggle('active', Number(s.dataset.step) <= step));
      const ids = {1:'#panel-cpf',2:'#panel-card',3:'#panel-value',4:'#panel-payment'};
      $(ids[step])?.classList.add('active');
    }

    window.scrollTo({top: Math.max(0, $('.flow-card').offsetTop - 18), behavior:'smooth'});
  }

  function go(view, pushHistory = true){
    renderView(view);
    if(pushHistory){
      history.pushState({ rechargeView: view }, '', location.href);
    }
  }

  history.replaceState({ rechargeView: 1 }, '', location.href);
  window.addEventListener('popstate', e => {
    const view = e.state?.rechargeView;
    if(view !== undefined && view !== null){
      renderView(view);
    }
  });

  $('#cpf').addEventListener('input', e => {
    const d = digits(e.target.value).slice(0,11);
    e.target.value = d.replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3})(\d{1,2})$/,'$1-$2');
  });

  function renderCards(){
    $('#cards-list').innerHTML = state.cards.map((c,i) => `
      <button class="card-option card-option-premium" type="button" data-card-index="${i}">
        <div class="card-option-top">
          <div class="card-identification">
            <span class="card-label">Cartão Rota Real</span>
            <strong class="card-number">${escapeHtml(c.cardNumber)}</strong>
            <strong class="card-holder">${escapeHtml(c.name || 'Titular não informado')}</strong>
          </div>
          <span class="select-pill">Recarregar →</span>
        </div>

        <div class="card-option-bottom">
          <div class="balance-box">
            <span>Saldo aproximado</span>
            <strong>${c.balance == null ? 'Não informado' : brl(c.balance)}</strong>
          </div>
          <div class="balance-update">
            <span>Atualizado em</span>
            <strong>${escapeHtml(formatBalanceDate(c.balanceDate))}</strong>
          </div>
        </div>
      </button>`).join('');
  }

  function showUpdatePanel(){
    clearAlert();
    const c = state.cards[0] || {};
    $('#update-name').textContent = c.name || 'Cliente';
    $('#update-cpf').textContent = 'CPF: ' + state.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

    const validApiEmail =
      /^\S+@\S+\.\S+$/.test(c.email || '') &&
      String(c.email || '').toLowerCase() !== 'recepcao@turintransportes.com.br';

    $('#update-email').value = validApiEmail ? c.email : '';
    $('#update-phone').value = digits(c.phone).length >= 10 ? c.phone : '';
    go('update');
  }

  $('#cpf-form').addEventListener('submit', async e => {
    e.preventDefault(); clearAlert();
    const btn = e.submitter; const cpf = digits($('#cpf').value);
    if (cpf.length !== 11) return showAlert('Informe um CPF com 11 dígitos.');
    btn.disabled = true; btn.textContent = 'Consultando…';
    try{
      const r = await fetch('/api/cards/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cpf})});
      const j = await r.json();
      if(!r.ok) throw new Error(j.message || 'Cadastro não encontrado.');
      state.cpf = cpf;
      state.cards = j.cards || [];
      renderCards();

      const needsUpdate = state.cards.some(c => c.contactUpdateRequired);
      if(needsUpdate){
        showUpdatePanel();
      }else{
        state.email = state.cards[0]?.email || '';
        state.phone = state.cards[0]?.phone || '';
        go(2);
      }
    }catch(err){ showAlert(err.message || 'Não foi possível consultar o cadastro.'); }
    finally{ btn.disabled=false; btn.textContent='Consultar cartões'; }
  });

  $('#update-phone').addEventListener('input', e => {
    const d = digits(e.target.value).slice(0,11);
    e.target.value = d.length > 10
      ? d.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3')
      : d.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
  });

  $('.back-update').addEventListener('click', () => history.back());

  $('#update-form').addEventListener('submit', async e => {
    e.preventDefault();
    clearAlert();

    const email = $('#update-email').value.trim().toLowerCase();
    const phone = digits($('#update-phone').value);
    const btn = e.submitter;

    if(!/^\S+@\S+\.\S+$/.test(email) || email === 'recepcao@turintransportes.com.br'){
      return showAlert('Informe um e-mail válido.');
    }
    if(phone.length < 10 || phone.length > 11){
      return showAlert('Informe um telefone válido com DDD.');
    }

    btn.disabled = true;
    btn.textContent = 'Salvando…';

    try{
      const r = await fetch('/api/customer/update',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ cpf:state.cpf, email, phone })
      });
      const j = await r.json();
      if(!r.ok) throw new Error(j.message || 'Não foi possível atualizar o cadastro.');

      state.email = email;
      state.phone = phone;
      state.cards = state.cards.map(c => ({
        ...c,
        email,
        phone,
        contactUpdateRequired:false
      }));
      renderCards();
      go(2);
    }catch(err){
      showAlert(err.message || 'Não foi possível atualizar o cadastro.');
    }finally{
      btn.disabled = false;
      btn.textContent = 'Salvar e continuar';
    }
  });

  $('#cards-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-card-index]'); if(!btn) return;
    state.card = state.cards[Number(btn.dataset.cardIndex)];
    $('#selected-card').innerHTML = `
      <div class="selected-card-head">
        <div>
          <b>Cartão ${escapeHtml(state.card.cardNumber)}</b>
          <span>${escapeHtml(state.card.name || '')}</span>
        </div>
      </div>
      <div class="balance-highlight">
        <span>Saldo aproximado do cartão</span>
        <strong>${state.card.balance == null ? 'Não informado' : brl(state.card.balance)}</strong>
        <small>Saldo atualizado em: ${escapeHtml(formatBalanceDate(state.card.balanceDate))}</small>
      </div>
      <p class="balance-note">O saldo refere-se às cargas já transferidas para o cartão. Pagamentos recentes podem ainda não aparecer e o saldo será atualizado quando o cartão for utilizado no veículo.</p>
    `;
    $('#email').value = state.email || state.card.email || '';
    $('#phone').value = state.phone || state.card.phone || '';
    go(3);
  });

  $('[data-back]').forEach(b => b.addEventListener('click', () => history.back()));

  $('#amount').addEventListener('input', e => {
    let v = e.target.value.replace(/[^\d,]/g,'');
    e.target.value = v;
  });

  $('#value-form').addEventListener('submit', async e => {
    e.preventDefault(); clearAlert();
    const raw = $('#amount').value.replace(/\./g,'').replace(',','.');
    const amount = Number(raw);
    const email = $('#email').value.trim();
    const phone = digits($('#phone').value);
    if(!(amount > 0)) return showAlert('Informe um valor de recarga válido.');
    if(!/^\S+@\S+\.\S+$/.test(email)) return showAlert('Informe um e-mail válido.');
    state.amount = Math.round((amount + Number.EPSILON)*100)/100;
    state.email = email; state.phone = phone;
    $('#payment-summary').innerHTML = `<b>${escapeHtml(state.card.cardNumber)}</b><br><span>Recarga: ${brl(state.amount)}</span>`;
    go(4);
    await mountPaymentBrick();
  });

  async function mountPaymentBrick(){
    try{
      if(state.mpController){ try{ await state.mpController.unmount(); }catch(_){} state.mpController=null; }
      $('#payment-brick').innerHTML='';
      $('#pix-box').hidden=true;

      const kr = await fetch('/api/mp/pubkey'); const kj = await kr.json();
      if(!kj.publicKey) throw new Error('Chave pública do Mercado Pago não configurada.');
      const mp = new MercadoPago(kj.publicKey,{locale:'pt-BR'});
      const bricks = mp.bricks();

      state.mpController = await bricks.create('payment','payment-brick',{
        initialization:{
          amount: state.amount,
          payer:{
            email: state.email || '',
            entityType: 'individual'
          }
        },
        customization:{
          paymentMethods:{
            bankTransfer:['pix'],
            creditCard:'all',
            debitCard:'all',
            minInstallments:1,
            maxInstallments:1
          },
          visual:{ style:{ theme:'default' } }
        },
        callbacks:{
          onReady:()=>{},
          onError:(err)=>{ console.error('[MP Brick]',err); showAlert('Não foi possível carregar o pagamento.'); },
          onSubmit: async ({selectedPaymentMethod, formData}) => {
            clearAlert();
            const method = String(selectedPaymentMethod || '').toLowerCase();
            const isPix = method === 'bank_transfer' ||
              String(formData?.payment_method_id || '').toLowerCase() === 'pix';

            const payload = {
              paymentMethodId: isPix ? 'pix' : formData?.payment_method_id,
              transactionAmount: state.amount,
              cpf: state.cpf,
              cardNumber: state.card.cardNumber,
              name: state.card.name,
              email: state.email || formData?.payer?.email || '',
              phone: state.phone,
              token: isPix ? undefined : formData?.token,
              issuerId: isPix ? undefined : formData?.issuer_id,
              installments: isPix ? undefined : 1
            };

            const r = await fetch('/api/mp/pay',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify(payload)
            });
            const j = await r.json();
            if(!r.ok) {
              showAlert(j.message || 'Falha ao processar o pagamento.');
              throw new Error(j.message || 'Falha ao processar o pagamento.');
            }

            state.paymentId = j.id;
            const status = String(j.status || '').toLowerCase();

            if(status === 'approved'){
              $$('.panel').forEach(p=>p.classList.remove('active'));
              $('#panel-success').classList.add('active');
              return;
            }

            const pix = j?.point_of_interaction?.transaction_data;
            if(pix?.qr_code || pix?.qr_code_base64){
              showPix(j);
              startPolling(j.id);
              return;
            }

            if(['in_process','pending','authorized'].includes(status)){
              $('#pix-box').hidden = false;
              $('#pix-qr').style.display = 'none';
              $('.copy-row').style.display = 'none';
              $('#pix-status').textContent = 'Pagamento em processamento. Aguarde a confirmação.';
              startPolling(j.id);
              return;
            }

            showAlert('Pagamento não aprovado: ' + (j.status_detail || j.status || 'verifique os dados informados.'));
          }
        }
      });
    }catch(err){ console.error(err); showAlert(err.message || 'Falha ao iniciar o pagamento.'); }
  }

  function showPix(p){
    const tx = p?.point_of_interaction?.transaction_data || {};
    const qrBase64 = tx.qr_code_base64;
    const code = tx.qr_code || '';
    $('#pix-qr').style.display = '';
    $('.copy-row').style.display = '';
    if(qrBase64) $('#pix-qr').src = `data:image/png;base64,${qrBase64}`;
    $('#pix-code').value = code;
    $('#pix-box').hidden = false;
    $('#payment-brick').style.display='none';
  }

  $('#copy-pix').addEventListener('click', async () => {
    const code = $('#pix-code').value;
    if(!code) return;
    await navigator.clipboard.writeText(code);
    $('#copy-pix').textContent='Copiado!';
    setTimeout(()=>$('#copy-pix').textContent='Copiar',1600);
  });

  function startPolling(id){
    const started=Date.now();
    const timer=setInterval(async()=>{
      try{
        const r=await fetch(`/api/mp/payment-status?id=${encodeURIComponent(id)}`);
        const j=await r.json();
        const st=String(j.status||'').toLowerCase();
        if(['approved','accredited'].includes(st)){
          clearInterval(timer);
          $('#pix-status').textContent='Pagamento confirmado!';
          $$('.panel').forEach(p=>p.classList.remove('active'));
          $('#panel-success').classList.add('active');
          return;
        }
        if(['rejected','cancelled'].includes(st)){ clearInterval(timer); $('#pix-status').textContent='Pagamento não aprovado. Gere um novo PIX.'; }
        if(Date.now()-started > 20*60*1000){ clearInterval(timer); $('#pix-status').textContent='Tempo de acompanhamento encerrado. Consulte novamente antes de pagar.'; }
      }catch(_){}
    },5000);
  }

  $('#new-recharge').addEventListener('click',()=>location.reload());
});
