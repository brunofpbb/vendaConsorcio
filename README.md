# Venda Consórcio Rota Real

Aplicação web para recarga online dos cartões de bilhetagem do Consórcio Rota Real.

## Fluxo

1. Cliente informa CPF.
2. Backend normaliza para somente números e consulta a API TACOM.
3. A aplicação exibe **somente cartões cujo `codigoExternoCartao` começa com `0362`**.
4. Cliente escolhe cartão e valor.
5. Pagamento PIX é criado no Mercado Pago.
6. A solicitação é registrada em uma planilha Google Sheets exclusiva.
7. O webhook do Mercado Pago confirma o pagamento, atualiza a planilha e chama o webhook do n8n.
8. O n8n pode então executar o lançamento da recarga no fluxo já existente.

## TACOM

O token fica somente no backend. Ele é armazenado em memória até próximo da expiração e renovado automaticamente. Se a consulta de cartão receber HTTP 401, o backend invalida o cache, gera um token novo e repete a consulta uma única vez.

Endpoints usados:
- `POST /authentication/v1/auth2/login`
- `GET /citsoa-cartao/v1/citsbe/cartao/{cpf}`

## Mercado Pago

A base do Payment Brick e da Payments API segue o padrão do projeto `turin-sitevendas`, mas as credenciais devem ser **da conta do Consórcio**.

Configure:
- `MP_ACCESS_TOKEN`
- `MP_PUBLIC_KEY`
- `MP_WEBHOOK_URL=https://SEU-DOMINIO/api/mp/webhook`

Não coloque credenciais no código ou no frontend.

## Google Sheets

Crie uma planilha exclusiva para as recargas e compartilhe-a com o e-mail da Service Account usada em `GOOGLE_SERVICE_ACCOUNT_JSON`.

A aplicação cria o cabeçalho quando a aba estiver vazia. Estrutura:
`Data/hora Solicitação | At. | Nome | Telefone | Endereço de e-mail | CPF | Número do Cartão | Valor | Data/hora_Pagamento | Lançado? | Nome Pagador | CPF Pagador | ID Transação | correlationID | idURL | Referencia | Forma_Pagamento | idUser | Transação_ID`

## n8n

Configure `N8N_PAYMENT_WEBHOOK_URL`. O endpoint é chamado somente quando o Mercado Pago confirma o pagamento como `approved` ou `accredited`.

Payload principal:
`event, paymentId, correlationId, amount, status, paymentMethod, approvedAt, cpf, cardNumber`.

Opcionalmente configure `N8N_WEBHOOK_SECRET`; ele será enviado no header `X-Webhook-Secret`.

## Deploy

O projeto está pronto para Node 18+ e usa `npm start`. Em Railway, cadastre as variáveis do `.env.example` no serviço e exponha a porta fornecida por `PORT`.
