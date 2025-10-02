// ==================================================================
// ARQUIVO: index.js (Versão Final com Persistência via Redis)
// ==================================================================

// 1. IMPORTAÇÕES E CONFIGURAÇÃO
const { default: makeWASocket, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const Redis = require('ioredis');

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1wSHcp496Wwpmcx3ANoF6UWai0qh0D-ccWsC0hSxWRrM';
const CONVERSATION_TIMEOUT = 3 * 60 * 1000; // 3 minutos

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
    // Para testes locais, descomente e cole sua URL aqui:
    // process.env.UPSTASH_REDIS_URL = "redis://:...@us1-intense-....upstash.io:32014";
    if (!process.env.UPSTASH_REDIS_URL) process.exit(1);
}
const redis = new Redis(process.env.UPSTASH_REDIS_URL);
const REDIS_SESSION_KEY = "baileys-session";

const app = express();
app.use(express.static('public'));
let sock;
let userState = {};
let userTimeouts = {};

// ==================================================================
// 2. FUNÇÕES DE APOIO
// ==================================================================

function clearConversationTimeout(contato) {
    if (userTimeouts[contato]) {
        clearTimeout(userTimeouts[contato]);
        delete userTimeouts[contato];
    }
}

function setConversationTimeout(contato, remoteJid) {
    clearConversationTimeout(contato);
    userTimeouts[contato] = setTimeout(() => {
        delete userState[contato];
        delete userTimeouts[contato];
        console.log(`[TIMEOUT] Conversa com ${contato} encerrada por inatividade.`);
        sock.sendMessage(remoteJid, { text: '⏳ Sua sessão foi encerrada por inatividade. Envie uma nova mensagem se quiser recomeçar. 👋' });
    }, CONVERSATION_TIMEOUT);
}

async function loadSpreadsheet() {
    const doc = new GoogleSpreadsheet(SPREADSHEET_ID);
    await doc.useServiceAccountAuth(credenciais);
    await doc.loadInfo();
    return doc;
}

function formatarCPF(cpf) {
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) return null;
    return cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

