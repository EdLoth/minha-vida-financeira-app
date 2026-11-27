/* =========================================================================
   MOTOR DE CÁLCULO — Minha Vida Financeira
   Um arquivo só, usado pelo app (index.html) e pelos scripts em Node (scripts/).
   Não toca em tela nem em rede: recebe o conteúdo de data/financas.json e
   devolve os meses calculados. Mudou uma regra de cálculo? É aqui.
   ========================================================================= */
(function (root) {
  'use strict';

  const NOMES_MES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const RE_MES = /^(Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\/\d{2}$/;
  const CALCULOS = ['auxilio-transporte', 'auxilio-alimentacao', 'carne'];
  const CAIXINHAS_PADRAO = [
    { nome: '120% CDI', percentualCdi: 120, teto: 10000 },
    { nome: '115% CDI', percentualCdi: 115, teto: 5000 },
    { nome: '100% CDI', percentualCdi: 100, teto: null },
  ];

  /* ---------- meses: "Nov/26" <-> número absoluto (ano*12 + mês) ---------- */
  function mesValido(label) { return typeof label === 'string' && RE_MES.test(label); }
  function mesAbs(label) {
    if (!mesValido(label)) throw new Error(`Mês inválido: "${label}" (use o formato Nov/26)`);
    const [nome, aa] = label.split('/');
    return (2000 + parseInt(aa, 10)) * 12 + NOMES_MES.indexOf(nome);
  }
  function mesLabel(abs) {
    return `${NOMES_MES[abs % 12]}/${String(Math.floor(abs / 12) % 100).padStart(2, '0')}`;
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function reaisTxt(v) { return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  /* ---------- divisão da sobra do mês ----------
     parametros.investimentos.divisaoSobra = { desde: 'Jan/27', investimento: 55, reserva: 15,
       grupo: 'Investimentos e reserva', grupoAvulsos: 'Avulsos (uso mensal)' }
     A partir de "desde", o que sobra no mês (receitas menos despesas, sem contar os dois grupos acima)
     é dividido: investimento % e reserva % viram despesas a pagar no grupo "grupo"; o resto é o
     orçamento do mês para os gastos lançados no grupo "grupoAvulsos". Mês sem sobra não divide nada.
     Com restoAvulsosParaInvestimento: true, o que não for gasto desse orçamento também vai para
     investimento, como uma terceira despesa a pagar ("Sobra do auxílio"), que diminui conforme os
     avulsos são lançados e some se o orçamento estourar. */
  const DESC_INVESTIMENTO = 'Investimento';
  const DESC_RESERVA = 'Reserva de emergência';
  const DESC_RESTO_AVULSOS = 'Sobra do auxílio';
  function divisaoConfig(dados) {
    const d = dados && dados.parametros && dados.parametros.investimentos && dados.parametros.investimentos.divisaoSobra;
    if (!d || typeof d !== 'object' || !mesValido(d.desde) || typeof d.grupo !== 'string' || typeof d.grupoAvulsos !== 'string') return null;
    const investimento = typeof d.investimento === 'number' ? d.investimento : 0;
    const reserva = typeof d.reserva === 'number' ? d.reserva : 0;
    return { desde: d.desde, desdeAbs: mesAbs(d.desde), investimento, reserva, avulsos: round2(100 - investimento - reserva), grupo: d.grupo, grupoAvulsos: d.grupoAvulsos,
      // para onde vai o que não for gasto do auxílio/avulsos: 'reserva' ou 'investimento' (ou nada)
      restoDestino: (d.restoAvulsosPara === 'reserva' || d.restoAvulsosPara === 'investimento') ? d.restoAvulsosPara : (d.restoAvulsosParaInvestimento === true ? 'investimento' : null),
      restoParaInvestimento: d.restoAvulsosPara === 'reserva' || d.restoAvulsosPara === 'investimento' || d.restoAvulsosParaInvestimento === true,
      prioridade: d.prioridadeInvestimentoReserva === true,
      // Quando o total guardado na reserva chegar a "valor", a partir do mês seguinte usa as novas
      // porcentagens (ex.: reserva 30% → 15% e investimento 55% → 70%).
      mudanca: (d.quandoReservaAtingir && typeof d.quandoReservaAtingir.valor === 'number' && typeof d.quandoReservaAtingir.investimento === 'number' && typeof d.quandoReservaAtingir.reserva === 'number')
        ? { valor: d.quandoReservaAtingir.valor, investimento: d.quandoReservaAtingir.investimento, reserva: d.quandoReservaAtingir.reserva } : null,
      tetoAvulsos: typeof d.tetoAvulsos === 'number' && d.tetoAvulsos >= 0 ? d.tetoAvulsos : null,
      novasDespesasNoAvulso: d.novasDespesasNoAvulso === true };
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function chaveItem(mes, tipo, grupo, desc) { return `${mes}|${tipo}|${grupo || ''}|${desc}`; }

  /* ---------- feriados (nacionais + Bahia + Salvador) e auxílios ---------- */
  function domingoPascoa(ano) {
    const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
    const d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const idx = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * idx - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const soma = h + l - 7 * m + 114;
    return new Date(ano, Math.floor(soma / 31) - 1, (soma % 31) + 1);
  }
  function addDias(data, n) { const d = new Date(data); d.setDate(d.getDate() + n); return d; }
  function isoData(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function feriadosDoAno(ano) {
    const pascoa = domingoPascoa(ano);
    return [
      new Date(ano, 0, 1),     // Confraternização Universal
      addDias(pascoa, -48),    // Carnaval (segunda)
      addDias(pascoa, -47),    // Carnaval (terça)
      addDias(pascoa, -2),     // Sexta-feira Santa
      new Date(ano, 3, 21),    // Tiradentes
      new Date(ano, 4, 1),     // Dia do Trabalho
      addDias(pascoa, 60),     // Corpus Christi
      new Date(ano, 6, 2),     // Independência da Bahia
      new Date(ano, 8, 7),     // Independência do Brasil
      new Date(ano, 9, 12),    // Nossa Senhora Aparecida
      new Date(ano, 10, 2),    // Finados
      new Date(ano, 10, 15),   // Proclamação da República
      new Date(ano, 10, 20),   // Consciência Negra
      new Date(ano, 11, 8),    // N. Sra. da Conceição da Praia (Salvador)
      new Date(ano, 11, 25),   // Natal
    ].map(isoData);
  }
  /* Alimentação: todo dia útil. Passagem: só nos dias da semana em que sai pra trabalhar. */
  function calcularAuxilio(abs, cfg) {
    const ano = Math.floor(abs / 12), mesIdx0 = abs % 12;
    const porDiaAlim = cfg && cfg.alimentacaoPorDia != null ? cfg.alimentacaoPorDia : 14;
    const porDiaPass = cfg && cfg.passagemPorDia != null ? cfg.passagemPorDia : 11.80;
    const diasSemanaPass = (cfg && cfg.diasDaSemanaPassagem) || [1, 3, 5];
    const feriados = new Set(feriadosDoAno(ano));
    const diasNoMes = new Date(ano, mesIdx0 + 1, 0).getDate();
    let diasAlimentacao = 0, diasPassagem = 0;
    for (let dia = 1; dia <= diasNoMes; dia++) {
      const d = new Date(ano, mesIdx0, dia);
      const dow = d.getDay();
      const eFeriado = feriados.has(isoData(d));
      if (dow >= 1 && dow <= 5 && !eFeriado) diasAlimentacao++;
      if (diasSemanaPass.includes(dow) && !eFeriado) diasPassagem++;
    }
    return {
      diasAlimentacao, diasPassagem,
      alimentacao: round2(diasAlimentacao * porDiaAlim),
      passagem: round2(diasPassagem * porDiaPass),
    };
  }
  function nEsimoDiaUtil(ano, mesIdx0, n) {
    let count = 0, dia = 1;
    while (true) {
      const dow = new Date(ano, mesIdx0, dia).getDay();
      if (dow !== 0 && dow !== 6) count++;
      if (count === n) return dia;
      dia++;
    }
  }

  /* ---------- um lançamento (regra) aplicado a um mês ---------- */
  function aplicarRegra(r, abs, dados) {
    const ini = mesAbs(r.inicio);
    if (abs < ini) return null;
    if (r.fim && abs > mesAbs(r.fim)) return null;
    let n = null, total = null;
    if (r.parcelas) {
      total = r.parcelas.total;
      n = (r.parcelas.primeira || 1) + (abs - ini);
      if (n > total) return null;
    }

    let desc = r.desc;
    if (n != null) {
      desc = desc.split('{n}').join(n).split('{total}').join(total)
        .split('{ultima}').join(n === total ? (r.ultima || '') : '');
    }
    if (desc.includes('{ref}')) {
      const p = abs + 1; // auxílios são referentes ao mês seguinte
      desc = desc.split('{ref}').join(`${NOMES_MES[p % 12]}/${Math.floor(p / 12)}`);
    }

    const cfgAux = dados.parametros && dados.parametros.auxilio;
    let valor;
    if (r.calculo === 'auxilio-transporte') valor = calcularAuxilio(abs + 1, cfgAux).passagem;
    else if (r.calculo === 'auxilio-alimentacao') valor = calcularAuxilio(abs + 1, cfgAux).alimentacao;
    else if (r.calculo === 'carne') valor = Math.max(0, round2((r.teto != null ? r.teto : 500) - calcularAuxilio(abs, cfgAux).alimentacao));
    else {
      valor = r.valor;
      const ajustes = (r.ajustes || []).slice().sort((a, b) => mesAbs(a.aPartirDe) - mesAbs(b.aPartirDe));
      ajustes.forEach(a => { if (abs >= mesAbs(a.aPartirDe)) valor = a.valor; });
    }

    const ano = Math.floor(abs / 12), mesIdx0 = abs % 12;
    const grupoCfg = r.grupo ? (dados.grupos || []).find(g => g.nome === r.grupo) : null;
    let dia = null;
    if (r.diaUtil) dia = nEsimoDiaUtil(ano, mesIdx0, r.diaUtil);
    else if (r.ultimoDiaAte) dia = Math.min(r.ultimoDiaAte, new Date(ano, mesIdx0 + 1, 0).getDate());
    else if (r.dia != null) dia = r.dia;
    else if (grupoCfg && grupoCfg.diaPadrao != null) dia = grupoCfg.diaPadrao;

    let vencimento = null;
    if (dia != null) {
      vencimento = r.textoVencimento
        ? r.textoVencimento.split('{dia}').join(dia).split('{dd}').join(pad2(dia)).split('{mm}').join(pad2(mesIdx0 + 1))
        : `${r.tipo === 'receita' ? 'recebe' : 'vence'} dia ${dia}`;
    }

    return {
      regraId: r.id, tipo: r.tipo, grupo: r.grupo || null, desc, valor,
      parcela: n != null ? { n, total } : null,
      ilustrativo: !!r.ilustrativo, dia, vencimento,
    };
  }

  /* ---------- carteira: os investimentos de verdade (o que foi aplicado, resgatado e rendeu) ----------
     dados.carteira = { ativos: [{ id, nome, instituicao, tipo, objetivo, rentabilidade, obs, encerrado }],
                        movimentos: [{ id, ativo, tipo, data: 'AAAA-MM-DD', valor, obs }] }
     Tipos de movimento:
       saldo-inicial  dinheiro que já estava lá antes de começar o controle (não saiu da conta agora)
       aporte         dinheiro novo colocado (saiu da conta)
       resgate        dinheiro retirado (voltou para a conta)
       rendimento     quanto rendeu (negativo = perdeu)
     As somas são feitas em centavos inteiros para bater exatamente com o extrato. */
  const TIPOS_MOVIMENTO = ['saldo-inicial', 'aporte', 'resgate', 'rendimento'];
  const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
  const RE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  function dataValida(s) {
    const m = typeof s === 'string' && RE_DATA.exec(s);
    if (!m) return false;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
  }
  function mesDaData(s) { return mesLabel(parseInt(s.slice(0, 4), 10) * 12 + parseInt(s.slice(5, 7), 10) - 1); }
  const centavos = (v) => Math.round(v * 100);
  const CAMPO_DO_TIPO = { 'saldo-inicial': 'saldoInicial', aporte: 'aportado', resgate: 'resgatado', rendimento: 'rendimento' };
  const SINAL_DO_TIPO = { 'saldo-inicial': 1, aporte: 1, resgate: -1, rendimento: 1 };

  /* ---------- caixinha: CDB de liquidez diária que rende um % do CDI (ex.: Caixinha Nubank) ----------
     Funciona como no banco:
     - rende em todo dia útil bancário (sem fim de semana e feriado nacional) pelo CDI daquele dia;
       um aporte começa a render no dia útil seguinte ao dia em que entrou;
     - dias que já passaram usam a taxa real do CDI (parametros.investimentos.juros.diario, % ao dia,
       gravada todo dia pelo workflow "Atualizar CDI"); dias futuros usam cdiAnual (% ao ano, base 252);
     - se o CDI cai, só os dias seguintes rendem menos: o que já rendeu fica (não há marcação a mercado);
     - na retirada: IOF sobre o rendimento se o dinheiro ficou menos de 30 dias e IR sobre o rendimento
       (menos o IOF) pela tabela regressiva, contada por aporte; sai primeiro o dinheiro mais antigo. */
  const TABELA_IR = [[180, 22.5], [360, 20], [720, 17.5], [Infinity, 15]];
  const TABELA_IOF = [96, 93, 90, 86, 83, 80, 76, 73, 70, 66, 63, 60, 56, 53, 50, 46, 43, 40, 36, 33, 30, 26, 23, 20, 16, 13, 10, 6, 3];
  function aliquotaIR(dias) { for (const [lim, a] of TABELA_IR) if (dias <= lim) return a; return 15; }
  function aliquotaIOF(dias) { return dias >= 30 ? 0 : (dias < 1 ? 100 : TABELA_IOF[dias - 1]); }
  function diaUTC(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
  function diasEntre(a, b) { return Math.round((diaUTC(b) - diaUTC(a)) / 86400000); }
  function isoDeUTC(t) { const d = new Date(t); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
  const __feriadosBanc = {};
  function ehDiaUtilBancario(iso) {
    const ano = +iso.slice(0, 4);
    if (!__feriadosBanc[ano]) __feriadosBanc[ano] = new Set(feriadosDoAno(ano).filter(d => d !== `${ano}-07-02` && d !== `${ano}-12-08`));
    const dow = new Date(diaUTC(iso)).getUTCDay();
    return dow !== 0 && dow !== 6 && !__feriadosBanc[ano].has(iso);
  }
  // Tira "valor" (bruto) dos lotes, do mais antigo para o mais novo, e calcula IOF e IR dessa retirada.
  function retirarDosLotes(lotes, valor, dia) {
    let falta = valor; const r = { data: dia, bruto: 0, rendimento: 0, iof: 0, ir: 0, liquido: 0 };
    for (const l of lotes) {
      if (falta <= 0.000001) break;
      if (l.saldo <= 0.000001) continue;
      const tira = Math.min(falta, l.saldo), frac = tira / l.saldo;
      const rend = Math.max(0, (l.saldo - l.principal) * frac), dias = diasEntre(l.data, dia);
      const iof = rend * aliquotaIOF(dias) / 100, ir = (rend - iof) * aliquotaIR(dias) / 100;
      r.bruto += tira; r.rendimento += rend; r.iof += iof; r.ir += ir;
      l.principal -= l.principal * frac; l.saldo -= tira; falta -= tira;
    }
    r.liquido = r.bruto - r.iof - r.ir;
    ['bruto', 'rendimento', 'iof', 'ir', 'liquido'].forEach(k => { r[k] = round2(r[k]); });
    r.faltou = round2(Math.max(0, falta));
    return r;
  }
  /* o = { aportes: [{data, valor}], resgates: [{data, valor}], percentualCdi: 100, cdiAnual: 13.65,
           diario: { 'AAAA-MM-DD': 0.0508 }, ate: 'AAAA-MM-DD' } */
  function simularCaixinha(o) {
    const pct = (o.percentualCdi != null ? o.percentualCdi : 100) / 100;
    const taxaFutura = Math.pow(1 + (o.cdiAnual || 0) / 100, 1 / 252) - 1;
    const diario = o.diario || {};
    const aportes = (o.aportes || []).filter(a => a && a.valor > 0 && dataValida(a.data)).slice().sort((a, b) => (a.data < b.data ? -1 : 1));
    const resgates = (o.resgates || []).filter(a => a && a.valor > 0 && dataValida(a.data)).slice().sort((a, b) => (a.data < b.data ? -1 : 1));
    const out = { lotes: [], aportado: 0, resgatado: 0, saldoBruto: 0, rendimento: 0, ir: 0, iof: 0, liquido: 0, resgates: [], porMes: [], diasReais: 0, diasProjetados: 0 };
    if (!aportes.length || !dataValida(o.ate)) return out;
    const lotes = [];
    let ai = 0, ri = 0, rendAcum = 0, aportadoAcum = 0;
    const fim = diaUTC(o.ate);
    for (let t = diaUTC(aportes[0].data); t <= fim; t += 86400000) {
      const dia = isoDeUTC(t);
      if (ehDiaUtilBancario(dia)) {
        const real = diario[dia];
        const taxa = (typeof real === 'number' ? real / 100 : taxaFutura) * pct;
        if (lotes.length) { if (typeof real === 'number') out.diasReais++; else out.diasProjetados++; }
        lotes.forEach(l => { if (l.data < dia && l.saldo > 0) { const g = l.saldo * taxa; l.saldo += g; rendAcum += g; } });
      }
      while (ai < aportes.length && aportes[ai].data === dia) { const a = aportes[ai++]; lotes.push({ data: dia, principal: a.valor, saldo: a.valor, valor: a.valor }); aportadoAcum += a.valor; }
      while (ri < resgates.length && resgates[ri].data === dia) { const r = retirarDosLotes(lotes, resgates[ri++].valor, dia); out.resgates.push(r); out.resgatado += r.bruto; }
      const amanha = isoDeUTC(t + 86400000);
      if (amanha.slice(0, 7) !== dia.slice(0, 7) || t === fim) {
        out.porMes.push({ mes: mesLabel(+dia.slice(0, 4) * 12 + +dia.slice(5, 7) - 1), ate: dia, saldoBruto: round2(lotes.reduce((x, l) => x + l.saldo, 0)), aportado: round2(aportadoAcum), rendimento: round2(rendAcum) });
      }
    }
    // impostos se tirasse tudo no último dia
    const copia = lotes.map(l => Object.assign({}, l));
    const tudo = retirarDosLotes(copia, lotes.reduce((x, l) => x + l.saldo, 0), o.ate);
    out.lotes = lotes.map(l => ({ data: l.data, aportado: round2(l.valor), saldo: round2(l.saldo), dias: diasEntre(l.data, o.ate), aliquotaIR: aliquotaIR(diasEntre(l.data, o.ate)) }));
    out.aportado = round2(aportadoAcum); out.resgatado = round2(out.resgatado);
    out.saldoBruto = tudo.bruto; out.rendimento = round2(rendAcum); out.ir = tudo.ir; out.iof = tudo.iof; out.liquido = tudo.liquido;
    out.rendimentoNaoResgatado = tudo.rendimento;
    return out;
  }

  /* ate: 'AAAA-MM-DD' (inclusive) para ver a carteira como estava naquele dia; sem ele, tudo. */
  function carteira(dados, ate) {
    const c = (dados && dados.carteira) || {};
    const zero = () => ({ saldoInicial: 0, aportado: 0, resgatado: 0, rendimento: 0, saldo: 0 });
    const ativos = (c.ativos || []).map(a => Object.assign({}, a, zero(), { rendimentoPct: null, movimentos: [] }));
    const porId = new Map(ativos.map(a => [a.id, a]));
    const total = zero();
    const meses = new Map();
    const movs = (c.movimentos || [])
      .map((m, i) => ({ m, i }))
      .filter(x => x.m && typeof x.m.data === 'string' && CAMPO_DO_TIPO[x.m.tipo] && typeof x.m.valor === 'number' && (!ate || x.m.data <= ate))
      .sort((x, y) => (x.m.data < y.m.data ? -1 : x.m.data > y.m.data ? 1 : x.i - y.i))
      .map(x => x.m);
    movs.forEach(m => {
      const a = porId.get(m.ativo);
      if (!a) return;
      const campo = CAMPO_DO_TIPO[m.tipo], v = centavos(m.valor), delta = SINAL_DO_TIPO[m.tipo] * v;
      a[campo] += v; a.saldo += delta;
      total[campo] += v; total.saldo += delta;
      a.movimentos.push(Object.assign({}, m, { saldoApos: a.saldo / 100 }));
      const mes = mesDaData(m.data);
      if (!meses.has(mes)) meses.set(mes, { mes, saldoInicial: 0, aportado: 0, resgatado: 0, rendimento: 0, saldoFinal: 0 });
      const linha = meses.get(mes);
      linha[campo] += v; linha.saldoFinal = total.saldo;
    });
    const emReais = (o, campos) => { campos.forEach(k => { o[k] = o[k] / 100; }); return o; };
    const CAMPOS = ['saldoInicial', 'aportado', 'resgatado', 'rendimento', 'saldo'];
    const pct = (o) => { const colocado = o.saldoInicial + o.aportado; return colocado > 0 ? Math.round((o.rendimento / colocado) * 10000) / 100 : null; };
    ativos.forEach(a => { a.rendimentoPct = pct(a); emReais(a, CAMPOS); });
    const rendimentoPct = pct(total);
    return {
      ativos,
      totais: emReais(total, CAMPOS),
      rendimentoPct,
      porMes: Array.from(meses.values()).map(l => emReais(l, ['saldoInicial', 'aportado', 'resgatado', 'rendimento', 'saldoFinal'])),
    };
  }

  /* ---------- motor: calcula todos os meses do horizonte ---------- */
  function criar(dados) {
    const estado = dados.estado = dados.estado || {};
    ['confirmados', 'extras', 'overrides', 'excluidos', 'dias'].forEach(k => { if (!estado[k]) estado[k] = {}; });

    const inicioAbs = mesAbs(dados.horizonte.inicio);
    const months = [], data = {}, info = {}, itensPorMes = {};
    const nomesGrupos = (dados.grupos || []).map(g => g.nome);

    for (let k = 0; k < dados.horizonte.meses; k++) {
      const abs = inicioAbs + k, m = mesLabel(abs);
      months.push(m);
      const receitas = {}, grupos = {};
      nomesGrupos.forEach(g => { grupos[g] = {}; });
      info[m] = {};
      itensPorMes[m] = [];
      (dados.lancamentos || []).forEach(r => {
        const it = aplicarRegra(r, abs, dados);
        if (!it) return;
        if (it.tipo === 'receita') receitas[it.desc] = it.valor;
        else { if (!grupos[it.grupo]) grupos[it.grupo] = {}; grupos[it.grupo][it.desc] = it.valor; }
        it.chave = chaveItem(m, it.tipo, it.grupo, it.desc);
        info[m][it.chave] = it;
        itensPorMes[m].push(it);
      });
      data[m] = { receitas, grupos };
    }

    /* ----- divisão da sobra: gera "Investimento" e "Reserva de emergência" como despesas do mês ----- */
    const div = divisaoConfig(dados);
    const divisaoPorMes = months.map(() => null);
    const avulsosDoMes = months.map(() => null); // ids dos itens novos que saem do orçamento de avulsos
    let reservaAcum = 0; // total guardado na reserva até o mês anterior (reserva + sobra do auxílio transferida)
    if (div) months.forEach((m, idx) => {
      let sobra = 0, gastoAvulsos = 0, gastoAvulsosPago = 0;
      itensPorMes[m].forEach(it => {
        if (it.ilustrativo || estado.excluidos[it.chave]) return;
        const v = valorEfetivo(it.chave, it.valor);
        if (it.tipo === 'despesa' && it.grupo === div.grupoAvulsos) { gastoAvulsos += v; if (estado.confirmados[it.chave]) gastoAvulsosPago += v; return; }
        if (it.tipo === 'despesa' && it.grupo === div.grupo) return;
        sobra += it.tipo === 'receita' ? v : -v;
      });
      // Item novo de despesa (avulso em extras): se for marcado como avulso ("avulso": true), sai do
      // orçamento de avulsos e não mexe em investimento e reserva; se for despesa ("avulso": false),
      // diminui a sobra e o investimento, a reserva e a sobra dos avulsos são recalculados.
      // Sem marcação vale novasDespesasNoAvulso. No grupo de avulsos é sempre avulso.
      const ativaMes = inicioAbs + idx >= div.desdeAbs;
      let gastoOutrosGrupos = 0;
      avulsosDoMes[idx] = new Set();
      (estado.extras[m] || []).forEach(e => {
        if (e.tipo === 'despesa' && e.grupo === div.grupoAvulsos) { gastoAvulsos += e.valor; if (estado.confirmados['extra:' + e.id]) gastoAvulsosPago += e.valor; avulsosDoMes[idx].add(e.id); return; }
        if (e.tipo === 'despesa' && e.grupo === div.grupo) return;
        const marcado = typeof e.avulso === 'boolean' ? e.avulso : div.novasDespesasNoAvulso;
        if (e.tipo === 'despesa' && ativaMes && marcado) { gastoAvulsos += e.valor; gastoOutrosGrupos += e.valor; if (estado.confirmados['extra:' + e.id]) gastoAvulsosPago += e.valor; avulsosDoMes[idx].add(e.id); return; }
        if (e.tipo === 'receita') sobra += e.valor; else if (e.tipo === 'despesa') sobra -= e.valor;
      });
      sobra = round2(sobra); gastoAvulsos = round2(gastoAvulsos);
      if (inicioAbs + idx < div.desdeAbs) { divisaoPorMes[idx] = { ativa: false, sobra, gastoAvulsos }; return; }
      const base = Math.max(sobra, 0);
      const fase2 = !!(div.mudanca && reservaAcum >= div.mudanca.valor - 0.004);
      const pInv = fase2 ? div.mudanca.investimento : div.investimento, pRes = fase2 ? div.mudanca.reserva : div.reserva;
      const pAvu = round2(100 - pInv - pRes);
      let investimento = round2(base * pInv / 100), reserva = round2(base * pRes / 100);
      let orcamentoAvulsos = round2(base - investimento - reserva);
      // Teto dos avulsos: o que passar do teto vai para investimento e reserva, na proporção deles.
      let excessoAvulsos = 0, extraInv = 0, extraRes = 0;
      const somaPct = pInv + pRes;
      if (div.tetoAvulsos != null && orcamentoAvulsos > div.tetoAvulsos && somaPct > 0) {
        excessoAvulsos = round2(orcamentoAvulsos - div.tetoAvulsos);
        extraInv = round2(excessoAvulsos * pInv / somaPct);
        extraRes = round2(excessoAvulsos - extraInv);
        investimento = round2(investimento + extraInv); reserva = round2(reserva + extraRes);
        orcamentoAvulsos = div.tetoAvulsos;
      }
      // Prioridade: investimento e reserva nunca ficam menores que o auxílio. Se ficariam, o auxílio
      // diminui até o menor dos dois e a diferença vai para investimento e reserva, na proporção deles.
      if (div.prioridade && somaPct > 0) {
        const limite = Math.min(investimento, reserva);
        if (orcamentoAvulsos > limite + 0.004) {
          const dif = round2(orcamentoAvulsos - limite);
          const di = round2(dif * pInv / somaPct), dr = round2(dif - di);
          investimento = round2(investimento + di); reserva = round2(reserva + dr);
          extraInv = round2(extraInv + di); extraRes = round2(extraRes + dr);
          excessoAvulsos = round2(excessoAvulsos + dif);
          orcamentoAvulsos = round2(limite);
        }
      }
      divisaoPorMes[idx] = {
        ativa: true, sobra, investimento, reserva, orcamentoAvulsos, gastoAvulsos,
        restanteAvulsos: round2(orcamentoAvulsos - gastoAvulsos),
        gastoAvulsosPago: round2(gastoAvulsosPago), restanteAvulsosReal: round2(orcamentoAvulsos - gastoAvulsosPago),
        pct: { investimento: pInv, reserva: pRes, avulsos: pAvu },
        fase2, reservaAcumuladaAntes: round2(reservaAcum),
        teto: div.tetoAvulsos, excessoAvulsos, gastoOutrosGrupos: round2(gastoOutrosGrupos),
        pctEfetivo: base > 0 ? { investimento: round2(investimento / base * 100), reserva: round2(reserva / base * 100), avulsos: round2(orcamentoAvulsos / base * 100) } : null,
      };
      if (base <= 0) return;
      const resto = div.restoParaInvestimento ? Math.max(0, divisaoPorMes[idx].restanteAvulsos) : 0;
      divisaoPorMes[idx].restoParaInvestimento = round2(resto);
      [
        [DESC_INVESTIMENTO, investimento, `${pInv.toLocaleString('pt-BR')}% da sobra do mês (${reaisTxt(sobra)})${extraInv > 0 ? ` + ${reaisTxt(extraInv)} que passou do teto do auxílio` : ''}`, 'divisao-investimento'],
        [DESC_RESERVA, reserva, `${pRes.toLocaleString('pt-BR')}% da sobra do mês (${reaisTxt(sobra)})${extraRes > 0 ? ` + ${reaisTxt(extraRes)} que passou do teto do auxílio` : ''}`, 'divisao-reserva'],
        [DESC_RESTO_AVULSOS, resto, `o que não foi gasto do auxílio pessoal (${reaisTxt(gastoAvulsos)} de ${reaisTxt(orcamentoAvulsos)}) · vai para ${div.restoDestino === 'reserva' ? 'a reserva' : 'o investimento'} no fim do mês`, 'divisao-resto-avulsos'],
      ].forEach(([desc, valor, texto, regraId]) => {
        if (valor <= 0) return;
        const it = {
          regraId, tipo: 'despesa', grupo: div.grupo, desc, valor, parcela: null, ilustrativo: false, dia: null,
          vencimento: texto, gerado: true,
        };
        it.chave = chaveItem(m, it.tipo, it.grupo, it.desc);
        info[m][it.chave] = it;
        itensPorMes[m].push(it);
        if (!data[m].grupos[div.grupo]) data[m].grupos[div.grupo] = {};
        data[m].grupos[div.grupo][desc] = valor;
      });
      // soma o que foi para a reserva neste mês (a sobra do auxílio só se foi marcada como transferida)
      const efet = (desc, soConfirmado) => { const ch = chaveItem(m, 'despesa', div.grupo, desc), it = info[m][ch];
        if (!it || estado.excluidos[ch] || (soConfirmado && !estado.confirmados[ch])) return 0; return valorEfetivo(ch, it.valor); };
      reservaAcum = round2(reservaAcum + efet(DESC_RESERVA, false) + (div.restoDestino === 'reserva' ? efet(DESC_RESTO_AVULSOS, true) : 0));
      if (div.mudanca && !fase2 && reservaAcum >= div.mudanca.valor - 0.004 && !div.mudancaEm) div.mudancaEm = months[idx + 1] || null;
    });
    function valorGerado(idx, desc) {
      if (!div) return 0;
      const m = months[idx], ch = chaveItem(m, 'despesa', div.grupo, desc);
      const it = info[m][ch];
      if (!it || estado.excluidos[ch]) return 0;
      return valorEfetivo(ch, it.valor);
    }

    function infoItem(mes, tipo, grupo, desc) { return (info[mes] || {})[chaveItem(mes, tipo, grupo, desc)] || null; }
    function isReceitaIlustrativa(desc, mes) { const i = infoItem(mes, 'receita', null, desc); return !!(i && i.ilustrativo); }
    function sumObj(o) { return Object.values(o).reduce((a, b) => a + b, 0); }

    const monthStats = months.map(m => {
      const d = data[m];
      const receita = Object.entries(d.receitas).reduce((a, [desc, v]) => a + (isReceitaIlustrativa(desc, m) ? 0 : v), 0);
      let debito = 0;
      Object.values(d.grupos).forEach(g => { debito += sumObj(g); });
      return { month: m, receita, debito, saldo: receita - debito };
    });

    const cfgInv = (dados.parametros && dados.parametros.investimentos) || {};
    const aporteMensal = cfgInv.aporteMensal || 0;
    const cdiAnual = (cfgInv.cdiAnualPercent != null ? cfgInv.cdiAnualPercent : 14.15) / 100;
    const caixinhas = cfgInv.caixinhas || CAIXINHAS_PADRAO;
    const taxa = {};
    caixinhas.forEach(c => { taxa[c.nome] = Math.pow(1 + (c.percentualCdi / 100) * cdiAnual, 1 / 12) - 1; });

    /* Aporte que alimenta as caixinhas da Simulação: o fixo (aporteMensal, que sai do cumulativo)
       mais o Investimento e a Reserva da divisão da sobra (que já são despesas do mês). */
    let acumulado = 0;
    monthStats.forEach((s, idx) => {
      s.aporteMensal = aporteMensal;
      s.aporteDaSobra = round2(valorGerado(idx, DESC_INVESTIMENTO) + valorGerado(idx, DESC_RESERVA) + valorGerado(idx, DESC_RESTO_AVULSOS));
      s.aporte = round2(aporteMensal + s.aporteDaSobra);
      acumulado += (s.saldo - s.aporteMensal);
      s.saldoCumulativo = acumulado;
    });

    const saldoCaixinha = {};
    caixinhas.forEach(c => { saldoCaixinha[c.nome] = 0; });
    const investimentos = monthStats.map(s => {
      const rendimento = {};
      caixinhas.forEach(c => { const r = saldoCaixinha[c.nome] * taxa[c.nome]; rendimento[c.nome] = r; saldoCaixinha[c.nome] += r; });
      let restante = s.aporte;
      const alocacao = {};
      caixinhas.forEach(c => {
        if (restante <= 0) return;
        if (c.teto == null) { alocacao[c.nome] = (alocacao[c.nome] || 0) + restante; saldoCaixinha[c.nome] += restante; restante = 0; }
        else {
          const usar = Math.min(Math.max(c.teto - saldoCaixinha[c.nome], 0), restante);
          if (usar > 0) { alocacao[c.nome] = (alocacao[c.nome] || 0) + usar; saldoCaixinha[c.nome] += usar; }
          restante -= usar;
        }
      });
      return {
        aporteTotal: s.aporte, alocacao,
        rendimento: Object.fromEntries(Object.entries(rendimento).filter(([, v]) => v > 0.004)),
        saldoFinal: { ...saldoCaixinha },
      };
    });
    monthStats.forEach((s, idx) => {
      s.saldoCaixinhaTotal = sumObj(investimentos[idx].saldoFinal);
      data[months[idx]].investimentos = investimentos[idx];
    });

    /* ----- cálculos que dependem do que foi marcado/editado (estado) ----- */
    function valorEfetivo(chave, valorOrig) {
      return estado.overrides[chave] != null ? estado.overrides[chave] : valorOrig;
    }
    /* Diferença causada por valores editados, itens removidos e itens avulsos, num mês. */
    function ajusteMesIdx(idx) {
      const m = months[idx];
      let ajusteReceitas = 0, ajusteDespesas = 0;
      itensPorMes[m].forEach(it => {
        if (it.ilustrativo) return;
        let delta = 0;
        if (estado.excluidos[it.chave]) delta = -it.valor;
        else if (estado.overrides[it.chave] != null) delta = estado.overrides[it.chave] - it.valor;
        if (it.tipo === 'receita') ajusteReceitas += delta; else ajusteDespesas += delta;
      });
      (estado.extras[m] || []).forEach(e => {
        if (e.tipo === 'receita') ajusteReceitas += e.valor;
        else if (e.tipo === 'despesa') ajusteDespesas += e.valor;
      });
      return { ajusteReceitas, ajusteDespesas, ajusteSaldo: ajusteReceitas - ajusteDespesas };
    }
    function ajusteAcumuladoAte(idx) {
      let a = 0;
      for (let k = 0; k <= idx; k++) a += ajusteMesIdx(k).ajusteSaldo;
      return a;
    }
    /* O que realmente já entrou/saiu: só o que está marcado como confirmado. */
    function saldoAtualIdx(idx) {
      const m = months[idx];
      let recebido = 0, pago = 0;
      itensPorMes[m].forEach(it => {
        if (it.ilustrativo || estado.excluidos[it.chave] || !estado.confirmados[it.chave]) return;
        const v = valorEfetivo(it.chave, it.valor);
        if (it.tipo === 'receita') recebido += v; else pago += v;
      });
      (estado.extras[m] || []).forEach(e => {
        if (!estado.confirmados[`extra:${e.id}`]) return;
        if (e.tipo === 'receita') recebido += e.valor;
        else if (e.tipo === 'despesa') pago += e.valor;
      });
      return { recebido, pago, saldoDoMes: recebido - pago };
    }
    function saldoInicialIdx(idx) {
      return idx > 0 ? (monthStats[idx - 1].saldoCumulativo + ajusteAcumuladoAte(idx - 1)) : 0;
    }
    function saldoAtualTotal(idx) { return saldoInicialIdx(idx) + saldoAtualIdx(idx).saldoDoMes; }

    /* Investimentos vistos do fim de um mês: quanto há investido e quanto saiu da conta para lá
       (aportes menos resgates feitos desde o primeiro mês do app). */
    const inicioIso = `${Math.floor(inicioAbs / 12)}-${pad2(inicioAbs % 12 + 1)}-01`;
    function fimDoMesIso(idx) { const abs = inicioAbs + idx; return `${Math.floor(abs / 12)}-${pad2(abs % 12 + 1)}-31`; }
    function carteiraAte(idx) { return carteira(dados, fimDoMesIso(idx)); }
    function aplicadoAte(idx) {
      const fim = fimDoMesIso(idx);
      let c = 0;
      ((dados.carteira && dados.carteira.movimentos) || []).forEach(m => {
        if (!m || typeof m.data !== 'string' || typeof m.valor !== 'number' || m.data < inicioIso || m.data > fim) return;
        if (m.tipo === 'aporte') c += centavos(m.valor);
        else if (m.tipo === 'resgate') c -= centavos(m.valor);
      });
      return c / 100;
    }
    function livreEmContaIdx(idx) { return (centavos(saldoAtualTotal(idx)) - centavos(aplicadoAte(idx))) / 100; }

    /* Meta do ano da divisão da sobra: quanto estava previsto para investimento e reserva nos meses
       do ano, quanto já foi marcado como pago e quanto era esperado até o mês "ateAbs" (inclusive). */
    function metasDoAno(ano, ateAbs) {
      const vazio = () => ({ meta: 0, feito: 0, esperadoAte: 0, meses: [] });
      const out = { ano, ativa: !!div, restoParaInvestimento: !!(div && div.restoParaInvestimento), restoDestino: div ? div.restoDestino : null, investimento: vazio(), reserva: vazio(), restoAvulsos: vazio(), avulsos: { orcamento: 0, gasto: 0 } };
      if (!div) return out;
      months.forEach((m, idx) => {
        const abs = inicioAbs + idx;
        if (Math.floor(abs / 12) !== ano) return;
        [['investimento', DESC_INVESTIMENTO], ['reserva', DESC_RESERVA], ['restoAvulsos', DESC_RESTO_AVULSOS]].forEach(([k, desc]) => {
          const v = valorGerado(idx, desc);
          if (!v) return;
          const pago = !!estado.confirmados[chaveItem(m, 'despesa', div.grupo, desc)];
          const o = out[k];
          o.meta += v; if (pago) o.feito += v; if (ateAbs != null && abs <= ateAbs) o.esperadoAte += v;
          o.meses.push({ mes: m, valor: v, pago });
        });
        const d = divisaoPorMes[idx];
        if (d && d.ativa) { out.avulsos.orcamento += d.orcamentoAvulsos; out.avulsos.gasto += d.gastoAvulsos; }
      });
      ['investimento', 'reserva', 'restoAvulsos'].forEach(k => { const o = out[k]; o.meta = round2(o.meta); o.feito = round2(o.feito); o.esperadoAte = round2(o.esperadoAte); });
      out.avulsos.orcamento = round2(out.avulsos.orcamento); out.avulsos.gasto = round2(out.avulsos.gasto);
      return out;
    }
    function divisaoIdx(idx) { return divisaoPorMes[idx]; }
    /* As duas caixinhas (investimento e reserva) alimentadas pela divisão da sobra.
       opc: { modo: 'previsto' (tudo o que está planejado) | 'realizado' (só o que já foi marcado como
       transferido), cdiAnual: % a.a. para os dias futuros, ate: 'AAAA-MM-DD' (padrão 31/12 do ano),
       resgates: { investimento: [{data, valor}], reserva: [...] } }. O aporte entra no dia do item. */
    function caixinhasDivisao(ano, opc) {
      opc = opc || {};
      if (!div) return null;
      const inv = (dados.parametros && dados.parametros.investimentos) || {};
      const cx = inv.caixinhaNubank || {}, juros = inv.juros || {};
      const cdiHoje = typeof juros.cdiAnual === 'number' ? juros.cdiAnual : (typeof inv.cdiAnualPercent === 'number' ? inv.cdiAnualPercent : 14.15);
      const cdiAnual = typeof opc.cdiAnual === 'number' ? opc.cdiAnual : cdiHoje;
      const modo = opc.modo === 'realizado' ? 'realizado' : 'previsto';
      const ate = opc.ate || `${ano}-12-31`;
      const aportes = { investimento: [], reserva: [] };
      months.forEach((m, idx) => {
        const abs = inicioAbs + idx;
        [[DESC_INVESTIMENTO, 'investimento'], [DESC_RESERVA, 'reserva'], [DESC_RESTO_AVULSOS, div.restoDestino === 'reserva' ? 'reserva' : 'investimento']].forEach(([desc, c]) => {
          const ch = chaveItem(m, 'despesa', div.grupo, desc), it = info[m][ch];
          if (!it || estado.excluidos[ch]) return;
          if (modo === 'realizado' && !estado.confirmados[ch]) return;
          // A sobra do auxílio só vai para a caixinha quando foi de fato transferida (marcada como paga):
          // até lá o auxílio pode ser gasto, então ela não entra nem no "previsto".
          if (desc === DESC_RESTO_AVULSOS && !estado.confirmados[ch]) return;
          const v = valorEfetivo(ch, it.valor);
          if (!(v > 0)) return;
          const data = `${Math.floor(abs / 12)}-${pad2(abs % 12 + 1)}-${pad2(diaDoItemRegra(it, idx).dia)}`;
          if (data <= ate) aportes[c].push({ data, valor: v });
        });
      });
      const pct = typeof cx.percentualCdi === 'number' ? cx.percentualCdi : 100;
      const sim = c => simularCaixinha({ aportes: aportes[c], resgates: (opc.resgates && opc.resgates[c]) || [], percentualCdi: pct, cdiAnual, diario: juros.diario || {}, ate });
      return { ano, ate, modo, cdiAnual, cdiHoje, selicMeta: juros.selicMeta, atualizadoEm: juros.atualizadoEm, percentualCdi: pct, nome: cx.nome || 'Caixinha', investimento: sim('investimento'), reserva: sim('reserva') };
    }
    /* O que já foi transferido (marcado como pago) para investimento (Investimento + Sobra dos
       avulsos) e para a reserva, do primeiro mês até idx, e o previsto/pago do próprio mês. */
    function saldosDivisao(idx) {
      const o = { investidoPago: 0, reservaPago: 0, investidoMes: 0, reservaMes: 0, investidoMesPago: 0, reservaMesPago: 0, investidoPrevisto: 0, reservaPrevisto: 0 };
      if (!div) return o;
      for (let k = 0; k <= idx; k++) {
        const m = months[k];
        [[DESC_INVESTIMENTO, 'investido'], [DESC_RESTO_AVULSOS, div.restoDestino === 'reserva' ? 'reserva' : 'investido'], [DESC_RESERVA, 'reserva']].forEach(([desc, c]) => {
          const v = valorGerado(k, desc); if (!v) return;
          const pago = !!estado.confirmados[chaveItem(m, 'despesa', div.grupo, desc)];
          o[c + 'Previsto'] += v;
          if (pago) o[c + 'Pago'] += v;
          if (k === idx) { o[c + 'Mes'] += v; if (pago) o[c + 'MesPago'] += v; }
        });
      }
      Object.keys(o).forEach(k => { o[k] = round2(o[k]); });
      return o;
    }

    /* Fluxo do mês por dia: começa no saldo acumulado até o mês anterior e, dia a dia, soma o que
       entra e tira o que sai (tudo o que está previsto, pago ou não). Mostra se em algum dia o
       dinheiro não dá. No mesmo dia, as entradas vêm antes das saídas. */
    const SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    function fluxoDoMes(mes) {
      const idx = months.indexOf(mes);
      const v = visaoMes(mes);
      const abs = inicioAbs + idx, ano = Math.floor(abs / 12), mes0 = abs % 12;
      const porDia = new Map();
      v.itens.filter(i => !i.ilustrativo).forEach(i => { if (!porDia.has(i.dia)) porDia.set(i.dia, []); porDia.get(i.dia).push(i); });
      const saldoInicial = round2(v.totais.saldoInicial);
      let saldo = saldoInicial;
      let menor = { valor: saldoInicial, dia: null };
      const dias = [...porDia.keys()].sort((a, b) => a - b).map(dia => {
        const lista = porDia.get(dia).sort((a, b) => (a.tipo === b.tipo ? b.valor - a.valor : (a.tipo === 'receita' ? -1 : 1)));
        const entradas = round2(lista.filter(i => i.tipo === 'receita').reduce((t, i) => t + i.valor, 0));
        const saidas = round2(lista.filter(i => i.tipo === 'despesa').reduce((t, i) => t + i.valor, 0));
        const saldoInicio = saldo;
        saldo = round2(saldo + entradas - saidas);
        if (saldo < menor.valor) menor = { valor: saldo, dia };
        return { dia, data: `${ano}-${pad2(mes0 + 1)}-${pad2(dia)}`, semana: SEMANA[new Date(ano, mes0, dia).getDay()], itens: lista, entradas, saidas, saldoInicio, saldoFim: saldo };
      });
      return {
        mes, saldoInicial, saldoFinal: saldo, dias, menor, ultimoDia: ultimoDiaIdx(idx),
        diasNoVermelho: dias.filter(x => x.saldoFim < -0.004).map(x => x.dia),
      };
    }

    /* ----- dia de cada item no mês -----
       Ordem: dia trocado só naquele mês (estado.dias) > dia da regra (ou o diaPadrao do grupo) >
       fim do mês para investimento/reserva/sobra dos avulsos > dia 1 para quem não tem data.
       Avulsos: diaVencimento > diaPadrao do grupo > dia 1. */
    const grupoPorNome = new Map((dados.grupos || []).map(g => [g.nome, g]));
    function ultimoDiaIdx(idx) { const abs = inicioAbs + idx; return new Date(Math.floor(abs / 12), abs % 12 + 1, 0).getDate(); }
    function diaDoItemRegra(it, idx) {
      const ov = estado.dias[it.chave];
      if (Number.isInteger(ov)) return { dia: Math.min(ov, ultimoDiaIdx(idx)), origem: 'mes' };
      if (it.dia != null) return { dia: Math.min(it.dia, ultimoDiaIdx(idx)), origem: 'regra' };
      if (it.gerado) return { dia: ultimoDiaIdx(idx), origem: 'fim' };
      return { dia: 1, origem: 'padrao' };
    }
    function diaDoAvulso(e, idx) {
      if (Number.isInteger(e.diaVencimento)) return { dia: Math.min(e.diaVencimento, ultimoDiaIdx(idx)), origem: 'avulso' };
      const g = e.tipo === 'despesa' ? grupoPorNome.get(e.grupo) : null;
      if (g && g.diaPadrao != null) return { dia: g.diaPadrao, origem: 'grupo' };
      return { dia: 1, origem: 'padrao' };
    }
    function textoDia(tipo, dia, origem) {
      const verbo = tipo === 'receita' ? 'recebe' : 'vence';
      if (origem === 'mes') return `${verbo} dia ${dia} (só este mês)`;
      if (origem === 'padrao') return `sem data · conta no dia ${dia}`;
      return `${verbo} dia ${dia}`;
    }

    /* Visão completa de um mês, já com tudo aplicado — é o que o app mostra em "Meu Mês". */
    function visaoMes(mes) {
      const idx = months.indexOf(mes);
      if (idx < 0) throw new Error(`Mês fora do horizonte: ${mes}`);
      const itens = [];
      itensPorMes[mes].forEach(it => {
        if (estado.excluidos[it.chave]) return;
        const d = diaDoItemRegra(it, idx);
        const vencimento = it.gerado ? (d.origem === 'mes' ? `${textoDia(it.tipo, d.dia, d.origem)} · ${it.vencimento}` : it.vencimento)
          : (d.origem === 'regra' ? it.vencimento : textoDia(it.tipo, d.dia, d.origem));
        itens.push({
          chave: it.chave, tipo: it.tipo, grupo: it.grupo, desc: it.desc,
          valor: valorEfetivo(it.chave, it.valor), valorOriginal: it.valor,
          editado: estado.overrides[it.chave] != null,
          confirmado: !!estado.confirmados[it.chave],
          ilustrativo: it.ilustrativo, dia: d.dia, diaOrigem: d.origem, diaRegra: it.dia, vencimento,
          origem: 'regra', regraId: it.regraId, parcela: it.parcela, gerado: !!it.gerado,
        });
      });
      (estado.extras[mes] || []).forEach(e => {
        const d = diaDoAvulso(e, idx);
        itens.push({
          chave: `extra:${e.id}`, tipo: e.tipo, grupo: e.grupo || null, desc: e.desc,
          valor: e.valor, valorOriginal: e.valor, editado: false,
          confirmado: !!estado.confirmados[`extra:${e.id}`],
          ilustrativo: false, dia: d.dia, diaOrigem: d.origem,
          vencimento: textoDia(e.tipo, d.dia, d.origem === 'avulso' ? 'regra' : d.origem),
          origem: 'avulso', id: e.id,
          contaComoAvulso: !!(avulsosDoMes[idx] && avulsosDoMes[idx].has(e.id)),
          podeSerAvulso: !!(div && e.tipo === 'despesa' && e.grupo !== div.grupo && e.grupo !== div.grupoAvulsos && inicioAbs + idx >= div.desdeAbs),
        });
      });
      const removidos = itensPorMes[mes].filter(it => estado.excluidos[it.chave]).map(it => ({ chave: it.chave, desc: it.desc, valor: it.valor }));
      const contam = itens.filter(i => !i.ilustrativo);
      const soma = (arr) => arr.reduce((a, i) => a + i.valor, 0);
      const receitas = soma(contam.filter(i => i.tipo === 'receita'));
      const despesas = soma(contam.filter(i => i.tipo === 'despesa'));
      const sa = saldoAtualIdx(idx);
      return {
        mes, itens, removidos,
        totais: {
          receitas, despesas, saldo: receitas - despesas,
          cumulativo: monthStats[idx].saldoCumulativo + ajusteAcumuladoAte(idx),
          saldoInicial: saldoInicialIdx(idx),
          aporteSimulado: monthStats[idx].aporte,
          // "Despesas reais" não contam investimento, reserva e sobra dos avulsos (que são transferências);
          // o saldo do mês é a sobra antes de investir e reservar.
          paraInvestir: monthStats[idx].aporteDaSobra,
          despesasReais: round2(despesas - monthStats[idx].aporteDaSobra),
          saldoAntesDeInvestir: round2(receitas - despesas + monthStats[idx].aporteDaSobra),
          divisao: divisaoPorMes[idx],
          recebido: sa.recebido, pago: sa.pago,
          saldoAtualConfirmado: saldoAtualTotal(idx),
          faltaReceber: soma(contam.filter(i => i.tipo === 'receita' && !i.confirmado)),
          faltaPagar: soma(contam.filter(i => i.tipo === 'despesa' && !i.confirmado)),
          aplicado: aplicadoAte(idx),
          livreEmConta: livreEmContaIdx(idx),
          investido: carteiraAte(idx).totais.saldo,
        },
      };
    }

    return {
      months, data, info, itensPorMes, monthStats, investimentos,
      infoItem, isReceitaIlustrativa,
      ajusteMesIdx, ajusteAcumuladoAte, saldoAtualIdx, saldoInicialIdx, saldoAtualTotal, visaoMes,
      carteiraAte, aplicadoAte, livreEmContaIdx,
      divisao: div, divisaoIdx, saldosDivisao, metasDoAno, fluxoDoMes, caixinhasDivisao,
    };
  }

  /* Troca a descrição (o modelo, com {n}/{total} se for parcelado) de uma regra e move as marcações
     de cada mês (confirmados, valores editados, removidos e dias trocados) para o nome novo. */
  function renomearRegra(dados, regraId, novoDesc) { alterarRegra(dados, regraId, { desc: novoDesc }); }
  /* Muda campos de uma regra (desc, grupo, tipo, dia...) e move as marcações de cada mês para a
     chave nova. Campo com valor undefined é apagado da regra. */
  function alterarRegra(dados, regraId, mudancas) {
    const r = (dados.lancamentos || []).find(x => x.id === regraId);
    if (!r) throw new Error(`Regra "${regraId}" não existe.`);
    const chaves = (m) => { const out = {}; m.months.forEach(mes => m.itensPorMes[mes].forEach(it => { if (it.regraId === regraId) out[mes] = it.chave; })); return out; };
    const antes = chaves(criar(dados));
    Object.entries(mudancas).forEach(([k, v]) => { if (v === undefined) delete r[k]; else r[k] = v; });
    const depois = chaves(criar(dados));
    ['confirmados', 'overrides', 'excluidos', 'dias'].forEach(k => {
      const o = dados.estado && dados.estado[k];
      if (!o) return;
      Object.keys(antes).forEach(mes => {
        const velha = antes[mes], nova = depois[mes];
        if (!nova || velha === nova || o[velha] === undefined) return;
        o[nova] = o[velha]; delete o[velha];
      });
    });
  }

  /* ---------- validação do financas.json ----------
     Devolve [{ nivel: 'erro' | 'aviso', msg }]. Com 'erro' o app não abre os dados. */
  /* ---------- assinaturas: o que é cobrado todo mês no cartão e quem paga o quê ----------
     dados.assinaturas = { cartao: { nome, limite },
                           itens: [{ id, nome, valor, dia, obs,
                                     divisao: { pessoas: [{ id, nome, meses: ['Jan','Jul'], obs }],
                                                pagos: { 'eu|Jan/27': true, 'isis|ano/27': true } } }] }
     Uma assinatura dividida (ex.: Spotify família) tem pessoas, cada uma responsável por alguns
     meses do ano. Em pagos, "pessoa|Mês/aa" = pagou aquele mês; "pessoa|ano/aa" = pagou o ano
     inteiro de uma vez. Nada daqui entra nas contas do mês: é só controle do cartão. */
  const RE_PAGO = /^([A-Za-z0-9][A-Za-z0-9_-]*)\|(ano|Jan|Fev|Mar|Abr|Mai|Jun|Jul|Ago|Set|Out|Nov|Dez)\/(\d{2})$/;
  function assinaturas(dados, ano) {
    const a = (dados && dados.assinaturas) || {};
    const cartao = (a.cartao && typeof a.cartao === 'object') ? a.cartao : {};
    const limite = typeof cartao.limite === 'number' ? cartao.limite : null;
    const anoRef = Number.isInteger(ano) ? ano : new Date().getFullYear();
    const aa = pad2(anoRef % 100);
    const itens = (Array.isArray(a.itens) ? a.itens : []).filter(it => it && typeof it === 'object').map(it => {
      const valor = typeof it.valor === 'number' ? it.valor : 0;
      const out = { id: it.id, nome: it.nome, valor, dia: it.dia == null ? null : it.dia, obs: it.obs || '', divisao: null };
      const d = it.divisao;
      if (d && typeof d === 'object' && Array.isArray(d.pessoas)) {
        const pagos = (d.pagos && typeof d.pagos === 'object') ? d.pagos : {};
        const pessoas = d.pessoas.filter(p => p && typeof p === 'object').map(p => {
          const anoTodo = pagos[`${p.id}|ano/${aa}`] === true;
          const meses = (Array.isArray(p.meses) ? p.meses : []).filter(m => NOMES_MES.includes(m)).map(m => {
            const noMes = pagos[`${p.id}|${m}/${aa}`] === true;
            return { nome: m, mes: `${m}/${aa}`, pago: anoTodo || noMes, pagoNoMes: noMes };
          });
          const pagosN = meses.filter(m => m.pago).length;
          return {
            id: p.id, nome: p.nome, obs: p.obs || '', meses, anoTodo,
            valorAno: round2(valor * meses.length), valorPago: round2(valor * pagosN), pagosN,
            quitado: meses.length > 0 && pagosN === meses.length,
          };
        });
        const porMes = NOMES_MES.map((m, i) => {
          const resp = pessoas.filter(p => p.meses.some(x => x.nome === m))
            .map(p => ({ id: p.id, nome: p.nome, pago: p.meses.find(x => x.nome === m).pago, anoTodo: p.anoTodo }));
          return { nome: m, mes: `${m}/${aa}`, idx: i, pessoas: resp, pago: resp.length > 0 && resp.every(r => r.pago) };
        });
        out.divisao = {
          ano: anoRef, pessoas, porMes,
          mesesCobertos: porMes.filter(x => x.pessoas.length).length,
          mesesPagos: porMes.filter(x => x.pago).length,
        };
      }
      return out;
    });
    const total = round2(itens.reduce((s, it) => s + it.valor, 0));
    return {
      ano: anoRef, cartao: { nome: cartao.nome || '', limite }, itens, total,
      livre: limite == null ? null : round2(limite - total),
      pct: limite ? round2(total / limite * 100) : null,
    };
  }

  function validar(dados) {
    const out = [];
    const erro = (msg) => out.push({ nivel: 'erro', msg });
    const aviso = (msg) => out.push({ nivel: 'aviso', msg });
    const ehObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
    const ehNum = (v) => typeof v === 'number' && isFinite(v);

    if (!ehObj(dados)) { erro('O arquivo precisa ser um objeto JSON.'); return out; }
    if (!ehObj(dados.horizonte) || !mesValido(dados.horizonte.inicio)) erro('horizonte.inicio precisa ser um mês no formato Nov/26.');
    if (!ehObj(dados.horizonte) || !Number.isInteger(dados.horizonte.meses) || dados.horizonte.meses < 1 || dados.horizonte.meses > 600) erro('horizonte.meses precisa ser um inteiro entre 1 e 600.');
    if (!Array.isArray(dados.grupos) || !dados.grupos.length) erro('grupos precisa ser uma lista com pelo menos um grupo.');
    const cfgInvP = (dados.parametros && dados.parametros.investimentos) || {};
    if (cfgInvP.caixinhaNubank != null) {
      const c = cfgInvP.caixinhaNubank;
      if (!ehObj(c)) erro('parametros.investimentos.caixinhaNubank precisa ser um objeto.');
      else if (c.percentualCdi != null && (!ehNum(c.percentualCdi) || c.percentualCdi <= 0 || c.percentualCdi > 300)) erro('parametros.investimentos.caixinhaNubank.percentualCdi precisa ser um número (ex.: 100).');
    }
    if (cfgInvP.juros != null) {
      const j = cfgInvP.juros;
      if (!ehObj(j)) erro('parametros.investimentos.juros precisa ser um objeto.');
      else {
        ['cdiAnual', 'selicMeta'].forEach(k => { if (j[k] != null && (!ehNum(j[k]) || j[k] < 0 || j[k] > 100)) erro(`parametros.investimentos.juros.${k} precisa ser uma taxa em % ao ano.`); });
        if (j.diario != null) {
          if (!ehObj(j.diario)) erro('parametros.investimentos.juros.diario precisa ser um objeto { "AAAA-MM-DD": taxa % ao dia }.');
          else Object.entries(j.diario).forEach(([d, v]) => { if (!dataValida(d) || !ehNum(v) || v < 0 || v > 1) erro(`parametros.investimentos.juros.diario["${d}"]: precisa de uma data AAAA-MM-DD e uma taxa % ao dia (ex.: 0.0508).`); });
        }
      }
    }
    const cfgDiv = dados.parametros && dados.parametros.investimentos && dados.parametros.investimentos.divisaoSobra;
    if (cfgDiv != null) {
      const ondeD = 'parametros.investimentos.divisaoSobra';
      if (!ehObj(cfgDiv)) erro(`${ondeD} precisa ser um objeto.`);
      else {
        if (!mesValido(cfgDiv.desde)) erro(`${ondeD}.desde precisa ser um mês no formato Jan/27.`);
        ['investimento', 'reserva'].forEach(k => { if (!ehNum(cfgDiv[k]) || cfgDiv[k] < 0 || cfgDiv[k] > 100) erro(`${ondeD}.${k} precisa ser uma porcentagem de 0 a 100.`); });
        if (ehNum(cfgDiv.investimento) && ehNum(cfgDiv.reserva) && cfgDiv.investimento + cfgDiv.reserva > 100) erro(`${ondeD}: investimento + reserva passam de 100%.`);
        ['grupo', 'grupoAvulsos'].forEach(k => { if (typeof cfgDiv[k] !== 'string' || !Array.isArray(dados.grupos) || !dados.grupos.some(g => g && g.nome === cfgDiv[k])) erro(`${ondeD}.${k} precisa ser o nome de um grupo que existe em grupos.`); });
        if (cfgDiv.grupo === cfgDiv.grupoAvulsos) erro(`${ondeD}: grupo e grupoAvulsos precisam ser grupos diferentes.`);
        if (cfgDiv.restoAvulsosParaInvestimento != null && typeof cfgDiv.restoAvulsosParaInvestimento !== 'boolean') erro(`${ondeD}.restoAvulsosParaInvestimento precisa ser true ou false.`);
        if (cfgDiv.quandoReservaAtingir != null) {
          const q = cfgDiv.quandoReservaAtingir, oq = `${ondeD}.quandoReservaAtingir`;
          if (!ehObj(q) || !ehNum(q.valor) || q.valor <= 0) erro(`${oq} precisa de "valor" (em reais, maior que zero).`);
          else ['investimento', 'reserva'].forEach(k => { if (!ehNum(q[k]) || q[k] < 0 || q[k] > 100) erro(`${oq}.${k} precisa ser uma porcentagem de 0 a 100.`); });
          if (ehObj(q) && ehNum(q.investimento) && ehNum(q.reserva) && q.investimento + q.reserva > 100) erro(`${oq}: investimento + reserva passam de 100%.`);
        }
        if (cfgDiv.restoAvulsosPara != null && !['reserva', 'investimento'].includes(cfgDiv.restoAvulsosPara)) erro(`${ondeD}.restoAvulsosPara precisa ser "reserva" ou "investimento".`);
        if (cfgDiv.prioridadeInvestimentoReserva != null && typeof cfgDiv.prioridadeInvestimentoReserva !== 'boolean') erro(`${ondeD}.prioridadeInvestimentoReserva precisa ser true ou false.`);
        if (cfgDiv.novasDespesasNoAvulso != null && typeof cfgDiv.novasDespesasNoAvulso !== 'boolean') erro(`${ondeD}.novasDespesasNoAvulso precisa ser true ou false.`);
        if (cfgDiv.tetoAvulsos != null && (!ehNum(cfgDiv.tetoAvulsos) || cfgDiv.tetoAvulsos < 0)) erro(`${ondeD}.tetoAvulsos precisa ser um valor em reais maior ou igual a zero (ou não existir).`);
      }
    }
    if (!Array.isArray(dados.lancamentos)) erro('lancamentos precisa ser uma lista.');
    if (dados.estado != null && !ehObj(dados.estado)) erro('estado precisa ser um objeto.');
    if (out.length) return out;

    const nomesGrupos = new Set();
    dados.grupos.forEach((g, i) => {
      if (!ehObj(g) || typeof g.nome !== 'string' || !g.nome) return erro(`grupos[${i}]: falta "nome".`);
      if (g.nome.includes('|')) erro(`grupos[${i}]: o nome não pode conter "|".`);
      if (nomesGrupos.has(g.nome)) erro(`grupos: nome repetido "${g.nome}".`);
      nomesGrupos.add(g.nome);
      if (g.diaPadrao != null && !(Number.isInteger(g.diaPadrao) && g.diaPadrao >= 1 && g.diaPadrao <= 31)) erro(`grupos[${i}]: diaPadrao precisa estar entre 1 e 31.`);
    });

    const ids = new Set();
    dados.lancamentos.forEach((r, i) => {
      const onde = `lancamentos[${i}]${r && r.id ? ` (${r.id})` : ''}`;
      if (!ehObj(r)) return erro(`${onde}: precisa ser um objeto.`);
      if (typeof r.id !== 'string' || !r.id) erro(`${onde}: falta "id".`);
      else if (ids.has(r.id)) erro(`${onde}: id repetido.`);
      else ids.add(r.id);
      if (r.tipo !== 'receita' && r.tipo !== 'despesa') erro(`${onde}: tipo precisa ser "receita" ou "despesa".`);
      if (r.tipo === 'despesa' && !nomesGrupos.has(r.grupo)) erro(`${onde}: grupo "${r.grupo}" não existe em grupos.`);
      if (r.tipo === 'receita' && r.grupo != null) erro(`${onde}: receita não tem grupo (use null).`);
      if (typeof r.desc !== 'string' || !r.desc.trim()) erro(`${onde}: falta "desc".`);
      else if (r.desc.includes('|')) erro(`${onde}: desc não pode conter "|".`);
      if (r.calculo != null) { if (!CALCULOS.includes(r.calculo)) erro(`${onde}: calculo desconhecido "${r.calculo}".`); }
      else if (!ehNum(r.valor) || r.valor < 0) erro(`${onde}: valor precisa ser um número maior ou igual a zero.`);
      if (!mesValido(r.inicio)) erro(`${onde}: inicio precisa ser um mês no formato Nov/26.`);
      if (r.fim != null) {
        if (!mesValido(r.fim)) erro(`${onde}: fim precisa ser um mês no formato Nov/26.`);
        else if (mesValido(r.inicio) && mesAbs(r.fim) < mesAbs(r.inicio)) erro(`${onde}: fim vem antes de inicio.`);
      }
      if (r.parcelas != null) {
        const p = r.parcelas;
        if (!ehObj(p) || !Number.isInteger(p.total) || p.total < 1) erro(`${onde}: parcelas.total precisa ser um inteiro maior que zero.`);
        else if (p.primeira != null && !(Number.isInteger(p.primeira) && p.primeira >= 1 && p.primeira <= p.total)) erro(`${onde}: parcelas.primeira precisa estar entre 1 e o total.`);
        if (typeof r.desc === 'string' && !r.desc.includes('{n}')) aviso(`${onde}: lançamento parcelado sem {n} na descrição — as parcelas ficam todas com o mesmo nome.`);
      }
      (r.ajustes || []).forEach((a, j) => {
        if (!ehObj(a) || !mesValido(a.aPartirDe) || !ehNum(a.valor) || a.valor < 0) erro(`${onde}: ajustes[${j}] precisa de aPartirDe (mês) e valor (número).`);
      });
      ['dia', 'ultimoDiaAte'].forEach(k => {
        if (r[k] != null && !(Number.isInteger(r[k]) && r[k] >= 1 && r[k] <= 31)) erro(`${onde}: ${k} precisa estar entre 1 e 31.`);
      });
      if (r.diaUtil != null && !(Number.isInteger(r.diaUtil) && r.diaUtil >= 1 && r.diaUtil <= 20)) erro(`${onde}: diaUtil precisa estar entre 1 e 20.`);
    });
    if (out.some(o => o.nivel === 'erro')) return out;

    // Dois lançamentos com o mesmo nome no mesmo mês e grupo se sobrescrevem — não pode.
    const inicioAbs = mesAbs(dados.horizonte.inicio);
    const chavesValidas = new Set();
    const repetidos = new Set();
    for (let k = 0; k < dados.horizonte.meses; k++) {
      const abs = inicioAbs + k, m = mesLabel(abs);
      dados.lancamentos.forEach(r => {
        const it = aplicarRegra(r, abs, dados);
        if (!it) return;
        const ch = chaveItem(m, it.tipo, it.grupo, it.desc);
        if (chavesValidas.has(ch) && !repetidos.has(`${it.tipo}|${it.grupo}|${it.desc}`)) {
          repetidos.add(`${it.tipo}|${it.grupo}|${it.desc}`);
          erro(`Dois lançamentos geram o mesmo item "${it.desc}" em ${m} (${it.grupo || 'Receitas'}). Mude a descrição de um deles.`);
        }
        chavesValidas.add(ch);
      });
      const dv = divisaoConfig(dados);
      if (dv && abs >= dv.desdeAbs) [DESC_INVESTIMENTO, DESC_RESERVA, DESC_RESTO_AVULSOS].forEach(desc => chavesValidas.add(chaveItem(m, 'despesa', dv.grupo, desc)));
    }

    const estado = dados.estado || {};
    const idsExtras = new Set();
    if (estado.extras != null && !ehObj(estado.extras)) erro('estado.extras precisa ser um objeto { "Mês": [itens] }.');
    else Object.entries(estado.extras || {}).forEach(([mes, lista]) => {
      if (!mesValido(mes)) erro(`estado.extras: "${mes}" não é um mês no formato Nov/26.`);
      if (!Array.isArray(lista)) return erro(`estado.extras["${mes}"] precisa ser uma lista.`);
      lista.forEach((e, i) => {
        const onde = `estado.extras["${mes}"][${i}]`;
        if (!ehObj(e)) return erro(`${onde}: precisa ser um objeto.`);
        if (typeof e.id !== 'string' || !e.id) erro(`${onde}: falta "id" (texto).`);
        else if (idsExtras.has(e.id)) erro(`${onde}: id repetido "${e.id}".`);
        else idsExtras.add(e.id);
        if (e.tipo !== 'receita' && e.tipo !== 'despesa') erro(`${onde}: tipo precisa ser "receita" ou "despesa".`);
        if (e.tipo === 'despesa' && !nomesGrupos.has(e.grupo)) erro(`${onde}: grupo "${e.grupo}" não existe em grupos.`);
        if (e.tipo === 'receita' && e.grupo != null) erro(`${onde}: receita não tem grupo (use null).`);
        if (typeof e.desc !== 'string' || !e.desc.trim()) erro(`${onde}: falta "desc".`);
        if (!ehNum(e.valor) || e.valor < 0) erro(`${onde}: valor precisa ser um número maior ou igual a zero.`);
        if (e.diaVencimento != null && !(Number.isInteger(e.diaVencimento) && e.diaVencimento >= 1 && e.diaVencimento <= 31)) erro(`${onde}: diaVencimento precisa estar entre 1 e 31 (ou null).`);
        if (e.avulso != null && typeof e.avulso !== 'boolean') erro(`${onde}: "avulso" precisa ser true ou false.`);
      });
    });

    const conferirChaves = (nome, obj, aceitaExtra, valorOk, descValor) => {
      if (obj != null && !ehObj(obj)) return erro(`estado.${nome} precisa ser um objeto.`);
      Object.entries(obj || {}).forEach(([ch, v]) => {
        if (!valorOk(v)) erro(`estado.${nome}["${ch}"]: o valor precisa ser ${descValor}.`);
        if (ch.startsWith('extra:')) {
          if (!aceitaExtra) aviso(`estado.${nome}["${ch}"]: itens avulsos não usam ${nome} — edite ou remova o item em estado.extras.`);
          else if (!idsExtras.has(ch.slice(6))) aviso(`estado.${nome}["${ch}"]: não existe item avulso com esse id (chave sobrando).`);
        } else if (!chavesValidas.has(ch)) {
          aviso(`estado.${nome}["${ch}"]: nenhum lançamento gera esse item nesse mês (chave sobrando — confira o nome exato com scripts/resumo.js).`);
        }
      });
    };
    conferirChaves('confirmados', estado.confirmados, true, v => typeof v === 'boolean', 'true ou false');
    conferirChaves('overrides', estado.overrides, false, v => ehNum(v) && v >= 0, 'um número maior ou igual a zero');
    conferirChaves('excluidos', estado.excluidos, false, v => v === true, 'true');
    conferirChaves('dias', estado.dias, false, v => Number.isInteger(v) && v >= 1 && v <= 31, 'um dia de 1 a 31');

    const cart = dados.carteira;
    if (cart != null) {
      if (!ehObj(cart) || !Array.isArray(cart.ativos) || !Array.isArray(cart.movimentos)) erro('carteira precisa de ativos (lista) e movimentos (lista).');
      else {
        const idsAtivos = new Set();
        const textoOpcional = ['instituicao', 'tipo', 'objetivo', 'rentabilidade', 'obs'];
        cart.ativos.forEach((a, i) => {
          const onde = `carteira.ativos[${i}]${a && a.id ? ` (${a.id})` : ''}`;
          if (!ehObj(a)) return erro(`${onde}: precisa ser um objeto.`);
          if (typeof a.id !== 'string' || !RE_ID.test(a.id)) erro(`${onde}: "id" precisa ser um texto só com letras, números e hífens.`);
          else if (idsAtivos.has(a.id)) erro(`${onde}: id repetido.`);
          else idsAtivos.add(a.id);
          if (typeof a.nome !== 'string' || !a.nome.trim()) erro(`${onde}: falta "nome".`);
          textoOpcional.forEach(k => { if (a[k] != null && typeof a[k] !== 'string') erro(`${onde}: "${k}" precisa ser texto.`); });
          if (a.encerrado != null && typeof a.encerrado !== 'boolean') erro(`${onde}: "encerrado" precisa ser true ou false.`);
          if (typeof a.objetivo !== 'string' || !a.objetivo.trim()) aviso(`${onde}: falta "objetivo" — diga para que serve este investimento.`);
        });
        const idsMov = new Set();
        cart.movimentos.forEach((m, i) => {
          const onde = `carteira.movimentos[${i}]${m && m.id ? ` (${m.id})` : ''}`;
          if (!ehObj(m)) return erro(`${onde}: precisa ser um objeto.`);
          if (typeof m.id !== 'string' || !RE_ID.test(m.id)) erro(`${onde}: "id" precisa ser um texto só com letras, números e hífens.`);
          else if (idsMov.has(m.id)) erro(`${onde}: id repetido.`);
          else idsMov.add(m.id);
          if (!idsAtivos.has(m.ativo)) erro(`${onde}: o investimento "${m.ativo}" não existe em carteira.ativos.`);
          if (!TIPOS_MOVIMENTO.includes(m.tipo)) erro(`${onde}: tipo precisa ser um destes: ${TIPOS_MOVIMENTO.join(', ')}.`);
          if (!dataValida(m.data)) erro(`${onde}: data precisa ser um dia que existe, no formato AAAA-MM-DD.`);
          if (!ehNum(m.valor) || (m.tipo === 'rendimento' ? m.valor === 0 : m.valor <= 0)) erro(`${onde}: valor precisa ser um número ${m.tipo === 'rendimento' ? 'diferente de zero (negativo se perdeu)' : 'maior que zero'}.`);
          else if (Math.abs(m.valor * 100 - Math.round(m.valor * 100)) > 1e-6) erro(`${onde}: valor com mais de duas casas decimais.`);
          if (m.obs != null && typeof m.obs !== 'string') erro(`${onde}: "obs" precisa ser texto.`);
        });
        if (!out.some(o => o.nivel === 'erro')) {
          carteira(dados).ativos.forEach(a => {
            const neg = a.movimentos.find(m => m.saldoApos < 0);
            if (neg) aviso(`carteira: "${a.nome}" fica com saldo negativo em ${neg.data} — confira os resgates e os rendimentos.`);
          });
        }
      }
    }

    const ass = dados.assinaturas;
    if (ass != null) {
      if (!ehObj(ass) || !Array.isArray(ass.itens)) erro('assinaturas precisa de itens (lista).');
      else {
        if (ass.cartao != null) {
          if (!ehObj(ass.cartao)) erro('assinaturas.cartao precisa ser um objeto { nome, limite }.');
          else {
            if (ass.cartao.nome != null && typeof ass.cartao.nome !== 'string') erro('assinaturas.cartao.nome precisa ser texto.');
            if (ass.cartao.limite != null && (!ehNum(ass.cartao.limite) || ass.cartao.limite < 0)) erro('assinaturas.cartao.limite precisa ser um número maior ou igual a zero.');
          }
        }
        const idsAss = new Set();
        ass.itens.forEach((it, i) => {
          const onde = `assinaturas.itens[${i}]${it && it.id ? ` (${it.id})` : ''}`;
          if (!ehObj(it)) return erro(`${onde}: precisa ser um objeto.`);
          if (typeof it.id !== 'string' || !RE_ID.test(it.id)) erro(`${onde}: "id" precisa ser um texto só com letras, números e hífens.`);
          else if (idsAss.has(it.id)) erro(`${onde}: id repetido.`);
          else idsAss.add(it.id);
          if (typeof it.nome !== 'string' || !it.nome.trim()) erro(`${onde}: falta "nome".`);
          if (!ehNum(it.valor) || it.valor < 0) erro(`${onde}: "valor" precisa ser um número maior ou igual a zero.`);
          if (it.dia != null && (!Number.isInteger(it.dia) || it.dia < 1 || it.dia > 31)) erro(`${onde}: "dia" precisa ser um inteiro de 1 a 31.`);
          if (it.obs != null && typeof it.obs !== 'string') erro(`${onde}: "obs" precisa ser texto.`);
          if (it.divisao == null) return;
          const d = it.divisao;
          if (!ehObj(d) || !Array.isArray(d.pessoas)) return erro(`${onde}.divisao: precisa de pessoas (lista).`);
          const idsP = new Set();
          d.pessoas.forEach((p, j) => {
            const ondeP = `${onde}.divisao.pessoas[${j}]`;
            if (!ehObj(p)) return erro(`${ondeP}: precisa ser um objeto.`);
            if (typeof p.id !== 'string' || !RE_ID.test(p.id)) erro(`${ondeP}: "id" precisa ser um texto só com letras, números e hífens.`);
            else if (idsP.has(p.id)) erro(`${ondeP}: id repetido.`);
            else idsP.add(p.id);
            if (typeof p.nome !== 'string' || !p.nome.trim()) erro(`${ondeP}: falta "nome".`);
            if (!Array.isArray(p.meses) || p.meses.some(m => !NOMES_MES.includes(m))) erro(`${ondeP}: "meses" precisa ser uma lista com nomes de mês (Jan … Dez).`);
            if (p.obs != null && typeof p.obs !== 'string') erro(`${ondeP}: "obs" precisa ser texto.`);
          });
          if (d.pagos == null) return;
          if (!ehObj(d.pagos)) return erro(`${onde}.divisao.pagos precisa ser um objeto.`);
          Object.entries(d.pagos).forEach(([k, v]) => {
            const m = RE_PAGO.exec(k);
            if (!m) return erro(`${onde}.divisao.pagos: chave "${k}" fora do formato pessoa|Mês/aa ou pessoa|ano/aa.`);
            if (typeof v !== 'boolean') erro(`${onde}.divisao.pagos["${k}"]: precisa ser true ou false.`);
            const pessoa = d.pessoas.find(p => ehObj(p) && p.id === m[1]);
            if (!pessoa) return erro(`${onde}.divisao.pagos: a pessoa "${m[1]}" não existe na divisão.`);
            if (m[2] !== 'ano' && Array.isArray(pessoa.meses) && !pessoa.meses.includes(m[2])) aviso(`${onde}.divisao.pagos: "${k}" marca um mês que não é de ${pessoa.nome} (meses: ${pessoa.meses.join(', ')}).`);
          });
        });
      }
    }

    const viagem = dados.viagem;
    if (viagem != null) {
      if (!ehObj(viagem)) erro('viagem precisa ser um objeto.');
      else {
        if (!Array.isArray(viagem.roteiro)) erro('viagem.roteiro precisa ser uma lista.');
        const c = viagem.custos;
        if (!ehObj(c) || !ehNum(c.fxRateEurBrl) || !Array.isArray(c.segmentos)) erro('viagem.custos precisa de fxRateEurBrl (número) e segmentos (lista).');
        else c.segmentos.forEach((s, i) => {
          if (!ehObj(s) || typeof s.id !== 'string' || !Array.isArray(s.itens)) return erro(`viagem.custos.segmentos[${i}]: precisa de id e itens.`);
          s.itens.forEach((it, j) => { if (!ehObj(it) || (it.valorEur != null && !ehNum(it.valorEur))) erro(`viagem.custos.segmentos[${i}].itens[${j}]: valorEur precisa ser número.`); });
        });
        const d = viagem.desafio40k;
        if (!ehObj(d) || !Array.isArray(d.pessoas)) erro('viagem.desafio40k precisa de pessoas (lista).');
        else d.pessoas.forEach((p, i) => {
          if (!ehObj(p) || typeof p.id !== 'string' || !ehNum(p.metaReais) || !Array.isArray(p.meses) || !ehObj(p.aportesRealizados)) return erro(`viagem.desafio40k.pessoas[${i}]: precisa de id, metaReais, meses e aportesRealizados.`);
          Object.entries(p.aportesRealizados).forEach(([mes, v]) => {
            if (!p.meses.includes(mes)) erro(`viagem.desafio40k.pessoas[${i}].aportesRealizados: "${mes}" não está na lista de meses dessa pessoa (formato Jan/2027).`);
            if (!ehNum(v)) erro(`viagem.desafio40k.pessoas[${i}].aportesRealizados["${mes}"]: precisa ser número.`);
          });
        });
      }
    }
    return out;
  }

  const Motor = { criar, validar, carteira, assinaturas, renomearRegra, alterarRegra, simularCaixinha, aliquotaIR, aliquotaIOF, ehDiaUtilBancario, dataValida, chaveItem, mesAbs, mesLabel, mesValido, calcularAuxilio, NOMES_MES, TIPOS_MOVIMENTO };
  if (typeof module !== 'undefined' && module.exports) module.exports = Motor;
  else root.Motor = Motor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
