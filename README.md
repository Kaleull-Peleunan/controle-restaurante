# Comanda

MVP web para operacao de mesas, pedidos e pagamentos. O Express serve a interface em `public/` e a API; os dados ficam no PostgreSQL.

## Requisitos

- Node.js 20 ou superior
- PostgreSQL 16 ou Docker com Docker Compose

## Execucao local com Docker

1. Copie `.env.example` para `.env`.
2. No `.env`, defina uma senha de administrador e um `JWT_SECRET` aleatorio com pelo menos 32 caracteres.
3. Inicie o banco: `docker compose up -d db`.
4. Instale os pacotes: `npm install`.
5. Inicie a aplicacao: `npm start`.
6. Acesse `http://localhost:3000`.

O esquema e os dados iniciais sao criados no primeiro inicio do servidor. O usuario inicial usa `ADMIN_EMAIL` e `ADMIN_PASSWORD` do `.env`; se omitidos, o MVP usa `admin@restaurante.com` e `admin123`. Troque esses valores antes de qualquer uso fora do ambiente local.

Sem Docker, configure `DATABASE_URL` para uma instancia PostgreSQL acessivel e execute `npm start`.

## API

- `GET /api/health`: disponibilidade da API e conexao com o banco.
- `POST /api/login`: autentica e emite um JWT.
- `GET /api/tables`, `GET /api/products`: dados da operacao autenticada.
- `/api/orders`: abertura, itens, desconto, pagamento e fechamento de comandas.
- `GET /api/history`: ultimas 200 comandas encerradas.

As rotas operacionais usam `Authorization: Bearer <token>`. Valores recebidos pelo cliente sao validados no servidor e as operacoes de pedido/pagamento usam transacoes.

## Ainda fora do escopo

Este MVP nao processa pagamentos reais, nao tem integracao fiscal, recuperacao de senha, gestao completa de usuarios, auditoria, backup automatizado ou deploy configurado. O pagamento registrado e apenas controle interno. Antes de operar com dados reais, configure HTTPS, segredos seguros, backup/restauracao e revisao de permissao por funcao.