async function verificarStatusAdmin(contato) {
    try {
        const doc = await loadSpreadsheet();
        const sheetCadastros = doc.sheetsByTitle['Cadastros'];
        if (!sheetCadastros) return false;
        const rowsCadastros = await sheetCadastros.getRows();
        const usuarioCadastrado = rowsCadastros.find(row => row.IDContatoWhatsApp === contato);
        if (!usuarioCadastrado) return false;
        const cpfDoUsuario = usuarioCadastrado['CPF (xxx.xxx.xxx-xx)'];
        if (!cpfDoUsuario) return false;
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        if (!sheetEventos) return false;
        const rowsEventos = await sheetEventos.getRows();
        const isAdminEntry = rowsEventos.find(row =>
            (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario &&
            (row.NomeEvento || '').trim() === 'ADMINISTRACAOGERAL'
        );
        return !!isAdminEntry;
    } catch (error) {
        console.error("Erro ao verificar status de admin:", error);
        return false;
    }
}

async function gerarRelatorioDeLideres() {
    const doc = await loadSpreadsheet();
    const sheetEventos = doc.sheetsByTitle['Eventos'];
    const rows = await sheetEventos.getRows();
    const respondidas = rows.filter(row =>
        (row.PesquisaEnviada || '').toUpperCase() === 'TRUE' &&
        row.Nota &&
        (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL'
    );
    const dadosLideres = respondidas.reduce((acc, row) => {
        const lider = row.NomeLider;
        const nota = parseInt(row.Nota);
        if (!lider || isNaN(nota)) return acc;
        if (!acc[lider]) {
            acc[lider] = { lider: lider, notas: [], totalVotos: 0, media: 0 };
        }
        acc[lider].notas.push(nota);
        acc[lider].totalVotos++;
        return acc;
    }, {});
    const ranking = Object.values(dadosLideres).map(liderData => {
        const soma = liderData.notas.reduce((a, b) => a + b, 0);
        liderData.media = (soma / liderData.totalVotos).toFixed(2);
        delete liderData.notas;
        return liderData;
    });
    ranking.sort((a, b) => b.media - a.media);
    return ranking;
}

function formatarRelatorioParaWhatsApp(ranking) {
    let relatorio = '📊 *Relatório de Desempenho dos Líderes* 📊\n\n';
    const medalhas = ['🥇', '🥈', '🥉'];
    if (ranking.length === 0) {
        return 'Nenhuma avaliação foi computada ainda para gerar um relatório.';
    }
    ranking.forEach((lider, index) => {
        const posicao = index + 1;
        const medalha = medalhas[index] || `${posicao}️⃣`;
        relatorio += `${medalha} *${lider.lider}*\n`;
        relatorio += `   - Nota Média: *${lider.media}*\n`;
        relatorio += `   - Total de Votos: *${lider.totalVotos}*\n\n`;
    });
    return relatorio;
}

async function iniciarFluxoDePesquisa(contato, remoteJid, cpfDoUsuario) {
    try {
        const doc = await loadSpreadsheet();
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        if (!sheetEventos) { console.error("ERRO: A aba 'Eventos' não foi encontrada."); return; }
        const rowsEventos = await sheetEventos.getRows();
        const pesquisasPendentes = rowsEventos.filter(row =>
            (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario &&
            (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' &&
            (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL'
        );
        const footer = '\n\n\n*_powered by Fabinho Eventos_*';
        if (pesquisasPendentes.length === 0) {
            const saudacao = userState[contato]?.stage === 'cadastroFinalizado' ? '' : 'Olá! 👋 ';
            const msg = `${saudacao}Verificamos aqui e não há pesquisas pendentes para você no momento. Obrigado! 😊${footer}`;
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
            pesquisasPendentes.forEach((pesquisa, index) => {
                textoEscolha += `${index + 1}️⃣ Evento: *${pesquisa.NomeEvento}* (Líder: ${pesquisa.NomeLider})\n`;
            });
            await sock.sendMessage(remoteJid, { text: textoEscolha });
            setConversationTimeout(contato, remoteJid);
        }
    } catch (error) {
        console.error("Erro ao iniciar fluxo de pesquisa:", error);
    }
}

// ==================================================================
// 3. CONEXÃO E LÓGICA PRINCIPAL DO BOT
// ==================================================================
async function connectToWhatsApp() {
    let savedState;
    try {
        const session = await redis.get(REDIS_SESSION_KEY);
        if (session) {
            savedState = JSON.parse(session, (key, value) => {
                if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
                    return Buffer.from(value.data);
                }
                return value;
            });
            console.log("[REDIS] Sessão restaurada do Redis.");
        }
    } catch (e) {
        console.error("[REDIS] Falha ao restaurar sessão:", e);
    }

    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version,
        auth: {
            creds: savedState?.creds || { noiseKey: null, signedIdentityKey: null, signedPreKey: null, registrationId: null, advSecretKey: null, nextPreKeyId: null, firstUnuploadedPreKeyId: null, accountSyncCounter: null, accountSettings: null, appStateSyncKey: {}, appStateVersions: {}, deviceId: null, accountId: null, registered: null, backupToken: null, registration: null, mutualUpgrade: null, signalIdentities: [], me: null, platform: null },
            keys: savedState?.keys || {},
        },
        logger: pino({ level: 'trace' }),
        browser: Browsers.macOS('Desktop'),
        shouldSyncHistoryWithSingleMsg: true,
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('[WHATSAPP] QR Code recebido, escaneie abaixo:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = (lastDisconnect.error = new Boom(lastDisconnect.error))?.output?.statusCode;
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

    sock.ev.on('creds.update', async () => {
        const newState = { creds: sock.authState.creds, keys: sock.authState.keys };
        const json = JSON.stringify(newState, (key, value) => {
            if (value instanceof Buffer) {
                return { type: 'Buffer', data: value.toJSON().data };
            }
            return value;
        });
        await redis.set(REDIS_SESSION_KEY, json);
        console.log("[REDIS] Sessão salva no Redis.");
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const remoteJid = msg.key.remoteJid;
        const contato = remoteJid.split('@')[0];
        let textoMsg = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const idBotao = msg.message.buttonsResponseMessage?.selectedButtonId;
        if (idBotao) textoMsg = idBotao;
        console.log(`[MSG RECEBIDA] De: ${contato} | Texto/Botão: "${textoMsg}"`);
        
        clearConversationTimeout(contato);

        try {
            const isAdmin = await verificarStatusAdmin(contato);
            if (isAdmin) {
                console.log(`[AUTH] Usuário ${contato} identificado como Administrador. Gerando relatório...`);
                await sock.sendMessage(remoteJid, { text: 'Olá, Administrador! 👋 Gerando seu relatório de desempenho, por favor, aguarde...' });
                const ranking = await gerarRelatorioDeLideres();
                const relatorioFormatado = formatarRelatorioParaWhatsApp(ranking);
                await sock.sendMessage(remoteJid, { text: relatorioFormatado });
                return;
            }

            const state = userState[contato];
            const footer = '\n\n\n*_powered by Fabinho Eventos_*';
            const resposta = textoMsg.toLowerCase();

            if (state) {
                if (state.stage === 'aguardandoCPF') {
                    const cpfFormatado = formatarCPF(textoMsg);
                    if (!cpfFormatado) {
                        await sock.sendMessage(remoteJid, { text: '❌ CPF inválido. Por favor, digite apenas os 11 números do seu CPF.' });
                        setConversationTimeout(contato, remoteJid);
                        return;
                    }
                    state.data.cpf = cpfFormatado;
                    state.stage = 'aguardandoConfirmacaoCPF';
                    const buttons = [{ buttonId: 'sim_cpf', buttonText: { displayText: '👍 Sim' }, type: 1 }, { buttonId: 'nao_cpf', buttonText: { displayText: '✏️ Não' }, type: 1 }];
                    const buttonMessage = { text: `📄 O CPF digitado foi: *${cpfFormatado}*. Está correto?`, buttons: buttons, headerType: 1 };
                    await sock.sendMessage(remoteJid, buttonMessage);
                    setConversationTimeout(contato, remoteJid);
                } else if (state.stage === 'aguardandoConfirmacaoCPF') {
                    if (resposta === 'sim_cpf' || ['sim', 's', 'correto'].includes(resposta)) {
                        state.stage = 'aguardandoNome';
                        await sock.sendMessage(remoteJid, { text: '👍 Ótimo! Agora, por favor, digite seu *Nome Completo*.' });
                        setConversationTimeout(contato, remoteJid);
                    } else if (resposta === 'nao_cpf' || ['não', 'nao', 'n'].includes(resposta)) {
                        state.stage = 'aguardandoCPF';
                        await sock.sendMessage(remoteJid, { text: 'Ok, vamos tentar de novo. Por favor, digite seu CPF novamente.' });
                        setConversationTimeout(contato, remoteJid);
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Por favor, clique em um dos botões ('Sim' ou 'Não') ou digite sua resposta." });
                        setConversationTimeout(contato, remoteJid);
                    }
                } else if (state.stage === 'aguardandoNome') {
                    state.data.nome = textoMsg;
                    state.stage = 'aguardandoTelefone';
                    await sock.sendMessage(remoteJid, { text: '✅ Nome registrado. Para finalizar, por favor, digite seu número de *telefone com DDD* (ex: 62988887777).' });
                    setConversationTimeout(contato, remoteJid);
                } else if (state.stage === 'aguardandoTelefone') {
                    state.data.telefone = textoMsg.replace(/\D/g, '');
                    const doc = await loadSpreadsheet();
                    const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                    await sheetCadastros.addRow({
                        'CPF (xxx.xxx.xxx-xx)': state.data.cpf,
                        'NomeCompleto': state.data.nome,
                        'TelefoneInformado': state.data.telefone,
                        'IDContatoWhatsApp': contato
                    });
                    await sock.sendMessage(remoteJid, { text: '🎉 Cadastro finalizado com sucesso! Obrigado. Vou verificar se há alguma pesquisa para você.' });
                    userState[contato] = { stage: 'cadastroFinalizado', data: { cpf: state.data.cpf } };
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    await iniciarFluxoDePesquisa(contato, remoteJid, state.data.cpf);
                } else if (state.stage === 'aguardandoNota') {
                    const nota = parseInt(textoMsg);
                    if (!isNaN(nota) && nota >= 0 && nota <= 10) {
                        const linhaParaAtualizar = state.data;
                        linhaParaAtualizar.Nota = nota;
                        linhaParaAtualizar.DataResposta = new Date().toLocaleDateString('pt-BR');
                        linhaParaAtualizar.PesquisaEnviada = 'TRUE';
                        await linhaParaAtualizar.save();
                        delete userState[contato];
                        const doc = await loadSpreadsheet();
                        const sheetEventos = doc.sheetsByTitle['Eventos'];
                        const rows = await sheetEventos.getRows();
                        const cpfDoUsuario = linhaParaAtualizar['CPF (xxx.xxx.xxx-xx)'];
                        const pesquisasRestantes = rows.filter(row =>
                            (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario &&
                            (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' &&
                            (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL'
                        );
                        if (pesquisasRestantes.length > 0) {
                            userState[contato] = { stage: 'aguardandoContinuar', data: { cpf: cpfDoUsuario } };
                            const buttons = [{ buttonId: 'sim_continuar', buttonText: { displayText: '👍 Sim, por favor' }, type: 1 }, { buttonId: 'nao_continuar', buttonText: { displayText: '👎 Não, obrigado' }, type: 1 }];
                            const buttonMessage = { text: `✅ Avaliação registrada! Notamos que você tem mais pesquisas pendentes. Deseja avaliar outro evento agora?`, buttons: buttons, headerType: 1 };
                            await sock.sendMessage(remoteJid, buttonMessage);
                            setConversationTimeout(contato, remoteJid);
                        } else {
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
                    if (resposta === 'sim_continuar' || ['sim', 's', 'quero'].includes(resposta)) {
                        delete userState[contato];
                        await iniciarFluxoDePesquisa(contato, remoteJid, state.data.cpf);
                    } else if (resposta === 'nao_continuar' || ['não', 'nao', 'n'].includes(resposta)) {
                        delete userState[contato];
                        await sock.sendMessage(remoteJid, { text: `Tudo bem! Agradecemos seu tempo. Tenha um ótimo dia! 👋${footer}` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: "Por favor, clique em um dos botões ('Sim' ou 'Não') ou digite sua resposta." });
                        setConversationTimeout(contato, remoteJid);
                    }
                }
            } else {
                const doc = await loadSpreadsheet();
                const sheetCadastros = doc.sheetsByTitle['Cadastros'];
                if (!sheetCadastros) { console.error("ERRO: A aba 'Cadastros' não foi encontrada."); return; }
                const rowsCadastros = await sheetCadastros.getRows();
                const usuarioCadastrado = rowsCadastros.find(row => row.IDContatoWhatsApp === contato);

                if (usuarioCadastrado) {
                    await iniciarFluxoDePesquisa(contato, remoteJid, usuarioCadastrado['CPF (xxx.xxx.xxx-xx)']);
                } else {
                    userState[contato] = { stage: 'aguardandoCPF', data: {} };
                    const msgBoasVindas = '*FABINHO EVENTOS*\n\nOlá! 👋 Seja bem-vindo(a) ao nosso sistema de pesquisas. Para começarmos, precisamos fazer um rápido cadastro.\n\nPor favor, digite seu *CPF* (apenas os números).';
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
// 4. API PARA O DASHBOARD (EXPRESS)
// ==================================================================
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

// ==================================================================
// 5. INICIALIZAÇÃO DO SERVIDOR WEB
// ==================================================================
app.listen(PORT, () => {
    console.log(`[SERVIDOR] Dashboard iniciado em http://localhost:${PORT}`);
});