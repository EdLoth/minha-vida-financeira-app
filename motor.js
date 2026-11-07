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
    ['confirmados', 'extras', 'overrides', 'excluidos'].forEach(k => { if (!estado[k]) estado[k] = {}; });

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

    let acumulado = 0;
    monthStats.forEach(s => {
      s.aporteMensal = aporteMensal;
      s.aporte = aporteMensal;
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

    /* Visão completa de um mês, já com tudo aplicado — é o que o app mostra em "Meu Mês". */
    function visaoMes(mes) {
      const idx = months.indexOf(mes);
      if (idx < 0) throw new Error(`Mês fora do horizonte: ${mes}`);
      const itens = [];
      itensPorMes[mes].forEach(it => {
        if (estado.excluidos[it.chave]) return;
        itens.push({
          chave: it.chave, tipo: it.tipo, grupo: it.grupo, desc: it.desc,
          valor: valorEfetivo(it.chave, it.valor), valorOriginal: it.valor,
          editado: estado.overrides[it.chave] != null,
          confirmado: !!estado.confirmados[it.chave],
          ilustrativo: it.ilustrativo, dia: it.dia, vencimento: it.vencimento,
          origem: 'regra', regraId: it.regraId, parcela: it.parcela,
        });
      });
      (estado.extras[mes] || []).forEach(e => {
        itens.push({
          chave: `extra:${e.id}`, tipo: e.tipo, grupo: e.grupo || null, desc: e.desc,
          valor: e.valor, valorOriginal: e.valor, editado: false,
          confirmado: !!estado.confirmados[`extra:${e.id}`],
          ilustrativo: false, dia: e.diaVencimento != null ? e.diaVencimento : null,
          vencimento: e.diaVencimento != null ? `${e.tipo === 'receita' ? 'recebe' : 'vence'} dia ${e.diaVencimento}` : null,
          origem: 'avulso', id: e.id,
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
    };
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

  const Motor = { criar, validar, carteira, assinaturas, dataValida, chaveItem, mesAbs, mesLabel, mesValido, calcularAuxilio, NOMES_MES, TIPOS_MOVIMENTO };
  if (typeof module !== 'undefined' && module.exports) module.exports = Motor;
  else root.Motor = Motor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
