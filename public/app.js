document.addEventListener('DOMContentLoaded', () => {
  const state = { cpf: '', cards: [], card: null, amount: 0, paymentId: null, mpController: null };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const alertBox = $('#alert');

  function digits(v){ return String(v || '').replace(/\D/g, ''); }
  function brl(v){ return Number(v || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
  function escapeHtml(v){ return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
  function showAlert(msg){ alertBox.textContent = msg; alertBox.hidden = false; }
  function clearAlert(){ alertBox.hidden = true; alertBox.textContent = ''; }

  function go(step){
    clearAlert();
    $$('.panel').forEach(p => p.classList.remove('active'));
    $$('.step').forEach(s => s.classList.toggle('active', Number(s.dataset.step) <= step));
    const ids = {1:'#panel-cpf',2:'#panel-card',3:'#panel-value',4:'#panel-payment'};
    $(ids[step])?.classList.add('active');
    window.scrollTo({top: Math.max(0, $('.flow-card').offsetTop - 18), behavior:'smooth'});
  }

  $('#cpf').addEventListener('input', e => {
    const d = digits(e.target.value).slice(0,11);
    e.target.value = d.replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3})(\d)/,'$1.$2').replace(/(\d{3})(\d{1,2})$/,'$1-$2');
  });

  $('#cpf-form').addEventListener('submit', async e => {
    e.preventDefault(); clearAlert();
    const btn = e.submitter; const cpf = digits($('#cpf').value);
    if (cpf.length !== 11) return showAlert('Informe um CPF com 11 dígitos.');
    btn.disabled = true; btn.textContent = 'Consultando…';
    try{
      const r = await fetch('/api/cards/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cpf})});
      const j = await r.json();
      if(!r.ok) throw new Error(j.message || 'Cadastro não encontrado.');
      state.cpf = cpf; state.cards = j.cards || [];
      $('#cards-list').innerHTML = state.cards.map((c,i) => `
        <button class="card-option" type="button" data-card-index="${i}">
          <div><strong>${escapeHtml(c.cardNumber)}</strong><span>${escapeHtml(c.name || 'Cartão de usuário')}</span></div>
          <em>Selecionar →</em>
        </button>`).join('');
      go(2);
    }catch(err){ showAlert(err.message || 'Não foi possível consultar o cadastro.'); }
    finally{ btn.disabled=false; btn.textContent='Consultar cartões'; }
  });

  $('#cards-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-card-index]'); if(!btn) return;
    state.card = state.cards[Number(btn.dataset.cardIndex)];
    $('#selected-card').innerHTML = `<b>Cartão ${escapeHtml(state.card.cardNumber)}</b><br><span>${escapeHtml(state.card.name || '')}</span>`;
    $('#email').value = state.card.email || '';
    $('#phone').value = state.card.phone || '';
    go(3);
  });

  $$('[data-back]').forEach(b => b.addEventListener('click', () => go(Number(b.dataset.back))));

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
        initialization:{ amount: state.amount },
        customization:{
          paymentMethods:{ bankTransfer:['pix'], creditCard:'all', debitCard:'all' },
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
              installments: isPix ? undefined : Number(formData?.installments || 1)
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
