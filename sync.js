/* =========================================================================
   SINCRONIZAÇÃO — lê e grava data/financas.json no repositório pelo GitHub.
   Usado pelo app (index.html). Cada gravação vira um commit "app: ...".
   Se o arquivo mudou no repositório enquanto o app estava aberto (o chat
   alterou algo, ou outro aparelho), as duas versões são juntadas campo a
   campo antes de gravar; quando os dois lados mexeram no MESMO campo, vale
   o que foi feito neste aparelho.
   ========================================================================= */
(function (root) {
  'use strict';

  const ehObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  /* Cópia pronta pra gravar: sem campos derivados (__cache) que o app recalcula sozinho. */
  const limpar = (v) => JSON.parse(JSON.stringify(v, (k, val) => (k === '__cache' ? undefined : val)));

  function igual(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => igual(x, b[i]));
    if (ehObj(a) && ehObj(b)) {
      const ka = Object.keys(a), kb = Object.keys(b);
      return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && igual(a[k], b[k]));
    }
    return false;
  }
  const listaComId = (v) => Array.isArray(v) && v.length > 0 && v.every(x => ehObj(x) && typeof x.id === 'string');

  /* Junta três versões: base (última sincronizada), local (este aparelho) e remoto (repositório). */
  function mesclar3(base, local, remoto) {
    if (igual(local, base)) return clone(remoto);
    if (igual(remoto, base)) return clone(local);

    if (ehObj(local) && ehObj(remoto)) {
      const b = ehObj(base) ? base : {};
      const tem = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
      const out = {};
      const chaves = Object.keys(remoto).concat(Object.keys(local).filter(k => !tem(remoto, k)));
      chaves.forEach(k => {
        const noL = tem(local, k), noR = tem(remoto, k), noB = tem(b, k);
        if (noL && noR) out[k] = mesclar3(b[k], local[k], remoto[k]);
        else if (noR) { if (!noB) out[k] = clone(remoto[k]); }            // remoto criou; se existia na base, este aparelho apagou
        else if (noL) { if (!noB || !igual(local[k], b[k])) out[k] = clone(local[k]); } // local criou/alterou; se igual à base, o remoto apagou
      });
      return out;
    }

    const vazia = (v) => Array.isArray(v) && v.length === 0;
    if ((listaComId(local) || vazia(local)) && (listaComId(remoto) || vazia(remoto))) {
      const b = listaComId(base) ? base : [];
      const porId = (arr) => new Map(arr.map(x => [x.id, x]));
      const mb = porId(b), ml = porId(local), mr = porId(remoto);
      const out = [];
      remoto.forEach(r => {
        if (ml.has(r.id)) out.push(mesclar3(mb.get(r.id), ml.get(r.id), r));
        else if (!mb.has(r.id)) out.push(clone(r));                        // remoto criou
      });
      local.forEach(l => {
        if (mr.has(l.id)) return;
        if (!mb.has(l.id) || !igual(l, mb.get(l.id))) out.push(clone(l));   // local criou/alterou
      });
      return out;
    }

    return clone(local); // mesmo campo mexido dos dois lados: vale este aparelho
  }

  /* ---------- base64 com acentos (UTF-8) ---------- */
  function paraBase64(texto) {
    const bytes = new TextEncoder().encode(texto);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function deBase64(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  class ErroSync extends Error {
    constructor(tipo, msg) { super(msg); this.tipo = tipo; } // tipo: 'chave' | 'acesso' | 'rede' | 'dados'
  }

  /* opcoes: { repo, arquivo, ramo, token, fetch, ler(chave), guardar(chave, valor),
               aoStatus(status, detalhe), aoDados(dados), esperaMs } */
  function criar(opcoes) {
    const o = Object.assign({ ramo: 'main', esperaMs: 2500 }, opcoes);
    const f = o.fetch || ((...a) => fetch(...a));
    const CACHE = 'vf:cache:' + o.repo;
    const url = `https://api.github.com/repos/${o.repo}/contents/${o.arquivo.split('/').map(encodeURIComponent).join('/')}`;
    const cabecalhos = () => ({
      'Authorization': 'Bearer ' + o.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });

    let base = null;      // última versão sincronizada (objeto)
    let sha = null;       // sha do arquivo nessa versão
    let local = null;     // objeto que o app altera diretamente
    let pendentes = [];   // descrições das alterações ainda não gravadas
    let sujo = false, salvando = false, timer = null, tentativaTimer = null;

    const status = (s, d) => { try { o.aoStatus && o.aoStatus(s, d); } catch (e) { /* tela não pode derrubar a gravação */ } };
    function guardarCache() {
      if (!o.guardar) return;
      try { o.guardar(CACHE, JSON.stringify({ sha, base, local: limpar(local), pendentes, sujo })); } catch (e) { /* sem espaço: segue sem cache */ }
    }
    function lerCache() {
      if (!o.ler) return null;
      try { const t = o.ler(CACHE); return t ? JSON.parse(t) : null; } catch (e) { return null; }
    }

    async function baixar() {
      let r;
      try { r = await f(`${url}?ref=${encodeURIComponent(o.ramo)}`, { headers: cabecalhos(), cache: 'no-store' }); }
      catch (e) { throw new ErroSync('rede', 'Sem conexão com o GitHub.'); }
      if (r.status === 401) throw new ErroSync('chave', 'Chave de acesso inválida ou vencida.');
      if (r.status === 403 || r.status === 404) throw new ErroSync('acesso', 'A chave não dá acesso ao repositório (ou o arquivo de dados não existe).');
      if (!r.ok) throw new ErroSync('rede', `GitHub respondeu ${r.status}.`);
      const j = await r.json();
      const texto = deBase64(j.content);
      let dados;
      try { dados = JSON.parse(texto); } catch (e) { throw new ErroSync('dados', 'O arquivo de dados no repositório não é um JSON válido.'); }
      return { dados, sha: j.sha, texto };
    }

    /* Abre os dados. Se havia alterações deste aparelho ainda não gravadas, elas voltam e são enviadas. */
    async function carregar() {
      const cache = lerCache();
      let remoto = null, erroRede = null;
      try { remoto = await baixar(); }
      catch (e) { if (e.tipo !== 'rede' || !cache) throw e; erroRede = e; }

      if (cache && cache.sujo) {
        base = cache.base; sha = cache.sha; local = cache.local; pendentes = cache.pendentes || []; sujo = true;
        agendar(300);
      } else if (remoto) {
        base = remoto.dados; sha = remoto.sha; local = clone(remoto.dados); pendentes = []; sujo = false;
        guardarCache();
      } else {
        base = cache.base; sha = cache.sha; local = cache.local; pendentes = []; sujo = false;
      }
      if (erroRede) status('offline', 'Sem conexão: mostrando a última versão vista neste aparelho.');
      return local;
    }

    function agendar(ms) {
      clearTimeout(timer);
      timer = setTimeout(salvar, ms == null ? o.esperaMs : ms);
    }
    /* O app chama depois de alterar o objeto de dados. descricao entra na mensagem do commit. */
    function alterou(descricao) {
      if (descricao && pendentes[pendentes.length - 1] !== descricao) pendentes.push(descricao);
      sujo = true;
      guardarCache();
      status('pendente');
      agendar();
    }

    function mensagemCommit(msgs) {
      const lista = msgs.length ? msgs : ['atualiza dados'];
      const titulo = lista.length === 1 ? lista[0] : `${lista[0]} (+${lista.length - 1})`;
      const corpo = lista.length > 1 ? '\n\n' + lista.map(m => '- ' + m).join('\n') : '';
      return `app: ${titulo.slice(0, 68)}${corpo}\n\n[skip ci]`;
    }

    async function salvar() {
      clearTimeout(timer); clearTimeout(tentativaTimer);
      if (salvando) return;
      if (!sujo) return;
      salvando = true;
      status('salvando');
      try {
        let gravado = false;
        for (let tentativa = 0; tentativa < 4 && !gravado; tentativa++) {
          const fotoLocal = limpar(local);
          const msgs = pendentes.slice();
          const remoto = await baixar();
          const houveRemoto = remoto.sha !== sha;
          const final = houveRemoto ? mesclar3(base, fotoLocal, remoto.dados) : fotoLocal;
          const texto = JSON.stringify(final, null, 2) + '\n';

          let novoSha = remoto.sha;
          if (texto !== remoto.texto) {
            let r;
            try {
              r = await f(url, {
                method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, cabecalhos()),
                body: JSON.stringify({ message: mensagemCommit(msgs), content: paraBase64(texto), sha: remoto.sha, branch: o.ramo }),
              });
            } catch (e) { throw new ErroSync('rede', 'Sem conexão com o GitHub.'); }
            if (r.status === 409 || r.status === 422) continue; // o arquivo mudou no meio do caminho: tenta de novo
            if (r.status === 401) throw new ErroSync('chave', 'Chave de acesso inválida ou vencida.');
            if (r.status === 403 || r.status === 404) throw new ErroSync('acesso', 'A chave não tem permissão de gravação no repositório.');
            if (!r.ok) throw new ErroSync('rede', `GitHub respondeu ${r.status} ao gravar.`);
            novoSha = (await r.json()).content.sha;
          }

          // o que foi alterado na tela enquanto a gravação estava em andamento não pode se perder
          const agora = limpar(local);
          const mexeuDurante = !igual(agora, fotoLocal);
          sha = novoSha; base = final;
          pendentes = pendentes.slice(msgs.length);
          sujo = mexeuDurante;
          if (houveRemoto) {
            local = mexeuDurante ? mesclar3(fotoLocal, agora, final) : clone(final);
            try { o.aoDados && o.aoDados(local); } catch (e) { /* idem */ }
          }
          guardarCache();
          gravado = true;
        }
        if (!gravado) throw new ErroSync('rede', 'O arquivo mudou várias vezes seguidas; tentando de novo.');
        status(sujo ? 'pendente' : 'salvo');
        if (sujo) agendar(500);
      } catch (e) {
        status('erro', e);
        if (e.tipo === 'rede') tentativaTimer = setTimeout(salvar, 8000);
      } finally {
        salvando = false;
      }
    }

    /* Confere se o repositório mudou (o chat gravou algo). Só troca os dados se não há nada pendente aqui. */
    async function conferir() {
      if (salvando || sujo || !base) return false;
      let remoto;
      try { remoto = await baixar(); } catch (e) { if (e.tipo !== 'rede') status('erro', e); return false; }
      if (salvando || sujo || remoto.sha === sha) return false;
      base = remoto.dados; sha = remoto.sha; local = clone(remoto.dados);
      guardarCache();
      try { o.aoDados && o.aoDados(local); } catch (e) { /* idem */ }
      status('atualizado');
      return true;
    }

    return {
      carregar, alterou, salvarAgora: salvar, conferir,
      get pendente() { return sujo || salvando; },
      get sha() { return sha; },
      esquecer() { if (o.guardar) { try { o.guardar(CACHE, null); } catch (e) { /* nada */ } } },
    };
  }

  const Sync = { criar, mesclar3, igual, limpar, ErroSync };
  if (typeof module !== 'undefined' && module.exports) module.exports = Sync;
  else root.Sync = Sync;
})(typeof globalThis !== 'undefined' ? globalThis : this);
