// ==================================================================
// ARQUIVO: index.js (Versão Final e Completa - API Oficial da Meta)
// ==================================================================

// 1. IMPORTAÇÕES E CONFIGURAÇÃO
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SPREADSHEET_ID = '1wSHcp496Wwpmcx3ANoF6UWai0qh0D-ccWsC0hSxWRrM';
const CONVERSATION_TIMEOUT = 3 * 60 * 1000;

// Carrega as credenciais do ambiente do Render
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

let credenciais;
try {
    credenciais = require('./credentials.json');
} catch (error) {
    console.error('ERRO FATAL: Arquivo "credentials.json" não encontrado.');
    process.exit(1);
}

let userState = {};
let userTimeouts = {};

// ==================================================================
// 2. FUNÇÕES DE APOIO
// ==================================================================

function clearConversationTimeout(contato) { if (userTimeouts[contato]) { clearTimeout(userTimeouts[contato]); delete userTimeouts[contato]; } }
function setConversationTimeout(contato) { clearConversationTimeout(contato); userTimeouts[contato] = setTimeout(() => { delete userState[contato]; delete userTimeouts[contato]; console.log(`[TIMEOUT] Conversa com ${contato} encerrada.`); enviarMensagem(contato, { text: { body: '⏳ Sua sessão foi encerrada por inatividade. Envie uma nova mensagem se quiser recomeçar. 👋' } }); }, CONVERSATION_TIMEOUT); }
async function loadSpreadsheet() { const doc = new GoogleSpreadsheet(SPREADSHEET_ID); await doc.useServiceAccountAuth(credenciais); await doc.loadInfo(); return doc; }
function formatarCPF(cpf) { const cpfLimpo = cpf.replace(/\D/g, ''); if (cpfLimpo.length !== 11) return null; return cpfLimpo.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4'); }

async function enviarMensagem(para, mensagem) {
    console.log(`[ENVIO MSG] Para: ${para}`);
    try {
        await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp",
            to: para,
            ...mensagem
        }, {
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
    } catch (error) {
        console.error("Erro ao enviar mensagem:", error.response ? error.response.data : error.message);
    }
}

async function verificarStatusAdmin(contato) { /* ... (sem alterações) ... */ }
async function gerarRelatorioDeLideres() { /* ... (sem alterações) ... */ }
function formatarRelatorioParaWhatsApp(ranking) { /* ... (sem alterações) ... */ }
async function iniciarFluxoDePesquisa(contato, cpfDoUsuario) { /* ... (sem alterações, mas usando a nova função enviarMensagem) ... */ }

// ... (Copie e cole TODAS as suas funções de apoio aqui, adaptando sock.sendMessage para enviarMensagem)
// Para sua conveniência, aqui estão elas já adaptadas:

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

async function iniciarFluxoDePesquisa(contato, cpfDoUsuario) {
    try {
        const doc = await loadSpreadsheet();
        const sheetEventos = doc.sheetsByTitle['Eventos'];
        if (!sheetEventos) { console.error("ERRO: A aba 'Eventos' não foi encontrada."); return; }
        const rowsEventos = await sheetEventos.getRows();
        const pesquisasPendentes = rowsEventos.filter(row => (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario && (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
        const footer = '\n\n\n*_powered by Fabinho Eventos_*';

        if (pesquisasPendentes.length === 0) {
            const saudacao = userState[contato]?.stage === 'cadastroFinalizado' ? '' : 'Olá! 👋 ';
            const msg = `${saudacao}Verificamos aqui e não há pesquisas pendentes para você no momento. Obrigado! 😊${footer}`;
            await enviarMensagem(contato, { text: { body: msg } });
            delete userState[contato];
            return;
        }
        if (pesquisasPendentes.length === 1) {
            const pesquisa = pesquisasPendentes[0];
            userState[contato] = { stage: 'aguardandoNota', data: pesquisa };
            const pergunta = `Olá! 👋 Vimos que você tem uma pesquisa pendente para o evento "${pesquisa.NomeEvento}".\n\nPara nos ajudar a melhorar, poderia avaliar o líder *${pesquisa.NomeLider}* com uma nota de 0 a 10? ✨`;
            await enviarMensagem(contato, { text: { body: pergunta } });
            setConversationTimeout(contato);
        } else {
            userState[contato] = { stage: 'aguardandoEscolhaEvento', data: pesquisasPendentes };
            let textoEscolha = 'Olá! 👋 Vimos que você tem mais de uma pesquisa pendente. Por favor, escolha qual evento gostaria de avaliar respondendo com o número correspondente:\n\n';
            pesquisasPendentes.forEach((pesquisa, index) => {
                textoEscolha += `${index + 1}️⃣ Evento: *${pesquisa.NomeEvento}* (Líder: ${pesquisa.NomeLider})\n`;
            });
            await enviarMensagem(contato, { text: { body: textoEscolha } });
            setConversationTimeout(contato);
        }
    } catch (error) {
        console.error("Erro ao iniciar fluxo de pesquisa:", error);
    }
}


// ==================================================================
// 3. LÓGICA PRINCIPAL DO BOT (WEBHOOKS)
// ==================================================================

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}.`));

// Rota para a verificação do Webhook (GET)
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);
        console.log("Webhook verificado com sucesso!");
    } else {
        res.sendStatus(403);
    }
});

// Rota para receber as mensagens do WhatsApp (POST)
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const message = change?.value?.messages?.[0];

        if (!message) {
            res.sendStatus(200);
            return;
        }

        const contato = message.from;
        let textoMsg = '';

        if (message.type === 'text') {
            textoMsg = message.text.body.trim();
        } else if (message.type === 'interactive' && message.interactive.type === 'button_reply') {
            textoMsg = message.interactive.button_reply.id;
        } else {
            res.sendStatus(200); // Ignora outros tipos de mensagem (áudio, imagem, etc.)
            return;
        }
        
        console.log(`[MSG RECEBIDA] De: ${contato} | Texto/Botão: "${textoMsg}"`);
        clearConversationTimeout(contato);

        const isAdmin = await verificarStatusAdmin(contato);
        if (isAdmin) {
            console.log(`[AUTH] Usuário ${contato} identificado como Administrador.`);
            const ranking = await gerarRelatorioDeLideres();
            const relatorioFormatado = formatarRelatorioParaWhatsApp(ranking);
            await enviarMensagem(contato, { text: { body: `Olá, Administrador! 👋 Aqui está seu relatório de desempenho:\n\n${relatorioFormatado}` } });
            res.sendStatus(200);
            return;
        }

        const state = userState[contato];
        const footer = '\n\n\n*_powered by Fabinho Eventos_*';
        const resposta = textoMsg.toLowerCase();

        if (state) {
            if (state.stage === 'aguardandoCPF') {
                const cpfFormatado = formatarCPF(textoMsg);
                if (!cpfFormatado) {
                    await enviarMensagem(contato, { text: { body: '❌ CPF inválido. Por favor, digite apenas os 11 números do seu CPF.' } });
                    setConversationTimeout(contato); return;
                }
                state.data.cpf = cpfFormatado;
                state.stage = 'aguardandoConfirmacaoCPF';
                const botoes = { type: "button", body: { text: `📄 O CPF digitado foi: *${cpfFormatado}*. Está correto?` }, action: { buttons: [{ type: "reply", reply: { id: "sim_cpf", title: "👍 Sim" } }, { type: "reply", reply: { id: "nao_cpf", title: "✏️ Não" } }]}};
                await enviarMensagem(contato, { type: "interactive", interactive: botoes });
                setConversationTimeout(contato);
            } else if (state.stage === 'aguardandoConfirmacaoCPF') {
                if (resposta === 'sim_cpf' || ['sim', 's'].includes(resposta)) {
                    state.stage = 'aguardandoNome';
                    await enviarMensagem(contato, { text: { body: '👍 Ótimo! Agora, por favor, digite seu *Nome Completo*.' } });
                    setConversationTimeout(contato);
                } else {
                    state.stage = 'aguardandoCPF';
                    await enviarMensagem(contato, { text: { body: 'Ok, vamos tentar de novo. Por favor, digite seu CPF novamente.' } });
                    setConversationTimeout(contato);
                }
            } else if (state.stage === 'aguardandoNome') {
                state.data.nome = textoMsg;
                state.stage = 'aguardandoTelefone';
                await enviarMensagem(contato, { text: { body: '✅ Nome registrado. Para finalizar, digite seu número de *telefone com DDD*.' } });
                setConversationTimeout(contato);
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
                await enviarMensagem(contato, { text: { body: '🎉 Cadastro finalizado com sucesso! Vou verificar se há alguma pesquisa para você.' } });
                userState[contato] = { stage: 'cadastroFinalizado', data: { cpf: state.data.cpf } };
                await new Promise(resolve => setTimeout(resolve, 1500));
                await iniciarFluxoDePesquisa(contato, state.data.cpf);
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
                    const pesquisasRestantes = rows.filter(row => (row['CPF (xxx.xxx.xxx-xx)'] || '').trim() === cpfDoUsuario && (row.PesquisaEnviada || '').toUpperCase() !== 'TRUE' && (row.NomeEvento || '').trim() !== 'ADMINISTRACAOGERAL');
                    
                    if (pesquisasRestantes.length > 0) {
                        userState[contato] = { stage: 'aguardandoContinuar', data: { cpf: cpfDoUsuario } };
                        const botoes = { type: "button", body: { text: `✅ Avaliação registrada! Notamos que você tem mais pesquisas pendentes. Deseja avaliar outro evento agora?` }, action: { buttons: [{ type: "reply", reply: { id: "sim_continuar", title: "👍 Sim, por favor" } }, { type: "reply", reply: { id: "nao_continuar", title: "👎 Não, obrigado" } }]}};
                        await enviarMensagem(contato, { type: "interactive", interactive: botoes });
                        setConversationTimeout(contato);
                    } else {
                        await enviarMensagem(contato, { text: { body: `✅ Muito obrigado! Todas as suas pesquisas foram concluídas. ✨${footer}` } });
                    }
                } else {
                    await enviarMensagem(contato, { text: { body: '❌ Ops! Por favor, envie apenas um número de 0 a 10. 😉' } });
                    setConversationTimeout(contato);
                }
            } else if (state.stage === 'aguardandoEscolhaEvento') {
                const escolha = parseInt(textoMsg);
                if (!isNaN(escolha) && escolha > 0 && escolha <= state.data.length) {
                    const eventoEscolhido = state.data[escolha - 1];
                    userState[contato] = { stage: 'aguardandoNota', data: eventoEscolhido };
                    await enviarMensagem(contato, { text: { body: `Ótimo! 👍 Para o evento "${eventoEscolhido.NomeEvento}", qual nota de 0 a 10 você daria para o líder *${eventoEscolhido.NomeLider}*?` } });
                    setConversationTimeout(contato);
                } else {
                    await enviarMensagem(contato, { text: { body: `❌ Por favor, responda com um número válido entre 1 e ${state.data.length}.` } });
                    setConversationTimeout(contato);
                }
            } else if (state.stage === 'aguardandoContinuar') {
                if (resposta === 'sim_continuar' || ['sim', 's'].includes(resposta)) {
                    delete userState[contato];
                    await iniciarFluxoDePesquisa(contato, state.data.cpf);
                } else {
                    delete userState[contato];
                    await enviarMensagem(contato, { text: { body: `Tudo bem! Agradecemos seu tempo. Tenha um ótimo dia! 👋${footer}` } });
                }
            }
        } else {
            const doc = await loadSpreadsheet();
            const sheetCadastros = doc.sheetsByTitle['Cadastros'];
            if (!sheetCadastros) { console.error("ERRO: A aba 'Cadastros' não foi encontrada."); res.sendStatus(500); return; }
            const rowsCadastros = await sheetCadastros.getRows();
            const usuarioCadastrado = rowsCadastros.find(row => row.IDContatoWhatsApp === contato);

            if (usuarioCadastrado) {
                await iniciarFluxoDePesquisa(contato, usuarioCadastrado['CPF (xxx.xxx.xxx-xx)']);
            } else {
                userState[contato] = { stage: 'aguardandoCPF', data: {} };
                const msgBoasVindas = '*FABINHO EVENTOS*\n\nOlá! 👋 Seja bem-vindo(a) ao nosso sistema de pesquisas. Para começarmos, precisamos fazer um rápido cadastro.\n\nPor favor, digite seu *CPF* (apenas os números).';
                await enviarMensagem(contato, { text: { body: msgBoasVindas } });
                setConversationTimeout(contato);
            }
        }
    } catch (error) {
        console.error("Erro no processamento do webhook:", error);
    }

    res.sendStatus(200);
});