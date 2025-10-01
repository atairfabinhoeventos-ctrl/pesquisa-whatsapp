// ==================================================================
// ARQUIVO: index.js (Versão Revisada para Depuração)
// ==================================================================

// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL
const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const SPREADSHEET_ID = '1wSHcp496Wwpmcx3ANoF6UWai0qh0D-ccWsC0hSxWRrM'; // SEU ID JÁ CONFIGURADO

// Adicionado: Tratamento de erro para o arquivo de credenciais
let credenciais;
try {
    credenciais = require('./credentials.json');
} catch (error) {
    console.error('ERRO FATAL: Arquivo "credentials.json" não encontrado ou mal formatado.');
    console.error('Certifique-se de que o arquivo está na pasta raiz do projeto.');
    process.exit(1); // Encerra o programa se não encontrar as credenciais
}

const app = express();
app.use(express.static('public'));

const aguardandoNota = {};

// ==================================================================
// 2. FUNÇÃO DE ACESSO À PLANILHA GOOGLE (COM MAIS LOGS)
// ==================================================================
async function acessarPlanilha() {
    console.log('[PLANILHA] Autenticando com a API do Google...');
    const serviceAccountAuth = new JWT({
        email: credenciais.client_email,
        key: credenciais.private_key.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
    
    console.log(`[PLANILHA] Carregando informações da planilha (ID: ${SPREADSHEET_ID})...`);
    await doc.loadInfo();
    console.log(`[PLANILHA] Título da planilha carregada: "${doc.title}"`);
    
    return doc.sheetsByIndex[0]; // Retorna a primeira aba
}

// ==================================================================
// 3. LÓGICA DO BOT DO WHATSAPP (COM MAIS LOGS E ROBUSTEZ)
// ==================================================================
console.log('[WHATSAPP] Iniciando cliente...');
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'], // Argumentos para compatibilidade com servidores (Render)
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

client.on('qr', qr => {
    console.log('[WHATSAPP] QR Code gerado. Escaneie com seu celular.');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('[WHATSAPP] Cliente conectado e pronto para receber mensagens!');
});

client.on('auth_failure', msg => {
    console.error('[WHATSAPP] FALHA DE AUTENTICAÇÃO:', msg);
});

client.on('message', async msg => {
    const contato = msg.from;
    const textoMsg = msg.body.trim();
    console.log(`[MSG RECEBIDA] De: ${contato} | Texto: "${textoMsg}"`);

    try {
        // --- FLUXO 1: O usuário está respondendo a uma pergunta de nota ---
        if (aguardandoNota[contato]) {
            console.log(`[FLUXO 1] Contato ${contato} está respondendo uma nota.`);
            const nota = parseInt(textoMsg);
            if (!isNaN(nota) && nota >= 0 && nota <= 10) {
                const linhaParaAtualizar = aguardandoNota[contato];
                
                console.log(`[FLUXO 1] Atualizando planilha para ${contato} com a nota ${nota}.`);
                linhaParaAtualizar.set('Nota', nota);
                linhaParaAtualizar.set('DataResposta', new Date().toLocaleDateString('pt-BR'));
                linhaParaAtualizar.set('PesquisaEnviada', 'TRUE');
                await linhaParaAtualizar.save();
                console.log('[FLUXO 1] Planilha atualizada com sucesso.');

                await client.sendMessage(contato, '✅ Obrigado por sua avaliação! Sua participação é muito importante para nós.');
                delete aguardandoNota[contato]; // Limpa o estado da conversa
            } else {
                console.log(`[FLUXO 1] Resposta inválida de ${contato}: "${textoMsg}"`);
                await client.sendMessage(contato, '❌ Por favor, envie apenas um número de 0 a 10.');
            }
            return;
        }

        // --- FLUXO 2: O usuário está iniciando uma nova conversa ---
        console.log(`[FLUXO 2] Contato ${contato} iniciando nova conversa.`);
        const sheet = await acessarPlanilha();
        console.log('[FLUXO 2] Carregando linhas da planilha...');
        const rows = await sheet.getRows();
        console.log(`[FLUXO 2] ${rows.length} linhas encontradas. Procurando por ${contato}...`);

        const linhaUsuario = rows.find(row => {
            const telefonePlanilha = row.get('NumeroTelefone');
            // A comparação (|| '').toUpperCase() torna a checagem mais robusta
            const pesquisaFoiEnviada = (row.get('PesquisaEnviada') || '').toUpperCase() === 'TRUE';
            return telefonePlanilha === contato && !pesquisaFoiEnviada;
        });

        if (linhaUsuario) {
            const nomeLider = linhaUsuario.get('NomeLider');
            const nomeEvento = linhaUsuario.get('NomeEvento');
            console.log(`[FLUXO 2] Usuário encontrado! Evento: ${nomeEvento}, Líder: ${nomeLider}. Enviando pergunta.`);
            
            aguardandoNota[contato] = linhaUsuario; // Armazena o estado
            
            const pergunta = `Olá! Vimos que você participou do evento "${nomeEvento}".\n\nPara nos ajudar a melhorar, por favor, avalie o líder *${nomeLider}* com uma nota de 0 a 10.`;
            await client.sendMessage(contato, pergunta);
        } else {
            console.log(`[FLUXO 2] Nenhuma pesquisa pendente encontrada para ${contato}.`);
            await client.sendMessage(contato, 'Olá! No momento, não encontramos nenhuma pesquisa pendente para você ou ela já foi respondida. Obrigado pelo contato!');
        }

    } catch (error) {
        console.error(`[ERRO GERAL] Falha ao processar mensagem de ${contato}:`, error);
        await client.sendMessage(contato, '🤖 Desculpe, nosso sistema encontrou um problema. A equipe técnica já foi notificada. Tente novamente mais tarde.');
    }
});

client.initialize();

// ==================================================================
// 4. API PARA O DASHBOARD (SEM ALTERAÇÕES SIGNIFICATIVAS)
// ==================================================================
// ... (O código da API do dashboard permanece o mesmo da versão anterior)
app.get('/api/dados', async (req, res) => {
    try {
        const sheet = await acessarPlanilha();
        const rows = await sheet.getRows();
        const dados = rows.map(row => row.toObject());
        res.json(dados);
    } catch (error) {
        console.error('Erro na rota /api/dados:', error);
        res.status(500).json({ error: 'Erro ao buscar dados da planilha.' });
    }
});

app.get('/api/estatisticas', async (req, res) => {
    try {
        const sheet = await acessarPlanilha();
        const rows = await sheet.getRows();
        
        const respondidas = rows.filter(row => (row.get('PesquisaEnviada') || '').toUpperCase() === 'TRUE');
        const totalCadastros = rows.length;
        const totalRespondidas = respondidas.length;
        
        const notasPorLider = respondidas.reduce((acc, row) => {
            const lider = row.get('NomeLider');
            const nota = parseInt(row.get('Nota'));
            if (!acc[lider]) {
                acc[lider] = { notas: [], media: 0, totalRespostas: 0 };
            }
            if (!isNaN(nota)) {
                acc[lider].notas.push(nota);
            }
            return acc;
        }, {});

        for (const lider in notasPorLider) {
            const soma = notasPorLider[lider].notas.reduce((a, b) => a + b, 0);
            const totalRespostas = notasPorLider[lider].notas.length;
            notasPorLider[lider].totalRespostas = totalRespostas;
            notasPorLider[lider].media = totalRespostas > 0 ? (soma / totalRespostas).toFixed(2) : 0;
            delete notasPorLider[lider].notas;
        }

        res.json({
            totalCadastros,
            totalRespondidas,
            estatisticasLideres: notasPorLider
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
    console.log(`[SERVIDOR] Dashboard iniciado e rodando em http://localhost:${PORT}`);
});