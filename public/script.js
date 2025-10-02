// Aguarda o carregamento completo da página para executar o script
document.addEventListener('DOMContentLoaded', () => {

    // Referências aos elementos do HTML
    const totalCadastrosEl = document.getElementById('total-cadastros');
    const totalRespondidasEl = document.getElementById('total-respondidas');
    const taxaRespostaEl = document.getElementById('taxa-resposta');
    const tabelaCorpoEl = document.querySelector('#tabela-dados tbody');
    const graficoCtx = document.getElementById('grafico-lideres').getContext('2d');
    
    // Elementos da nova funcionalidade de envio ativo
    const btnIniciarPesquisa = document.getElementById('btn-iniciar-pesquisa');
    const statusEnvioEl = document.getElementById('status-envio');

    let graficoLideres; // Variável para armazenar a instância do gráfico

    // Função principal para buscar e atualizar todos os dados do dashboard
    async function carregarDados() {
        try {
            // Faz duas chamadas simultâneas para as APIs do backend
            const [respostaEstatisticas, respostaDados] = await Promise.all([
                fetch('/api/estatisticas'),
                fetch('/api/dados')
            ]);

            if (!respostaEstatisticas.ok || !respostaDados.ok) {
                throw new Error('Falha ao buscar dados do servidor.');
            }

            const estatisticas = await respostaEstatisticas.json();
            const dados = await respostaDados.json();

            // Atualiza os cards de métricas
            atualizarMetricas(estatisticas);

            // Atualiza a tabela com os dados brutos
            atualizarTabela(dados);
            
            // Atualiza o gráfico de líderes
            atualizarGrafico(estatisticas.estatisticasLideres);

        } catch (error) {
            console.error("Erro ao carregar dados:", error);
            tabelaCorpoEl.innerHTML = `<tr><td colspan="5">Não foi possível carregar os dados. Verifique o console.</td></tr>`;
        }
    }

    // Função para atualizar os cards de métricas
    function atualizarMetricas(estatisticas) {
        const { totalCadastros, totalRespondidas } = estatisticas;
        totalCadastrosEl.textContent = totalCadastros;
        totalRespondidasEl.textContent = totalRespondidas;

        const taxa = totalCadastros > 0 ? ((totalRespondidas / totalCadastros) * 100).toFixed(1) : 0;
        taxaRespostaEl.textContent = `${taxa}%`;
    }

    // Função para preencher a tabela de dados
    function atualizarTabela(dados) {
        tabelaCorpoEl.innerHTML = ''; // Limpa a tabela antes de preencher

        if (dados.length === 0) {
            tabelaCorpoEl.innerHTML = `<tr><td colspan="5">Nenhum dado encontrado.</td></tr>`;
            return;
        }

        dados.forEach(item => {
            const linha = document.createElement('tr');
            linha.innerHTML = `
                <td>${item.NumeroTelefone || '-'}</td>
                <td>${item.NomeEvento || '-'}</td>
                <td>${item.NomeLider || '-'}</td>
                <td>${item.Nota || 'Pendente'}</td>
                <td>${item.DataResposta || '-'}</td>
            `;
            tabelaCorpoEl.appendChild(linha);
        });
    }
    
    // Função para criar ou atualizar o gráfico de líderes
    function atualizarGrafico(estatisticasLideres) {
        const labels = Object.keys(estatisticasLideres);
        const data = labels.map(lider => estatisticasLideres[lider].media);

        if (graficoLideres) {
            // Se o gráfico já existe, apenas atualiza os dados
            graficoLideres.data.labels = labels;
            graficoLideres.data.datasets[0].data = data;
            graficoLideres.update();
        } else {
            // Se não existe, cria um novo
            graficoLideres = new Chart(graficoCtx, {
                type: 'bar', // Tipo do gráfico
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Nota Média',
                        data: data,
                        backgroundColor: 'rgba(52, 152, 219, 0.8)',
                        borderColor: 'rgba(41, 128, 185, 1)',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 10 // Define a escala máxima da nota para 10
                        }
                    },
                    plugins: {
                        legend: {
                            display: false
                        }
                    }
                }
            });
        }
    }


    // Carrega os dados assim que a página é aberta
    carregarDados();

    // Atualiza os dados do dashboard a cada 30 segundos
    setInterval(carregarDados, 30000);
});