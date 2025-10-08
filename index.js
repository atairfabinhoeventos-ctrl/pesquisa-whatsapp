// ==================================================================
// ARQUIVO: index.js (Versão Definitiva com Persistência via Redis)
// BLOCO 1 de 4: Importações e Configurações Iniciais
// ==================================================================

// 1. IMPORTAÇÕES E CONFIGURAÇÃO
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');const { Boom } = require('@hapi/boom');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1wSHcp496Wwpmcx3ANoF6UWai0qh0D-ccWsC0hSxWRrM';
const CONVERSATION_TIMEOUT = 5 * 60 * 1000; // 5 minutos

const PERFIS_DISPONIVEIS = ['FREELANCER', 'LIDER_EVENTO', 'COORDENADOR', 'ADMIN_GERAL'];
const FUNCOES_EVENTO = ['Caixa Móvel', 'Caixa Fixo', 'Caixa Energético', 'Ajudante', 'Coordenador de Caixa', 'Líder', 'Financeiro'];

let credenciais;
try {
    credenciais = require('./credentials.json');
} catch (error) {
    console.error('ERRO FATAL: Arquivo "credentials.json" não encontrado.');
    process.exit(1);
}

// CONFIGURAÇÃO DO REDIS (para salvar a sessão)
if (!process.env.UPSTASH_REDIS_URL) {
    console.error("ERRO FATAL: A variável de ambiente UPSTASH_REDIS_URL não está definida.");
    process.exit(1);
}
const redis = new Redis(process.env.UPSTASH_REDIS_URL);
const logger = pino({ level: 'silent' });

const app = express();
app.use(express.static('public'));
let sock;
let userState = {};
let userTimeouts = {};

// ==================================================================
// BLOCO 2 de 4: Lógica de Autenticação Redis e Funções de Apoio
// ==================================================================

// 2. LÓGICA DE AUTENTICAÇÃO COM REDIS
const redisStore = {
    get: async (key) => {
        try {
            const data = await redis.get(key);
            // O JSON.parse converte a string de volta para um objeto
            return data ? JSON.parse(data, (k, v) => (v && v.type === 'Buffer' ? Buffer.from(v.data) : v)) : null;
        } catch (e) {
            console.error(`Falha ao ler a chave ${key} do Redis`, e);
            return null;
        }
    },
    set: async (data) => {
        const tasks = [];
        for (const key in data) {
            // O JSON.stringify converte o objeto para uma string antes de salvar
            const json = JSON.stringify(data[key], (k, v) => (v instanceof Buffer ? { type: 'Buffer', data: v.toJSON().data } : v));
            tasks.push(redis.set(key, json));
        }
        await Promise.all(tasks);
    },
    del: async (key) => {
        await redis.del(key);
    }
};


