# Comanda

Aplicação web instalável (PWA) para gestão de mesas e comandas, com Express e PostgreSQL. O backend suporta várias lojas independentes na mesma base, separadas por políticas de segurança por linha do PostgreSQL (RLS). Cada conta pertence a uma loja; funcionários e dispositivos autenticados nessa loja compartilham os mesmos dados.

## Requisitos

- Node.js 20 ou superior
- PostgreSQL 16 ou Docker com Docker Compose
- HTTPS no endereço publicado (necessário para instalação PWA e Service Worker; localhost é aceito para desenvolvimento)

## Execução local

1. Copie `.env.example` para `.env` e substitua `JWT_SECRET`, `ADMIN_PASSWORD`, `POSTGRES_PASSWORD` e `APP_DATABASE_PASSWORD` por valores fortes e exclusivos. Use apenas letras, números, hífen ou sublinhado em `APP_DATABASE_PASSWORD`, pois esse valor compõe a URL PostgreSQL do Compose. Não publique os valores do exemplo.
2. Inicie e construa a aplicação e o banco: `docker compose up --build -d`.
3. Acesse `http://localhost:3000`.

O Compose usa PostgreSQL local, vinculado apenas ao loopback do host, e o papel `comanda_app`, sem `SUPERUSER`/`BYPASSRLS`, exigido para que o isolamento das lojas funcione. Em uma instalação limpa, o papel é criado pelo script de inicialização do banco com a senha `APP_DATABASE_PASSWORD`. Para PostgreSQL externo, use uma conta de aplicação sem `SUPERUSER` nem `BYPASSRLS`, com permissão para aplicar o esquema, e configure `DATABASE_URL`; em provedores que exigem TLS, use `PGSSL=true`.

### Banco local já existente

O script automático de criação do papel só é executado quando o volume PostgreSQL é inicializado pela primeira vez. Não remova nem recrie um volume com dados. Para um banco existente, faça backup e migre o papel de forma controlada com uma conta administrativa, configurando uma senha exclusiva para `comanda_app` e concedendo a propriedade dos objetos da aplicação a esse papel não privilegiado. A aplicação interrompe a inicialização quando a conexão é `SUPERUSER` ou `BYPASSRLS`; isso evita operar com isolamento multi-loja ineficaz.

Para executar a aplicação fora do Compose, configure `DATABASE_URL` com o papel de aplicação e a mesma senha definida em `APP_DATABASE_PASSWORD` (percent-encode caracteres reservados da URL, se usar algum); depois rode `npm install` e `npm start`. As alterações de esquema são aplicadas no início do serviço. Em produção, teste a migração em homologação e confirme uma restauração de backup antes da publicação.

O teste `npm run test:tenant` exige uma base PostgreSQL descartável, não produtiva, e `TENANT_TEST_DATABASE_URL` apontando para uma base cujo nome contenha `test`; o teste cria lojas e dados e reinicia a aplicação para validar a migração repetida.

## Cadastro e isolamento de lojas

Na tela de entrada, selecione **Criar uma nova loja**, informe o nome e o identificador exclusivo (slug), e crie a conta administradora. Os demais usuários devem ser adicionados pela administração daquela loja. O login exige identificador da loja, email e senha. A loja existente é identificada pelo slug `legado`.

Cada loja tem suas próprias mesas, produtos, usuários, comandas, pagamentos, avisos, configurações, auditoria e dados de migração. A migração do esquema atribui os dados existentes à loja `legado`; não apaga registros. Cada sessão carrega o identificador da loja e o PostgreSQL aplica RLS às tabelas operacionais.

## PWA, dispositivos e uso sem internet

- Instale pelo menu do navegador em dispositivos compatíveis; o Service Worker mantém a interface essencial disponível.
- Com uma sessão autenticada, respostas de leitura ficam em cache local por loja/usuário e a tela indica conexão e operações pendentes.
- Durante uma queda de internet, é possível abrir uma comanda e adicionar itens com dados carregados anteriormente. As operações ficam em IndexedDB e são enviadas em ordem ao reconectar. IDs estáveis de comanda e chaves de idempotência evitam duplicar gravações quando uma resposta se perde.
- Pagamentos, estornos, descontos, transferências, junções, cancelamento e fechamento exigem conexão. Erros de sincronização mantêm a operação na fila e são mostrados ao usuário.
- Avisos e filas de produção atualizam periodicamente com o app aberto; não há entrega push nem sincronização quando o navegador está fechado.
- O cache offline contém dados comerciais e fica no perfil/dispositivo. A saída limpa o cache e é bloqueada enquanto houver operações não sincronizadas. Proteja dispositivos compartilhados e use bloqueio de tela.

Vários dispositivos compartilham estado quando conectados ao mesmo backend e à mesma loja. Se duas comandas forem abertas offline na mesma mesa, o servidor aceitará a primeira sincronizada e manterá a outra na fila com conflito para decisão da equipe.

## Publicação em nuvem

O repositório inclui `Dockerfile` e Compose como base independente de provedor. Publique o contêiner Node em serviço com HTTPS e conecte-o a PostgreSQL gerenciado. Configure pelo mecanismo seguro de variáveis do provedor:

- `DATABASE_URL`: papel da aplicação sem `SUPERUSER` e sem `BYPASSRLS`, com permissões para inicializar/atualizar o esquema;
- `JWT_SECRET`: segredo aleatório de pelo menos 32 caracteres, exclusivo por ambiente;
- `ADMIN_EMAIL` e `ADMIN_PASSWORD`: credenciais iniciais para a loja `legado`;
- `PGSSL=true` quando exigido pelo banco e `PORT` conforme a plataforma.

O serviço precisa aceitar conexões HTTP persistentes para o polling. Nenhum provedor, banco, domínio ou segredo de nuvem foi configurado ou publicado nesta alteração. O cadastro de lojas está disponível com PostgreSQL, não no modo JSON local.

## Recursos e limites

O **Salão** mostra mesas, comandas abertas e histórico. A comanda permite busca e inclusão de produtos, edição de itens, descontos e pagamentos internos. O catálogo completo fica em **Produtos**. Configurações de terminais armazenam dados de integração, mas pagamentos reais ainda dependem da implementação e configuração seguras do SDK/API ou TEF do provedor. A exportação administrativa JSON contém dados sensíveis e deve ser protegida; ela não substitui backups e restauração automatizados do PostgreSQL.