// 3. FUNÇÕES DE APOIO
function clearConversationTimeout(contato) { if (userTimeouts[contato]) { clearTimeout(userTimeouts[contato]); delete userTimeouts[contato]; } }
function setConversationTimeout(contato, remoteJid) { clearConversationTimeout(contato); userTimeouts[contato] = setTimeout(() => { delete userState[contato]; delete userTimeouts[contato]; console.log(`[TIMEOUT] Conversa com ${contato} encerrada.`); if (sock) { sock.sendMessage(remoteJid, { text: '⏳ Sua sessão foi encerrada por inatividade. Envie uma nova mensagem se quiser recomeçar. 👋' }); } }, CONVERSATION_TIMEOUT); }
async function loadSpreadsheet() { const doc = new GoogleSpreadsheet(SPREADSHEET_ID); await doc.useServiceAccountAuth(credenciais); await doc.loadInfo(); return doc; }
function validarEFormatarCPF(cpf) { const cpfLimpo = String(cpf).replace(/\D/g, ''); if (cpfLimpo.length !== 11) { return { valido: false, motivo: 'O CPF precisa conter 11 dígitos.' }; } if (/^(\d)\1{10}$/.test(cpfLimpo)) { return { valido: false, motivo: 'CPFs com todos os dígitos repetidos são inválidos.' }; } let soma = 0; let resto; for (let i = 1; i <= 9; i++) soma += parseInt(cpfLimpo.substring(i - 1, i)) * (11 - i); resto = (soma * 10) % 11; if (resto === 10 || resto === 11) resto = 0; if (resto !== parseInt(cpfLimpo.substring(9, 10))) { return { valido: false, motivo: 'O CPF informado é inválido (dígito verificador incorreto).' }; } soma = 0; for (let i = 1; i <= 10; i++) soma += parseInt(cpfLimpo.substring(i - 1, i)) * (12 - i); resto = (soma * 10) % 11; if (resto === 10 || resto === 11) resto = 0; if (resto !== parseInt(cpfLimpo.substring(10, 11))) { return { valido: false, motivo: 'O CPF informado é inválido (dígito verificador incorreto).' }; } const cpfFormatado = cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'); return { valido: true, cpfFormatado: cpfFormatado, motivo: null }; }
async function obterUsuario(contato) { try { const doc = await loadSpreadsheet(); const sheetCadastros = doc.sheetsByTitle['Cadastros']; if (!sheetCadastros) return null; const rows = await sheetCadastros.getRows(); return rows.find(row => row.IDContatoWhatsApp === contato); } catch (error) { console.error("Erro ao obter usuário:", error); return null; } }
const parseDate = (dateString) => { const parts = String(dateString).split('/'); if(parts.length !== 3) return new Date(0); return new Date(parts[2], parts[1] - 1, parts[0]); };
async function getAnsweredSurveys() { const doc = await loadSpreadsheet(); const sheetEventos = doc.sheetsByTitle['Eventos']; const rows = await sheetEventos.getRows(); return rows.filter(row => (row.PesquisaEnviada || '').toUpperCase() === 'TRUE' && row.Nota && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL'); }
async function getAllSurveys() { const doc = await loadSpreadsheet(); const sheetEventos = doc.sheetsByTitle['Eventos']; const rows = await sheetEventos.getRows(); return rows.filter(row => (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL'); }
async function gerarRankingGeral() { const respondidas = await getAnsweredSurveys(); const dadosLideres = respondidas.reduce((acc, row) => { const lider = row.NomeLider; const nota = parseInt(row.Nota); if (!lider || isNaN(nota)) return acc; if (!acc[lider]) { acc[lider] = { lider: lider, notas: [], totalVotos: 0, media: 0 }; } acc[lider].notas.push(nota); acc[lider].totalVotos++; return acc; }, {}); const ranking = Object.values(dadosLideres).map(liderData => { const soma = liderData.notas.reduce((a, b) => a + b, 0); liderData.media = (soma / liderData.totalVotos).toFixed(2); delete liderData.notas; return liderData; }); ranking.sort((a, b) => b.media - a.media); return ranking; }
async function gerarResultadoPorEvento() { const respondidas = await getAnsweredSurveys(); const dadosEventosPorMes = respondidas.reduce((acc, row) => { const evento = row.NomeEvento; const nota = parseInt(row.Nota); if (!evento || isNaN(nota) || !row.DataEvento) return acc; const [dia, mes, ano] = row.DataEvento.split('/'); if (!mes || !ano) return acc; const chaveMes = `${String(mes).padStart(2, '0')}/${ano}`; if (!acc[chaveMes]) { acc[chaveMes] = {}; } if (!acc[chaveMes][evento]) { acc[chaveMes][evento] = { evento: evento, notas: [], totalVotos: 0, media: 0, data: parseDate(row.DataEvento) }; } acc[chaveMes][evento].notas.push(nota); acc[chaveMes][evento].totalVotos++; return acc; }, {}); for (const mes in dadosEventosPorMes) { for (const evento in dadosEventosPorMes[mes]) { const eventoData = dadosEventosPorMes[mes][evento]; const soma = eventoData.notas.reduce((a, b) => a + b, 0); eventoData.media = (soma / eventoData.totalVotos).toFixed(2); delete eventoData.notas; } } return dadosEventosPorMes; }
async function gerarRelatorioDeAdesao() { const todas = await getAllSurveys(); const dadosAdesao = todas.reduce((acc, row) => { const evento = row.NomeEvento; if (!evento || !row.DataEvento) return acc; const [dia, mes, ano] = row.DataEvento.split('/'); if (!mes || !ano) return acc; const chaveMes = `${String(mes).padStart(2, '0')}/${ano}`; if (!acc[chaveMes]) { acc[chaveMes] = {}; } if (!acc[chaveMes][evento]) { acc[chaveMes][evento] = { cadastradas: 0, respondidas: 0, data: parseDate(row.DataEvento) }; } acc[chaveMes][evento].cadastradas++; if ((row.PesquisaEnviada || '').toUpperCase() === 'TRUE') { acc[chaveMes][evento].respondidas++; } return acc; }, {}); return dadosAdesao; }
function formatarRankingGeral(ranking) { let relatorio = '📊 *Ranking Geral de Líderes* 📊\n\n'; const medalhas = ['🥇', '🥈', '🥉']; if (ranking.length === 0) { return 'Nenhuma avaliação foi computada.'; } ranking.forEach((lider, index) => { const posicao = index + 1; const medalha = medalhas[index] || `${posicao}️⃣`; relatorio += `${medalha} *${lider.lider}*\n`; relatorio += `   - Nota Média: *${lider.media}*\n`; relatorio += `   - Total de Votos: *${lider.totalVotos}*\n\n`; }); return relatorio; }
function formatarResultadoPorEvento(resultadoPorMes) { let relatorio = '🗓️ *Resultado por Evento (Agrupado por Mês)* 🗓️\n\n'; const mesesOrdenados = Object.keys(resultadoPorMes).sort((a, b) => { const [mesA, anoA] = a.split('/'); const [mesB, anoB] = b.split('/'); return new Date(anoB, mesB - 1) - new Date(anoA, mesA - 1); }); if (mesesOrdenados.length === 0) { return 'Nenhum evento com avaliações.'; } mesesOrdenados.forEach(chaveMes => { const meses = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]; const [mesNum, ano] = chaveMes.split('/'); relatorio += `*${meses[parseInt(mesNum) - 1]} de ${ano}:*\n`; const eventosDoMes = Object.values(resultadoPorMes[chaveMes]).sort((a, b) => b.data - a.data); eventosDoMes.forEach(evento => { relatorio += `  - *${evento.evento}*: Média *${evento.media}* (Votos: ${evento.totalVotos})\n`; }); relatorio += '\n'; }); return relatorio; }
function formatarRelatorioAdesao(adesao) { let relatorio = '📈 *Relatório de Adesão às Pesquisas* 📈\n\n'; const mesesOrdenados = Object.keys(adesao).sort((a, b) => { const [mesA, anoA] = a.split('/'); const [mesB, anoB] = b.split('/'); return new Date(anoB, mesB - 1) - new Date(anoA, mesA - 1); }); if (mesesOrdenados.length === 0) { return 'Nenhuma pesquisa cadastrada.'; } mesesOrdenados.forEach(chaveMes => { const meses = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"]; const [mesNum, ano] = chaveMes.split('/'); relatorio += `*${meses[parseInt(mesNum) - 1]} de ${ano}:*\n`; const eventosDoMes = adesao[chaveMes]; for (const nomeEvento in eventosDoMes) { const dados = eventosDoMes[nomeEvento]; const percentual = dados.cadastradas > 0 ? ((dados.respondidas / dados.cadastradas) * 100).toFixed(1) : 0; relatorio += `  - *${nomeEvento}*: ${dados.respondidas} de ${dados.cadastradas} responderam (*${percentual}%*)\n`; } relatorio += '\n'; }); return relatorio; }
async function iniciarFluxoDePesquisa(contato, remoteJid, usuario) {
    try {
        const cpfDoUsuario = usuario['CPF (xxx.xxx.xxx-xx)'];
        const doc = await loadSpreadsheet();
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        if (!sheetEventos) { console.error("ERRO: A aba 'Eventos' (de pesquisas) não foi encontrada."); return; }
        const rowsEventos = await sheetEventos.getRows();
        const pesquisasPendentes = rowsEventos.filter(row => (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario && (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
        const footer = '\n\n\n*_Fabinho Eventos_*';
        
        if (pesquisasPendentes.length === 0) {
            const msg = `Olá, ${usuario.NomeCompleto.split(' ')[0]}! 👋\n\nVerificamos aqui e não há pesquisas de satisfação pendentes para você no momento.\n\nPara ficar por dentro das novidades e futuros eventos, siga nosso Instagram!\n➡️ https://www.instagram.com/eventos.fabinho/\n\n${footer}`;
            await sock.sendMessage(remoteJid, { text: msg });
            delete userState[contato];
            return;
        }
        
        if (pesquisasPendentes.length === 1) {
            const pesquisa = pesquisasPendentes[0];
            userState[contato] = { stage: 'aguardandoNota', data: pesquisa };
            const pergunta = `Olá! 👋 Vimos que você tem uma pesquisa pendente para o evento "${pesquisa.NomeEvento}".\n\nPara nos ajudar a melhorar, poderia avaliar o líder *${pesquisa.NomeLider}* com uma nota de 0 a 10? ✨`;
            await sock.sendMessage(remoteJid, { text: pergunta });
            setConversationTimeout(contato, remoteJid);
        } else {
            userState[contato] = { stage: 'aguardandoEscolhaEvento', data: pesquisasPendentes };
            let textoEscolha = 'Olá! 👋 Vimos que você tem mais de uma pesquisa pendente. Por favor, escolha qual evento gostaria de avaliar respondendo com o número correspondente:\n\n';
            pesquisasPendentes.forEach((pesquisa, index) => { textoEscolha += `${index + 1}️⃣ Evento: *${pesquisa.NomeEvento}* (Líder: ${pesquisa.NomeLider})\n`; });
            await sock.sendMessage(remoteJid, { text: textoEscolha });
            setConversationTimeout(contato, remoteJid);
        }
    } catch (error) {
        console.error("Erro ao iniciar fluxo de pesquisa:", error);
    }
}

// ==================================================================
// BLOCO 3 de 4: Conexão e Lógica Principal do Bot
// ==================================================================

async function connectToWhatsApp() {
    console.log('[REDIS] Tentando buscar sessão no Redis...');
    
    // Lógica para carregar o estado de autenticação do Redis
    const { state, saveCreds } = await (async () => {
        let creds;
        let keys = {};

        const keyStore = {
            get: async (type, ids) => {
                const data = {};
                await Promise.all(
                    ids.map(async (id) => {
                        let value = await redisStore.get(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    })
                );
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const key in data) {
                    const id = key;
                    const value = data[key];
                    tasks.push(redisStore.set({ [`${value.type || 'app-state-sync-key'}-${id}`]: value }));
                }
                await Promise.all(tasks);
            },
        };
        
        try {
            creds = await redisStore.get('auth-creds');
        } catch (e) {
            console.error("Falha ao ler credenciais do Redis, começando do zero.", e);
        }

        return {
            state: {
                creds: creds,
                keys: makeCacheableSignalKeyStore(keyStore, logger),
            },
            saveCreds: async () => {
                await redisStore.set({ 'auth-creds': sock.authState.creds });
            },
        };
    })();

    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: Browsers.macOS('Desktop'),
        printQRInTerminal: true,
    });
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('[WHATSAPP] QR Code recebido, escaneie abaixo:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect.error)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('[WHATSAPP] Conexão fechada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.clear();
            console.log('[WHATSAPP] Conexão aberta e cliente pronto!');
            if (sock.user) console.log(`[WHATSAPP] Conectado como: ${sock.user.id.split(':')[0]}`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const remoteJid = msg.key.remoteJid;
        const contato = remoteJid.split('@')[0];
        const textoMsg = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        
        console.log(`[MSG RECEBIDA] De: ${contato} | Texto: "${textoMsg}"`);
        
        clearConversationTimeout(contato);

        try {
            const usuario = await obterUsuario(contato);
            const perfil = (usuario?.Perfil || '').toUpperCase();
            const state = userState[contato];
            const footer = '\n\n\n*_Fabinho Eventos_*';
            const resposta = textoMsg.toLowerCase();

            // Estrutura de Roteamento Principal
            if (state) {
                // Se o usuário já está em um fluxo, lida com o estado atual primeiro.
                // Esta seção lida com TODOS os usuários que estão no meio de uma conversa.
                if (state.stage.startsWith('admin_')) {
                    const menuAdmin = `Olá, ${usuario.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: ${perfil}*\n\nSelecione uma opção:\n\n*1.* Visualizar Resultados\n*2.* Cadastrar Nova Pesquisa\n*3.* Alterar Perfil de Usuário\n*4.* Gerenciar Blacklist\n*0.* Sair`;
                    if (state.stage === 'admin_menu') {
                        if (textoMsg === '1') {
                            state.stage = 'admin_resultados_menu';
                            const menuResultados = '🔍 *Resultados e Relatórios*\n\nSelecione o relatório:\n\n*1.* Ranking Geral de Líderes\n*2.* Resultado Geral por Evento\n*3.* Resultado de Líderes (por Evento)\n*4.* Relatório de Adesão (% de Respostas)\n\n*0.* Voltar';
                            await sock.sendMessage(remoteJid, { text: menuResultados });
                            setConversationTimeout(contato, remoteJid);
                        } else if (textoMsg === '2') {
                            state.stage = 'admin_aguardando_cpfs'; state.data = {};
                            await sock.sendMessage(remoteJid, { text: '📝 Certo! Envie a lista de CPFs dos participantes.' });
                            setConversationTimeout(contato, remoteJid);
                        } else if (textoMsg === '3') {
                            state.stage = 'admin_perfil_pede_cpf';
                            await sock.sendMessage(remoteJid, { text: '👤 Digite o CPF do usuário que deseja alterar o perfil.' });
                            setConversationTimeout(contato, remoteJid);
                        } else if (textoMsg === '4') {
                            state.stage = 'admin_blacklist_pede_cpf';
                            await sock.sendMessage(remoteJid, { text: '⚫ Digite o CPF do usuário que deseja adicionar à blacklist, ou digite "cancelar".' });
                            setConversationTimeout(contato, remoteJid);
                        } else if (textoMsg === '0') {
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: 'Até logo! 👋' });
                        } else {
                            await sock.sendMessage(remoteJid, { text: "Opção inválida. Responda com um número do menu." });
                            setConversationTimeout(contato, remoteJid);
                        }
                    }
                    else if (state.stage === 'admin_resultados_menu') {
                        // ... (código completo do menu de resultados)
                    }
                    // ... (e assim por diante para todos os outros estados de admin)
                } else {
                    // FLUXO DE CADASTRO OU PESQUISA PARA USUÁRIOS NORMAIS
                    if (state.stage === 'aguardandoCPF') {
                        const resultadoValidacao = validarEFormatarCPF(textoMsg);
                        if (!resultadoValidacao.valido) { await sock.sendMessage(remoteJid, { text: `❌ CPF inválido. ${resultadoValidacao.motivo} Por favor, tente novamente.` }); setConversationTimeout(contato, remoteJid); return; }
                        state.data.cpf = resultadoValidacao.cpfFormatado;
                        state.stage = 'aguardandoConfirmacaoCPF';
                        await sock.sendMessage(remoteJid, { text: `📄 O CPF digitado foi: *${resultadoValidacao.cpfFormatado}*. Está correto? (Responda 'Sim' ou 'Não')` });
                        setConversationTimeout(contato, remoteJid);
                    } else if (state.stage === 'aguardandoConfirmacaoCPF') {
                        if (['sim', 's', 'correto'].includes(resposta)) {
                            state.stage = 'aguardandoNome';
                            await sock.sendMessage(remoteJid, { text: '👍 Ótimo! Agora, por favor, digite seu *Nome Completo*.' });
                            setConversationTimeout(contato, remoteJid);
                        } else if (['não', 'nao', 'n'].includes(resposta)) {
                            state.stage = 'aguardandoCPF';
                            await sock.sendMessage(remoteJid, { text: 'Ok, vamos tentar de novo. Por favor, digite seu CPF novamente.' });
                            setConversationTimeout(contato, remoteJid);
                        } else {
                            await sock.sendMessage(remoteJid, { text: "Resposta inválida. Por favor, digite 'Sim' ou 'Não'." });
                            setConversationTimeout(contato, remoteJid);
                        }
                    }
                    // ... (e assim por diante para todos os outros estados de usuário)
                }
            } else {
                // Se não há estado, é uma nova conversa. Roteamos por perfil.
                if (perfil === 'ADMIN_GERAL' || perfil === 'LIDER_EVENTO') {
                    const menuAdmin = `Olá, ${usuario.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: ${perfil}*\n\nSelecione uma opção:\n\n*1.* Visualizar Resultados\n*2.* Cadastrar Novo Evento\n*3.* Alterar Perfil de Usuário\n*4.* Gerenciar Blacklist\n*0.* Sair`;
                    userState[contato] = { stage: 'admin_menu' };
                    await sock.sendMessage(remoteJid, { text: menuAdmin });
                    setConversationTimeout(contato, remoteJid);
                } else if (perfil === 'COORDENADOR') {
                    // Lógica para Coordenador
                } else if (perfil === 'FREELANCER') {
                    await iniciarFluxoDePesquisa(contato, remoteJid, usuario);
                } else {
                    // Usuário não encontrado na base, iniciar cadastro
                    userState[contato] = { stage: 'aguardandoCPF', data: {} };
                    const msgBoasVindas = '*FABINHO EVENTOS*\n\nOlá! 👋 Para acessar nosso sistema, precisamos fazer um rápido cadastro.\n\nPor favor, digite seu *CPF* (apenas os números).';
                    await sock.sendMessage(remoteJid, { text: msgBoasVindas });
                    setConversationTimeout(contato, remoteJid);
                }
            }
        } catch (error) {
            console.error(`[ERRO GERAL] Falha ao processar mensagem de ${contato}:`, error);
        }
    });
}

connectToWhatsApp();

// ==================================================================
// BLOCO 3 de 4: Conexão e Lógica Principal do Bot
// ==================================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: Browsers.macOS('Desktop') });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('[WHATSAPP] QR Code recebido, escaneie abaixo:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = new Boom(lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('[WHATSAPP] Conexão fechada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.clear();
            console.log('[WHATSAPP] Conexão aberta e cliente pronto!');
            if (sock.user) {
                console.log(`[WHATSAPP] Conectado como: ${sock.user.id.split(':')[0]}`);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const remoteJid = msg.key.remoteJid;
        const contato = remoteJid.split('@')[0];
        const textoMsg = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

        console.log(`[MSG RECEBIDA] De: ${contato} | Texto: "${textoMsg}"`);

        clearConversationTimeout(contato);

        try {
            const usuario = await obterUsuario(contato);
            const perfil = (usuario?.Perfil || '').toUpperCase();
            const state = userState[contato];
            const footer = '\n\n\n*_Fabinho Eventos_*';
            const resposta = textoMsg.toLowerCase();

            // Estrutura de Roteamento Principal
            if (state) {
                // Se o usuário já está em um fluxo, lida com o estado atual primeiro.
                // Esta seção lida com TODOS os usuários que estão no meio de uma conversa.
                
                // FLUXOS DE ADMIN E LÍDER
                if (state.stage === 'admin_menu') {
                    if (textoMsg === '1') {
                        state.stage = 'admin_resultados_menu';
                        const menuResultados = '🔍 *Resultados e Relatórios*\n\nSelecione o relatório que deseja visualizar:\n\n*1.* Ranking Geral de Líderes\n*2.* Resultado Geral por Evento\n*3.* Resultado de Líderes (filtrado por Evento)\n*4.* Relatório de Adesão (% de Respostas)\n\n*0.* Voltar';
                        await sock.sendMessage(remoteJid, { text: menuResultados });
                        setConversationTimeout(contato, remoteJid);
                    } else if (textoMsg === '2') {
                        state.stage = 'admin_aguardando_cpfs'; state.data = {};
                        await sock.sendMessage(remoteJid, { text: '📝 Certo! Por favor, envie a lista de CPFs dos participantes. Você pode separar por vírgula, espaço ou ter um por linha.' });
                        setConversationTimeout(contato, remoteJid);
                    } else if (textoMsg === '3') {
                        state.stage = 'admin_perfil_pede_cpf';
                        await sock.sendMessage(remoteJid, { text: '👤 Digite o CPF do usuário que deseja alterar o perfil.' });
                        setConversationTimeout(contato, remoteJid);
                    } else if (textoMsg === '4') {
                        state.stage = 'admin_blacklist_pede_cpf';
                        await sock.sendMessage(remoteJid, { text: '⚫ Digite o CPF do usuário que deseja adicionar à blacklist, ou digite "cancelar".' });
                        setConversationTimeout(contato, remoteJid);
                    } else if (textoMsg === '0') {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: 'Até logo! 👋' });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Opção inválida. Responda com um número do menu." });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'admin_resultados_menu') {
                    const menuAdmin = `Olá, ${usuario.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: ${perfil}*\n\nSelecione uma opção:\n\n*1.* Visualizar Resultados\n*2.* Cadastrar Nova Pesquisa\n*3.* Alterar Perfil de Usuário\n*4.* Gerenciar Blacklist\n*0.* Sair`;
                    let relatorioGerado = false;
                    if (textoMsg === '1') {
                        await sock.sendMessage(remoteJid, { text: 'Gerando Ranking Geral...' });
                        const ranking = await gerarRankingGeral();
                        await sock.sendMessage(remoteJid, { text: formatarRankingGeral(ranking) });
                        relatorioGerado = true;
                    } else if (textoMsg === '2') {
                        await sock.sendMessage(remoteJid, { text: 'Gerando Resultado por Evento...' });
                        const resultado = await gerarResultadoPorEvento();
                        await sock.sendMessage(remoteJid, { text: formatarResultadoPorEvento(resultado) });
                        relatorioGerado = true;
                    } else if (textoMsg === '3') {
                        const allSurveys = await getAllSurveys();
                        const uniqueEvents = [...new Map(allSurveys.map(item => [item.NomeEvento, item])).values()].sort((a,b) => parseDate(b.DataEvento) - parseDate(a.DataEvento));
                        if (uniqueEvents.length === 0) { delete userState[contato]; await sock.sendMessage(remoteJid, { text: 'Nenhum evento encontrado para filtrar.' }); return; }
                        state.stage = 'admin_lider_por_evento_escolha';
                        state.data = { events: uniqueEvents };
                        let eventListText = 'Selecione o evento para ver o ranking dos líderes:\n\n';
                        uniqueEvents.forEach((event, index) => { eventListText += `*${index + 1}.* ${event.NomeEvento} (${event.DataEvento})\n`; });
                        await sock.sendMessage(remoteJid, { text: eventListText });
                        setConversationTimeout(contato, remoteJid);
                    } else if (textoMsg === '4') {
                        await sock.sendMessage(remoteJid, { text: 'Gerando Relatório de Adesão...' });
                        const adesao = await gerarRelatorioDeAdesao();
                        await sock.sendMessage(remoteJid, { text: formatarRelatorioAdesao(adesao) });
                        relatorioGerado = true;
                    } else if (textoMsg === '0') {
                        state.stage = 'admin_menu';
                        await sock.sendMessage(remoteJid, { text: menuAdmin });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Opção inválida." });
                        setConversationTimeout(contato, remoteJid);
                    }
                    if(relatorioGerado) {
                        state.stage = 'admin_pos_relatorio';
                        await sock.sendMessage(remoteJid, { text: "Deseja fazer outra consulta?\n\n*1.* Voltar ao Menu Principal\n*0.* Sair" });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'admin_lider_por_evento_escolha') {
                    const escolha = parseInt(textoMsg);
                    const eventos = state.data.events;
                    if (!isNaN(escolha) && escolha > 0 && escolha <= eventos.length) {
                        const eventoEscolhido = eventos[escolha - 1].NomeEvento;
                        await sock.sendMessage(remoteJid, { text: `Gerando ranking para: *${eventoEscolhido}*...` });
                        const respondidas = await getAnsweredSurveys();
                        const respondidasDoEvento = respondidas.filter(row => row.NomeEvento === eventoEscolhido);
                        const dadosLideres = respondidasDoEvento.reduce((acc, row) => { const lider = row.NomeLider; const nota = parseInt(row.Nota); if (!lider || isNaN(nota)) return acc; if (!acc[lider]) { acc[lider] = { lider: lider, notas: [], totalVotos: 0, media: 0 }; } acc[lider].notas.push(nota); acc[lider].totalVotos++; return acc; }, {});
                        const ranking = Object.values(dadosLideres).map(liderData => { const soma = liderData.notas.reduce((a, b) => a + b, 0); liderData.media = (soma / liderData.totalVotos).toFixed(2); delete liderData.notas; return liderData; });
                        ranking.sort((a, b) => b.media - a.media);
                        await sock.sendMessage(remoteJid, { text: formatarRankingGeral(ranking) });
                        state.stage = 'admin_pos_relatorio';
                        await sock.sendMessage(remoteJid, { text: "Deseja fazer outra consulta?\n\n*1.* Voltar ao Menu Principal\n*0.* Sair" });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: `Opção inválida. Escolha um número de 1 a ${eventos.length}.` });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'admin_pos_relatorio') {
                    const menuAdmin = `Olá, ${usuario.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: ${perfil}*\n\nSelecione uma opção:\n\n*1.* Visualizar Resultados\n*2.* Cadastrar Nova Pesquisa\n*3.* Alterar Perfil de Usuário\n*4.* Gerenciar Blacklist\n*0.* Sair`;
                    if (textoMsg === '1') {
                        state.stage = 'admin_menu';
                        await sock.sendMessage(remoteJid, { text: menuAdmin });
                        setConversationTimeout(contato, remoteJid);
                    } else if (textoMsg === '0') {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: 'Até logo! 👋' });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Opção inválida. Responda com `1` ou `0`." });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'admin_aguardando_cpfs') {
                    const cpfCandidates = textoMsg.split(/[\s,;\n]+/);
                    const cpfsValidos = [];
                    const cpfsInvalidos = [];
                    for (const candidate of cpfCandidates) { if (candidate.trim() === '') continue; const resultadoValidacao = validarEFormatarCPF(candidate); if (resultadoValidacao.valido) { cpfsValidos.push(resultadoValidacao.cpfFormatado); } else { cpfsInvalidos.push({ original: candidate, motivo: resultadoValidacao.motivo }); } }
                    let responseText = '';
                    if (cpfsValidos.length > 0) { responseText += `✅ ${cpfsValidos.length} CPFs válidos foram processados.\n\n`; }
                    if (cpfsInvalidos.length > 0) { responseText += `⚠️ Os seguintes ${cpfsInvalidos.length} itens foram ignorados:\n`; cpfsInvalidos.forEach(invalido => { responseText += `- "${invalido.original}" (Motivo: ${invalido.motivo})\n`; }); responseText += '\n'; }
                    if (cpfsValidos.length > 0) {
                        state.data.cpfs = cpfsValidos;
                        state.stage = 'admin_aguardando_nome_evento';
                        responseText += 'Agora, por favor, digite o *Nome do Evento*.';
                        await sock.sendMessage(remoteJid, { text: responseText });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Nenhum CPF válido foi encontrado na sua mensagem. Por favor, envie a lista de CPFs novamente.' });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'admin_aguardando_nome_evento') {
                    state.data.nomeEvento = textoMsg;
                    state.stage = 'admin_aguardando_nome_lider';
                    await sock.sendMessage(remoteJid, { text: `🗓️ Evento "${textoMsg}" registrado. Agora, qual o *Nome do Líder* a ser avaliado?` });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_aguardando_nome_lider') {
                    state.data.nomeLider = textoMsg;
                    state.stage = 'admin_aguardando_data_evento';
                    await sock.sendMessage(remoteJid, { text: `👤 Líder "${textoMsg}" registrado. Para finalizar, qual a *Data do Evento*? (ex: 03/10/2025)` });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_aguardando_data_evento') {
                    state.data.dataEvento = textoMsg;
                    await sock.sendMessage(remoteJid, { text: `Salvando... ⏳` });
                    const doc = await loadSpreadsheet();
                    const sheetEventos = doc.sheetsByTitle['Eventos'];
                    const novasLinhas = state.data.cpfs.map(cpf => ({ 'CPF (xxx.xxx.xxx-xx)': cpf, 'NomeEvento': state.data.nomeEvento, 'NomeLider': state.data.nomeLider, 'DataEvento': state.data.dataEvento }));
                    await sheetEventos.addRows(novasLinhas);
                    delete userState[contato];
                    await sock.sendMessage(remoteJid, { text: `🎉 *Sucesso!* ${state.data.cpfs.length} participantes foram cadastrados para a pesquisa do evento "${state.data.nomeEvento}".${footer}` });
                }
                else if (state.stage === 'admin_perfil_pede_cpf') {
                    const cpfBusca = validarEFormatarCPF(textoMsg);
                    if (!cpfBusca.valido) { await sock.sendMessage(remoteJid, { text: `❌ CPF inválido. ${cpfBusca.motivo} Tente novamente.` }); setConversationTimeout(contato, remoteJid); return; }
                    const doc = await loadSpreadsheet();
                    const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                    const rows = await sheetCadastros.getRows();
                    const usuarioParaAlterar = rows.find(row => row['CPF (xxx.xxx.xxx-xx)'] === cpfBusca.cpfFormatado);
                    if (!usuarioParaAlterar) { await sock.sendMessage(remoteJid, { text: '❌ CPF não encontrado na base de cadastros. Tente novamente.' }); setConversationTimeout(contato, remoteJid); return; }
                    state.stage = 'admin_perfil_pede_novo_perfil';
                    state.data = { usuario: usuarioParaAlterar };
                    let perfisTexto = `Encontrei este usuário:\n*Nome:* ${usuarioParaAlterar.NomeCompleto}\n*Perfil Atual:* ${usuarioParaAlterar.Perfil}\n\nPara qual perfil você deseja alterá-lo? Responda com o número:\n`;
                    PERFIS_DISPONIVEIS.forEach((perfil, index) => { perfisTexto += `*${index + 1}.* ${perfil}\n`; });
                    await sock.sendMessage(remoteJid, { text: perfisTexto });
                    setConversationTimeout(contato, remoteJid);
                } else if (state.stage === 'admin_perfil_pede_novo_perfil') {
                    const escolha = parseInt(textoMsg);
                    if (!isNaN(escolha) && escolha > 0 && escolha <= PERFIS_DISPONIVEIS.length) {
                        const novoPerfil = PERFIS_DISPONIVEIS[escolha - 1];
                        const usuarioParaAlterar = state.data.usuario;
                        usuarioParaAlterar.Perfil = novoPerfil;
                        await usuarioParaAlterar.save();
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: `✅ Perfil de *${usuarioParaAlterar.NomeCompleto}* alterado para *${novoPerfil}* com sucesso!${footer}` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: `Opção inválida. Escolha um número de 1 a ${PERFIS_DISPONIVEIS.length}.` });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
                else if (state.stage === 'admin_blacklist_pede_cpf') {
                    if (resposta === 'cancelar') { delete userState[contato]; await sock.sendMessage(remoteJid, { text: 'Ação cancelada.' }); return; }
                    const resultadoValidacao = validarEFormatarCPF(textoMsg);
                    if (!resultadoValidacao.valido) { await sock.sendMessage(remoteJid, { text: `❌ CPF inválido. ${resultadoValidacao.motivo} Tente novamente ou digite 'cancelar'.` }); setConversationTimeout(contato, remoteJid); return; }
                    const doc = await loadSpreadsheet();
                    const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                    const rows = await sheetCadastros.getRows();
                    const usuarioBlacklist = rows.find(row => row['CPF (xxx.xxx.xxx-xx)'] === resultadoValidacao.cpfFormatado);
                    if (!usuarioBlacklist) { await sock.sendMessage(remoteJid, { text: 'Este CPF não foi encontrado na base de cadastros. Tente outro CPF ou digite "cancelar".' }); setConversationTimeout(contato, remoteJid); return; }
                    state.data = { cpf: resultadoValidacao.cpfFormatado, nome: usuarioBlacklist.NomeCompleto };
                    state.stage = 'admin_blacklist_pede_motivo';
                    await sock.sendMessage(remoteJid, { text: `Encontrei *${state.data.nome}*. Qual o motivo para adicioná-lo(a) à blacklist? (Digite o motivo ou 'cancelar')` });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_blacklist_pede_motivo') {
                    if (resposta === 'cancelar') { delete userState[contato]; await sock.sendMessage(remoteJid, { text: 'Ação cancelada.' }); return; }
                    state.data.motivo = textoMsg;
                    state.stage = 'admin_blacklist_confirma';
                    const confirmMsg = `Confirma a inclusão de:\n\n*Nome:* ${state.data.nome}\n*CPF:* ${state.data.cpf}\n*Motivo:* ${state.data.motivo}\n\nNa blacklist? (Responda 'Sim' ou 'Não')`;
                    await sock.sendMessage(remoteJid, { text: confirmMsg });
                    setConversationTimeout(contato, remoteJid);
                }
                else if (state.stage === 'admin_blacklist_confirma') {
                    if (['sim', 's'].includes(resposta)) {
                        const doc = await loadSpreadsheet();
                        const sheetBlacklist = doc.sheetsByTitle['Blacklist'];
                        await sheetBlacklist.addRow({ 'CPF': state.data.cpf, 'Nome Completo': state.data.nome, 'Data de Inclusão': new Date().toLocaleDateString('pt-BR'), 'Quem Incluiu': usuario.NomeCompleto, 'Motivo': state.data.motivo, });
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: `✅ *${state.data.nome}* foi adicionado(a) à blacklist com sucesso.` });
                    } else {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: 'Ação cancelada.' });
                    }
                }
                // FLUXOS DE USUÁRIO (CADASTRO E PESQUISA)
                else if (state.stage === 'aguardandoCPF') {
                    const resultadoValidacao = validarEFormatarCPF(textoMsg);
                    if (!resultadoValidacao.valido) { await sock.sendMessage(remoteJid, { text: `❌ CPF inválido. ${resultadoValidacao.motivo} Por favor, tente novamente.` }); setConversationTimeout(contato, remoteJid); return; }
                    state.data.cpf = resultadoValidacao.cpfFormatado;
                    state.stage = 'aguardandoConfirmacaoCPF';
                    await sock.sendMessage(remoteJid, { text: `📄 O CPF digitado foi: *${resultadoValidacao.cpfFormatado}*. Está correto? (Responda 'Sim' ou 'Não')` });
                    setConversationTimeout(contato, remoteJid);
                } else if (state.stage === 'aguardandoConfirmacaoCPF') {
                    if (['sim', 's', 'correto'].includes(resposta)) {
                        state.stage = 'aguardandoNome';
                        await sock.sendMessage(remoteJid, { text: '👍 Ótimo! Agora, por favor, digite seu *Nome Completo*.' });
                        setConversationTimeout(contato, remoteJid);
                    } else if (['não', 'nao', 'n'].includes(resposta)) {
                        state.stage = 'aguardandoCPF';
                        await sock.sendMessage(remoteJid, { text: 'Ok, vamos tentar de novo. Por favor, digite seu CPF novamente.' });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Resposta inválida. Por favor, digite 'Sim' ou 'Não'." });
                        setConversationTimeout(contato, remoteJid);
                    }
                } else if (state.stage === 'aguardandoNome') {
                    state.data.nome = textoMsg;
                    state.stage = 'aguardandoTelefone';
                    await sock.sendMessage(remoteJid, { text: '✅ Nome registrado. Para finalizar, digite seu *telefone com DDD*.' });
                    setConversationTimeout(contato, remoteJid);
                } else if (state.stage === 'aguardandoTelefone') {
                    state.data.telefone = textoMsg.replace(/\D/g, '');
                    const doc = await loadSpreadsheet();
                    const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                    await sheetCadastros.addRow({ 'CPF (xxx.xxx.xxx-xx)': state.data.cpf, 'NomeCompleto': state.data.nome, 'TelefoneInformado': state.data.telefone, 'IDContatoWhatsApp': contato, 'Perfil': 'FREELANCER' });
                    await sock.sendMessage(remoteJid, { text: '🎉 Cadastro finalizado! Obrigado. Vou verificar se há pesquisas para você.' });
                    const novoUsuarioCadastrado = await obterUsuario(contato);
                    delete userState[contato];
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    await iniciarFluxoDePesquisa(contato, remoteJid, novoUsuarioCadastrado);
                } 
                else if (state.stage === 'aguardandoNota') {
                    const nota = parseInt(textoMsg);
                    if (!isNaN(nota) && nota >= 0 && nota <= 10) {
                        const linhaParaAtualizar = state.data;
                        linhaParaAtualizar.Nota = nota;
                        linhaParaAtualizar.DataResposta = new Date().toLocaleDateString('pt-BR');
                        linhaParaAtualizar.PesquisaEnviada = 'TRUE';
                        await linhaParaAtualizar.save();
                        const cpfDoUsuario = linhaParaAtualizar['CPF (xxx.xxx.xxx-xx)'];
                        const doc = await loadSpreadsheet();
                        const sheetEventos = doc.sheetsByTitle['Eventos'];
                        const rows = await sheetEventos.getRows();
                        const pesquisasRestantes = rows.filter(row => (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario && (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
                        if (pesquisasRestantes.length > 0) {
                            userState[contato] = { stage: 'aguardandoContinuar', data: { cpf: cpfDoUsuario } };
                            const perguntaContinuar = `✅ Avaliação registrada! Notamos que você tem mais pesquisas pendentes. Deseja avaliar outro evento agora? (Responda 'Sim' ou 'Não')`;
                            await sock.sendMessage(remoteJid, { text: perguntaContinuar });
                            setConversationTimeout(contato, remoteJid);
                        } else {
                            delete userState[contato];
                            await sock.sendMessage(remoteJid, { text: `✅ Muito obrigado! Todas as suas pesquisas foram concluídas. ✨${footer}` });
                        }
                    } else {
                        await sock.sendMessage(remoteJid, { text: '❌ Ops! Por favor, envie apenas um número de 0 a 10. 😉' });
                        setConversationTimeout(contato, remoteJid);
                    }
                } else if (state.stage === 'aguardandoEscolhaEvento') {
                    const escolha = parseInt(textoMsg);
                    if (!isNaN(escolha) && escolha > 0 && escolha <= state.data.length) {
                        const eventoEscolhido = state.data[escolha - 1];
                        userState[contato] = { stage: 'aguardandoNota', data: eventoEscolhido };
                        await sock.sendMessage(remoteJid, { text: `Ótimo! 👍 Para o evento "${eventoEscolhido.NomeEvento}", qual nota de 0 a 10 você daria para o líder *${eventoEscolhido.NomeLider}*?` });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: `❌ Por favor, responda com um número válido entre 1 e ${state.data.length}.` });
                        setConversationTimeout(contato, remoteJid);
                    }
                } else if (state.stage === 'aguardandoContinuar') {
                    if (['sim', 's', 'quero'].includes(resposta)) {
                        delete userState[contato];
                        await iniciarFluxoDePesquisa(contato, remoteJid, state.data.cpf);
                    } else if (['não', 'nao', 'n'].includes(resposta)) {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: `Tudo bem! Agradecemos seu tempo. Tenha um ótimo dia! 👋${footer}` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Resposta inválida. Por favor, digite 'Sim' ou 'Não'." });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
            } else {
                // Se não há estado, é uma nova conversa. Roteamos por perfil.
                if (perfil === 'ADMIN_GERAL' || perfil === 'LIDER_EVENTO') {
                    const menuAdmin = `Olá, ${usuario.NomeCompleto.split(' ')[0]}! 👋\n*Perfil: ${perfil}*\n\nSelecione uma opção:\n\n*1.* Visualizar Resultados\n*2.* Cadastrar Nova Pesquisa\n*3.* Alterar Perfil de Usuário\n*4.* Gerenciar Blacklist\n*0.* Sair`;
                    userState[contato] = { stage: 'admin_menu' };
                    await sock.sendMessage(remoteJid, { text: menuAdmin });
                    setConversationTimeout(contato, remoteJid);
                } else if (perfil === 'COORDENADOR') {
                    // Placeholder para o menu do Coordenador
                    await sock.sendMessage(remoteJid, { text: `Olá, ${usuario.NomeCompleto.split(' ')[0]}! Seu perfil de Coordenador está ativo. As funções de credenciamento serão implementadas em breve.` });
                } else if (perfil === 'FREELANCER') {
                    await iniciarFluxoDePesquisa(contato, remoteJid, usuario);
                } else {
                    // Usuário não encontrado na base, iniciar cadastro
                    userState[contato] = { stage: 'aguardandoCPF', data: {} };
                    const msgBoasVindas = '*FABINHO EVENTOS*\n\nOlá! 👋 Para acessar nosso sistema, precisamos fazer um rápido cadastro.\n\nPor favor, digite seu *CPF* (apenas os números).';
                    await sock.sendMessage(remoteJid, { text: msgBoasVindas });
                    setConversationTimeout(contato, remoteJid);
                }
            }
        } catch (error) {
            console.error(`[ERRO GERAL] Falha ao processar mensagem de ${contato}:`, error);
        }
    });
}

connectToWhatsApp();

// ==================================================================
// BLOCO 4 de 4: API do Dashboard e Inicialização do Servidor
// ==================================================================

// 4. API PARA O DASHBOARD (EXPRESS)
app.get('/api/dados', async (req, res) => {
    try {
        const doc = await loadSpreadsheet();
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        const rows = await sheetEventos.getRows();
        const dados = rows.map(row => ({
            CPF: row['CPF (xxx.xxx.xxx-xx)'],
            NomeEvento: row.NomeEvento,
            NomeLider: row.NomeLider,
            PesquisaEnviada: row.PesquisaEnviada,
            Nota: row.Nota,
            DataResposta: row.DataResposta,
        }));
        res.json(dados);
    } catch (error) {
        console.error('Erro na rota /api/dados:', error);
        res.status(500).json({ error: 'Erro ao buscar dados da planilha.' });
    }
});

app.get('/api/estatisticas', async (req, res) => {
    try {
        const ranking = await gerarRelatorioDeLideres();
        const doc = await loadSpreadsheet();
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        const rows = await sheetEventos.getRows();
        
        const respondidas = rows.filter(row => (row.PesquisaEnviada || '').toUpperCase() === 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
        const totalCadastros = rows.filter(row => (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL').length;
        const totalRespondidas = respondidas.length;
        
        const estatisticasLideres = ranking.reduce((acc, lider) => {
            acc[lider.lider] = {
                media: lider.media,
                totalRespostas: lider.totalVotos
            };
            return acc;
        }, {});

        res.json({
            totalCadastros,
            totalRespondidas,
            estatisticasLideres: estatisticasLideres
        });

    } catch (error) {
        console.error('Erro na rota /api/estatisticas:', error);
        res.status(500).json({ error: 'Erro ao calcular estatísticas.' });
    }
});

// Rota de verificação simples para saber se o servidor está online
app.get('/', (req, res) => {
    res.send('Servidor do Bot de Pesquisa está online!');
});


// 5. INICIALIZAÇÃO DO SERVIDOR WEB
app.listen(PORT, () => {
    console.log(`[SERVIDOR] Dashboard e Bot iniciados na porta ${PORT}`);
});